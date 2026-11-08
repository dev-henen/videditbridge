import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { probe, runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import { controlled, native } from "../native/index.js";
import { createOrtSession, ensureModelFile, loadOrt, modelsDir, ortProviders, type Ort, type OrtSession } from "./faces.js";
import { decodeFrames } from "./objects.js";
import { resizeMask } from "./segment.js";

/**
 * Finding the sky (docs/design/cinematic-grade-and-vfx.md, section 5.3), for sky masks and sky
 * replacement.
 *
 * The model is skyseg (a U-2-Net trained for sky, MIT, 176 MB, from xiongzhu666's Sky-Segmentation-
 * and-Post-processing), run with ONNX Runtime at 320 x 320. Compared on nine project frames with
 * UperNet ConvNeXt-tiny (ADE20K), DETR panoptic (COCO), CLIPSeg and OWLv2 with SAM 2.1 (see the sky
 * guide): it keeps railings, branches and distant ridges, tells sea from sky, and is
 * the fastest with usable edges (CLIPSeg is faster but far too coarse), though still about 1.3 s a
 * frame on a laptop CPU.
 *
 * So it runs on keyframes (every second) and the matte is carried between them by the Rust region
 * tracker following the foreground, forward from one keyframe and backward from the next, blended.
 * A guided filter then snaps the edges to each frame, and light smoothing over time stops shimmer.
 * The same pass measures how the camera moves, by tracking a band of distant scenery just under the
 * sky edge, so a new sky can move with it.
 */

export const SKY_MODEL = { url: "https://huggingface.co/JianyuanWang/skyseg/resolve/main/skyseg.onnx", file: "skyseg.onnx", minBytes: 100_000_000 };
/** The model's input size; frames are stretched to it. */
export const SKY_INPUT = 320;
/** Bump when sky masks for the same input would come out differently. */
export const SKY_MASK_VERSION = 1;
/** Long side of sky masks and of the frames they are tracked and refined on. */
export const SKY_MASK_SIZE = 768;
/** Seconds between keyframes the model looks at. */
const KEY_SECONDS = 1;
/** Frames are processed this many seconds at a time, to bound memory on long clips. */
const CHUNK_SECONDS = 8;

export interface SkyOptions extends FfmpegOptions {
  modelsDir?: string;
  onDownload?: (progress: number) => void;
}

interface SkySession {
  ort: Ort;
  /** The session to use now: the CPU until the graphics card's session is ready. */
  current(): OrtSession;
  /** Start creating the graphics card's session in the background (once). */
  speedUp(): void;
  input: string;
  output: string;
}

const sessions = new Map<string, Promise<SkySession>>();

/** Model frames a job needs before the graphics card's session is worth creating. */
const GPU_WORTH_FRAMES = 40;

/**
 * Sky probability for single frames. One model session is shared per models folder.
 *
 * On the reference laptop a DirectML session takes 22 s to create and then runs a frame in 0.58 s,
 * against 0.7 s and 1.1 s on the CPU, so the graphics card only pays off after about 40 frames.
 * The CPU session starts at once; for a job of GPU_WORTH_FRAMES or more (see `expect`), the graphics
 * card's (see createOrtSession) is created in the background and takes over when it is ready. Short
 * clips never wait for it, and long ones speed up partway through.
 */
export class SkySegmenter {
  constructor(private readonly options: SkyOptions = {}) {}

  private load() {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async (): Promise<SkySession> => {
        const ort = await loadOrt("Finding the sky");
        const file = await ensureModelFile(this.options, "sky", SKY_MODEL);
        const cpu = await ort.InferenceSession.create(file, { logSeverityLevel: 3 });
        let fast: OrtSession | undefined;
        let started = false;
        const providers = ortProviders();
        const speedUp = () => {
          if (started || (providers !== "auto" && providers[0] === "cpu")) return;
          started = true;
          createOrtSession(ort, file, providers).then(
            (gpu) => (fast = gpu),
            () => undefined,
          );
        };
        const raw = cpu as unknown as { inputNames?: string[]; outputNames?: string[] };
        return { ort, current: () => fast ?? cpu, speedUp, input: raw.inputNames?.[0] ?? "input.1", output: raw.outputNames?.[0] ?? "1959" };
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

  /** Sky probability (0..1, SKY_INPUT square) of an RGB frame already stretched to SKY_INPUT x SKY_INPUT. */
  async probability(rgb: Uint8Array): Promise<Float32Array> {
    const { ort, current, input, output } = await this.load();
    const session = current();
    const n = SKY_INPUT * SKY_INPUT;
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = (rgb[i * 3 + c]! / 255 - mean[c]!) / std[c]!;
    const out = await session.run({ [input]: new ort.Tensor("float32", x, [1, 3, SKY_INPUT, SKY_INPUT]) });
    return Float32Array.from(out[output]!.data, (v) => Math.min(1, Math.max(0, v)));
  }
}

/** A probability map as a matte (0..255): 0.35..0.65 maps to 0..1, which gives a clean edge. */
export const probabilityToMatte = (p: Float32Array): Uint8Array => Uint8Array.from(p, (v) => Math.round(255 * Math.min(1, Math.max(0, (v - 0.35) / 0.3))));

/**
 * Distant scenery: pixels that are not sky (matte < 128) with sky at most `depth` pixels above them
 * in their column. The camera's motion is measured there, since it moves like the sky would.
 */
export function horizonBand(matte: Uint8Array, w: number, h: number, depth: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let lastSky = -Infinity;
    for (let y = 0; y < h; y++) {
      if (matte[y * w + x]! >= 128) lastSky = y;
      else if (y - lastSky <= depth) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Half size by 2 x 2 averages (odd last rows and columns dropped). */
export function halve(img: Uint8Array, w: number, h: number): Uint8Array {
  const [hw, hh] = [w >> 1, h >> 1];
  const out = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const q = 2 * y * w + 2 * x;
      out[y * hw + x] = (img[q]! + img[q + 1]! + img[q + w]! + img[q + w + 1]! + 2) >> 2;
    }
  return out;
}

/** Transforms (9 numbers each) measured on half-size frames, for the full-size frames. */
export function doubleTransforms(m: Float64Array): Float64Array {
  const out = new Float64Array(m.length);
  for (let o = 0; o < m.length; o += 9) {
    out.set([m[o]!, m[o + 1]!, 2 * m[o + 2]!, m[o + 3]!, m[o + 4]!, 2 * m[o + 5]!, m[o + 6]! / 2, m[o + 7]! / 2, m[o + 8]!], o);
  }
  return out;
}

/** Row-major 3x3 product a * b (apply b first). */
export function compose(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const m = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[r * 3 + c]! += a[r * 3 + k]! * b[k * 3 + c]!;
  return m;
}

const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** Mean colors of a frame's sky (where p > 0.8) and of the sky's lowest band, near the scenery: #RRGGBB, or undefined without sky. */
export function skyColors(rgb: Uint8Array, p: Float32Array, size = SKY_INPUT): { sky?: string; horizon?: string; share: number } {
  const sum = [0, 0, 0];
  const low = [0, 0, 0];
  let [n, m, any] = [0, 0, 0];
  const band = Math.max(2, Math.round(size * 0.05));
  for (let x = 0; x < size; x++) {
    // The lowest sky pixels of each column that touch the scenery below.
    let near = -1;
    for (let y = size - 1; y >= 0; y--) {
      const v = p[y * size + x]!;
      if (v >= 0.5) any++;
      if (v < 0.5) near = y;
      else if (v > 0.8) {
        for (let c = 0; c < 3; c++) sum[c]! += rgb[(y * size + x) * 3 + c]!;
        n++;
        if (near >= 0 && near - y <= band) {
          for (let c = 0; c < 3; c++) low[c]! += rgb[(y * size + x) * 3 + c]!;
          m++;
        }
      }
    }
  }
  return { ...(n ? { sky: hex(sum.map((v) => v / n)) } : {}), ...(m ? { horizon: hex(low.map((v) => v / m)) } : {}), share: round3(any / (size * size)) };
}

export interface SkyTrack {
  fps: number;
  /** Source seconds of the first frame. */
  start: number;
  /** Mask size. */
  width: number;
  height: number;
  /** Per frame: the share of the frame that is sky. */
  share: number[];
  /**
   * Per frame: how the distant scenery (and so the sky) has moved since the first frame, as a
   * similarity transform in mask pixels: [a, -b, tx, b, a, ty] of the 3x3 matrix's first two rows.
   */
  motion: number[][];
  /** Mean colors over the keyframes: the old sky, and its band just above the scenery. */
  colors: { sky?: string; horizon?: string };
  keyframes: number[];
}

/** Mask size for a source of `width` x `height`. */
function maskSize(width: number, height: number) {
  const k = Math.min(1, SKY_MASK_SIZE / Math.max(width, height));
  return { w: Math.max(32, Math.round((width * k) / 2) * 2), h: Math.max(32, Math.round((height * k) / 2) * 2) };
}

/**
 * Sky mattes of a source range at `fps`, written as raw gray frames (mask size) to `rawFile`, and the
 * track (camera motion, colors). See the module notes for the method.
 */
export async function trackSky(
  src: string,
  rawFile: string,
  opts: SkyOptions & { start: number; end: number; fps: number; segmenter?: SkySegmenter; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<SkyTrack> {
  const info = await probe(src, opts);
  if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${src}`);
  const ms = maskSize(info.width, info.height);
  const area = ms.w * ms.h;
  const still = info.isImage || info.duration === undefined;
  const from = still ? 0 : Math.max(0, opts.start);
  const to = still ? 0.04 : Math.min(info.duration!, Math.max(opts.end, from + 1 / opts.fps));
  const total = Math.max(1, Math.ceil((to - from) * opts.fps - 1e-6));
  const segmenter = opts.segmenter ?? new SkySegmenter(opts);
  const k = native();
  const step = Math.max(2, Math.round(opts.fps * KEY_SECONDS));
  await segmenter.expect(Math.ceil(total / step) + 1);
  const chunk = Math.max(step, Math.round((opts.fps * CHUNK_SECONDS) / step) * step);
  const radius = Math.max(2, Math.round(Math.min(ms.w, ms.h) * 0.01));
  const share: number[] = [];
  const motion: number[][] = [];
  const keyframes: number[] = [];
  const colorSums = { sky: [0, 0, 0, 0], horizon: [0, 0, 0, 0] };
  await rm(rawFile, { force: true });
  await mkdir(path.dirname(rawFile), { recursive: true });
  let prev: Uint8Array | undefined;
  let carried = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // The keyframe that ends one chunk starts the next, so it is segmented once.
  let first: { gray: Uint8Array; matte: Uint8Array } | undefined;
  /** 1 where the matte is not sky. */
  const scenery = (m: Uint8Array) => {
    const out = new Uint8Array(m.length);
    for (let q = 0; q < m.length; q++) out[q] = m[q]! < 128 ? 1 : 0;
    return out;
  };

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
    const rgb = wanted.length ? await decodeFrames(src, range, opts.fps, { w: SKY_INPUT, h: SKY_INPUT }, "rgb24", opts, wanted) : [];
    const mattes: (Uint8Array | undefined)[] = new Array(n);
    if (first) mattes[0] = first.matte;
    for (const [i, f] of wanted.entries()) {
      if (!rgb[i]) continue;
      const p = await segmenter.probability(rgb[i]!);
      const colors = skyColors(rgb[i]!, p);
      for (const kind of ["sky", "horizon"] as const) {
        const h = colors[kind];
        if (!h) continue;
        const s = colorSums[kind];
        [1, 3, 5].forEach((o, j) => (s[j]! += parseInt(h.slice(o, o + 2), 16)));
        s[3]!++;
      }
      mattes[f] = probabilityToMatte(resizeMask(p, SKY_INPUT, SKY_INPUT, ms.w, ms.h));
      keyframes.push(c0 + f);
      opts.onProgress?.(Math.min(0.99, (c0 + f + 1) / total));
    }
    const known = keys.filter((f) => mattes[f]);
    const pack = (idx: number[]) => {
      const out = new Uint8Array(idx.length * area);
      idx.forEach((f, i) => out.set(gray[f]!, i * area));
      return out;
    };
    const at = (arr: Uint8Array, i: number) => arr.subarray(i * area, (i + 1) * area);
    // Carrying the matte between keyframes needs no fine detail (the guided filter snaps edges later),
    // so it is tracked on half-size frames, four times less work.
    const [hw, hh] = [ms.w >> 1, ms.h >> 1];
    const small = gray.map((g) => halve(g, ms.w, ms.h));
    const packSmall = (idx: number[]) => {
      const out = new Uint8Array(idx.length * hw * hh);
      idx.forEach((f, i) => out.set(small[f]!, i * hw * hh));
      return out;
    };
    const carry = async (idx: number[], matte: Uint8Array) => {
      const r = await controlled({ signal: opts.signal }, (c) => k.trackRegion(packSmall(idx), hw, hh, idx.length, scenery(halve(matte, ms.w, ms.h)), { model: "affine" }, c));
      return doubleTransforms(r.matrices);
    };
    const chunkMotion: number[][] = new Array(n);
    chunkMotion[0] = carried;
    for (let s = 1; s < known.length; s++) {
      const [a, b] = [known[s - 1]!, known[s]!];
      const idx = Array.from({ length: b - a + 1 }, (_, i) => a + i);
      const last = idx.length - 1;
      // The scenery carries the edge: forward from a, backward from b, blended by distance.
      const fwd = await carry(idx, mattes[a]!);
      const fwdM = await k.warpMasks(mattes[a]!, ms.w, ms.h, fwd);
      const bwd = await carry(idx.slice().reverse(), mattes[b]!);
      const bwdM = await k.warpMasks(mattes[b]!, ms.w, ms.h, bwd);
      // Where a warp reaches outside the picture it has nothing (sky coming into view in a pan):
      // blend only what each direction saw, and where neither did, keep the nearer keyframe's matte.
      const ones = new Uint8Array(area).fill(255);
      const [fwdV, bwdV] = [await k.warpMasks(ones, ms.w, ms.h, fwd), await k.warpMasks(ones, ms.w, ms.h, bwd)];
      for (let i = 1; i < last; i++) {
        const u = i / last;
        const [f, g, fv, gv] = [at(fwdM, i), at(bwdM, last - i), at(fwdV, i), at(bwdV, last - i)];
        const near = u < 0.5 ? mattes[a]! : mattes[b]!;
        const m = new Uint8Array(area);
        for (let q = 0; q < area; q++) {
          // Warped values already fade with their validity (zeros outside), so divide by the validity they had.
          const valid = (fv[q]! / 255) * (1 - u) + (gv[q]! / 255) * u;
          m[q] = valid < 0.05 ? near[q]! : Math.min(255, Math.round((f[q]! * (1 - u) + g[q]! * u) / valid));
        }
        mattes[idx[i]!] = m;
      }
      // The camera: a band of distant scenery under the sky (or all the scenery when the band is thin).
      let band = horizonBand(mattes[a]!, ms.w, ms.h, Math.round(ms.h * 0.12));
      if (band.reduce((t, v) => t + v, 0) < area * 0.01) band = scenery(mattes[a]!);
      if (band.reduce((t, v) => t + v, 0) < area * 0.01) band = new Uint8Array(area).fill(1);
      // The camera at full size: the new sky's drift depends on it.
      const cam = await controlled({ signal: opts.signal }, (c) => k.trackRegion(pack(idx), ms.w, ms.h, idx.length, band, { model: "similarity" }, c));
      for (let i = 1; i <= last; i++) chunkMotion[idx[i]!] = compose(Array.from(cam.matrices.subarray(i * 9, i * 9 + 9)), chunkMotion[a]!);
    }
    // Edges snapped to the frame, then smoothed over time. The first frame of a later chunk was written already.
    const raw = new Uint8Array(n * area);
    for (let i = 0; i < n; i++) raw.set(mattes[i] ?? mattes[known[known.length - 1]!]!, i * area);
    const refined = await k.guidedFilter(pack(Array.from({ length: n }, (_, i) => i)), raw, ms.w, ms.h, radius, 1e-3);
    const startAt = first ? 1 : 0;
    const out = new Uint8Array((n - startAt) * area);
    for (let i = startAt; i < n; i++) {
      const cur = at(refined, i);
      const m = cur.slice();
      if (prev) for (let q = 0; q < area; q++) m[q] = Math.round(cur[q]! * 0.75 + prev[q]! * 0.25);
      out.set(m, (i - startAt) * area);
      let sky = 0;
      for (let q = 0; q < area; q += 4) if (m[q]! >= 128) sky++;
      share.push(round3(sky / (area / 4)));
      const t = chunkMotion[i] ?? carried;
      motion.push([t[0]!, t[1]!, t[2]!, t[3]!, t[4]!, t[5]!].map((v) => Math.round(v * 1e5) / 1e5));
      prev = m;
    }
    await appendFile(rawFile, out);
    carried = chunkMotion[n - 1] ?? carried;
    first = { gray: gray[n - 1]!, matte: mattes[n - 1]! };
    if (c1 >= total) break;
  }
  opts.onProgress?.(1);
  const mean = (s: number[]) => (s[3] ? hex([s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]]) : undefined);
  const sky = mean(colorSums.sky);
  const horizon = mean(colorSums.horizon);
  return { fps: opts.fps, start: round3(from), width: ms.w, height: ms.h, share, motion, colors: { ...(sky ? { sky } : {}), ...(horizon ? { horizon } : {}) }, keyframes };
}

/** The cache files (mask video and track) of the sky over a source range. */
export async function skyMaskFile(dir: string, file: string, range: { start: number; end: number }, fps: number): Promise<{ file: string; track: string; exists: boolean }> {
  const st = await stat(file).catch(() => undefined);
  const key = JSON.stringify({ v: SKY_MASK_VERSION, kind: "sky", model: SKY_MODEL.file, file, bytes: st?.size, mtime: st?.mtimeMs, start: round3(range.start), end: round3(range.end), fps });
  const base = path.join(dir, `sky-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  return { file: `${base}.mkv`, track: `${base}.json`, exists: await stat(`${base}.mkv`).then((s) => s.size > 0, () => false) };
}

/** Find the sky over a source range and write its mask video (FFV1 gray) and track (JSON). */
export async function writeSkyMask(src: string, output: { file: string; track: string }, opts: Parameters<typeof trackSky>[2]): Promise<SkyTrack> {
  await mkdir(path.dirname(output.file), { recursive: true });
  const part = `${output.file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
  const raw = `${part}.gray`;
  try {
    const track = await trackSky(src, raw, opts);
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${track.width}x${track.height}`, "-r", String(track.fps), "-i", raw, "-c:v", "ffv1", part], opts);
    await rename(part, output.file);
    await writeFile(output.track, JSON.stringify(track));
    return track;
  } finally {
    await rm(part, { force: true });
    await rm(raw, { force: true });
  }
}
