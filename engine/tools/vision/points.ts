import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Corners, Position, Project, Track } from "../../core/schema.js";
import { computeTimeline, timelineToSource, type TimedClip } from "../../core/timeline.js";
import { positionAt } from "../../core/keyframes.js";
import { round3 } from "../../core/util.js";
import { probe, runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import { native } from "../native/index.js";
import { fitTransform } from "./faces.js";
import { decodeFrames } from "./objects.js";

/**
 * Point and surface tracking (docs/design/cinematic-grade-and-vfx.md, section 5.4): follow a point,
 * or the four corners of a flat surface (a screen, a sign, a wall), through a source range, so layers
 * can be pinned to it and inserts corner-pinned onto it.
 *
 * The work is the Rust region tracker (`trackRegion`: Shi-Tomasi corners inside the area, pyramidal
 * Lucas-Kanade with a forward-backward check, RANSAC for the motion model, new corners when too few
 * survive). It runs forward from the marked frame to the end of the range and backward to its start,
 * on gray frames TRACK_SIZE pixels on the long side, and the transform of each frame moves the marked
 * corners. A short centered filter takes out sub-pixel jitter without lag.
 */

/** Bump when tracks for the same input would come out differently. */
export const POINT_TRACK_VERSION = 1;
/** Long side of the frames tracked. The tracker is sub-pixel, so this gives corners within a pixel at 1080p. */
export const TRACK_SIZE = 960;

/** Corners in pixels, in the order top-left, top-right, bottom-right, bottom-left. */
export type Quad = [number, number][];

export type Motion = NonNullable<Track["motion"]>;

const MODELS = { translation: "translation", similarity: "similarity", perspective: "homography" } as const;

/** What to track: a point with the square around it, or corners (source frame fractions). */
export type PointTrackSpec = Pick<Track, "assetId" | "time" | "point" | "corners" | "motion"> & { radius?: number; margin?: number };

export const motionOf = (spec: Pick<Track, "corners" | "motion">): Motion => spec.motion ?? (spec.corners ? "perspective" : "similarity");

export const quadOf = (c: Corners, w = 1, h = 1): Quad => [c.tl, c.tr, c.br, c.bl].map((p) => [p.x * w, p.y * h]);

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export const cornersOf = (q: Quad, w = 1, h = 1): Corners => {
  const [tl, tr, br, bl] = q.map(([x, y]) => ({ x: r4(x / w), y: r4(y / h) }));
  return { tl: tl!, tr: tr!, br: br!, bl: bl! };
};

/** The middle of four corners. */
export const quadCenter = (q: Quad): [number, number] => [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length];

/** A quad grown around its center by `margin` of its size (0.1 = 10% bigger each way). */
export function growQuad(q: Quad, margin: number): Quad {
  const [cx, cy] = quadCenter(q);
  return q.map(([x, y]) => [cx + (x - cx) * (1 + margin), cy + (y - cy) * (1 + margin)]);
}

/** 1 for pixels whose centers are inside the quad (even-odd rule, so any four corners work), else 0. */
export function fillQuad(q: Quad, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const ys = q.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    // Where the edges cross this row, sorted: pixels between pairs are inside.
    const xs: number[] = [];
    for (let i = 0; i < q.length; i++) {
      const [a, b] = [q[i]!, q[(i + 1) % q.length]!];
      if (a[1] <= cy !== b[1] <= cy) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k]! - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5)); x++) out[y * w + x] = 1;
  }
  return out;
}

/** Where the 3x3 row-major transform at `m[o..o+9]` puts (x, y). */
function apply(m: ArrayLike<number>, o: number, x: number, y: number): [number, number] {
  const d = m[o + 6]! * x + m[o + 7]! * y + m[o + 8]!;
  return [(m[o]! * x + m[o + 1]! * y + m[o + 2]!) / d, (m[o + 3]! * x + m[o + 4]! * y + m[o + 5]!) / d];
}

export interface QuadTrack {
  /** Per frame: where the quad is (pixels). */
  quads: Quad[];
  /** Per frame, 0..1: how well the tracking is supported (agreeing points and their fit). */
  confidence: number[];
  /** Frames where new corners had to be found because too few survived. */
  redetected: number[];
}

/**
 * Follow a quad (pixels, on frame `key`) through gray frames of `w` x `h`: forward to the last frame
 * and backward to the first. The tracked area is the quad grown by `margin`.
 */
export async function trackQuad(gray: Uint8Array[], w: number, h: number, key: number, quad: Quad, opts: { motion: Motion; margin?: number }): Promise<QuadTrack> {
  const n = gray.length;
  const area = w * h;
  const region = fillQuad(growQuad(quad, opts.margin ?? 0), w, h);
  if (!region.some((v) => v)) throw new Error("The area to track is outside the frame");
  const quads: Quad[] = new Array(n);
  const confidence: number[] = new Array(n).fill(0);
  const redetected: number[] = [];
  quads[key] = quad.map(([x, y]) => [x, y]);
  confidence[key] = 1;
  const k = native();
  for (const dir of [1, -1]) {
    const idx: number[] = [];
    for (let f = key; f >= 0 && f < n; f += dir) idx.push(f);
    if (idx.length < 2) continue;
    const frames = new Uint8Array(idx.length * area);
    idx.forEach((f, i) => frames.set(gray[f]!, i * area));
    const r = await k.trackRegion(frames, w, h, idx.length, region, { model: MODELS[opts.motion] });
    for (let i = 1; i < idx.length; i++) {
      const f = idx[i]!;
      quads[f] = quad.map(([x, y]) => apply(r.matrices, i * 9, x, y));
      const err = r.errors[i]!;
      confidence[f] = round3(Number.isFinite(err) ? Math.min(1, r.inliers[i]! / 30) * Math.min(1, 1 / Math.max(1, err)) : 0);
      if (r.redetected[i]) redetected.push(f);
    }
  }
  // A centered [1 2 1] filter on each corner, where both neighbours were tracked: no lag, less jitter.
  const smooth = quads.map((q, f) => {
    if (f === key || f === 0 || f === n - 1 || !confidence[f - 1] || !confidence[f + 1] || !confidence[f]) return q;
    return q.map(([x, y], c) => [(quads[f - 1]![c]![0] + 2 * x + quads[f + 1]![c]![0]) / 4, (quads[f - 1]![c]![1] + 2 * y + quads[f + 1]![c]![1]) / 4] as [number, number]);
  });
  return { quads: smooth, confidence, redetected: redetected.sort((a, b) => a - b) };
}

export interface PointTrack {
  fps: number;
  /** Source seconds of the first frame. */
  start: number;
  /** Upright source picture size. */
  source: { width: number; height: number };
  motion: Motion;
  /** Per frame: the tracked corners (source frame fractions); for a point, the square around it. */
  corners: Corners[];
  /** Per frame, 0..1: how well the tracking is supported. */
  confidence: number[];
  /** Frame numbers where new corners were found. */
  redetected: number[];
}

/** The tracked quad (source fractions) of a spec: its corners, or the square around its point. */
export function specQuad(spec: PointTrackSpec, source: { width: number; height: number }): Quad {
  if (spec.corners) return quadOf(spec.corners);
  if (!spec.point) throw new Error("A track needs a point or corners");
  const r = spec.radius ?? 0.04;
  const long = Math.max(source.width, source.height);
  const [rx, ry] = [(r * long) / source.width, (r * long) / source.height];
  const { x, y } = spec.point;
  return [
    [x - rx, y - ry],
    [x + rx, y - ry],
    [x + rx, y + ry],
    [x - rx, y + ry],
  ];
}

/** Track a point or surface over a source range (extended to include the marked frame). Only the asked range is returned. */
export async function trackPoints(src: string, opts: FfmpegOptions & { start: number; end: number; fps: number; spec: PointTrackSpec; signal?: AbortSignal }): Promise<PointTrack> {
  const info = await probe(src, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${src}`);
  if (info.isImage || info.duration === undefined) throw new Error("Tracking needs a video; a still image does not move");
  const source = { width: info.width, height: info.height };
  const k = Math.min(1, TRACK_SIZE / Math.max(source.width, source.height));
  const size = { w: Math.max(32, Math.round((source.width * k) / 2) * 2), h: Math.max(32, Math.round((source.height * k) / 2) * 2) };
  const { time } = opts.spec;
  const from = Math.max(0, Math.min(opts.start, time));
  const to = Math.min(info.duration, Math.max(opts.end, time + 1 / opts.fps));
  const gray = await decodeFrames(src, { start: from, end: to }, opts.fps, size, "gray", opts);
  const n = gray.length;
  if (!n) throw new Error(`No frames between ${from}s and ${to}s of ${src}`);
  const key = Math.min(n - 1, Math.max(0, Math.round((time - from) * opts.fps)));
  const motion = motionOf(opts.spec);
  const quad = specQuad(opts.spec, source).map(([x, y]): [number, number] => [x * size.w, y * size.h]);
  const r = await trackQuad(gray, size.w, size.h, key, quad, { motion, margin: opts.spec.corners ? opts.spec.margin : 0 });
  const s0 = Math.max(0, Math.round((opts.start - from) * opts.fps));
  const s1 = Math.min(n, s0 + Math.max(1, Math.ceil((opts.end - opts.start) * opts.fps - 1e-6)));
  return {
    fps: opts.fps,
    start: round3(from + s0 / opts.fps),
    source,
    motion,
    corners: r.quads.slice(s0, s1).map((q) => cornersOf(q, size.w, size.h)),
    confidence: r.confidence.slice(s0, s1),
    redetected: r.redetected.filter((f) => f >= s0 && f < s1).map((f) => f - s0),
  };
}

/** The cache file of a track over a source range. */
export async function pointTrackFile(dir: string, file: string, range: { start: number; end: number }, fps: number, spec: PointTrackSpec): Promise<{ file: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const { assetId: _, label: __, ...what } = spec as PointTrackSpec & { label?: string };
  const key = JSON.stringify({ v: POINT_TRACK_VERSION, file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps, size: TRACK_SIZE, what });
  const out = path.join(dir, `track-${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return { file: out, exists: await stat(out).then((s) => s.size > 0, () => false) };
}

export interface ClipPointTrack {
  clipId: string;
  track: PointTrack;
}

/**
 * Track a point or surface (project.tracks) through the primary clips of its video (all of them, or
 * `clipIds`), each over the source footage it uses, cached in the render cache. One frame per output
 * frame in source time (more for fast clips).
 */
export async function trackPointsInClips(
  project: Project,
  trackId: string,
  opts: FfmpegOptions & { baseDir?: string; cacheDir?: string; clipIds?: string[]; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<ClipPointTrack[]> {
  const spec = project.tracks[trackId];
  if (!spec) throw new Error(`No track "${trackId}"; make one with track_points`);
  const clips = computeTimeline(project).clips.filter((tc) => tc.asset.id === spec.assetId && (!opts.clipIds || opts.clipIds.includes(tc.clip.id)));
  if (!clips.length) throw new Error(`No primary clip shows ${spec.assetId}, the video "${trackId}" was marked in`);
  const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "tracks");
  await mkdir(dir, { recursive: true });
  const out: ClipPointTrack[] = [];
  for (const [i, tc] of clips.entries()) {
    if (tc.asset.type !== "video") continue;
    const src = /^[a-z]+:\/\//i.test(tc.asset.src) ? tc.asset.src : path.resolve(opts.baseDir ?? process.cwd(), tc.asset.src);
    const fastest = tc.clip.keyframes?.speed?.length ? Math.max(...tc.clip.keyframes.speed.map((k) => k.value)) : tc.clip.speed;
    const fps = Math.min(60, Math.max(1, Math.round(project.settings.fps * fastest)));
    const range = { start: tc.clip.in, end: tc.clip.in + tc.sourceDuration };
    const cached = await pointTrackFile(dir, src, range, fps, spec);
    let track: PointTrack;
    if (cached.exists) track = JSON.parse(await readFile(cached.file, "utf8")) as PointTrack;
    else {
      track = await trackPoints(src, { ...range, fps, spec, ffmpegPath: opts.ffmpegPath, signal: opts.signal });
      const part = `${cached.file}.${process.pid}.part`;
      await writeFile(part, JSON.stringify(track));
      await rename(part, cached.file);
    }
    out.push({ clipId: tc.clip.id, track });
    opts.onProgress?.((i + 1) / clips.length);
  }
  return out;
}

/** The track's corners (source fractions) at source time `s`, between the nearest frames, or undefined outside the track. */
export function trackCornersAt(track: PointTrack, s: number): { corners: Corners; confidence: number } | undefined {
  const f = (s - track.start) * track.fps;
  const n = track.corners.length;
  if (f < -0.5 || f > n - 0.5) return undefined;
  const a = Math.min(n - 1, Math.max(0, Math.floor(f)));
  const b = Math.min(n - 1, a + 1);
  const u = Math.min(1, Math.max(0, f - a));
  const [qa, qb] = [quadOf(track.corners[a]!), quadOf(track.corners[b]!)];
  const q = qa.map(([x, y], c): [number, number] => [x + (qb[c]![0] - x) * u, y + (qb[c]![1] - y) * u]);
  return { corners: cornersOf(q), confidence: Math.min(track.confidence[a]!, track.confidence[b]!) };
}

/** A point in source fractions in the edit's frame, through a clip's fit and crop focus at that moment (no rounding). */
export function sourcePointToFrame(p: Position, source: { width: number; height: number }, out: { width: number; height: number }, tc: TimedClip, t: number): Position {
  const focusKeys = tc.clip.keyframes?.focus;
  const focus = focusKeys?.length ? positionAt(focusKeys, t - tc.start) : tc.clip.focus;
  const m = fitTransform(source, out, tc.clip.fit, focus);
  return { x: m.ox + p.x * m.sx, y: m.oy + p.y * m.sy };
}

/** The inverse of sourcePointToFrame. */
export function framePointToSource(p: Position, source: { width: number; height: number }, out: { width: number; height: number }, tc: TimedClip, t: number): Position {
  const focusKeys = tc.clip.keyframes?.focus;
  const focus = focusKeys?.length ? positionAt(focusKeys, t - tc.start) : tc.clip.focus;
  const m = fitTransform(source, out, tc.clip.fit, focus);
  return { x: (p.x - m.ox) / m.sx, y: (p.y - m.oy) / m.sy };
}

/**
 * Where the tracked corners are in the edit's frame at timeline time `t`, from the clip tracks of
 * trackPointsInClips, or undefined when no tracked clip plays then. Effects that move the picture
 * (zooms, shakes) are not followed.
 */
export function trackSampler(project: Project, tracks: ClipPointTrack[]): (t: number) => { corners: Corners; confidence: number; clipId: string } | undefined {
  const tl = computeTimeline(project);
  const out = project.settings;
  const timed = tracks.flatMap((ct) => {
    const tc = tl.clips.find((c) => c.clip.id === ct.clipId);
    return tc ? [{ tc, track: ct.track }] : [];
  });
  return (t) => {
    const hit = timed.find(({ tc }) => t >= tc.start - 1e-6 && t < tc.end);
    if (!hit) return undefined;
    const at = trackCornersAt(hit.track, timelineToSource(hit.tc, t));
    if (!at) return undefined;
    const q = quadOf(at.corners).map(([x, y]) => sourcePointToFrame({ x, y }, hit.track.source, out, hit.tc, t));
    return { corners: cornersOf(q.map((p) => [p.x, p.y])), confidence: at.confidence, clipId: hit.tc.clip.id };
  };
}

/**
 * An image of a track's corners drawn in blue over chosen frames of its source (frame numbers of the
 * track), side by side, at tracking size.
 */
export async function writeCornersPreview(src: string, track: PointTrack, frames: number[], file: string, opts: FfmpegOptions = {}): Promise<void> {
  const k = Math.min(1, 480 / Math.max(track.source.width, track.source.height));
  const size = { w: Math.round((track.source.width * k) / 2) * 2, h: Math.round((track.source.height * k) / 2) * 2 };
  const n = track.corners.length;
  const picks = [...new Set(frames.map((f) => Math.min(n - 1, Math.max(0, Math.round(f)))))].sort((a, b) => a - b);
  const rgb = await decodeFrames(src, { start: track.start, end: track.start + (n + 1) / track.fps }, track.fps, size, "rgb24", opts, picks);
  if (!rgb.length) throw new Error(`Could not read frames ${picks.join(", ")} of the track`);
  const gap = 4;
  const W = rgb.length * size.w + (rgb.length - 1) * gap;
  const img = Buffer.alloc(W * size.h * 3, 20);
  rgb.forEach((frame, t) => {
    const ox = t * (size.w + gap);
    for (let y = 0; y < size.h; y++) frame.subarray(y * size.w * 3, (y + 1) * size.w * 3).forEach((v, i) => (img[(y * W + ox) * 3 + i] = v));
    const dot = (x: number, y: number) => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const [px, py] = [Math.round(x) + dx, Math.round(y) + dy];
          if (px < 0 || py < 0 || px >= size.w || py >= size.h) continue;
          const o = (py * W + ox + px) * 3;
          [img[o], img[o + 1], img[o + 2]] = [59, 130, 246];
        }
    };
    const q = quadOf(track.corners[picks[t]!]!, size.w, size.h);
    for (let c = 0; c < 4; c++) {
      const [a, b] = [q[c]!, q[(c + 1) % 4]!];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let s = 0; s <= steps; s++) dot(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps);
    }
  });
  await mkdir(path.dirname(file), { recursive: true });
  const raw = `${file}.${process.pid}.rgb`;
  await writeFile(raw, img);
  try {
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${size.h}`, "-i", raw, "-frames:v", "1", file], opts);
  } finally {
    await rm(raw, { force: true });
  }
}
