import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TimedClip } from "../../core/timeline.js";
import { round3 } from "../../core/util.js";
import { probe, resolveFfmpegPath, type FfmpegOptions } from "../render/ffmpeg.js";
import { SEGMENT_CODEC } from "../render/compile.js";
import { createOrtSession, ensureModelFile, loadOrt, modelsDir, ortProviders, type Ort, type OrtSession } from "../vision/faces.js";
import { streamFrames } from "../vision/objects.js";
import { fitSize } from "../vision/removal.js";
import { colorMatrixOf } from "../../library/color/spaces.js";

/**
 * Smooth slow motion and frame rate conversion (docs/design/cinematic-grade-and-vfx.md, section
 * 7.3). Where a clip shows more frames than its footage has (slowed down, ramped, or a 24 fps
 * source in a 60 fps edit), the frames in between are made by RIFE 4.9 (MIT, 21 MB), which beat
 * FFmpeg's minterpolate on six project clips (see the slow motion guide). Only the frames the edit
 * shows are made: each output frame's source time comes from the clip's time map, a real frame is
 * used where one is there, and the model makes the rest at the right fraction between its two
 * neighbors. The result is the clip's retimed picture, cached per clip like masks, which the
 * renderer reads in place of the source.
 */

export const INTERPOLATE_MODEL = { url: "https://huggingface.co/FuryTMP/RIFE_v4.9/resolve/main/rife_v4.9.onnx", file: "rife-v4.9.onnx", minBytes: 20_000_000 };
/** Bump when the frames for the same input would come out differently. */
export const INTERPOLATE_VERSION = 2;
/** Long side of interpolated pictures (the source's own size when smaller). */
export const INTERPOLATE_SIZE = 1920;
/** A frame this near a real one (in frames) is the real one. */
const SNAP = 0.05;
/** Mean difference (levels) above which two neighbors are a cut, not motion: no frames are made across it. */
const CUT_LEVELS = 40;

export interface InterpolateOptions extends FfmpegOptions {
  modelsDir?: string;
  onDownload?: (progress: number) => void;
}

/** Makes the frame at fraction `t` (0..1) between two RGB frames. */
export interface Interpolating {
  between(a: Uint8Array, b: Uint8Array, width: number, height: number, t: number): Promise<Uint8Array>;
}

const sessions = new Map<string, Promise<{ ort: Ort; session: OrtSession }>>();

/** RIFE 4.9 through ONNX Runtime, on the provider measured best for it on this computer. */
export class Interpolator implements Interpolating {
  constructor(private readonly options: InterpolateOptions = {}) {}

  private load() {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async () => {
        const ort = await loadOrt("Smooth slow motion");
        const file = await ensureModelFile(this.options, "interpolate", INTERPOLATE_MODEL);
        // One session: frames come one after another, and the graphics card is several times faster
        // here (0.5 against 3 s a frame at 960 x 544 on the reference laptop), so it is measured first.
        return { ort, session: await createOrtSession(ort, file, ortProviders()) };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  async between(a: Uint8Array, b: Uint8Array, w: number, h: number, t: number): Promise<Uint8Array> {
    const { ort, session } = await this.load();
    // The model wants sides in multiples of 32: the frame is padded by repeating its edge.
    const [W, H] = [Math.ceil(w / 32) * 32, Math.ceil(h / 32) * 32];
    const n = W * H;
    const x = new Float32Array(7 * n);
    for (const [f, o] of [[a, 0], [b, 3]] as const)
      for (let y = 0; y < H; y++) {
        const row = Math.min(h - 1, y) * w;
        for (let xx = 0; xx < W; xx++) {
          const q = (row + Math.min(w - 1, xx)) * 3;
          for (let c = 0; c < 3; c++) x[(o + c) * n + y * W + xx] = f[q + c]! / 255;
        }
      }
    x.fill(t, 6 * n);
    const out = (await session.run({ input: new ort.Tensor("float32", x, [1, 7, H, W]) })).output!.data as Float32Array;
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) for (let c = 0; c < 3; c++) rgb[(y * w + xx) * 3 + c] = Math.round(Math.min(1, Math.max(0, out[c * n + y * W + xx]!)) * 255);
    return rgb;
  }
}

/**
 * The source time (seconds) of every frame a clip shows at `fps`, in source order (ascending; a
 * reversed clip shows them last to first). One frame more than the clip lasts, as the renderer may take it.
 */
export function clipFrameTimes(tc: Pick<TimedClip, "clip" | "duration" | "sourceDuration" | "speedMap">, fps: number): number[] {
  const count = Math.ceil(tc.duration * fps - 1e-6) + 1;
  const times = Array.from({ length: count }, (_, n) => {
    const u = Math.min(tc.duration, n / fps);
    const along = Math.min(tc.sourceDuration, tc.speedMap ? tc.speedMap.toSource(u) : u * tc.clip.speed);
    return tc.clip.in + (tc.clip.reverse ? tc.sourceDuration - along : along);
  });
  return tc.clip.reverse ? times.reverse() : times;
}

/** For each time, the source frame before it (by number) and how far toward the next it is (0 = the frame itself). */
export function framePlan(times: number[], sourceFps: number): { frame: number; t: number }[] {
  return times.map((s) => {
    const p = s * sourceFps;
    let frame = Math.floor(p + 1e-6);
    let t = p - frame;
    if (t < SNAP) t = 0;
    else if (t > 1 - SNAP) [frame, t] = [frame + 1, 0];
    return { frame, t: round3(t) };
  });
}

/** Whether a clip shows frames its footage does not have, so interpolation would make some. */
export const needsFrames = (plan: { t: number }[]) => plan.some((p) => p.t > 0);

/**
 * How two neighbors differ: the mean absolute difference (levels), and the share of pixels that
 * changed by more than compression noise (12 levels in a channel). A moving object can be a small
 * part of the frame, so "nothing moved" is judged by the share, a cut by the mean.
 */
function difference(a: Uint8Array, b: Uint8Array): { mean: number; changed: number } {
  let [s, changed] = [0, 0];
  for (let q = 0; q < a.length; q += 3) {
    const d = Math.max(Math.abs(a[q]! - b[q]!), Math.abs(a[q + 1]! - b[q + 1]!), Math.abs(a[q + 2]! - b[q + 2]!));
    s += Math.abs(a[q]! - b[q]!) + Math.abs(a[q + 1]! - b[q + 1]!) + Math.abs(a[q + 2]! - b[q + 2]!);
    if (d > 12) changed++;
  }
  const n = Math.max(1, a.length / 3);
  return { mean: s / (3 * n), changed: changed / n };
}

export interface InterpolateTrack {
  fps: number;
  width: number;
  height: number;
  sourceFps: number;
  /** Frames written, made by the model, and held at a cut or between identical frames instead. */
  frames: number;
  made: number;
  held: number;
}

/**
 * Write the frames at source `times` (ascending) as a video at `fps` (frame after frame, at the
 * render cache's intermediate quality), real frames where they are and the model's in between.
 */
export async function writeInterpolated(
  src: string,
  output: { file: string; track: string },
  opts: InterpolateOptions & { times: number[]; fps: number; interpolator?: Interpolating; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<InterpolateTrack> {
  const info = await probe(src, opts);
  if (!info.width || !info.height || !info.fps) throw new Error(`Could not read the picture size and frame rate of ${src}`);
  const size = fitSize(info.width, info.height, INTERPOLATE_SIZE);
  const plan = framePlan(opts.times, info.fps);
  const first = Math.max(0, plan[0]?.frame ?? 0);
  const last = Math.max(first, ...plan.map((p) => p.frame + (p.t > 0 ? 1 : 0)));
  const interpolator = opts.interpolator ?? new Interpolator(opts);
  const track: InterpolateTrack = { fps: opts.fps, width: size.w, height: size.h, sourceFps: info.fps, frames: 0, made: 0, held: 0 };

  await mkdir(path.dirname(output.file), { recursive: true });
  const part = `${output.file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
  const enc = spawn(
    resolveFfmpegPath(opts),
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${size.w}x${size.h}`, "-r", String(opts.fps), "-i", "-", ...SEGMENT_CODEC, part],
    { windowsHide: true, signal: opts.signal },
  );
  let err = "";
  enc.stderr.on("data", (d: Buffer) => (err += d.toString()).length > 20_000 && (err = err.slice(-10_000)));
  const closed = new Promise<void>((resolve, reject) => {
    enc.on("error", reject);
    enc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (writing interpolated frames) failed: ${err.trim().split("\n").pop()}`))));
  });
  const write = async (px: Uint8Array) => {
    if (!enc.stdin.write(px)) await new Promise((r) => enc.stdin.once("drain", r));
    track.frames++;
  };
  const frames = streamFrames(src, { start: first / info.fps, end: (last + 1) / info.fps }, info.fps, size, "rgb24", { ...opts, colorMatrix: colorMatrixOf(info) });
  // The two source frames around the current time, numbers `at` and `at + 1`.
  let previous: Uint8Array | undefined;
  const read = async () => {
    const r = await frames.next();
    // Past the end of the video its last frame holds.
    previous = r.done ? (previous ?? new Uint8Array(size.w * size.h * 3)) : r.value;
    return previous;
  };
  try {
    const pair = [await read(), await read()];
    let at = first;
    for (const [k, p] of plan.entries()) {
      opts.signal?.throwIfAborted();
      for (; at < p.frame; at++) pair.splice(0, 2, pair[1]!, await read());
      const [a, b] = [pair[0]!, pair[1]!];
      if (p.t === 0) await write(a);
      else {
        const d = difference(a, b);
        if (d.changed < 0.0005 || d.mean > CUT_LEVELS) {
          // Identical neighbors have nothing to make; a cut must not be blended across.
          await write(p.t < 0.5 ? a : b);
          track.held++;
        } else {
          await write(await interpolator.between(a, b, size.w, size.h, p.t));
          track.made++;
        }
      }
      opts.onProgress?.((k + 1) / plan.length);
    }
    enc.stdin.end();
    await closed;
    await rename(part, output.file);
    await writeFile(output.track, JSON.stringify(track));
    return track;
  } catch (e) {
    enc.kill();
    throw e;
  } finally {
    await frames.return(undefined);
    await rm(part, { force: true });
  }
}

/** The cache files (picture and track) of a clip's interpolated frames. */
export async function interpolatedFile(dir: string, file: string, times: number[], fps: number): Promise<{ file: string; track: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const key = JSON.stringify({ v: INTERPOLATE_VERSION, kind: "interpolate", model: INTERPOLATE_MODEL.file, file, bytes: st?.size, mtime: st?.mtimeMs, fps, times: createHash("sha256").update(times.map((t) => t.toFixed(5)).join(",")).digest("hex") });
  const base = path.join(dir, `interpolate-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  return { file: `${base}.mkv`, track: `${base}.json`, exists: await stat(`${base}.mkv`).then((s) => s.size > 0, () => false) };
}
