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

async function execute(compiled: CompiledRender, opts: RenderOptions): Promise<string | undefined> {
  const workDir = await mkdtemp(path.join(tmpdir(), "ave-render-"));
  try {
    for (const f of compiled.files) await writeFile(path.join(workDir, f.name), f.content, "utf8");
    await mkdir(path.dirname(path.resolve(opts.output)), { recursive: true });
    await runFfmpegOrThrow(compiled.args, {
      ffmpegPath: opts.ffmpegPath,
      cwd: workDir,
      signal: opts.signal,
      onProgress: opts.onProgress && compiled.duration > 0 ? (s) => opts.onProgress!(Math.min(1, s / compiled.duration)) : undefined,
    });
    return opts.keepWorkDir ? workDir : undefined;
  } finally {
    if (!opts.keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}

/** Render a project to a video file. */
export async function render(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const p = opts.probe === false ? project : await probeAssets(project, opts);
  const compiled = compileProject(p, opts);
  const workDir = await execute(compiled, opts);
  opts.onProgress?.(1);
  return { output: path.resolve(opts.output), duration: compiled.duration, workDir, args: compiled.args };
}

/** Render a single frame (PNG/JPG) at a timeline time — lets an AI "look" at its edit. */
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
