import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import type { RemovalRegion, RemovalSpec } from "../../library/effects/removal.js";
import { probe, type FfmpegOptions } from "../render/ffmpeg.js";
import { writeAlphaVideo } from "../graphics/index.js";
import { controlled, native } from "../native/index.js";
import { createOrtSession, ensureModelFile, loadOrt, modelsDir, ortProviders, type Ort, type OrtSession } from "./faces.js";
import { decodeFrames, streamFrames } from "./objects.js";
import { TRACK_SIZE } from "./points.js";

/**
 * Object removal (docs/design/cinematic-grade-and-vfx.md, section 7.2): the area under tracked
 * objects or fixed regions, filled with what is behind them, as a video with transparency per clip
 * range that the removeObject effect lays over the picture.
 *
 * The Rust Remover fills each frame from a pool of frames spread over the range, moved by the
 * camera's motion (tracked here on the background, as a homography per frame): exact copies and
 * the median of the whole pool on a locked-off shot, the median of the nearest frames with matched
 * exposure on a moving one. What no frame shows goes to LaMa (big-lama, Apache-2.0, 208 MB, fixed
 * 512 x 512 input), which won against MI-GAN on seven project frames (see the removal guide). It
 * takes about 8 s a frame on a laptop CPU, so it runs only where something is left, and each result
 * becomes a layer later frames take from: an object that never moves on a still shot costs one
 * model run, and generated detail does not change from frame to frame.
 */

export const INPAINT_MODEL = { url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx", file: "lama-fp32.onnx", minBytes: 200_000_000 };
/** The model's fixed input size. */
export const INPAINT_SIZE = 512;
/** Bump when a removal for the same input would come out differently. */
export const REMOVAL_VERSION = 1;
/** Long side of removal fills (the source's own size when smaller). */
export const REMOVAL_SIZE = 1920;
/** Pool frames per second of the range, and their bounds (memory: about 8 MB a frame at 1080p). */
const POOL_PER_SECOND = 3;
const POOL_MIN = 8;
const POOL_MAX = 48;
const POOL_BYTES = 320e6;
/** Masks are read this many seconds at a time. */
const MASK_SECONDS = 2;
/** Seconds of gray frames tracked at a time for the camera's motion. */
const MOTION_SECONDS = 8;
/** A camera whose frame corners stay within this many pixels on 9 frames in 10 is locked off. */
const LOCKED_PX = 1;

export interface RemovalOptions extends FfmpegOptions {
  modelsDir?: string;
  onDownload?: (progress: number) => void;
}

/** Fills a hole in an RGB frame (1 in `hole` = fill): the frame back, filled. */
export interface Inpainting {
  inpaint(rgb: Uint8Array, width: number, height: number, hole: Uint8Array): Promise<Uint8Array>;
}

interface InpaintSession {
  ort: Ort;
  session: OrtSession;
}

const sessions = new Map<string, Promise<InpaintSession>>();

const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));

/** A picture of `width` x `height` fitted to `long` on its long side (never enlarged). */
export function fitSize(width: number, height: number, long: number): { w: number; h: number } {
  const k = Math.min(1, long / Math.max(width, height));
  return { w: even(width * k), h: even(height * k) };
}

/**
 * The crop the model sees around a hole: its bounding box, 2.5 times as large (context for the
 * model) and at least 256 pixels, inside the frame. Undefined when the hole is empty.
 */
export function inpaintCrop(hole: Uint8Array, w: number, h: number): { x: number; y: number; cw: number; ch: number } | undefined {
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let k = 0; k < w * h; k++) {
    if (!hole[k]) continue;
    const [x, y] = [k % w, Math.floor(k / w)];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return undefined;
  const side = Math.max(256, Math.max(x1 - x0 + 1, y1 - y0 + 1) * 2.5 + 32);
  const cw = Math.min(w, Math.round(side));
  const ch = Math.min(h, Math.round(side));
  const x = Math.round(Math.min(w - cw, Math.max(0, (x0 + x1) / 2 - cw / 2)));
  const y = Math.round(Math.min(h - ch, Math.max(0, (y0 + y1) / 2 - ch / 2)));
  return { x, y, cw, ch };
}

/** LaMa inpainting of holes in RGB frames. One model session per models folder. */
export class Inpainter implements Inpainting {
  constructor(private readonly options: RemovalOptions = {}) {}

  private load() {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async (): Promise<InpaintSession> => {
        const ort = await loadOrt("Removing objects");
        const file = await ensureModelFile(this.options, "inpaint", INPAINT_MODEL);
        // One session, on the provider measured best for this model on this computer (the first use
        // measures it). Unlike depth, no CPU session starts first: a model run is rare, and loading
        // the 208 MB model twice costs more than a run (about 20 s each on the reference laptop).
        const session = await createOrtSession(ort, file, ortProviders());
        return { ort, session };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  async inpaint(rgb: Uint8Array, w: number, h: number, hole: Uint8Array): Promise<Uint8Array> {
    const crop = inpaintCrop(hole, w, h);
    if (!crop) return rgb;
    const { ort, session } = await this.load();
    const S = INPAINT_SIZE;
    const n = S * S;
    const [kx, ky] = [crop.cw / S, crop.ch / S];
    const image = new Float32Array(3 * n);
    const mask = new Float32Array(n);
    for (let y = 0; y < S; y++) {
      // Each model pixel covers a footprint of the crop: it is a hole if any pixel there is.
      const [fy0, fy1] = [crop.y + Math.floor(y * ky), crop.y + Math.max(Math.floor(y * ky) + 1, Math.ceil((y + 1) * ky))];
      const sy = Math.min(h - 1, Math.max(0, crop.y + (y + 0.5) * ky - 0.5));
      for (let x = 0; x < S; x++) {
        const [fx0, fx1] = [crop.x + Math.floor(x * kx), crop.x + Math.max(Math.floor(x * kx) + 1, Math.ceil((x + 1) * kx))];
        let m = 0;
        for (let yy = fy0; yy < Math.min(h, fy1) && !m; yy++) for (let xx = fx0; xx < Math.min(w, fx1); xx++) if (hole[yy * w + xx]) { m = 1; break; }
        const i = y * S + x;
        mask[i] = m;
        if (m) continue;
        const sx = Math.min(w - 1, Math.max(0, crop.x + (x + 0.5) * kx - 0.5));
        for (let c = 0; c < 3; c++) image[c * n + i] = bilinear(rgb, w, h, sx, sy, c, 3) / 255;
      }
    }
    const out = await session.run({ image: new ort.Tensor("float32", image, [1, 3, S, S]), mask: new ort.Tensor("float32", mask, [1, 1, S, S]) });
    const o = out.output!.data as Float32Array;
    const res = Uint8Array.from(rgb);
    for (let y = crop.y; y < crop.y + crop.ch; y++) {
      for (let x = crop.x; x < crop.x + crop.cw; x++) {
        const k = y * w + x;
        if (!hole[k]) continue;
        const [u, v] = [Math.min(S - 1, Math.max(0, (x - crop.x + 0.5) / kx - 0.5)), Math.min(S - 1, Math.max(0, (y - crop.y + 0.5) / ky - 0.5))];
        for (let c = 0; c < 3; c++) res[k * 3 + c] = Math.round(Math.min(255, Math.max(0, bilinearPlanar(o, S, S, u, v, c))));
      }
    }
    return res;
  }
}

function bilinear(px: Uint8Array, w: number, h: number, x: number, y: number, c: number, channels: number): number {
  const [x0, y0] = [Math.floor(x), Math.floor(y)];
  const [x1, y1] = [Math.min(w - 1, x0 + 1), Math.min(h - 1, y0 + 1)];
  const [fx, fy] = [x - x0, y - y0];
  const at = (xx: number, yy: number) => px[(yy * w + xx) * channels + c]!;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

function bilinearPlanar(px: Float32Array, w: number, h: number, x: number, y: number, c: number): number {
  const [x0, y0] = [Math.floor(x), Math.floor(y)];
  const [x1, y1] = [Math.min(w - 1, x0 + 1), Math.min(h - 1, y0 + 1)];
  const [fx, fy] = [x - x0, y - y0];
  const at = (xx: number, yy: number) => px[c * w * h + yy * w + xx]!;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

/** Masks (0..255) of the area to remove on frames of the range (frame numbers from its start), at a size. */
export type RemovalMasks = (frames: number[], size: { w: number; h: number }) => Promise<Uint8Array[]>;

/** A fixed region drawn at a size: 255 inside. */
export function drawRegion(r: RemovalRegion, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const [x0, x1] = [Math.min(r.x0, r.x1) * w, Math.max(r.x0, r.x1) * w];
  const [y0, y1] = [Math.min(r.y0, r.y1) * h, Math.max(r.y0, r.y1) * h];
  const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, (x1 - x0) / 2), Math.max(0.5, (y1 - y0) / 2)];
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
      const [px, py] = [x + 0.5, y + 0.5];
      const inside = r.shape === "ellipse" ? ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 : px >= x0 && px <= x1 && py >= y0 && py <= y1;
      if (inside) out[y * w + x] = 255;
    }
  }
  return out;
}

/**
 * The masks of a removal: its fixed regions, and its objects' mask videos (from writeObjectMask,
 * at the range's fps from its start), joined.
 */
export function removalMasks(regions: RemovalRegion[], objectFiles: string[], fps: number, opts: FfmpegOptions = {}): RemovalMasks {
  const drawn = new Map<string, Uint8Array>();
  return async (frames, size) => {
    const key = `${size.w}x${size.h}`;
    let fixed = drawn.get(key);
    if (!fixed) {
      fixed = new Uint8Array(size.w * size.h);
      for (const r of regions) {
        const m = drawRegion(r, size.w, size.h);
        for (let k = 0; k < m.length; k++) if (m[k]! > fixed[k]!) fixed[k] = m[k]!;
      }
      drawn.set(key, fixed);
    }
    const out = frames.map(() => Uint8Array.from(fixed));
    if (!frames.length) return out;
    const [lo, hi] = [Math.min(...frames), Math.max(...frames)];
    const contiguous = frames.every((f, i) => f === lo + i);
    for (const file of objectFiles) {
      // A run of frames is read from its start; scattered frames are picked out of one pass.
      const got = contiguous
        ? await decodeFrames(file, { start: lo / fps, end: (hi + 1) / fps }, fps, size, "gray", opts)
        : await decodeFrames(file, { start: 0, end: (hi + 1) / fps }, fps, size, "gray", opts, [...new Set(frames)].sort((a, b) => a - b));
      const sorted = contiguous ? frames : [...new Set(frames)].sort((a, b) => a - b);
      frames.forEach((f, i) => {
        // Past the mask video's end (it can be a frame shorter), its last frame holds.
        const m = got[Math.min(got.length - 1, sorted.indexOf(f))];
        if (!m) return;
        const o = out[i]!;
        for (let k = 0; k < o.length; k++) if (m[k]! > o[k]!) o[k] = m[k]!;
      });
    }
    return out;
  };
}

export interface RemovalTrack {
  fps: number;
  /** Source seconds of the first frame. */
  start: number;
  width: number;
  height: number;
  /** The camera did not move (fills are exact copies, the same on every frame). */
  locked: boolean;
  /** How far the camera moved the frame's corners at most over the range, pixels at width x height. */
  moved: number;
  /** Per frame: the area removed (fraction of the frame), and the shares of it filled from real frames and generated by the model. */
  area: number[];
  real: number[];
  generated: number[];
  /** Frames the inpainting model ran on. */
  inpainted: number[];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const m = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[r * 3 + c]! += a[r * 3 + k]! * b[k * 3 + c]!;
  return m;
}

/** The farthest a transform moves a w x h frame's corners. */
function cornerShift(m: ArrayLike<number>, w: number, h: number): number {
  let most = 0;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]] as const) {
    const d = m[6]! * x + m[7]! * y + m[8]!;
    most = Math.max(most, Math.hypot((m[0]! * x + m[1]! * y + m[2]!) / d - x, (m[3]! * x + m[4]! * y + m[5]!) / d - y));
  }
  return most;
}

/**
 * The camera's motion over the range: per frame, the transform from frame 0's pixels to that
 * frame's, at `size`, tracked on the background (away from the masks) as a homography. Where
 * tracking is lost, the last transform holds.
 */
async function cameraMotion(src: string, range: { from: number; total: number; fps: number }, size: { w: number; h: number }, masks: RemovalMasks, opts: FfmpegOptions & { signal?: AbortSignal }): Promise<Float64Array> {
  const { from, total, fps } = range;
  const ts = fitSize(size.w, size.h, TRACK_SIZE);
  const [sx, sy] = [size.w / ts.w, size.h / ts.h];
  const area = ts.w * ts.h;
  const out = new Float64Array(total * 9);
  const chunk = Math.max(2, Math.round(fps * MOTION_SECONDS));
  let base = IDENTITY;
  let prev: Uint8Array | undefined;
  const stream = streamFrames(src, { start: from, end: from + total / fps }, fps, ts, "gray", opts);
  for (let c0 = 0; c0 < total; c0 += chunk) {
    opts.signal?.throwIfAborted();
    const c1 = Math.min(total, c0 + chunk);
    const got: Uint8Array[] = [];
    while (got.length < c1 - c0) {
      const r = await stream.next();
      // A range can run a frame past the end of its video: its last frame holds.
      got.push(r.done ? (got[got.length - 1] ?? prev ?? new Uint8Array(area)) : r.value);
    }
    // The chunk is tracked from the last frame of the one before, so the two join.
    const frames = prev ? [prev, ...got] : got;
    const [mask] = await masks([prev ? c0 - 1 : c0], ts);
    const region = Uint8Array.from(mask!, (v) => (v >= 128 ? 0 : 1));
    const packed = new Uint8Array(frames.length * area);
    frames.forEach((g, i) => packed.set(g, i * area));
    const cam = frames.length > 1 ? await controlled({ signal: opts.signal }, (c) => native().trackRegion(packed, ts.w, ts.h, frames.length, region, { model: "homography" }, c)) : undefined;
    let last = IDENTITY;
    for (let i = prev ? 1 : 0; i < frames.length; i++) {
      const ok = cam && Number.isFinite(cam.errors[i]!) && cam.inliers[i]! > 0;
      if (ok) last = Array.from(cam.matrices.subarray(i * 9, i * 9 + 9));
      const g = mul(last, base);
      // At the fill's size: S * g * S^-1.
      const s = [g[0]!, (g[1]! * sx) / sy, g[2]! * sx, (g[3]! * sy) / sx, g[4]!, g[5]! * sy, g[6]! / sx, g[7]! / sy, g[8]!];
      out.set(s, (c0 + i - (prev ? 1 : 0)) * 9);
    }
    base = mul(last, base);
    prev = got[got.length - 1];
  }
  await stream.return(undefined);
  return out;
}

/**
 * The fill of a removal over a source range, one RGBA frame (straight alpha, see fitSize for the
 * size) per frame at `fps`, then what was measured.
 */
export async function* removalFrames(
  src: string,
  opts: RemovalOptions & {
    start: number;
    end: number;
    fps: number;
    masks: RemovalMasks;
    /** Grow and feather as fractions of the frame's short side (RemovalSpec). */
    grow: number;
    feather: number;
    inpainter?: Inpainting;
    onProgress?: (p: number) => void;
    signal?: AbortSignal;
  },
): AsyncGenerator<Uint8Array, RemovalTrack> {
  const info = await probe(src, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${src}`);
  const size = fitSize(info.width, info.height, REMOVAL_SIZE);
  const { w, h } = size;
  const still = info.isImage || info.duration === undefined;
  const from = still ? 0 : Math.max(0, opts.start);
  const to = still ? 0.04 : Math.min(info.duration!, Math.max(opts.end, from + 1 / opts.fps));
  const total = still ? 1 : Math.max(1, Math.ceil((to - from) * opts.fps - 1e-6));
  const range = { start: from, end: from + total / opts.fps };
  const k = native();
  const short = Math.min(w, h);

  // The camera's motion, and whether it moved at all.
  opts.onProgress?.(0.01);
  let motion = total > 1 ? await cameraMotion(src, { from, total, fps: opts.fps }, size, opts.masks, opts) : Float64Array.from(IDENTITY);
  const shifts = Array.from({ length: total }, (_, f) => cornerShift(motion.subarray(f * 9, f * 9 + 9), w, h)).sort((a, b) => a - b);
  const moved = shifts[total - 1]!;
  // A few frames of tracking noise (hands moving, compression) do not make a tripod shot move.
  const locked = shifts[Math.floor((total - 1) * 0.9)]! < LOCKED_PX;
  if (locked) motion = Float64Array.from({ length: total * 9 }, (_, i) => IDENTITY[i % 9]!);
  opts.onProgress?.(0.1);

  // The pool: frames spread evenly over the range.
  const poolSize = Math.max(1, Math.min(total, Math.floor(POOL_BYTES / (w * h * 4)), Math.max(POOL_MIN, Math.min(POOL_MAX, Math.round((total / opts.fps) * POOL_PER_SECOND)))));
  const pool = [...new Set(Array.from({ length: poolSize }, (_, i) => Math.round(((i + 0.5) * total) / poolSize - 0.5)))];
  const remover = new k.Remover(w, h, motion, {
    grow: opts.grow * short,
    feather: opts.feather * short,
    ring: Math.max(6, 0.012 * short),
    locked,
  });
  const poolRgb = still ? await decodeFrames(src, range, opts.fps, size, "rgb24", opts) : await decodeFrames(src, range, opts.fps, size, "rgb24", opts, pool);
  const poolMasks = await opts.masks(pool, size);
  for (const [i, f] of pool.entries()) {
    const rgb = poolRgb[Math.min(i, poolRgb.length - 1)];
    if (rgb) await remover.addFrame(f, rgb, poolMasks[i]!);
  }
  opts.onProgress?.(0.2);

  const inpainter = opts.inpainter ?? new Inpainter(opts);
  const track: RemovalTrack = { fps: opts.fps, start: round3(from), width: w, height: h, locked, moved: round3(moved), area: [], real: [], generated: [], inpainted: [] };
  // Frames come from one decode; masks are read a few seconds at a time.
  const stream = still ? undefined : streamFrames(src, range, opts.fps, size, "rgb24", opts);
  const step = Math.max(1, Math.round(opts.fps * MASK_SECONDS));
  let [masks, m0] = [[] as Uint8Array[], 0];
  let last: Uint8Array | undefined;
  try {
    for (let f = 0; f < total; f++) {
      opts.signal?.throwIfAborted();
      const next = stream ? await stream.next() : { done: false as const, value: poolRgb[0]! };
      // A clip can run a frame past the end of its video: its last frame holds.
      const rgb = next.done ? (last ?? new Uint8Array(w * h * 3)) : next.value;
      last = rgb;
      if (f - m0 >= masks.length) [masks, m0] = [await opts.masks(Array.from({ length: Math.min(step, total - f) }, (_, i) => f + i), size), f];
      const mask = masks[f - m0]!;
      let fill = await remover.fill(f, rgb, mask);
      if (fill.left > 0) {
        // What nothing showed: the model fills it, on the frame as filled so far, and later frames take it from there.
        const known = Uint8Array.from(rgb);
        for (let q = 0; q < w * h; q++) if (fill.rgba[q * 4 + 3]! > 0 && !fill.residual[q]) known.set(fill.rgba.subarray(q * 4, q * 4 + 3), q * 3);
        const painted = await inpainter.inpaint(known, w, h, fill.residual);
        await remover.addLayer(f, painted, fill.residual);
        fill = await remover.fill(f, rgb, mask);
        track.inpainted.push(f);
      }
      const hole = Math.max(1, fill.hole);
      track.area.push(round3(fill.hole / (w * h)));
      track.real.push(round3(fill.real / hole));
      track.generated.push(round3(fill.hole ? (fill.layered + fill.left) / hole : 0));
      opts.onProgress?.(0.2 + (0.8 * (f + 1)) / total);
      yield fill.rgba;
    }
  } finally {
    await stream?.return(undefined);
  }
  return track;
}

/** The cache files (fill video and track) of a removal over a source range. `objects` are the removal's objects' prompts, by id. */
export async function removalFile(dir: string, file: string, range: { start: number; end: number }, fps: number, spec: RemovalSpec, objects: Record<string, unknown>): Promise<{ file: string; track: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const key = JSON.stringify({ v: REMOVAL_VERSION, kind: "removal", model: INPAINT_MODEL.file, file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps, spec, objects: spec.objects.map((id) => objects[id] ?? null) });
  const base = path.join(dir, `removal-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  return { file: `${base}.mkv`, track: `${base}.json`, exists: await stat(`${base}.mkv`).then((s) => s.size > 0, () => false) };
}

/** Prepare a removal over a source range and write its fill (FFV1 with transparency) and track (JSON). */
export async function writeRemoval(src: string, output: { file: string; track: string }, opts: Parameters<typeof removalFrames>[1]): Promise<RemovalTrack> {
  const info = await probe(src, opts);
  const size = fitSize(info.width ?? 2, info.height ?? 2, REMOVAL_SIZE);
  const frames = removalFrames(src, opts);
  let track: RemovalTrack | undefined;
  await mkdir(path.dirname(output.file), { recursive: true });
  await writeAlphaVideo(output.file, { ...opts, width: size.w, height: size.h, fps: opts.fps, what: "the object removal" }, async () => {
    const r = await frames.next();
    if (r.done) {
      track = r.value;
      return undefined;
    }
    return r.value;
  });
  if (!track) throw new Error(`The object removal of ${src} ended early`);
  const part = `${output.track}.${process.pid}.part`;
  await writeFile(part, JSON.stringify(track));
  await rename(part, output.track).catch(async (e) => {
    await rm(part, { force: true });
    throw e;
  });
  return track;
}
