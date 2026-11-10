import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { probe, resolveFfmpegPath, type FfmpegOptions } from "../render/ffmpeg.js";
import { createOrtSession, ensureModelFile, loadOrt, modelsDir, type Ort, type OrtSession } from "./faces.js";

/**
 * Person cutout on this machine: PaddleSeg's PP-HumanSeg (Apache 2.0, 6 MB, from the OpenCV model
 * zoo), run with ONNX Runtime. About 11 ms a frame on a laptop CPU, so every frame of a clip can be
 * cut out. It was picked over MediaPipe selfie segmentation (cruder edges around hands) and MODNet
 * (finer hair, but 70 times slower).
 */
export const PERSON_MODEL = {
  url: "https://huggingface.co/opencv/human_segmentation_pphumanseg/resolve/main/human_segmentation_pphumanseg_2023mar.onnx",
  file: "human_segmentation_pphumanseg_2023mar.onnx",
};

/** The model's input size; frames are stretched to it, as it was trained. */
export const PERSON_INPUT = 192;

/** Bump when masks for the same source would come out differently. */
export const MASK_VERSION = 2;

/** Long side of the frames read for a cutout: the model sees them at PERSON_INPUT, and a small person again from these, closer. */
const WORK_SIZE = 640;

/** A box in frame fractions. */
export interface FrameBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A box of an RGB24 frame stretched to PERSON_INPUT square, each pixel the average of what it covers. */
export function sampleSquare(rgb: Uint8Array, w: number, h: number, box: FrameBox = { x0: 0, y0: 0, x1: 1, y1: 1 }): Uint8Array {
  const N = PERSON_INPUT;
  const out = new Uint8Array(N * N * 3);
  const [bx, by, bw, bh] = [box.x0 * w, box.y0 * h, (box.x1 - box.x0) * w, (box.y1 - box.y0) * h];
  for (let y = 0; y < N; y++) {
    const [ya, yb] = [Math.floor(by + (y * bh) / N), Math.max(Math.floor(by + (y * bh) / N) + 1, Math.ceil(by + ((y + 1) * bh) / N))];
    for (let x = 0; x < N; x++) {
      const [xa, xb] = [Math.floor(bx + (x * bw) / N), Math.max(Math.floor(bx + (x * bw) / N) + 1, Math.ceil(bx + ((x + 1) * bw) / N))];
      let [r, g, b, n] = [0, 0, 0, 0];
      for (let sy = ya; sy < yb; sy++) {
        const row = Math.min(h - 1, Math.max(0, sy)) * w;
        for (let sx = xa; sx < xb; sx++) {
          const k = (row + Math.min(w - 1, Math.max(0, sx))) * 3;
          r += rgb[k]!;
          g += rgb[k + 1]!;
          b += rgb[k + 2]!;
          n++;
        }
      }
      const o = (y * N + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

/**
 * Where to look again, closer: the box around everyone the first pass found, with room around it,
 * when that is a small part of the frame (a wide shot: someone 20 px wide at the model's size comes
 * out as a blob without legs or arms). Undefined when nobody is found or the people fill the frame.
 */
export function closerBox(p: Float32Array): FrameBox | undefined {
  const N = PERSON_INPUT;
  let [x0, y0, x1, y1] = [N, N, -1, -1];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (p[y * N + x]! > 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return undefined;
  const [w, h] = [(x1 - x0 + 1) / N, (y1 - y0 + 1) / N];
  if (w > 0.5 || h > 0.75 || w * h > 0.3) return undefined;
  // Legs and arms the first pass missed lie outside its box: more room below and to the sides than above.
  const [px, top, bottom] = [Math.max(0.06, w * 0.6), Math.max(0.04, h * 0.25), Math.max(0.08, h * 0.6)];
  return { x0: Math.max(0, x0 / N - px), y0: Math.max(0, y0 / N - top), x1: Math.min(1, (x1 + 1) / N + px), y1: Math.min(1, (y1 + 1) / N + bottom) };
}

export interface PersonSegmenterOptions extends FfmpegOptions {
  modelsDir?: string;
  onDownload?: (progress: number) => void;
}

const sessions = new Map<string, Promise<{ ort: Ort; session: OrtSession }>>();

/** Person probability (0..1) per pixel from the model's two-class output: channel 1 is "person". */
export function personProbability(output: ArrayLike<number>): Float32Array {
  const n = PERSON_INPUT * PERSON_INPUT;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = output[n + i]!;
  return out;
}

/** Bilinear resize of a one-channel float image. */
export function resizeMask(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const top = src[y0 * sw + x0]! * (1 - wx) + src[y0 * sw + x1]! * wx;
      const bottom = src[y1 * sw + x0]! * (1 - wx) + src[y1 * sw + x1]! * wx;
      out[y * dw + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

/**
 * Smooth masks over time so the edge does not flicker: each frame is mostly itself, partly the
 * previous result. Then sharpen the soft probabilities into a clean edge (0.35..0.65 maps to 0..1).
 */
export function stabilizeMask(current: Float32Array, previous: Float32Array | undefined, keep = 0.35): Float32Array {
  const out = new Float32Array(current.length);
  for (let i = 0; i < current.length; i++) out[i] = previous ? current[i]! * (1 - keep) + previous[i]! * keep : current[i]!;
  return out;
}

const toBytes = (p: Float32Array) => {
  const b = Buffer.alloc(p.length);
  for (let i = 0; i < p.length; i++) b[i] = Math.round(255 * Math.min(1, Math.max(0, (p[i]! - 0.35) / 0.3)));
  return b;
};

/** Cuts people out of frames and videos. One model session is shared per models folder. */
export class PersonSegmenter {
  constructor(private readonly options: PersonSegmenterOptions = {}) {}

  private load(): Promise<{ ort: Ort; session: OrtSession }> {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async () => {
        const ort = await loadOrt("Person cutout");
        const file = await ensureModelFile(this.options, "pphumanseg", PERSON_MODEL);
        return { ort, session: await createOrtSession(ort, file) };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  /** Person probability per pixel (PERSON_INPUT square) for an RGB24 frame already stretched to PERSON_INPUT square. */
  async segmentSquare(rgb: Uint8Array): Promise<Float32Array> {
    const { ort, session } = await this.load();
    const n = PERSON_INPUT * PERSON_INPUT;
    const data = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) data[c * n + i] = (rgb[i * 3 + c]! / 255 - 0.5) / 0.5;
    const out = await session.run({ x: new ort.Tensor("float32", data, [1, 3, PERSON_INPUT, PERSON_INPUT]) });
    return personProbability(Object.values(out)[0]!.data);
  }

  /**
   * Person probability per pixel, `mw` x `mh`, for an RGB24 frame of `w` x `h`: the whole frame
   * through the model, and when the people in it are small, the area around them again from closer
   * (closerBox), which replaces the first pass there. `previousBox` steadies that area between frames.
   */
  async segmentFrame(rgb: Uint8Array, w: number, h: number, mw: number, mh: number, previousBox?: FrameBox): Promise<{ mask: Float32Array; box?: FrameBox }> {
    const whole = await this.segmentSquare(sampleSquare(rgb, w, h));
    const mask = resizeMask(whole, PERSON_INPUT, PERSON_INPUT, mw, mh);
    const found = closerBox(whole);
    if (!found) return { mask };
    // The box follows the people smoothly, and never shrinks faster than they move out of it.
    const box: FrameBox = previousBox
      ? { x0: Math.min(found.x0, previousBox.x0 * 0.7 + found.x0 * 0.3), y0: Math.min(found.y0, previousBox.y0 * 0.7 + found.y0 * 0.3), x1: Math.max(found.x1, previousBox.x1 * 0.7 + found.x1 * 0.3), y1: Math.max(found.y1, previousBox.y1 * 0.7 + found.y1 * 0.3) }
      : found;
    const [cx0, cy0, cx1, cy1] = [Math.floor(box.x0 * mw), Math.floor(box.y0 * mh), Math.ceil(box.x1 * mw), Math.ceil(box.y1 * mh)];
    const [cw, ch] = [cx1 - cx0, cy1 - cy0];
    if (cw < 2 || ch < 2) return { mask };
    const close = resizeMask(await this.segmentSquare(sampleSquare(rgb, w, h, { x0: cx0 / mw, y0: cy0 / mh, x1: cx1 / mw, y1: cy1 / mh })), PERSON_INPUT, PERSON_INPUT, cw, ch);
    // Outside the box nobody was found; inside, the closer look, eased in over its border so no seam shows.
    mask.fill(0);
    const edge = Math.max(1, Math.round(Math.min(cw, ch) * 0.04));
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const inset = Math.min(cx0 > 0 ? x : edge, cy0 > 0 ? y : edge, cx1 < mw ? cw - 1 - x : edge, cy1 < mh ? ch - 1 - y : edge);
        mask[(cy0 + y) * mw + cx0 + x] = close[y * cw + x]! * Math.min(1, inset / edge);
      }
    return { mask, box };
  }

  /**
   * Write the person cutout of a source range as a gray video (255 = person) at `fps` frames a
   * second of source time, upright and at the source's shape (long side `size` pixels). Frames
   * stream through, so long recordings use little memory.
   */
  async writeMask(file: string, output: string, opts: { start?: number; end?: number; fps: number; size?: number; onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<void> {
    const info = await probe(file, this.options);
    if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${file}`);
    const long = opts.size ?? 320;
    const k = long / Math.max(info.width, info.height);
    const mw = Math.max(2, Math.round((info.width * k) / 2) * 2);
    const mh = Math.max(2, Math.round((info.height * k) / 2) * 2);
    // Frames come in larger than the model reads them, so a small person can be looked at again from closer.
    const wk = Math.min(1, WORK_SIZE / Math.max(info.width, info.height));
    const [fw, fh] = [Math.max(PERSON_INPUT, Math.round((info.width * wk) / 2) * 2), Math.max(PERSON_INPUT, Math.round((info.height * wk) / 2) * 2)];
    const still = info.isImage || info.duration === undefined;
    const start = still ? 0 : Math.max(0, opts.start ?? 0);
    const end = still ? 0.04 : Math.min(opts.end ?? info.duration!, info.duration!);
    await this.load();
    const bin = resolveFfmpegPath(this.options);
    const decoder = spawn(
      bin,
      [
        "-hide_banner", "-loglevel", "error",
        ...(start > 0 ? ["-ss", String(round3(start))] : []),
        ...(still ? ["-loop", "1", "-t", "0.04"] : ["-t", String(round3(Math.max(0.05, end - start)))]),
        "-i", file,
        "-an", "-vf", `fps=${opts.fps},scale=${fw}:${fh}:flags=area`,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
      ],
      { windowsHide: true, signal: opts.signal },
    );
    const part = `${output}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
    await mkdir(path.dirname(output), { recursive: true });
    const encoder = spawn(bin, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${mw}x${mh}`, "-r", String(opts.fps), "-i", "-", "-c:v", "ffv1", part], { windowsHide: true, signal: opts.signal });
    const done = (p: ChildProcess, name: string) => {
      let err = "";
      p.stderr!.on("data", (d: Buffer) => (err += d.toString()).length > 20_000 && (err = err.slice(-10_000)));
      return new Promise<void>((resolve, reject) => {
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (${name}) failed for ${file}: ${err.trim().split("\n").pop()}`))));
      });
    };
    const decoded = done(decoder, "reading frames");
    const encoded = done(encoder, "writing the mask");
    // A failed encoder must not leave the decoder blocked on a full pipe.
    encoded.catch(() => decoder.kill());
    const size = fw * fh * 3;
    let box: FrameBox | undefined;
    const expected = Math.max(1, Math.ceil((end - start) * opts.fps));
    let pending: Buffer = Buffer.alloc(0);
    let previous: Float32Array | undefined;
    let count = 0;
    try {
      for await (const chunk of decoder.stdout as AsyncIterable<Buffer>) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= size) {
          const r = await this.segmentFrame(pending.subarray(0, size), fw, fh, mw, mh, box);
          box = r.box;
          previous = stabilizeMask(r.mask, previous);
          pending = pending.subarray(size);
          if (!encoder.stdin!.write(toBytes(previous))) await new Promise((r) => encoder.stdin!.once("drain", r));
          opts.onProgress?.(Math.min(1, ++count / expected));
        }
      }
      encoder.stdin!.end();
      await Promise.all([decoded, encoded]);
      await rename(part, output);
    } catch (e) {
      decoder.kill();
      encoder.kill();
      throw e;
    } finally {
      await rm(part, { force: true });
    }
  }
}

/**
 * The cache file for the person cutout of a source range: keyed by the file (path, size, modified
 * time), the range, the frame rate and MASK_VERSION.
 */
export async function maskFile(dir: string, file: string, range: { start: number; end: number }, fps: number): Promise<{ file: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const key = JSON.stringify({ v: MASK_VERSION, file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps });
  const out = path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.mkv`);
  return { file: out, exists: await stat(out).then((s) => s.size > 0, () => false) };
}
