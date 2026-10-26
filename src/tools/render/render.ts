import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { deepClone } from "../../core/util.js";
import { compileProject, type CompileOptions, type CompiledRender } from "./compile.js";
import { probe, runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";

export interface RenderOptions extends Omit<CompileOptions, "frameAt">, FfmpegOptions {
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

/** Render a project to a video file. */
export async function render(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const p = opts.probe === false ? project : await probeAssets(project, opts);
  const compiled = compileProject(p, opts);
  const { workDir } = await execute(compiled, opts);
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
  const compiled = compileProject(p, { ...opts, frameAt: time });
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
  const compiled = compileProject(p, {
    ...opts,
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
  const compiled = compileProject(p, { ...opts, output: "", analysis: { framesAt: opts.framesAt, audio: opts.audio } });
  const audio = opts.audio ? [opts.audio.mix, opts.audio.voice, opts.audio.music].filter((f): f is string => !!f) : [];
  const { stdout } = await execute(compiled, { ...opts, output: "" }, audio);
  opts.onProgress?.(1);
  const size = compiled.width * compiled.height * 3;
  const times = compiled.frameTimes ?? [];
  const frames: AnalysisFrame[] = [];
  for (let i = 0; stdout && i < times.length && (i + 1) * size <= stdout.length; i++) frames.push({ time: times[i]!, rgb: stdout.subarray(i * size, (i + 1) * size) });
  return { width: compiled.width, height: compiled.height, frames };
}
