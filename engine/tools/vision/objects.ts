import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { probe, resolveFfmpegPath, runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import { defaultModelsDir } from "../appdirs.js";
import { controlled, native } from "../native/index.js";
import { resizeMask } from "./segment.js";

/**
 * Selecting and tracking any object (docs/design/cinematic-grade-and-vfx.md, section 5.2).
 *
 * Segmentation: SAM 2.1 hiera tiny (Apache-2.0, 155 MB, through transformers.js), from a point or a
 * box. Compared on the project test frames against SlimSAM-77 and SAM 2.1 small: all encode a frame
 * in 3.5 to 4.7 s on the reference laptop (DirectML on its Intel GPU is no faster), SAM 2.1 tiny and
 * small agree within IoU 0.98 on box prompts, and SlimSAM fails on box prompts. Points are ambiguous
 * for every model (a shirt for the person), so boxes are preferred and a point takes the largest
 * confident mask.
 *
 * Names: OWLv2 base (Apache-2.0, 155 MB quantized) finds the box once, at selection, and the box is
 * stored, so renders never run it. It found all eight named things on the test frames (box IoU
 * 0.63 to 0.92 against hand-placed boxes) in about 12 s an image. Grounding DINO tiny, the other
 * candidate, fails inside the transformers.js detection pipeline.
 *
 * Video: the encoder is far too slow for every frame, so SAM runs on keyframes (every 1.5 s) and the
 * mask is carried between them by region tracking (Rust: pyramidal Lucas-Kanade and RANSAC), forward
 * from one keyframe and backward from the next, blended. Each keyframe is prompted with the box the
 * tracking predicts, and the candidate that overlaps the prediction most is kept, so a similar object
 * nearby is not picked up. Where the two directions disagree in the middle of a span (fast or
 * non-rigid motion), SAM segments a frame there too and each half is solved again. Edges are snapped
 * to the frame with a guided filter.
 */

export const OBJECT_MODEL = { id: "onnx-community/sam2.1-hiera-tiny-ONNX", dtype: "fp32" } as const;
/** Open-vocabulary detector for text prompts ("the red car"). */
export const DETECT_MODEL = { id: "Xenova/owlv2-base-patch16-ensemble", dtype: "q8" } as const;
/** Bump when object masks for the same input would come out differently. */
export const OBJECT_MASK_VERSION = 1;
/** Long side of object masks and of the frames they are tracked on. */
export const OBJECT_MASK_SIZE = 480;
/** Long side of the frames SAM sees (it works at 1024 internally). */
const KEY_SIZE = 1024;
/** Seconds between keyframes. */
const KEY_SECONDS = 1.5;
/** Where tracking forward and back disagree this much (IoU) in the middle of a span, SAM segments a frame there. */
const SPLIT_IOU = 0.85;
/** Keyframes can be added on a grid this many times finer than KEY_SECONDS. */
const SPLIT_STEPS = 4;
/** Memory for the decoded frames SAM may use, in bytes. */
const MAX_KEY_BYTES = 600e6;

/** What to select, on one frame: a point, a box (frame fractions) or a name. */
export interface ObjectPrompt {
  point?: { x: number; y: number };
  box?: { x0: number; y0: number; x1: number; y1: number };
  text?: string;
}

export interface ObjectOptions extends FfmpegOptions {
  modelsDir?: string;
  onDownload?: (progress: number) => void;
}

type Tf = typeof import("@huggingface/transformers");

async function loadTf(opts: ObjectOptions): Promise<Tf> {
  let tf: Tf;
  try {
    tf = await import("@huggingface/transformers");
  } catch {
    throw new Error("Selecting objects needs the optional package @huggingface/transformers (npm install @huggingface/transformers).");
  }
  tf.env.cacheDir = opts.modelsDir ?? defaultModelsDir();
  return tf;
}

/** Download progress over every file of a model, as one fraction. */
function progress(onDownload?: (p: number) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (e: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (e.status !== "progress" || !e.file || !onDownload) return;
    files.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 });
    const all = [...files.values()];
    const total = all.reduce((s, f) => s + f.total, 0);
    if (total) onDownload(all.reduce((s, f) => s + f.loaded, 0) / total);
  };
}

/** Fraction of the pixels where both masks are on, over where either is (masks 0..255, cut at 128). */
export function maskIou(a: Uint8Array, b: Uint8Array): number {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k]! >= 128;
    const y = b[k]! >= 128;
    if (x && y) i++;
    if (x || y) u++;
  }
  return u ? i / u : 0;
}

/** Bounding box of a mask in pixels (cut at 128), or undefined when it is empty. */
export function maskBox(m: Uint8Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x]! >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? undefined : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** What the segmenter uses of the SAM model and its processor. */
interface Sam {
  tf: Tf;
  model: (inputs: object) => Promise<{ pred_masks: unknown; iou_scores: { data: unknown } }>;
  processor: {
    (image: unknown, prompts: object): Promise<{ original_sizes: unknown; reshaped_input_sizes: unknown }>;
    post_process_masks(masks: unknown, original: unknown, reshaped: unknown, opts: object): Promise<{ data: unknown }[]>;
  };
}

const sessions = new Map<string, Promise<Sam>>();

/** Promptable segmentation of single frames (SAM 2.1). One model is shared per models folder. */
export class ObjectSegmenter {
  constructor(private readonly options: ObjectOptions = {}) {}

  private load(): Promise<Sam> {
    const key = this.options.modelsDir ?? defaultModelsDir();
    let s = sessions.get(key);
    if (!s) {
      s = (async (): Promise<Sam> => {
        const tf = await loadTf(this.options);
        const progress_callback = progress(this.options.onDownload);
        const model = await tf.Sam2Model.from_pretrained(OBJECT_MODEL.id, { dtype: OBJECT_MODEL.dtype, progress_callback });
        const processor = await tf.AutoProcessor.from_pretrained(OBJECT_MODEL.id, { progress_callback });
        return { tf, model: model as unknown as Sam["model"], processor: processor as unknown as Sam["processor"] };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  /**
   * The mask (0..255 at `out` size) of what a prompt points at in an RGB frame of `w` x `h`.
   * Points and boxes are in frame pixels. With `prefer` (a predicted mask at `out` size), the
   * candidate overlapping it most is chosen; for a point alone, the largest confident candidate.
   */
  async segment(
    rgb: Uint8Array,
    w: number,
    h: number,
    prompt: { point?: [number, number]; box?: [number, number, number, number]; prefer?: Uint8Array },
    out: { w: number; h: number },
  ): Promise<{ mask: Uint8Array; score: number; overlap?: number }> {
    const { tf, model, processor } = await this.load();
    const image = new tf.RawImage(new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.byteLength), w, h, 3);
    const inputs = await processor(image, {
      ...(prompt.point ? { input_points: [[[prompt.point]]], input_labels: [[[1]]] } : {}),
      ...(prompt.box ? { input_boxes: [[prompt.box]] } : {}),
    });
    const output = await model(inputs);
    const scores = Array.from(output.iou_scores.data as Float32Array);
    // The low-resolution logits cover the padded square input; crop the padding and resize straight to
    // the mask size (post_process_masks would upsample all three to the frame size first, a second a call).
    const pred = output.pred_masks as { data: Float32Array; dims: number[] };
    const side = pred.dims[pred.dims.length - 1]!;
    const [rh, rw] = (inputs.reshaped_input_sizes as number[][])[0]!;
    const scale = side / Math.max(rh!, rw!);
    const [cw, ch] = [Math.max(1, Math.round(rw! * scale)), Math.max(1, Math.round(rh! * scale))];
    const candidates = scores.map((score, k) => {
      const crop = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = pred.data[k * side * side + y * side + x]!;
      const mask = Uint8Array.from(resizeMask(crop, cw, ch, out.w, out.h), (v) => Math.round(255 / (1 + Math.exp(-v))));
      let area = 0;
      for (const v of mask) if (v >= 128) area++;
      return { mask, score, area, overlap: prompt.prefer ? maskIou(mask, prompt.prefer) : undefined };
    });
    const best = Math.max(...scores);
    const pick = prompt.prefer
      ? candidates.reduce((a, b) => (b.overlap! > a.overlap! ? b : a))
      : prompt.point && !prompt.box
        ? candidates.filter((c) => c.score >= Math.max(0.5, best - 0.15)).reduce((a, b) => (b.area > a.area ? b : a), candidates[scores.indexOf(best)]!)
        : candidates[scores.indexOf(best)]!;
    return { mask: pick.mask, score: round3(pick.score), ...(pick.overlap !== undefined ? { overlap: round3(pick.overlap) } : {}) };
  }
}

type Detector = (image: unknown, labels: string[], opts: object) => Promise<{ score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }[]>;
const detectors = new Map<string, Promise<{ tf: Tf; detect: Detector }>>();

/** Finds a named thing in a frame ("the red car"), as a box for the segmenter. */
export class ObjectDetector {
  constructor(private readonly options: ObjectOptions = {}) {}

  private load() {
    const key = this.options.modelsDir ?? defaultModelsDir();
    let d = detectors.get(key);
    if (!d) {
      d = (async () => {
        const tf = await loadTf(this.options);
        const detect = (await tf.pipeline("zero-shot-object-detection", DETECT_MODEL.id, { dtype: DETECT_MODEL.dtype, progress_callback: progress(this.options.onDownload) })) as unknown as Detector;
        return { tf, detect };
      })();
      detectors.set(key, d);
      d.catch(() => detectors.delete(key));
    }
    return d;
  }

  /** The most likely box (pixels) for `text` in an RGB frame, or undefined when nothing scores 0.2. */
  async find(rgb: Uint8Array, w: number, h: number, text: string): Promise<{ box: [number, number, number, number]; score: number } | undefined> {
    const { tf, detect } = await this.load();
    const image = new tf.RawImage(new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.byteLength), w, h, 3);
    const label = /^(a|an|the)\s/i.test(text.trim()) ? text.trim() : `a ${text.trim()}`;
    const found = (await detect(image, [label], { threshold: 0.1, top_k: 8 })).sort((a, b) => b.score - a.score);
    if (!found.length || found[0]!.score < 0.2) return undefined;
    return { box: wholeBox(found.map((f) => ({ box: [f.box.xmin, f.box.ymin, f.box.xmax, f.box.ymax], score: f.score }))), score: round3(found[0]!.score) };
  }
}

/**
 * The box of the best detection, grown over the others that are parts of the same thing: the
 * detector often answers a seated or turned person with a box per half and one for the upper body,
 * none of them the whole. A part scores at least half of the best and shares a quarter of the
 * smaller box with what is gathered so far; another thing of the same name stands apart.
 */
export function wholeBox(found: { box: [number, number, number, number]; score: number }[]): [number, number, number, number] {
  const sorted = [...found].sort((a, b) => b.score - a.score);
  const whole = [...sorted[0]!.box] as [number, number, number, number];
  const rest = sorted.slice(1).filter((f) => f.score >= sorted[0]!.score * 0.5);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [k, f] of rest.entries()) {
      const [x0, y0, x1, y1] = f.box;
      const shared = Math.max(0, Math.min(x1, whole[2]) - Math.max(x0, whole[0])) * Math.max(0, Math.min(y1, whole[3]) - Math.max(y0, whole[1]));
      const smaller = Math.min((x1 - x0) * (y1 - y0), (whole[2] - whole[0]) * (whole[3] - whole[1]));
      if (smaller <= 0 || shared / smaller < 0.25) continue;
      [whole[0], whole[1], whole[2], whole[3]] = [Math.min(whole[0], x0), Math.min(whole[1], y0), Math.max(whole[2], x1), Math.max(whole[3], y1)];
      rest.splice(k, 1);
      grew = true;
      break;
    }
  }
  return whole;
}

/** Mask and frame sizes for a source of `width` x `height`. */
function sizes(width: number, height: number) {
  const fit = (long: number) => {
    const k = long / Math.max(width, height);
    return { w: Math.max(2, Math.round((width * k) / 2) * 2), h: Math.max(2, Math.round((height * k) / 2) * 2) };
  };
  return { mask: fit(OBJECT_MASK_SIZE), key: fit(KEY_SIZE) };
}

export interface DecodeOptions extends FfmpegOptions {
  signal?: AbortSignal;
  /**
   * The YUV matrix the file's colors are stored with (the asset's colorMatrix, colorMatrixOf): RGB
   * frames are read with it. FFmpeg reads a file without a tag as BT.601, which shifts the colors
   * of untagged HD video; frames that go back into the picture (smooth motion, removal fills) must
   * have the footage's own colors.
   */
  colorMatrix?: "bt601" | "bt709" | "bt2020";
}

const matrixArg = (opts: DecodeOptions) => (opts.colorMatrix ? `:in_color_matrix=${opts.colorMatrix}` : "");

/** Frames of a source range at `fps`, as raw bytes of `w` x `h` (gray or rgb24). `pick` keeps only those frame numbers. */
export async function decodeFrames(src: string, range: { start: number; end: number }, fps: number, size: { w: number; h: number }, fmt: "gray" | "rgb24", opts: DecodeOptions, pick?: number[]): Promise<Uint8Array[]> {
  const select = pick ? `,select='${pick.map((n) => `eq(n\\,${n})`).join("+")}'` : "";
  const res = await runFfmpegOrThrow(
    [
      "-hide_banner", "-loglevel", "error",
      ...(range.start > 0 ? ["-ss", String(round3(range.start))] : []),
      "-t", String(round3(Math.max(0.05, range.end - range.start))),
      "-i", src,
      "-an", "-vf", `fps=${fps},scale=${size.w}:${size.h}${matrixArg(opts)}${select}`,
      "-fps_mode", "passthrough",
      "-f", "rawvideo", "-pix_fmt", fmt, "-",
    ],
    { ...opts, binaryStdout: true },
  );
  const buf = res.stdoutBuffer ?? Buffer.alloc(0);
  const bytes = size.w * size.h * (fmt === "gray" ? 1 : 3);
  return Array.from({ length: Math.floor(buf.length / bytes) }, (_, i) => new Uint8Array(buf.buffer, buf.byteOffset + i * bytes, bytes));
}

/**
 * Frames of a source range at `fps`, as raw bytes of `w` x `h` (gray or rgb24), one at a time from a
 * single decode: for long ranges, where decodeFrames would hold every frame, and where seeking for
 * each chunk would decode from the previous keyframe again (slow for AV1 and VP9).
 */
export async function* streamFrames(src: string, range: { start: number; end: number }, fps: number, size: { w: number; h: number }, fmt: "gray" | "rgb24", opts: DecodeOptions): AsyncGenerator<Uint8Array> {
  const proc = spawn(
    resolveFfmpegPath(opts),
    [
      "-hide_banner", "-loglevel", "error",
      ...(range.start > 0 ? ["-ss", String(round3(range.start))] : []),
      "-t", String(round3(Math.max(0.05, range.end - range.start))),
      "-i", src,
      "-an", "-vf", `fps=${fps},scale=${size.w}:${size.h}${matrixArg(opts)}`,
      "-fps_mode", "passthrough",
      "-f", "rawvideo", "-pix_fmt", fmt, "-",
    ],
    { windowsHide: true, signal: opts.signal },
  );
  let err = "";
  proc.stderr.on("data", (d: Buffer) => (err += d.toString()).length > 20_000 && (err = err.slice(-10_000)));
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  });
  const bytes = size.w * size.h * (fmt === "gray" ? 1 : 3);
  // Pipe chunks are copied straight into the frame being filled (joining them would copy a large frame many times over).
  let frame = new Uint8Array(bytes);
  let at = 0;
  try {
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      for (let o = 0; o < chunk.length; ) {
        const n = Math.min(bytes - at, chunk.length - o);
        frame.set(chunk.subarray(o, o + n), at);
        [at, o] = [at + n, o + n];
        if (at === bytes) {
          yield frame;
          [frame, at] = [new Uint8Array(bytes), 0];
        }
      }
    }
    const code = await closed;
    if (code !== 0) throw new Error(`ffmpeg (reading frames) failed for ${src}: ${err.trim().split("\n").pop()}`);
  } finally {
    // Stopped early (or failed): do not leave the decoder running.
    if (proc.exitCode === null) proc.kill();
  }
}

/** A prompt in frame fractions as segmenter input in pixels of a `size` frame; a name is found by the detector first. */
async function promptPixels(
  p: ObjectPrompt,
  rgb: Uint8Array,
  size: { w: number; h: number },
  time: number,
  detector: () => ObjectDetector,
): Promise<{ box?: [number, number, number, number]; point?: [number, number] }> {
  const out: { box?: [number, number, number, number]; point?: [number, number] } = {};
  if (p.box) out.box = [p.box.x0 * size.w, p.box.y0 * size.h, p.box.x1 * size.w, p.box.y1 * size.h];
  else if (p.text) {
    const found = await detector().find(rgb, size.w, size.h, p.text);
    if (!found) throw new Error(`Could not find "${p.text}" in the frame at ${round3(time)}s; point at it or give a box instead`);
    out.box = found.box;
  }
  if (p.point) out.point = [p.point.x * size.w, p.point.y * size.h];
  if (!out.box && !out.point) throw new Error("Select an object with a point, a box or a name");
  return out;
}

/**
 * Segment an object on one frame, at source time `time` (select_object's quick check): the mask and
 * the frame at mask size, its box (frame fractions), and SAM's score for it.
 */
export async function selectObject(
  src: string,
  opts: ObjectOptions & { time: number; prompt: ObjectPrompt; segmenter?: ObjectSegmenter; detector?: ObjectDetector },
): Promise<{ width: number; height: number; rgb: Uint8Array; mask: Uint8Array; box: { x0: number; y0: number; x1: number; y1: number } | null; score: number }> {
  const info = await probe(src, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${src}`);
  const { mask: ms, key: ks } = sizes(info.width, info.height);
  const range = { start: Math.max(0, opts.time), end: opts.time + 0.5 };
  const [key] = await decodeFrames(src, range, 30, ks, "rgb24", opts, [0]);
  const [small] = await decodeFrames(src, range, 30, ms, "rgb24", opts, [0]);
  if (!key || !small) throw new Error(`No frame at ${round3(opts.time)}s of ${src}`);
  const prompt = await promptPixels(opts.prompt, key, ks, opts.time, () => opts.detector ?? new ObjectDetector(opts));
  const r = await (opts.segmenter ?? new ObjectSegmenter(opts)).segment(key, ks.w, ks.h, prompt, ms);
  const b = maskBox(r.mask, ms.w, ms.h);
  return { width: ms.w, height: ms.h, rgb: small, mask: r.mask, box: b ? { x0: round3(b.x0 / ms.w), y0: round3(b.y0 / ms.h), x1: round3(b.x1 / ms.w), y1: round3(b.y1 / ms.h) } : null, score: r.score };
}

/** Write a frame with a mask tinted blue over it (and its outline drawn) as an image file. */
export async function writeMaskOverlay(file: string, rgb: Uint8Array, mask: Uint8Array, w: number, h: number, opts: FfmpegOptions = {}): Promise<void> {
  const out = Buffer.from(rgb);
  for (let q = 0; q < w * h; q++) {
    const m = mask[q]! / 255;
    // Outline: inside pixels next to an outside one.
    const x = q % w;
    const edge = mask[q]! >= 128 && ((x > 0 && mask[q - 1]! < 128) || (x < w - 1 && mask[q + 1]! < 128) || (q >= w && mask[q - w]! < 128) || (q < w * (h - 1) && mask[q + w]! < 128));
    const a = edge ? 1 : 0.45 * m;
    out[q * 3] = Math.round(out[q * 3]! * (1 - a) + 59 * a);
    out[q * 3 + 1] = Math.round(out[q * 3 + 1]! * (1 - a) + 130 * a);
    out[q * 3 + 2] = Math.round(out[q * 3 + 2]! * (1 - a) + 246 * a);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const raw = `${file}.${process.pid}.rgb`;
  await writeFile(raw, out);
  try {
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", raw, "-frames:v", "1", file], opts);
  } finally {
    await rm(raw, { force: true });
  }
}

/**
 * An image of a tracked object's mask over chosen frames of its track (frame numbers of the track),
 * side by side, from the source video and the mask video writeObjectMask made.
 */
export async function writeTrackPreview(src: string, maskFile: string, track: ObjectTrack, frames: number[], file: string, opts: FfmpegOptions = {}): Promise<void> {
  const size = { w: track.width, h: track.height };
  const range = { start: track.start, end: track.start + (track.boxes.length + 1) / track.fps };
  const picks = [...new Set(frames.map((f) => Math.min(track.boxes.length - 1, Math.max(0, Math.round(f)))))].sort((a, b) => a - b);
  const rgb = await decodeFrames(src, range, track.fps, size, "rgb24", opts, picks);
  const masks = await decodeFrames(maskFile, { start: 0, end: (track.boxes.length + 1) / track.fps }, track.fps, size, "gray", opts, picks);
  const n = Math.min(rgb.length, masks.length);
  if (!n) throw new Error(`Could not read frames ${picks.join(", ")} of the track`);
  // Tiles side by side, with a 4 px dark gap.
  const gap = 4;
  const W = n * size.w + (n - 1) * gap;
  const wideRgb = new Uint8Array(W * size.h * 3).fill(20);
  const wideMask = new Uint8Array(W * size.h);
  for (let t = 0; t < n; t++)
    for (let y = 0; y < size.h; y++) {
      const o = y * W + t * (size.w + gap);
      wideRgb.set(rgb[t]!.subarray(y * size.w * 3, (y + 1) * size.w * 3), o * 3);
      wideMask.set(masks[t]!.subarray(y * size.w, (y + 1) * size.w), o);
    }
  await writeMaskOverlay(file, wideRgb, wideMask, W, size.h, opts);
}

export interface ObjectTrack {
  fps: number;
  /** Source seconds of the first frame. */
  start: number;
  width: number;
  height: number;
  /** Per frame: the object's box (frame fractions), or null where it is not seen. */
  boxes: ({ x0: number; y0: number; x1: number; y1: number } | null)[];
  /** Per frame, 0..1: how sure the mask is (keyframes that matched their prediction, strong tracking). */
  confidence: number[];
  /** Frame numbers SAM segmented. */
  keyframes: number[];
}

export interface ObjectMasks extends ObjectTrack {
  /** One mask per frame, width x height, 0..255. */
  masks: Uint8Array[];
}

/**
 * Masks of an object through a source range, from a prompt on the frame at source time `time`
 * (the range is extended to include it). See the module notes for the method.
 */
export async function trackObject(
  src: string,
  opts: ObjectOptions & {
    start: number;
    end: number;
    fps: number;
    time: number;
    prompt: ObjectPrompt;
    segmenter?: ObjectSegmenter;
    detector?: ObjectDetector;
    onProgress?: (p: number) => void;
    signal?: AbortSignal;
  },
): Promise<ObjectMasks> {
  const info = await probe(src, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${src}`);
  const { mask: ms, key: ks } = sizes(info.width, info.height);
  const still = info.isImage || info.duration === undefined;
  const from = still ? 0 : Math.max(0, Math.min(opts.start, opts.time));
  const to = still ? 0.04 : Math.min(info.duration!, Math.max(opts.end, opts.time + 1 / opts.fps));
  const gray = await decodeFrames(src, { start: from, end: to }, opts.fps, ms, "gray", opts);
  const n = gray.length;
  if (!n) throw new Error(`No frames between ${from}s and ${to}s of ${src}`);
  const kp = Math.min(n - 1, Math.max(0, Math.round((opts.time - from) * opts.fps)));
  // Keyframes about a second apart, outward from the prompted frame, always including both ends.
  // Frames on a finer grid are decoded too, for keyframes added where tracking disagrees.
  const step = Math.max(2, Math.round(opts.fps * KEY_SECONDS));
  const keys = new Set([kp, 0, n - 1]);
  for (let f = kp; f < n; f += step) keys.add(f);
  for (let f = kp; f >= 0; f -= step) keys.add(f);
  const order = [...keys].sort((a, b) => a - b);
  const grid = Math.max(1, Math.round(step / SPLIT_STEPS));
  // Keep the decoded frames within a memory budget: fewer candidates on long ranges.
  const fine = (n * ks.w * ks.h * 3) / grid <= MAX_KEY_BYTES ? grid : step;
  const candidates = new Set(order);
  for (let f = kp % fine; f < n; f += fine) candidates.add(f);
  const pickList = [...candidates].sort((a, b) => a - b);
  const rgb = new Map<number, Uint8Array>();
  const decoded = await decodeFrames(src, { start: from, end: to }, opts.fps, ks, "rgb24", opts, pickList);
  pickList.forEach((f, i) => decoded[i] && rgb.set(f, decoded[i]!));

  const segmenter = opts.segmenter ?? new ObjectSegmenter(opts);
  const area = ms.w * ms.h;
  const work = order.length;
  let done = 0;
  const tick = () => opts.onProgress?.(Math.min(1, ++done / work));

  // The prompted keyframe.
  const first = await promptPixels(opts.prompt, rgb.get(kp)!, ks, opts.time, () => opts.detector ?? new ObjectDetector(opts));
  const masks: (Uint8Array | undefined)[] = new Array(n);
  const keyConf = new Map<number, number>();
  const seed = await segmenter.segment(rgb.get(kp)!, ks.w, ks.h, first, ms);
  masks[kp] = seed.mask;
  keyConf.set(kp, Math.min(1, seed.score));
  tick();

  const k = native();
  const pack = (idx: number[]) => {
    const out = new Uint8Array(idx.length * area);
    idx.forEach((f, i) => out.set(gray[f]!, i * area));
    return out;
  };
  const region = (m: Uint8Array) => Uint8Array.from(m, (v) => (v >= 128 ? 1 : 0));
  const at = (arr: Uint8Array, i: number) => arr.subarray(i * area, (i + 1) * area);
  const strength = new Float32Array(n).fill(1);

  const areaOf = (m: Uint8Array) => {
    let on = 0;
    for (const v of m) if (v >= 128) on++;
    return on;
  };
  /** Follow a mask through frames (the first is its own); nothing to follow gives empty masks. */
  const follow = async (frames: number[], mask: Uint8Array): Promise<{ masks: Uint8Array; inliers: ArrayLike<number> }> => {
    if (!areaOf(mask)) return { masks: new Uint8Array(frames.length * area), inliers: new Float32Array(frames.length) };
    const t = await controlled({ signal: opts.signal }, (c) => k.trackRegion(pack(frames), ms.w, ms.h, frames.length, region(mask), undefined, c));
    return { masks: await k.warpMasks(mask, ms.w, ms.h, t.matrices), inliers: t.inliers };
  };

  /**
   * Segment keyframe `f` from a predicted mask: its padded box as the prompt, keeping the candidate
   * that matches. `from` says what the prediction came from (the mask's area at the last keyframe,
   * the points tracking still held): a prediction that held few points, or grew or shrank more than
   * three times, lost the object (it left, or something passed in front and took the points along),
   * and no object there is better than a mask stretched over the picture.
   */
  const segmentAt = async (f: number, predicted: Uint8Array, from?: { area: number; inliers: number }) => {
    const size = areaOf(predicted);
    if (!size || (from && (from.inliers < 8 || size > from.area * 3 || size * 3 < from.area))) {
      masks[f] = new Uint8Array(area);
      keyConf.set(f, 0);
      return;
    }
    const box = maskBox(predicted, ms.w, ms.h);
    let mask = predicted;
    let conf = 0.3;
    if (box) {
      const pad = 0.08 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
      const [sx, sy] = [ks.w / ms.w, ks.h / ms.h];
      const promptBox: [number, number, number, number] = [Math.max(0, (box.x0 - pad) * sx), Math.max(0, (box.y0 - pad) * sy), Math.min(ks.w, (box.x1 + pad) * sx), Math.min(ks.h, (box.y1 + pad) * sy)];
      const r = await segmenter.segment(rgb.get(f)!, ks.w, ks.h, { box: promptBox, prefer: predicted }, ms);
      // A candidate far from the prediction means the object was occluded or lost: keep the prediction.
      if ((r.overlap ?? 0) >= 0.3) {
        mask = r.mask;
        conf = Math.min(1, r.score) * Math.min(1, (r.overlap ?? 0) / 0.7);
      }
    }
    masks[f] = mask;
    keyConf.set(f, round3(conf));
  };

  /**
   * Fill the frames between keyframe `a` (known) and `b`: track forward from a (and segment b from
   * that prediction if it is new), track back from b, and blend by distance. Where the two tracks
   * disagree in the middle, segment a keyframe there and solve each half.
   */
  const solve = async (a: number, b: number): Promise<void> => {
    const dir = b > a ? 1 : -1;
    const frames = Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => a + dir * i);
    const last = frames.length - 1;
    const fwd = await follow(frames, masks[a]!);
    const fwdMasks = fwd.masks;
    if (!masks[b]) {
      await segmentAt(b, at(fwdMasks, last), { area: areaOf(masks[a]!), inliers: fwd.inliers[last]! });
      tick();
    }
    const back = frames.slice().reverse();
    const bwd = await follow(back, masks[b]!);
    const bwdMasks = bwd.masks;
    // The decoded frame nearest the middle, strictly inside the span.
    const mid = frames
      .slice(1, -1)
      .filter((f) => rgb.has(f))
      .sort((x, y) => Math.abs(x - (a + b) / 2) - Math.abs(y - (a + b) / 2))[0];
    if (mid !== undefined) {
      const i = Math.abs(mid - a);
      if (maskIou(at(fwdMasks, i), at(bwdMasks, last - i)) < SPLIT_IOU) {
        const u = i / last;
        const g = at(bwdMasks, last - i);
        // Where one end lost the object, the middle is judged from the end that has it.
        const [aa, ab] = [areaOf(masks[a]!), areaOf(masks[b]!)];
        const predicted = !ab ? at(fwdMasks, i) : !aa ? g : Uint8Array.from(at(fwdMasks, i), (v, q) => Math.round(v * (1 - u) + g[q]! * u));
        await segmentAt(mid, predicted, !ab ? { area: aa, inliers: fwd.inliers[i]! } : !aa ? { area: ab, inliers: bwd.inliers[last - i]! } : undefined);
        await solve(a, mid);
        await solve(mid, b);
        return;
      }
    }
    for (let i = 1; i < last; i++) {
      const u = i / last;
      const f = at(fwdMasks, i);
      const g = at(bwdMasks, last - i);
      const m = new Uint8Array(area);
      for (let q = 0; q < area; q++) m[q] = Math.round(f[q]! * (1 - u) + g[q]! * u);
      masks[frames[i]!] = m;
      // Tracking that kept few points is weaker evidence.
      strength[frames[i]!] = Math.min(1, Math.max(fwd.inliers[i]!, bwd.inliers[last - i]!) / 40);
    }
  };

  // Walk outward from the prompted frame, one keyframe span at a time.
  for (const dir of [1, -1]) {
    const span = order.filter((f) => (dir > 0 ? f >= kp : f <= kp)).sort((a, b) => dir * (a - b));
    for (let s = 1; s < span.length; s++) await solve(span[s - 1]!, span[s]!);
  }

  // Snap the edges to the frame, then smooth over time so they do not shimmer.
  const radius = Math.max(2, Math.round(Math.min(ms.w, ms.h) * 0.012));
  const all = pack(Array.from({ length: n }, (_, i) => i));
  const raw = new Uint8Array(n * area);
  masks.forEach((m, i) => raw.set(m!, i * area));
  const refined = await k.guidedFilter(all, raw, ms.w, ms.h, radius, 1e-3);
  const out: Uint8Array[] = [];
  let prev: Uint8Array | undefined;
  for (let i = 0; i < n; i++) {
    const cur = refined.subarray(i * area, (i + 1) * area);
    const m = new Uint8Array(area);
    for (let q = 0; q < area; q++) m[q] = prev ? Math.round(cur[q]! * 0.75 + prev[q]! * 0.25) : cur[q]!;
    out.push(m);
    prev = m;
  }

  // Confidence: from the nearest keyframes, weakened where tracking was thin.
  const keyList = [...keyConf.keys()].sort((a, b) => a - b);
  const confidence = out.map((_, i) => {
    const before = keyList.filter((f) => f <= i).pop() ?? keyList[0]!;
    const after = keyList.find((f) => f >= i) ?? keyList[keyList.length - 1]!;
    const u = after === before ? 0 : (i - before) / (after - before);
    return round3(((keyConf.get(before) ?? 0.5) * (1 - u) + (keyConf.get(after) ?? 0.5) * u) * (0.6 + 0.4 * strength[i]!));
  });
  const boxes = out.map((m) => {
    const b = maskBox(m, ms.w, ms.h);
    return b ? { x0: round3(b.x0 / ms.w), y0: round3(b.y0 / ms.h), x1: round3(b.x1 / ms.w), y1: round3(b.y1 / ms.h) } : null;
  });
  // Report only the asked range (the prompt frame may lie outside it).
  const s0 = Math.max(0, Math.round((opts.start - from) * opts.fps));
  const s1 = Math.min(n, s0 + Math.max(1, Math.ceil((opts.end - opts.start) * opts.fps - 1e-6)));
  return {
    fps: opts.fps,
    start: round3(from + s0 / opts.fps),
    width: ms.w,
    height: ms.h,
    masks: out.slice(s0, s1),
    boxes: boxes.slice(s0, s1),
    confidence: confidence.slice(s0, s1),
    keyframes: keyList.filter((f) => f >= s0 && f < s1).map((f) => f - s0),
  };
}

/** A tracked object, as the project stores it (project.objects). */
export interface ObjectSpec extends ObjectPrompt {
  assetId: string;
  /** Source seconds of the frame the prompt is on. */
  time: number;
}

/** The cache files (mask video and track) of an object over a source range. */
export async function objectMaskFile(dir: string, file: string, range: { start: number; end: number }, fps: number, object: ObjectSpec): Promise<{ file: string; track: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  // The label is a name only: renaming an object keeps its mask.
  const { assetId: _, label: __, ...prompt } = object as ObjectSpec & { label?: string };
  const key = JSON.stringify({ v: OBJECT_MASK_VERSION, kind: "object", model: OBJECT_MODEL, file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps, prompt });
  const base = path.join(dir, `object-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  return { file: `${base}.mkv`, track: `${base}.json`, exists: await stat(`${base}.mkv`).then((s) => s.size > 0, () => false) };
}

/** Track an object over a source range and write its mask video (FFV1 gray) and track (JSON). */
export async function writeObjectMask(
  src: string,
  output: { file: string; track: string },
  opts: Parameters<typeof trackObject>[1],
): Promise<ObjectTrack> {
  const r = await trackObject(src, opts);
  await mkdir(path.dirname(output.file), { recursive: true });
  const part = `${output.file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
  const raw = `${part}.gray`;
  try {
    const all = new Uint8Array(r.masks.length * r.width * r.height);
    r.masks.forEach((m, i) => all.set(m, i * r.width * r.height));
    await writeFile(raw, all);
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${r.width}x${r.height}`, "-r", String(r.fps), "-i", raw, "-c:v", "ffv1", part], opts);
    await rename(part, output.file);
    const { masks: _, ...track } = r;
    await writeFile(output.track, JSON.stringify(track));
    return track;
  } finally {
    await rm(part, { force: true });
    await rm(raw, { force: true });
  }
}
