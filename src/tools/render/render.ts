import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { deepClone } from "../../core/util.js";
import { compileProject, type CompileOptions, type CompiledRender } from "./compile.js";
import { planSegments, pruneCache, touchSegments, type SegmentPlan } from "./cache.js";
import { detectHardwareEncoder, wantsHardware } from "./hardware.js";
import { probe, runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";

export interface RenderOptions extends Omit<CompileOptions, "frameAt" | "segments" | "segment" | "hardwareEncoder">, FfmpegOptions {
  /**
   * Encode on the graphics card (NVENC, Quick Sync or AMF) when one works and the x264 preset is
   * slower than veryfast, falling back to x264 if it fails (default true).
   */
  hardware?: boolean;
  /**
   * Render cache folder. Each clip's picture (source, fit, effects, fades and per-frame global
   * effects) is kept there and reused until something about the clip changes, so a re-render only
   * processes changed clips. Without it, everything is rendered from the sources every time.
   */
  cacheDir?: string;
  /** Size limit of the cache folder in bytes; least recently used clips go first (default 4 GB). */
  cacheBytes?: number;
  /** Probe assets with unknown duration/size/audio before compiling (default true). */
  probe?: boolean;
  /** Keep the work directory (graph + ASS files) for debugging. */
  keepWorkDir?: boolean;
  /** Progress callback: 0..1 */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  output: string;
  duration: number;
  workDir?: string;
  args: string[];
}

/** Fill in missing asset metadata (duration, dimensions, audio presence) by probing files. */
export async function probeAssets(project: Project, opts: FfmpegOptions & { baseDir?: string } = {}): Promise<Project> {
  const out = deepClone(project);
  const baseDir = opts.baseDir ?? process.cwd();
  await Promise.all(
    out.assets.map(async (asset) => {
      if (asset.type === "color" || asset.type === "gradient") return;
      const needs =
        asset.type === "video"
          ? asset.duration === undefined || asset.hasAudio === undefined || asset.width === undefined
          : asset.type === "audio"
            ? asset.duration === undefined
            : asset.width === undefined;
      if (!needs || /^[a-z]+:\/\//i.test(asset.src)) return;
      const info = await probe(path.resolve(baseDir, asset.src), opts);
      if (asset.type === "video") {
        asset.duration ??= info.duration;
        asset.hasAudio ??= info.hasAudio;
        asset.width ??= info.width;
        asset.height ??= info.height;
      } else if (asset.type === "audio") {
        asset.duration ??= info.duration;
      } else {
        asset.width ??= info.width;
        asset.height ??= info.height;
      }
    }),
  );
  return out;
}

async function execute(compiled: CompiledRender, opts: RenderOptions, outputs = [opts.output]): Promise<{ workDir?: string; stdout?: Buffer }> {
  const workDir = await mkdtemp(path.join(tmpdir(), "ave-render-"));
  try {
    for (const f of compiled.files) await writeFile(path.join(workDir, f.name), f.content, "utf8");
    for (const out of outputs) await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    const res = await runFfmpegOrThrow(compiled.args, {
      ffmpegPath: opts.ffmpegPath,
      cwd: workDir,
      signal: opts.signal,
      binaryStdout: !!compiled.frameTimes?.length,
      onProgress: opts.onProgress && compiled.duration > 0 ? (s) => opts.onProgress!(Math.min(1, s / compiled.duration)) : undefined,
    });
    return { workDir: opts.keepWorkDir ? workDir : undefined, stdout: res.stdoutBuffer };
  } finally {
    if (!opts.keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}

/** Clips rendered into the cache at once. Filters already use several threads, so this stays small. */
const SEGMENT_JOBS = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)));

/** Render one clip's picture into the cache, through a temporary file so a crash never leaves a broken entry. */
async function renderSegment(p: Project, seg: SegmentPlan, opts: Omit<RenderOptions, "output">, onProgress?: (fraction: number) => void): Promise<void> {
  const one: Project = { ...p, clips: [{ ...seg.clip.clip, transition: undefined, muted: true }], layers: [], audio: [], captions: undefined, audioEffects: [] };
  const part = seg.file.replace(/.mkv$/, `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`);
  const compiled = compileProject(one, { output: part, scale: opts.scale, baseDir: opts.baseDir, fontsDir: opts.fontsDir, segment: true });
  try {
    await execute(compiled, { output: part, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress });
    await rename(part, seg.file);
  } finally {
    await rm(part, { force: true });
  }
}

/**
 * The cached clip pictures to use for a render, when `opts.cacheDir` is set. With `create`, clips
 * not cached yet (and starting before `until`) are rendered first, a few at a time; otherwise only
 * what is already cached is used. Reports progress as `share` of the whole job.
 */
async function cachedSegments(p: Project, opts: Omit<RenderOptions, "output">, create: boolean, until = Infinity): Promise<{ segments?: Record<string, string>; share: number }> {
  if (!opts.cacheDir) return { share: 0 };
  await mkdir(opts.cacheDir, { recursive: true });
  const plan = await planSegments(p, { cacheDir: opts.cacheDir, baseDir: opts.baseDir, scale: opts.scale });
  const missing = create ? plan.filter((x) => !x.exists && x.clip.start < until) : [];
  const work = missing.reduce((n, x) => n + x.clip.duration, 0);
  // Rendering a clip into the cache costs about as much as rendering it in the final pass.
  const share = work / (work + Math.min(until, plan.at(-1)?.clip.end ?? 0) + 1e-9);
  const done = new Map<SegmentPlan, number>();
  const queue = [...missing];
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const seg = x;
      await renderSegment(p, seg, opts, (f) => {
        done.set(seg, f * seg.clip.duration);
        opts.onProgress?.((share * [...done.values()].reduce((a, b) => a + b, 0)) / work);
      });
      seg.exists = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEGMENT_JOBS, missing.length) }, worker));
  const ready = plan.filter((x) => x.exists);
  await touchSegments(ready.map((x) => x.file));
  await pruneCache(opts.cacheDir, opts.cacheBytes);
  return { segments: Object.fromEntries(ready.map((x) => [x.clip.clip.id, x.file])), share: missing.length ? share : 0 };
}

/** Progress of the final pass, after the share spent filling the cache. */
const after = (opts: Omit<RenderOptions, "output">, share: number) => (opts.onProgress ? { onProgress: (f: number) => opts.onProgress!(share + (1 - share) * f) } : {});

/** Render a project to a video file. */
export async function render(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const p = opts.probe === false ? project : await probeAssets(project, opts);
  const { segments, share } = await cachedSegments(p, opts, true, opts.range?.end);
  const hardwareEncoder =
    opts.hardware !== false && wantsHardware(p.export.videoCodec, opts.preset ?? p.export.preset) ? await detectHardwareEncoder(opts) : undefined;
  let compiled = compileProject(p, { ...opts, segments, hardwareEncoder });
  let workDir: string | undefined;
  try {
    ({ workDir } = await execute(compiled, { ...opts, ...after(opts, share) }));
  } catch (e) {
    // A graphics driver can refuse a stream its test encode accepted (size limits, busy device).
    if (!hardwareEncoder || opts.signal?.aborted) throw e;
    compiled = compileProject(p, { ...opts, segments });
    ({ workDir } = await execute(compiled, { ...opts, ...after(opts, share) }));
  }
  opts.onProgress?.(1);
  return { output: path.resolve(opts.output), duration: compiled.duration, workDir, args: compiled.args };
}

/** Render a single frame (PNG/JPG) at a timeline time, lets an AI "look" at its edit. */
export async function renderFrame(
  project: Project,
  time: number,
  opts: Omit<RenderOptions, "range" | "onProgress">,
): Promise<string> {
  const p = opts.probe === false ? project : await probeAssets(project, opts);
  // One frame does not pay for caching clips, but uses those already cached.
  const { segments } = await cachedSegments(p, opts, false);
  const compiled = compileProject(p, { ...opts, segments, frameAt: time });
  await execute(compiled, opts);
  return path.resolve(opts.output);
}

/**
 * Render a contact sheet: a grid of frames sampled evenly across the video.
 * One image gives an AI a quick overview of the whole edit.
 */
export async function renderContactSheet(
  project: Project,
  opts: Omit<RenderOptions, "range" | "onProgress"> & { columns?: number; rows?: number; thumbWidth?: number },
): Promise<string> {
  const p = opts.probe === false ? project : await probeAssets(project, opts);
  const { segments } = await cachedSegments(p, opts, true);
  const compiled = compileProject(p, {
    ...opts,
    segments,
    contactSheet: { columns: opts.columns ?? 4, rows: opts.rows ?? 3, thumbWidth: opts.thumbWidth ?? 360 },
  });
  await execute(compiled, opts);
  return path.resolve(opts.output);
}

export interface AnalysisFrame {
  /** Timeline time of the frame (snapped to the frame grid). */
  time: number;
  /** Packed RGB24 pixels, width * height * 3 bytes. */
  rgb: Buffer;
}

/**
 * Render for measurement in one pass: raw frames at chosen timeline times and/or the audio mix
 * with its voice and music submixes as WAV files. Use a small `scale`: the frames are only
 * measured, and the video graph runs even when only the audio is wanted.
 */
export async function renderForAnalysis(
  project: Project,
  opts: Omit<RenderOptions, "output" | "range"> & { framesAt?: number[]; audio?: { mix: string; voice?: string; music?: string } },
): Promise<{ width: number; height: number; frames: AnalysisFrame[] }> {
  const p = opts.probe === false ? project : await probeAssets(project, opts);
  const { segments, share } = await cachedSegments(p, opts, true);
  const compiled = compileProject(p, { ...opts, segments, output: "", analysis: { framesAt: opts.framesAt, audio: opts.audio } });
  const audio = opts.audio ? [opts.audio.mix, opts.audio.voice, opts.audio.music].filter((f): f is string => !!f) : [];
  const { stdout } = await execute(compiled, { ...opts, ...after(opts, share), output: "" }, audio);
  opts.onProgress?.(1);
  const size = compiled.width * compiled.height * 3;
  const times = compiled.frameTimes ?? [];
  const frames: AnalysisFrame[] = [];
  for (let i = 0; stdout && i < times.length && (i + 1) * size <= stdout.length; i++) frames.push({ time: times[i]!, rgb: stdout.subarray(i * size, (i + 1) * size) });
  return { width: compiled.width, height: compiled.height, frames };
}
