import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { deepClone } from "../../core/util.js";
import { compileProject, type CompileOptions, type CompiledRender } from "./compile.js";
import { planSegments, pruneCache, segmentProject, touchSegments, type SegmentPlan } from "./cache.js";
import { detectHardwareEncoder, wantsHardware } from "./hardware.js";
import { computeTimeline } from "../../core/timeline.js";
import { usesPersonMask } from "../../library/effects/index.js";
import { PersonSegmenter, maskFile } from "../vision/segment.js";
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

interface MaskJob {
  file: string;
  exists: boolean;
  src: string;
  range: { start: number; end: number };
  fps: number;
}

/**
 * The person cutout file of each video clip whose effects use one (see PersonSegmenter), kept in the
 * cache folder (or the system temp folder). Only names them; makeMasks makes the missing ones.
 */
async function planMasks(p: Project, opts: Omit<RenderOptions, "output">): Promise<Map<string, MaskJob>> {
  const jobs = new Map<string, MaskJob>();
  const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "masks");
  for (const tc of computeTimeline(p).clips) {
    if (tc.asset.type !== "video" || !tc.clip.effects.some(usesPersonMask)) continue;
    const src = /^[a-z]+:\/\//i.test(tc.asset.src) ? tc.asset.src : path.resolve(opts.baseDir ?? process.cwd(), tc.asset.src);
    // One mask frame per output frame, counted in source time.
    const fps = Math.min(60, Math.max(1, Math.round(p.settings.fps * tc.clip.speed)));
    const range = { start: tc.clip.in, end: tc.clip.in + tc.sourceDuration };
    jobs.set(tc.clip.id, { ...(await maskFile(dir, src, range, fps)), src, range, fps });
  }
  return jobs;
}

/** Make the missing cutouts of the clips in `only` (a few seconds per clip second on a laptop). */
async function makeMasks(jobs: Map<string, MaskJob>, only: Iterable<string>, opts: Omit<RenderOptions, "output">): Promise<void> {
  let segmenter: PersonSegmenter | undefined;
  for (const id of only) {
    const job = jobs.get(id);
    if (!job || job.exists) continue;
    segmenter ??= new PersonSegmenter({ ffmpegPath: opts.ffmpegPath });
    await segmenter.writeMask(job.src, job.file, { ...job.range, fps: job.fps, signal: opts.signal });
    job.exists = true;
  }
}

const maskFiles = (jobs: Map<string, MaskJob>) => Object.fromEntries([...jobs].map(([id, j]) => [id, j.file]));

/** Cutouts and cached clips for a render: `create` fills the cache; clips not taken from it get their cutouts made. */
async function prepare(p: Project, opts: Omit<RenderOptions, "output">, create: boolean, until?: number) {
  const jobs = await planMasks(p, opts);
  const { segments, share } = await cachedSegments(p, opts, create, until, jobs);
  await makeMasks(jobs, p.clips.filter((c) => !segments?.[c.id]).map((c) => c.id), opts);
  return { segments, share, masks: maskFiles(jobs) };
}

/** Clips rendered into the cache at once. Filters already use several threads, so this stays small. */
const SEGMENT_JOBS = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)));

/** Render one clip's picture into the cache, through a temporary file so a crash never leaves a broken entry. */
async function renderSegment(p: Project, seg: SegmentPlan, opts: Omit<RenderOptions, "output">, masks: Record<string, string>, onProgress?: (fraction: number) => void): Promise<void> {
  const one = segmentProject(p, seg.clip.clip);
  const part = seg.file.replace(/\.mkv$/, `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`);
  const compiled = compileProject(one, { output: part, scale: opts.scale, baseDir: opts.baseDir, fontsDir: opts.fontsDir, segment: true, masks });
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
async function cachedSegments(
  p: Project,
  opts: Omit<RenderOptions, "output">,
  create: boolean,
  until = Infinity,
  jobs: Map<string, MaskJob> = new Map(),
): Promise<{ segments?: Record<string, string>; share: number }> {
  if (!opts.cacheDir) return { share: 0 };
  await mkdir(opts.cacheDir, { recursive: true });
  const masks = maskFiles(jobs);
  const plan = await planSegments(p, { cacheDir: opts.cacheDir, baseDir: opts.baseDir, fontsDir: opts.fontsDir, scale: opts.scale, masks });
  const missing = create ? plan.filter((x) => !x.exists && x.clip.start < until) : [];
  const work = missing.reduce((n, x) => n + x.clip.duration, 0);
  // Rendering a clip into the cache costs about as much as rendering it in the final pass.
  const share = work / (work + Math.min(until, plan.at(-1)?.clip.end ?? 0) + 1e-9);
  const done = new Map<SegmentPlan, number>();
  await makeMasks(jobs, missing.map((x) => x.clip.clip.id), opts);
  const queue = [...missing];
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      const seg = x;
      await renderSegment(p, seg, opts, masks, (f) => {
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
  const { segments, share, masks } = await prepare(p, opts, true, opts.range?.end);
  const hardwareEncoder =
    opts.hardware !== false && wantsHardware(p.export.videoCodec, opts.preset ?? p.export.preset) ? await detectHardwareEncoder(opts) : undefined;
  let compiled = compileProject(p, { ...opts, segments, masks, hardwareEncoder });
  let workDir: string | undefined;
  try {
    ({ workDir } = await execute(compiled, { ...opts, ...after(opts, share) }));
  } catch (e) {
    // A graphics driver can refuse a stream its test encode accepted (size limits, busy device).
    if (!hardwareEncoder || opts.signal?.aborted) throw e;
    compiled = compileProject(p, { ...opts, segments, masks });
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
  const { segments, masks } = await prepare(p, opts, false);
  const compiled = compileProject(p, { ...opts, segments, masks, frameAt: time });
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
  const { segments, masks } = await prepare(p, opts, true);
  const compiled = compileProject(p, {
    ...opts,
    segments,
    masks,
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
  const { segments, share, masks } = await prepare(p, opts, true);
  const compiled = compileProject(p, { ...opts, segments, masks, output: "", analysis: { framesAt: opts.framesAt, audio: opts.audio } });
  const audio = opts.audio ? [opts.audio.mix, opts.audio.voice, opts.audio.music].filter((f): f is string => !!f) : [];
  const { stdout } = await execute(compiled, { ...opts, ...after(opts, share), output: "" }, audio);
  opts.onProgress?.(1);
  const size = compiled.width * compiled.height * 3;
  const times = compiled.frameTimes ?? [];
  const frames: AnalysisFrame[] = [];
  for (let i = 0; stdout && i < times.length && (i + 1) * size <= stdout.length; i++) frames.push({ time: times[i]!, rgb: stdout.subarray(i * size, (i + 1) * size) });
  return { width: compiled.width, height: compiled.height, frames };
}
