import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { probe, runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import { native } from "../native/index.js";
import { createOrtSession, ensureModelFile, loadOrt, modelsDir, ortProviders, type Ort, type OrtSession } from "./faces.js";
import { decodeFrames } from "./objects.js";
import { resizeMask } from "./segment.js";

/**
 * Depth of every frame (docs/design/cinematic-grade-and-vfx.md, section 7.1), for depth masks and
 * the depth effects (depthOfField, depthFog, parallax).
 *
 * The model is Depth Anything V2 Small (Apache-2.0, 99 MB; the Base, Large and Giant weights are
 * CC-BY-NC and must not be used), run with ONNX Runtime with the short side at 364 pixels. Compared
 * on eight project frames with Depth Anything V1 Small and DPT-Hybrid MiDaS (see the depth guide), it
 * has the cleanest edges by far (petals, twigs, a pen on a desk), at 1.5 s a frame on a laptop CPU.
 *
 * So it runs on keyframes (twice a second) and the Rust kernel depthSequence does the rest: each
 * keyframe is fitted to the one before (relative depth has its own scale and shift every frame),
 * depth is carried between keyframes along the camera's motion, edges are snapped to each frame, and
 * it is blended lightly over time. The result is distance on 0 (near) .. 1 (far), the first
 * keyframe's nearest and farthest things at 0.1 and 0.9 so later ones have room, stored as 16-bit
 * gray video per clip range.
 */

export const DEPTH_MODEL = { url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx", file: "depth-anything-v2-small.onnx", minBytes: 90_000_000 };
/** The model's input short side (a multiple of 14, its patch size). */
export const DEPTH_INPUT = 364;
/** Bump when depth for the same input would come out differently. */
export const DEPTH_VERSION = 2;
/** Long side of depth maps. */
export const DEPTH_SIZE = 512;
/** Seconds between keyframes the model looks at. */
const KEY_SECONDS = 0.5;
/** Frames are processed this many seconds at a time, to bound memory on long clips. */
const CHUNK_SECONDS = 8;
/** Model frames a job needs before the graphics card's session is worth creating. */
const GPU_WORTH_FRAMES = 30;

export interface DepthOptions extends FfmpegOptions {
  modelsDir?: string;
  onDownload?: (progress: number) => void;
}

interface DepthSession {
  ort: Ort;
  current(): OrtSession;
  speedUp(): void;
  input: string;
  output: string;
}

const sessions = new Map<string, Promise<DepthSession>>();

const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
const m14 = (v: number) => Math.max(14, 14 * Math.round(v / 14));

/** Size of a source's depth maps: DEPTH_SIZE on the long side. */
export function depthMapSize(width: number, height: number): { w: number; h: number } {
  const k = DEPTH_SIZE / Math.max(width, height);
  return { w: even(width * k), h: even(height * k) };
}

/** The model's input size for a picture shape. */
export function depthInputSize(width: number, height: number): { w: number; h: number } {
  return width >= height ? { w: m14((DEPTH_INPUT * width) / height), h: DEPTH_INPUT } : { w: DEPTH_INPUT, h: m14((DEPTH_INPUT * height) / width) };
}

/** Relative depth (disparity: larger is nearer) of single frames. One model session per models folder. */
export class DepthEstimator {
  constructor(private readonly options: DepthOptions = {}) {}

  private load() {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async (): Promise<DepthSession> => {
        const ort = await loadOrt("Estimating depth");
        const file = await ensureModelFile(this.options, "depth", DEPTH_MODEL);
        const cpu = await ort.InferenceSession.create(file, { logSeverityLevel: 3 });
        let fast: OrtSession | undefined;
        let started = false;
        const providers = ortProviders();
        // As for the sky model: the CPU starts at once, the graphics card takes over when its session is ready.
        const speedUp = () => {
          if (started || (providers !== "auto" && providers[0] === "cpu")) return;
          started = true;
          createOrtSession(ort, file, providers).then(
            (gpu) => (fast = gpu),
            () => undefined,
          );
        };
        const raw = cpu as unknown as { inputNames?: string[]; outputNames?: string[] };
        return { ort, current: () => fast ?? cpu, speedUp, input: raw.inputNames?.[0] ?? "pixel_values", output: raw.outputNames?.[0] ?? "predicted_depth" };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  /** Say how many frames a job will ask for, so a long one can move to the graphics card. */
  async expect(frames: number): Promise<void> {
    if (frames >= GPU_WORTH_FRAMES) (await this.load()).speedUp();
  }

  /** Disparity of an RGB frame already resized to `size` (see depthInputSize), at that size. */
  async disparity(rgb: Uint8Array, size: { w: number; h: number }): Promise<Float32Array> {
    const { ort, current, input, output } = await this.load();
    const n = size.w * size.h;
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = (rgb[i * 3 + c]! / 255 - mean[c]!) / std[c]!;
    const out = await current().run({ [input]: new ort.Tensor("float32", x, [1, 3, size.h, size.w]) });
    const o = out[output]!;
    const dims = (o as unknown as { dims: number[] }).dims;
    const [oh, ow] = [dims[dims.length - 2]!, dims[dims.length - 1]!];
    const d = Float32Array.from(o.data as Float32Array);
    return ow === size.w && oh === size.h ? d : resizeMask(d, ow, oh, size.w, size.h);
  }
}

export interface DepthTrack {
  fps: number;
  /** Source seconds of the first frame. */
  start: number;
  width: number;
  height: number;
  /** Frames the model looked at, from the first. */
  keyframes: number[];
  /** Distance of the nearest and farthest tenth of each frame (10th and 90th percentiles). */
  near: number[];
  far: number[];
}

/**
 * Depth over a source range, one map per frame at `fps`, written to `rawFile` as 16-bit gray
 * (little-endian, 0 near .. 65535 far) at depthMapSize. Returns what was measured.
 */
export async function trackDepth(
  src: string,
  rawFile: string,
  opts: DepthOptions & { start: number; end: number; fps: number; estimator?: DepthEstimator; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<DepthTrack> {
  const info = await probe(src, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${src}`);
  const ms = depthMapSize(info.width, info.height);
  const input = depthInputSize(info.width, info.height);
  const area = ms.w * ms.h;
  const still = info.isImage || info.duration === undefined;
  const from = still ? 0 : Math.max(0, opts.start);
  const to = still ? 0.04 : Math.min(info.duration!, Math.max(opts.end, from + 1 / opts.fps));
  const total = Math.max(1, Math.ceil((to - from) * opts.fps - 1e-6));
  const estimator = opts.estimator ?? new DepthEstimator(opts);
  const k = native();
  const step = Math.max(2, Math.round(opts.fps * KEY_SECONDS));
  await estimator.expect(Math.ceil(total / step) + 1);
  const chunk = Math.max(step, Math.round((opts.fps * CHUNK_SECONDS) / step) * step);
  const keyframes: number[] = [];
  const near: number[] = [];
  const far: number[] = [];
  await rm(rawFile, { force: true });
  await mkdir(path.dirname(rawFile), { recursive: true });
  // The last frame of one chunk is the first of the next, so it is estimated once and chunks join.
  let first: { gray: Uint8Array; depth: Float32Array; disparity: Float32Array } | undefined;
  const radius = Math.max(2, Math.round(Math.min(ms.w, ms.h) * 0.012));

  for (let c0 = 0; c0 < total; c0 += chunk) {
    opts.signal?.throwIfAborted();
    const c1 = Math.min(total, c0 + chunk + 1);
    const range = { start: from + c0 / opts.fps, end: from + c1 / opts.fps };
    const gray = (await decodeFrames(src, range, opts.fps, ms, "gray", opts)).slice(0, c1 - c0);
    const n = gray.length;
    if (!n) break;
    if (first) gray[0] = first.gray;
    const keys = [...new Set([...Array.from({ length: Math.ceil(n / step) }, (_, i) => i * step), n - 1])].filter((f) => f < n);
    const wanted = keys.filter((f) => !(f === 0 && first));
    const rgb = wanted.length ? await decodeFrames(src, range, opts.fps, input, "rgb24", opts, wanted) : [];
    const disparity = new Float32Array(keys.length * area);
    for (const [j, f] of keys.entries()) {
      if (f === 0 && first) {
        disparity.set(first.disparity, 0);
        continue;
      }
      const frame = rgb[wanted.indexOf(f)];
      if (!frame) throw new Error(`Could not read frame ${c0 + f} of ${src}`);
      const d = await estimator.disparity(frame, input);
      disparity.set(resizeMask(d, input.w, input.h, ms.w, ms.h), j * area);
      keyframes.push(c0 + f);
      opts.onProgress?.(Math.min(0.95, (c0 + f + 1) / total));
    }
    // The camera's motion over the chunk, from the whole picture; where it is lost, it holds.
    const packed = new Uint8Array(n * area);
    gray.forEach((g, i) => packed.set(g, i * area));
    const cam = n > 1 ? await k.trackRegion(packed, ms.w, ms.h, n, new Uint8Array(area).fill(1), { model: "affine" }) : undefined;
    const motion = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) {
      const ok = cam && Number.isFinite(cam.errors[i]!) && cam.inliers[i]! > 0;
      motion.set(ok ? cam.matrices.subarray(i * 9, i * 9 + 9) : i > 0 ? motion.subarray((i - 1) * 9, i * 9) : [1, 0, 0, 0, 1, 0, 0, 0, 1], i * 9);
    }
    const depth = await k.depthSequence(packed, ms.w, ms.h, n, Uint32Array.from(keys), disparity, motion, { radius, ...(first ? { previous: first.depth } : {}) });
    const startAt = first ? 1 : 0;
    const out = Buffer.alloc((n - startAt) * area * 2);
    const sample = new Float32Array(Math.ceil(area / 16));
    for (let i = startAt; i < n; i++) {
      const frame = depth.subarray(i * area, (i + 1) * area);
      for (let q = 0; q < area; q++) out.writeUInt16LE(Math.round(65535 * Math.min(1, Math.max(0, frame[q]!))), ((i - startAt) * area + q) * 2);
      for (let q = 0, s = 0; q < area; q += 16, s++) sample[s] = frame[q]!;
      const sorted = Float32Array.from(sample).sort();
      near.push(round3(Math.max(0, sorted[Math.floor(sorted.length * 0.1)]!)));
      far.push(round3(Math.min(1, sorted[Math.floor(sorted.length * 0.9)]!)));
    }
    await appendFile(rawFile, out);
    first = { gray: gray[n - 1]!, depth: depth.slice((n - 1) * area, n * area), disparity: disparity.slice((keys.length - 1) * area) };
    if (c1 >= total) break;
  }
  opts.onProgress?.(1);
  return { fps: opts.fps, start: round3(from), width: ms.w, height: ms.h, keyframes, near, far };
}

/** The cache files (depth video and track) of a source range. */
export async function depthFile(dir: string, file: string, range: { start: number; end: number }, fps: number): Promise<{ file: string; track: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const key = JSON.stringify({ v: DEPTH_VERSION, kind: "depth", model: DEPTH_MODEL.file, file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps });
  const base = path.join(dir, `depth-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  return { file: `${base}.mkv`, track: `${base}.json`, exists: await stat(`${base}.mkv`).then((s) => s.size > 0, () => false) };
}

/** Estimate depth over a source range and write its video (FFV1, 16-bit gray) and track (JSON). */
export async function writeDepth(src: string, output: { file: string; track: string }, opts: Parameters<typeof trackDepth>[2]): Promise<DepthTrack> {
  await mkdir(path.dirname(output.file), { recursive: true });
  const part = `${output.file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
  const raw = `${part}.gray16`;
  try {
    const track = await trackDepth(src, raw, opts);
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray16le", "-s", `${track.width}x${track.height}`, "-r", String(track.fps), "-i", raw, "-c:v", "ffv1", "-pix_fmt", "gray16le", part], opts);
    await rename(part, output.file);
    await writeFile(output.track, JSON.stringify(track));
    return track;
  } finally {
    await rm(part, { force: true });
    await rm(raw, { force: true });
  }
}

/** Frames of a depth video (by frame number), as distance 0..1, each track.width x track.height. */
export async function readDepthFrames(file: string, track: Pick<DepthTrack, "width" | "height">, frames: number[], opts: FfmpegOptions = {}): Promise<Float32Array[]> {
  const wanted = [...new Set(frames.map((f) => Math.max(0, Math.round(f))))].sort((a, b) => a - b);
  if (!wanted.length) return [];
  const select = wanted.map((n) => `eq(n\,${n})`).join("+");
  const res = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select='${select}'`, "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "gray16le", "-"], { ...opts, binaryStdout: true });
  const area = track.width * track.height;
  const buf = res.stdoutBuffer ?? Buffer.alloc(0);
  const got = wanted.map((_, i) => {
    const out = new Float32Array(area);
    for (let q = 0; q < area && (i * area + q) * 2 + 1 < buf.length; q++) out[q] = buf.readUInt16LE((i * area + q) * 2) / 65535;
    return out;
  });
  // A frame past the end (the clip runs a frame longer than the video) is the last one.
  return frames.map((f) => got[Math.min(got.length - 1, wanted.indexOf(Math.max(0, Math.round(f))))] ?? got[got.length - 1]!);
}

/** The median distance inside a box (source frame fractions) of a depth map. */
export function depthInBox(map: Float32Array, w: number, h: number, box: { x0: number; y0: number; x1: number; y1: number }): number {
  const [x0, x1] = [Math.max(0, Math.floor(Math.min(box.x0, box.x1) * w)), Math.min(w - 1, Math.ceil(Math.max(box.x0, box.x1) * w))];
  const [y0, y1] = [Math.max(0, Math.floor(Math.min(box.y0, box.y1) * h)), Math.min(h - 1, Math.ceil(Math.max(box.y0, box.y1) * h))];
  const v: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) v.push(map[y * w + x]!);
  v.sort((a, b) => a - b);
  return round3(v[Math.floor(v.length / 2)] ?? 0.5);
}
