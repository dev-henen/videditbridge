import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { probe, resolveFfmpegPath } from "../render/ffmpeg.js";
import { detectFacesCached } from "./clips.js";
import { FaceDetector, trackFaces, type Box, type FaceDetectorOptions, type FaceTrack } from "./faces.js";

/** Bump when the mask drawing changes, so cached masks are remade. */
const FACE_MASK_VERSION = 1;
/** Faces are found this many times a second; the ellipses move smoothly in between. */
const DETECT_FPS = 10;

/** Cache file for the face mask of a source range (keyed like the person cutout). */
export async function faceMaskFile(dir: string, file: string, range: { start: number; end: number }, fps: number): Promise<{ file: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const key = JSON.stringify({ v: FACE_MASK_VERSION, kind: "face", file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps });
  const out = path.join(dir, `face-${createHash("sha256").update(key).digest("hex").slice(0, 32)}.mkv`);
  return { file: out, exists: await stat(out).then((s) => s.size > 0, () => false) };
}

/** A track's face box at time t: interpolated between samples, or undefined outside the track (with a little slack). */
export function boxAt(track: FaceTrack, t: number, slack = 1 / DETECT_FPS): Box | undefined {
  const f = track.frames;
  if (!f.length || t < f[0]!.time - slack || t > f[f.length - 1]!.time + slack) return undefined;
  let k = f.findIndex((x) => x.time >= t);
  if (k === -1) return f[f.length - 1]!.face;
  if (k === 0) return f[0]!.face;
  const a = f[k - 1]!;
  const b = f[k]!;
  // Faces missed for a while (a turn of the head) hold their last place instead of sliding across.
  if (b.time - a.time > 0.6) return t - a.time < b.time - t ? a.face : b.face;
  const u = (t - a.time) / Math.max(1e-6, b.time - a.time);
  const mix = (p: number, q: number) => p + (q - p) * u;
  return { x0: mix(a.face.x0, b.face.x0), y0: mix(a.face.y0, b.face.y0), x1: mix(a.face.x1, b.face.x1), y1: mix(a.face.y1, b.face.y1) };
}

/** Paint soft-edged ellipses (1.5 times the face box, like faceRegion) into a gray frame. */
export function paintFaces(boxes: Box[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (const b of boxes) {
    const cx = ((b.x0 + b.x1) / 2) * w;
    const cy = ((b.y0 + b.y1) / 2) * h;
    const rx = Math.max(1, ((b.x1 - b.x0) * 1.5 * w) / 2);
    const ry = Math.max(1, ((b.y1 - b.y0) * 1.5 * h) / 2);
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
        // Full inside 80% of the radius, fading to nothing at the edge.
        const v = d <= 0.8 ? 255 : d >= 1 ? 0 : Math.round(255 * (1 - (d - 0.8) / 0.2));
        if (v > out[y * w + x]!) out[y * w + x] = v;
      }
  }
  return out;
}

/**
 * Write a gray video (255 = face) for a source range at `fps` frames a second of source time, at the
 * source's shape (long side 320): a soft ellipse over every face, following it. Same form as the
 * person cutout, so the renderer times and crops it like the picture.
 */
export async function writeFaceMask(
  file: string,
  output: string,
  opts: { start: number; end: number; fps: number; detector?: FaceDetector; signal?: AbortSignal } & FaceDetectorOptions,
): Promise<void> {
  const info = await probe(file, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${file}`);
  const k = 320 / Math.max(info.width, info.height);
  const mw = Math.max(2, Math.round((info.width * k) / 2) * 2);
  const mh = Math.max(2, Math.round((info.height * k) / 2) * 2);
  const detector = opts.detector ?? new FaceDetector(opts);
  const found = await detectFacesCached(detector, file, { start: opts.start, end: opts.end }, Math.min(opts.fps, DETECT_FPS));
  const tracks = trackFaces(found.frames);
  const frames = Math.max(1, Math.ceil((opts.end - opts.start) * opts.fps));
  const part = `${output}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
  await mkdir(path.dirname(output), { recursive: true });
  const enc = spawn(resolveFfmpegPath(opts), ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${mw}x${mh}`, "-r", String(opts.fps), "-i", "-", "-c:v", "ffv1", part], {
    windowsHide: true,
    signal: opts.signal,
  });
  let err = "";
  enc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const closed = new Promise<void>((resolve, reject) => {
    enc.on("error", reject);
    enc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (writing the face mask) failed for ${file}: ${err.trim().split("\n").pop()}`))));
  });
  try {
    for (let n = 0; n < frames; n++) {
      const t = opts.start + n / opts.fps;
      const boxes = tracks.flatMap((tr) => boxAt(tr, t) ?? []);
      if (!enc.stdin.write(paintFaces(boxes, mw, mh))) await new Promise((r) => enc.stdin.once("drain", r));
    }
    enc.stdin.end();
    await closed;
    await rename(part, output);
  } catch (e) {
    enc.kill();
    throw e;
  } finally {
    await rm(part, { force: true });
  }
}
