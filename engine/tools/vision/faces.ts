import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { bundledModelsDir, defaultModelsDir } from "../appdirs.js";
import path from "node:path";
import type { Fit, Position } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { probe, resolveFfmpegPath, type FfmpegOptions } from "../render/ffmpeg.js";

/**
 * Face detection that runs on this machine: OpenCV's YuNet model (MIT license, 230 KB) executed with
 * ONNX Runtime. It downloads once and then works offline, with no account or key. On a laptop CPU
 * it takes about 16 ms per frame and finds faces from about 10 pixels wide to frame-filling selfies.
 */
export const FACE_MODEL = {
  url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
  file: "face_detection_yunet_2023mar.onnx",
};

/** The model's square input size; frames are scaled to fit and padded. */
export const FACE_INPUT = 640;

/** A rectangle in frame fractions (0..1, may extend a little past the edges). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Face extends Box {
  /** 0..1 detection confidence. */
  score: number;
  /** Right eye, left eye, nose tip, right and left mouth corners (as seen in the picture), in frame fractions. */
  landmarks: [number, number][];
}

export interface FaceFrame {
  /** Seconds (source time for media, as given for frames). */
  time: number;
  faces: Face[];
}

export interface FaceDetectorOptions extends FfmpegOptions {
  /** Where the model is kept. Default $AVE_MODELS_DIR, else the models folder in the app cache (see appDir). */
  modelsDir?: string;
  /** Called while the model downloads on first use (0..1). */
  onDownload?: (progress: number) => void;
  /** Lowest confidence kept (default 0.6). */
  minScore?: number;
}

const iou = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const i = w * h;
  const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i;
  return u > 0 ? i / u : 0;
};

/**
 * Turn YuNet's raw outputs into faces. `content` is the size of the picture inside the padded
 * square input (it sits at the top left), so boxes come back as fractions of that picture.
 */
export function decodeYunet(outputs: Record<string, ArrayLike<number>>, content: { width: number; height: number }, minScore = 0.6): Face[] {
  const found: Face[] = [];
  for (const stride of [8, 16, 32]) {
    const n = FACE_INPUT / stride;
    const cls = outputs[`cls_${stride}`]!;
    const obj = outputs[`obj_${stride}`]!;
    const bbox = outputs[`bbox_${stride}`]!;
    const kps = outputs[`kps_${stride}`]!;
    for (let i = 0; i < n * n; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)));
      if (score < minScore) continue;
      const row = Math.floor(i / n);
      const col = i % n;
      const cx = (col + bbox[i * 4]!) * stride;
      const cy = (row + bbox[i * 4 + 1]!) * stride;
      const w = Math.exp(bbox[i * 4 + 2]!) * stride;
      const h = Math.exp(bbox[i * 4 + 3]!) * stride;
      const fx = (v: number) => round3(v / content.width);
      const fy = (v: number) => round3(v / content.height);
      const landmarks: [number, number][] = [];
      for (let k = 0; k < 5; k++) landmarks.push([fx((col + kps[i * 10 + 2 * k]!) * stride), fy((row + kps[i * 10 + 2 * k + 1]!) * stride)]);
      found.push({ x0: fx(cx - w / 2), y0: fy(cy - h / 2), x1: fx(cx + w / 2), y1: fy(cy + h / 2), score: round3(score), landmarks });
    }
  }
  // Keep the best of overlapping boxes.
  const kept: Face[] = [];
  for (const f of found.sort((a, b) => b.score - a.score)) if (!kept.some((k) => iou(k, f) > 0.3)) kept.push(f);
  return kept;
}

/** Models folder shared with the other local models. */
export function modelsDir(opts: { modelsDir?: string } = {}): string {
  return opts.modelsDir ?? defaultModelsDir();
}

/** A model file in the models folder, downloaded on first use. */
export async function ensureModelFile(
  opts: { modelsDir?: string; onDownload?: (p: number) => void },
  folder: string,
  model: { url: string; file: string; /** Smallest complete size (default 100 KB). */ minBytes?: number },
): Promise<string> {
  const complete = (f: string) => stat(f).then((s) => s.size > (model.minBytes ?? 100_000), () => false);
  // An installed app carries its models: used in place, nothing to download.
  const bundled = opts.modelsDir ? undefined : bundledModelsDir();
  if (bundled && (await complete(path.join(bundled, folder, model.file)))) return path.join(bundled, folder, model.file);
  const dir = path.join(modelsDir(opts), folder);
  const file = path.join(dir, model.file);
  if (await complete(file)) return file;
  await mkdir(dir, { recursive: true });
  const res = await fetch(model.url);
  if (!res.ok || !res.body) throw new Error(`Could not download the model (${res.status}) from ${model.url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks: Uint8Array[] = [];
  let got = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    got += chunk.length;
    if (total) opts.onDownload?.(got / total);
  }
  const part = `${file}.${process.pid}.part`;
  await writeFile(part, Buffer.concat(chunks));
  await rename(part, file).catch(async (e) => {
    await rm(part, { force: true });
    if (!(await stat(file).then(() => true, () => false))) throw e;
  });
  return file;
}

export type OrtSession = { run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>> };
export type Ort = { InferenceSession: { create(file: string, opts?: object): Promise<OrtSession> }; Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown };

/** ONNX Runtime, an optional package. */
export async function loadOrt(what: string): Promise<Ort> {
  try {
    return (await import("onnxruntime-node" as string)) as Ort;
  } catch {
    throw new Error(`${what} needs the optional package onnxruntime-node (it comes with @huggingface/transformers; npm install onnxruntime-node).`);
  }
}

/** The graphics card provider for each system: DirectML on Windows, CoreML on macOS, CUDA on Linux (when installed). */
export const gpuProvider = (platform: NodeJS.Platform = process.platform): string | undefined =>
  platform === "win32" ? "dml" : platform === "darwin" ? "coreml" : platform === "linux" ? "cuda" : undefined;

/**
 * ONNX Runtime execution providers to try, best first, or "auto" (the default): measure this
 * system's graphics card provider against the CPU on this computer (see createOrtSession).
 * $AVE_ORT_PROVIDERS sets them instead: "cpu", "gpu" (this system's graphics card provider) or a
 * comma separated list such as "dml,cpu". The CPU is always the last resort.
 */
export function ortProviders(platform: NodeJS.Platform = process.platform, env = process.env): string[] | "auto" {
  const asked = (env.AVE_ORT_PROVIDERS ?? "auto").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (asked[0] === "auto" || !asked.length) return gpuProvider(platform) ? "auto" : ["cpu"];
  const list = asked.flatMap((p) => (p === "gpu" ? [gpuProvider(platform) ?? "cpu"] : [p]));
  return [...new Set([...list, "cpu"])];
}

/** Runs timed on each provider before choosing (after one untimed warm-up run each). */
const MEASURED_RUNS = 3;
/**
 * Runs a typical job makes with one session (a clip of about 20 seconds at 24 frames a second): the
 * graphics card is chosen only when its saving over these pays back the longer time it takes to
 * set up a session. Found on real use: DirectML took 13 to 40 s to set up the person cutout, which
 * it then ran 5 ms faster a frame, so the app's first matte of each session waited half a minute.
 */
const TYPICAL_RUNS = 500;

/** The provider measured for a model on this computer, kept next to the model file. */
export interface ProviderChoice {
  provider: string;
  /** Median milliseconds per run on each provider (absent when the provider failed). */
  ms: Record<string, number>;
  /** Milliseconds to set up a session on each provider. Choices saved without it are measured again. */
  setupMs?: Record<string, number>;
  measuredAt: string;
}

export const providerChoiceFile = (modelFile: string) => `${modelFile}.provider.json`;

/**
 * A model session on the best execution provider for this computer. With "auto" (the default),
 * the first runs go through both the graphics card provider and the CPU, timing each, and return
 * the CPU's answer so results never depend on the measurement; then the faster one is kept, and
 * remembered next to the model file (delete that file to measure again, e.g. after a new graphics
 * card). Any provider that fails to load, or fails on a run, falls back to the CPU.
 */
export async function createOrtSession(ort: Ort, file: string, providers = ortProviders()): Promise<OrtSession> {
  const base = { logSeverityLevel: 3 };
  const cpu = () => ort.InferenceSession.create(file, base);
  const on = async (list: string[]) => (list[0] === "cpu" ? undefined : await ort.InferenceSession.create(file, { ...base, executionProviders: list }).catch(() => undefined));

  if (providers !== "auto") {
    if (providers[0] === "cpu") return cpu();
    const session = await on(providers);
    return session ? withCpuFallback(session, cpu) : cpu();
  }

  const gpu = gpuProvider()!;
  const saved = await readFile(providerChoiceFile(file), "utf8").then((t) => JSON.parse(t) as ProviderChoice, () => undefined);
  // A choice made before setup time counted is made again, unless it was the CPU, which sets up at once.
  if (saved && (saved.setupMs || saved.provider === "cpu")) {
    const session = saved.provider === "cpu" ? undefined : await on([saved.provider, "cpu"]);
    return session ? withCpuFallback(session, cpu) : cpu();
  }

  let t0 = performance.now();
  const cpuSession = await cpu();
  const setupMs: Record<string, number> = { cpu: Math.round(performance.now() - t0) };
  t0 = performance.now();
  const gpuSession = await on([gpu, "cpu"]);
  setupMs[gpu] = Math.round(performance.now() - t0);
  const choose = async (choice: Omit<ProviderChoice, "measuredAt">) => {
    await writeFile(providerChoiceFile(file), JSON.stringify({ ...choice, measuredAt: new Date().toISOString() }, null, 2)).catch(() => undefined);
    return choice.provider;
  };
  if (!gpuSession) {
    await choose({ provider: "cpu", ms: {}, setupMs });
    return cpuSession;
  }

  const times: Record<string, number[]> = { cpu: [], [gpu]: [] };
  let chosen: string | undefined;
  const timed = async (name: string, s: OrtSession, feeds: Record<string, unknown>, warm: boolean) => {
    const t = performance.now();
    const out = await s.run(feeds);
    if (!warm) times[name]!.push(performance.now() - t);
    return out;
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  let runs = 0;
  return {
    run: async (feeds) => {
      if (chosen === "cpu") return cpuSession.run(feeds);
      if (chosen) return gpuSession.run(feeds).catch(() => cpuSession.run(feeds));
      const warm = runs++ === 0;
      const answer = await timed("cpu", cpuSession, feeds, warm);
      try {
        await timed(gpu, gpuSession, feeds, warm);
      } catch {
        chosen = await choose({ provider: "cpu", ms: times.cpu!.length ? { cpu: median(times.cpu!) } : {}, setupMs });
        return answer;
      }
      if (times.cpu!.length >= MEASURED_RUNS) {
        const ms = { cpu: median(times.cpu!), [gpu]: median(times[gpu]!) };
        const pays = (ms.cpu - ms[gpu]!) * TYPICAL_RUNS > setupMs[gpu]! - setupMs.cpu!;
        chosen = await choose({ provider: pays ? gpu : "cpu", ms, setupMs });
      }
      return answer;
    },
  };
}

/** A provider can load a model and still lack one of its operators: switch to the CPU once, then stay there. */
function withCpuFallback(session: OrtSession, cpu: () => Promise<OrtSession>): OrtSession {
  let fallback: Promise<OrtSession> | undefined;
  return {
    run: async (feeds) => {
      if (fallback) return (await fallback).run(feeds);
      try {
        return await session.run(feeds);
      } catch {
        fallback ??= cpu();
        return (await fallback).run(feeds);
      }
    },
  };
}

const sessions = new Map<string, Promise<{ ort: Ort; session: OrtSession }>>();

/** Finds faces in pictures and videos. One model session is shared per models folder. */
export class FaceDetector {
  constructor(private readonly options: FaceDetectorOptions = {}) {}

  private load(): Promise<{ ort: Ort; session: OrtSession }> {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async () => {
        const ort = await loadOrt("Face detection");
        const file = await ensureModelFile(this.options, "yunet", FACE_MODEL);
        return { ort, session: await createOrtSession(ort, file) };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  /**
   * Faces in one picture already fitted into the model's square (RGB24, FACE_INPUT x FACE_INPUT,
   * picture of `content` size at the top left, black padding elsewhere).
   */
  async detectSquare(rgb: Uint8Array, content: { width: number; height: number }): Promise<Face[]> {
    const { ort, session } = await this.load();
    const S = FACE_INPUT;
    const data = new Float32Array(3 * S * S);
    // The model takes BGR planes with 0..255 values.
    for (let i = 0; i < S * S; i++) {
      data[i] = rgb[i * 3 + 2]!;
      data[S * S + i] = rgb[i * 3 + 1]!;
      data[2 * S * S + i] = rgb[i * 3]!;
    }
    const out = await session.run({ input: new ort.Tensor("float32", data, [1, 3, S, S]) });
    return decodeYunet(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.data])), content, this.options.minScore);
  }

  /** Faces in an RGB24 frame of any size (resized to fit the model's input). */
  async detectRgb(rgb: Uint8Array, width: number, height: number): Promise<Face[]> {
    const k = Math.min(1, FACE_INPUT / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const S = FACE_INPUT;
    const square = new Uint8Array(S * S * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const src = (Math.min(height - 1, Math.floor(y / k)) * width + Math.min(width - 1, Math.floor(x / k))) * 3;
        const dst = (y * S + x) * 3;
        square[dst] = rgb[src]!;
        square[dst + 1] = rgb[src + 1]!;
        square[dst + 2] = rgb[src + 2]!;
      }
    return this.detectSquare(square, { width: w, height: h });
  }

  /**
   * Faces in a video (or image) file, sampled `fps` times a second over a source time range. Frames
   * are read upright (phone rotation applied). Times are source seconds.
   */
  async detectFile(file: string, opts: { start?: number; end?: number; fps?: number; onProgress?: (p: number) => void } = {}): Promise<{ width: number; height: number; frames: FaceFrame[] }> {
    const info = await probe(file, this.options);
    if (!info.width || !info.height) throw new Error(`Could not read the picture size of ${file}`);
    const scale = Math.min(1, FACE_INPUT / Math.max(info.width, info.height));
    const w = Math.max(2, Math.floor((info.width * scale) / 2) * 2);
    const h = Math.max(2, Math.floor((info.height * scale) / 2) * 2);
    const still = info.isImage || info.duration === undefined;
    const start = still ? 0 : Math.max(0, opts.start ?? 0);
    const end = still ? 0 : Math.min(opts.end ?? info.duration!, info.duration!);
    const fps = opts.fps ?? 2;
    const args = [
      "-hide_banner", "-loglevel", "error",
      ...(start > 0 ? ["-ss", String(round3(start))] : []),
      ...(still ? [] : ["-t", String(round3(Math.max(0.05, end - start)))]),
      "-i", file,
      "-an",
      "-vf", `${still ? "" : `fps=${fps},`}scale=${w}:${h},pad=${FACE_INPUT}:${FACE_INPUT}:0:0:black`,
      ...(still ? ["-frames:v", "1"] : []),
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ];
    await this.load();
    const proc = spawn(resolveFfmpegPath(this.options), args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()).length > 20_000 && (stderr = stderr.slice(-10_000)));
    const exited = new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? -1));
    });
    const size = FACE_INPUT * FACE_INPUT * 3;
    const frames: FaceFrame[] = [];
    const expected = still ? 1 : Math.max(1, Math.ceil((end - start) * fps));
    let pending: Buffer = Buffer.alloc(0);
    // Reading the stream frame by frame keeps memory small for long recordings.
    for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        const faces = await this.detectSquare(pending.subarray(0, size), { width: w, height: h });
        frames.push({ time: round3(start + frames.length / fps), faces });
        pending = pending.subarray(size);
        opts.onProgress?.(Math.min(1, frames.length / expected));
      }
    }
    const code = await exited;
    if (code !== 0) throw new Error(`ffmpeg could not read ${file}: ${stderr.trim().split("\n").pop()}`);
    return { width: info.width, height: info.height, frames };
  }
}

// ---------------------------------------------------------------------------
// Following faces over time
// ---------------------------------------------------------------------------

export interface FaceTrack {
  id: number;
  start: number;
  end: number;
  frames: { time: number; face: Face }[];
  /** Median box over the track. */
  box: Box;
  /** Smallest box holding the face at every sampled moment. */
  extent: Box;
}

const center = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/**
 * Link the faces found in successive frames into tracks, one per person: a face continues the track
 * whose last box it overlaps or sits close to, within `maxGap` seconds. One-frame tracks are dropped
 * as noise when there are several frames.
 */
export function trackFaces(frames: FaceFrame[], opts: { maxGap?: number } = {}): FaceTrack[] {
  const maxGap = opts.maxGap ?? 1.5;
  const tracks: FaceTrack[] = [];
  for (const fr of frames) {
    const taken = new Set<FaceTrack>();
    for (const face of [...fr.faces].sort((a, b) => b.score - a.score)) {
      const c = center(face);
      const size = face.x1 - face.x0;
      let best: FaceTrack | undefined;
      let bestScore = 0;
      for (const t of tracks) {
        if (taken.has(t) || fr.time - t.end > maxGap) continue;
        const last = t.frames[t.frames.length - 1]!.face;
        const lc = center(last);
        const near = 1 - Math.hypot(c.x - lc.x, c.y - lc.y) / Math.max(size, last.x1 - last.x0, 1e-6);
        const s = Math.max(iou(last, face), near * 0.5);
        if (s > 0.15 && s > bestScore) [best, bestScore] = [t, s];
      }
      if (!best) {
        best = { id: tracks.length + 1, start: fr.time, end: fr.time, frames: [], box: face, extent: face };
        tracks.push(best);
      }
      taken.add(best);
      best.frames.push({ time: fr.time, face });
      best.end = fr.time;
    }
  }
  const kept = tracks.filter((t) => frames.length < 3 || t.frames.length > 1);
  for (const [i, t] of kept.entries()) {
    t.id = i + 1;
    const b = t.frames.map((f) => f.face);
    t.box = { x0: median(b.map((f) => f.x0)), y0: median(b.map((f) => f.y0)), x1: median(b.map((f) => f.x1)), y1: median(b.map((f) => f.y1)) };
    t.extent = { x0: Math.min(...b.map((f) => f.x0)), y0: Math.min(...b.map((f) => f.y0)), x1: Math.max(...b.map((f) => f.x1)), y1: Math.max(...b.map((f) => f.y1)) };
  }
  return kept;
}

// ---------------------------------------------------------------------------
// From the source picture to the edit's frame
// ---------------------------------------------------------------------------

/** How a source picture lands in the output frame for a clip's fit (scale and offset per axis, in output fractions). */
export function fitTransform(src: { width: number; height: number }, out: { width: number; height: number }, fit: Fit, focus?: Position) {
  if (fit === "stretch") return { sx: 1, sy: 1, ox: 0, oy: 0 };
  const k = fit === "cover" ? Math.max(out.width / src.width, out.height / src.height) : Math.min(out.width / src.width, out.height / src.height);
  const sx = (src.width * k) / out.width;
  const sy = (src.height * k) / out.height;
  if (fit !== "cover") return { sx, sy, ox: (1 - sx) / 2, oy: (1 - sy) / 2 };
  const fx = Math.min(1, Math.max(0, focus?.x ?? 0.5));
  const fy = Math.min(1, Math.max(0, focus?.y ?? 0.5));
  return { sx, sy, ox: -(sx - 1) * fx, oy: -(sy - 1) * fy };
}

/** A box in source fractions mapped into the output frame, or undefined when cropped out entirely. */
export function sourceToFrame(box: Box, src: { width: number; height: number }, out: { width: number; height: number }, fit: Fit, focus?: Position): Box | undefined {
  const t = fitTransform(src, out, fit, focus);
  const b = { x0: t.ox + box.x0 * t.sx, y0: t.oy + box.y0 * t.sy, x1: t.ox + box.x1 * t.sx, y1: t.oy + box.y1 * t.sy };
  if (b.x1 <= 0 || b.x0 >= 1 || b.y1 <= 0 || b.y0 >= 1) return undefined;
  return { x0: round3(b.x0), y0: round3(b.y0), x1: round3(b.x1), y1: round3(b.y1) };
}

/** The inverse of sourceToFrame: a box in output frame fractions as source fractions (clamped to the source). */
export function frameToSource(box: Box, src: { width: number; height: number }, out: { width: number; height: number }, fit: Fit, focus?: Position): Box {
  const t = fitTransform(src, out, fit, focus);
  const c = (v: number) => round3(Math.min(1, Math.max(0, v)));
  return { x0: c((box.x0 - t.ox) / t.sx), y0: c((box.y0 - t.oy) / t.sy), x1: c((box.x1 - t.ox) / t.sx), y1: c((box.y1 - t.oy) / t.sy) };
}

/**
 * The cover-fit focus that keeps `box` (source fractions) in frame, centered where the crop allows.
 * When the box is wider than what the crop shows, it centers the box.
 */
export function focusOn(box: Box, src: { width: number; height: number }, out: { width: number; height: number }): Position {
  const t = fitTransform(src, out, "cover");
  const axis = (s: number, a: number, b: number) => {
    if (s <= 1 + 1e-6) return 0.5;
    // Offset that puts the box's center in the middle of the frame, as a share of the crop margin.
    const c = ((a + b) / 2) * s - 0.5;
    return round3(Math.min(1, Math.max(0, c / (s - 1))));
  };
  return { x: axis(t.sx, box.x0, box.x1), y: axis(t.sy, box.y0, box.y1) };
}

/** An ellipse (center and size, frame fractions) around a face, for skin retouch. */
export function faceRegion(box: Box): { x: number; y: number; width: number; height: number } {
  const c = center(box);
  return { x: round3(Math.min(1, Math.max(0, c.x))), y: round3(Math.min(1, Math.max(0, c.y))), width: round3(Math.min(2, (box.x1 - box.x0) * 1.5)), height: round3(Math.min(2, (box.y1 - box.y0) * 1.5)) };
}

/**
 * An ellipse around the whole person, estimated from the face: a little above the head, about three
 * face widths across the shoulders, and down to the bottom of the frame. For portrait-mode blur.
 */
export function personRegion(box: Box): { x: number; y: number; width: number; height: number } {
  const fw = box.x1 - box.x0;
  const fh = box.y1 - box.y0;
  const top = Math.max(0, box.y0 - fh * 0.35);
  const bottom = Math.min(1.2, box.y1 + fh * 5);
  const c = center(box);
  return {
    x: round3(Math.min(1, Math.max(0, c.x))),
    y: round3(Math.min(1, (top + bottom) / 2)),
    width: round3(Math.min(2, fw * 3.4)),
    height: round3(Math.min(2, (bottom - top) * 1.15)),
  };
}
