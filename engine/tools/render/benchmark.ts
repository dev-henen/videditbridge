import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addAsset, addClip, addLayer, createProject, setTransition } from "../../core/operations.js";
import type { Project } from "../../core/schema.js";
import { deltaE2000, rgbToLab } from "../../library/effects/color-match.js";
import { appDir } from "../appdirs.js";
import { engineInfo, enginePath, type EngineInfo } from "./engine.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";
import { render, setDefaultBackend, type RenderBackend } from "./render.js";

/**
 * The first-run performance test: render the same short edit with the FFmpeg backend (on the
 * processor) and the GPU render engine, check the engine's picture matches, and choose the faster
 * renderer that works as the default for this machine.
 */

export type PictureRenderer = "ffmpeg" | "engine";

export interface RendererResult {
  renderer: PictureRenderer;
  ok: boolean;
  /** Seconds the test render took, and the frames it made per second. */
  seconds?: number;
  fps?: number;
  /** Mean ΔE 2000 against the FFmpeg render (the engine only). */
  deltaE?: number;
  error?: string;
}

export interface PerformanceReport {
  version: 1;
  /** ISO time of the test. */
  measuredAt: string;
  /** The renderer chosen, and the render backend that gives it (the engine falls back to FFmpeg for what it cannot draw yet). */
  choice: PictureRenderer;
  backend: RenderBackend;
  /** Why it was chosen, in a sentence for people. */
  reason: string;
  /** The graphics adapter the engine used. */
  adapter?: EngineInfo;
  /** Frames of the test edit, and its frame rate (real time). */
  frames: number;
  frameRate: number;
  results: RendererResult[];
}

/** Above this mean ΔE 2000 against the FFmpeg render, the engine's picture counts as wrong (a driver bug, black frames). */
const MAX_DELTA_E = 3;
/** The graphics card is chosen when it is at least this much faster; a closer result is noise, and FFmpeg draws everything. */
const MIN_SPEEDUP = 1.05;
/** Size of the frames compared. */
const [CW, CH] = [320, 180];

/** Where the report is kept: one per machine, in the app's data folder. */
export const performanceFile = () => path.join(appDir("data"), "performance.json");

export async function loadPerformance(file = performanceFile()): Promise<PerformanceReport | undefined> {
  try {
    const r = JSON.parse(await readFile(file, "utf8")) as PerformanceReport;
    return r.version === 1 && (r.backend === "ffmpeg" || r.backend === "auto") ? r : undefined;
  } catch {
    return undefined;
  }
}

export async function savePerformance(report: PerformanceReport, file = performanceFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
}

/** Use a report's choice for every render that does not name a backend. */
export function applyPerformance(report: PerformanceReport | undefined): void {
  setDefaultBackend(report?.backend ?? "ffmpeg");
}

/** The test's stages, in order. */
export type BenchmarkStage = "media" | "ffmpeg" | "engine" | "compare" | "done";

export interface BenchmarkProgress {
  stage: BenchmarkStage;
  /** What is happening, for people. */
  step: string;
  /** Progress of the stage and of the whole test, 0..1. */
  stageProgress: number;
  progress: number;
  /** The graphics adapter, once the engine has opened it. */
  adapter?: EngineInfo;
  /** Frames of the test edit and its frame rate, so a speed in frames per second can be shown. */
  frames: number;
  frameRate: number;
}

export interface BenchmarkOptions extends FfmpegOptions {
  onProgress?: (p: BenchmarkProgress) => void;
  signal?: AbortSignal;
}

const TEST_FPS = 30;
/** Frames of the test edit: 4.5 s at 30 fps. */
const TEST_FRAMES = Math.ceil(4.5 * TEST_FPS);

/** The test edit: 4.5 s at 1920x1080, two clips with a crossfade, a blended picture overlay and a title, all things the engine draws. */
async function testProject(dir: string, opts: FfmpegOptions & { signal?: AbortSignal }): Promise<Project> {
  const [video, image] = [path.join(dir, "footage.mp4"), path.join(dir, "still.png")];
  const base = ["-y", "-hide_banner", "-loglevel", "error"];
  await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video], opts);
  await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "mandelbrot=s=960x720", "-frames:v", "1", image], opts);
  let p = createProject({ settings: { width: 1920, height: 1080, fps: TEST_FPS } });
  p = addAsset(p, { id: "footage", type: "video", src: video, width: 1920, height: 1080, duration: 4, hasAudio: true });
  p = addAsset(p, { id: "still", type: "image", src: image, width: 960, height: 720 });
  p = addClip(p, { id: "a", assetId: "footage", duration: 2.5, fadeIn: 0.3 });
  p = addClip(p, { id: "b", assetId: "footage", in: 1, duration: 2.5, fit: "contain" });
  p = setTransition(p, "b", { type: "fade", duration: 0.5 });
  p = addLayer(p, { type: "media", assetId: "still", start: 0.5, duration: 3.5, position: { x: 0.7, y: 0.35 }, size: { width: 0.35 }, opacity: 0.85, blend: "screen", animationIn: { type: "fade", duration: 0.4 } });
  p = addLayer(p, { type: "text", text: "Performance test", start: 0, duration: 4.5, position: { x: 0.5, y: 0.85 } });
  return p;
}

/** Frames at a few times, small, as RGB. */
async function sampleFrames(file: string, opts: FfmpegOptions): Promise<Buffer[]> {
  const times = [0.5, 1.4, 2.2, 3.1, 4.0];
  const select = times.map((t) => `lt(abs(t-${t}),0.017)`).join("+");
  const { stdoutBuffer } = await runFfmpegOrThrow(
    ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select='${select}',scale=${CW}:${CH}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { ...opts, binaryStdout: true },
  );
  const size = CW * CH * 3;
  return Array.from({ length: Math.floor(stdoutBuffer!.length / size) }, (_, i) => stdoutBuffer!.subarray(i * size, (i + 1) * size));
}

function meanDeltaE(a: Buffer[], b: Buffer[]): number {
  if (!a.length || a.length !== b.length) return Infinity;
  let sum = 0;
  let n = 0;
  a.forEach((fa, k) => {
    const fb = b[k]!;
    for (let i = 0; i < fa.length; i += 3) {
      const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
      sum += deltaE2000(lab(fa), lab(fb));
      n++;
    }
  });
  return sum / n;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/** Run the test. Nothing is saved; see savePerformance and applyPerformance. */
export async function benchmarkBackends(opts: BenchmarkOptions = {}): Promise<PerformanceReport> {
  let adapter: EngineInfo | undefined;
  /** Stages and their share of the whole test. */
  const spans: Record<BenchmarkStage, [number, number]> = { media: [0, 0.05], ffmpeg: [0.05, 0.45], engine: [0.45, 0.85], compare: [0.85, 1], done: [1, 1] };
  const progress = (stage: BenchmarkStage, step: string, f = 0) => {
    const [a, b] = spans[stage];
    opts.onProgress?.({ stage, step, stageProgress: f, progress: a + (b - a) * f, frames: TEST_FRAMES, frameRate: TEST_FPS, ...(adapter ? { adapter } : {}) });
  };
  const dir = await mkdtemp(path.join(tmpdir(), "ave-benchmark-"));
  try {
    progress("media", "Making the test video");
    const ff = { ffmpegPath: opts.ffmpegPath, signal: opts.signal };
    const project = await testProject(dir, ff);
    const results: RendererResult[] = [];
    const outputs: Partial<Record<PictureRenderer, string>> = {};
    const run = async (renderer: PictureRenderer, label: string) => {
      progress(renderer, label);
      const output = path.join(dir, `${renderer}.mp4`);
      const started = performance.now();
      try {
        await render(project, { ...ff, output, backend: renderer, probe: false, onProgress: (f) => progress(renderer, label, f) });
        const seconds = (performance.now() - started) / 1000;
        results.push({ renderer, ok: true, seconds: Math.round(seconds * 100) / 100, fps: Math.round((TEST_FRAMES / seconds) * 10) / 10 });
        outputs[renderer] = output;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        results.push({ renderer, ok: false, error: message(e) });
      }
    };
    await run("ffmpeg", "Rendering on the processor (FFmpeg)");
    if (!enginePath()) results.push({ renderer: "engine", ok: false, error: "The GPU render engine is not installed" });
    else {
      try {
        adapter = await engineInfo();
        await run("engine", `Rendering on the graphics card (${adapter.adapter})`);
      } catch (e) {
        results.push({ renderer: "engine", ok: false, error: message(e) });
      }
    }
    const [cpu, gpu] = [results.find((r) => r.renderer === "ffmpeg")!, results.find((r) => r.renderer === "engine")!];
    if (cpu.ok && gpu.ok) {
      progress("compare", "Comparing the pictures");
      gpu.deltaE = Math.round(meanDeltaE(await sampleFrames(outputs.ffmpeg!, ff), await sampleFrames(outputs.engine!, ff)) * 100) / 100;
      if (!(gpu.deltaE <= MAX_DELTA_E)) {
        gpu.ok = false;
        gpu.error = `Its picture differs from the processor's (mean color difference ${gpu.deltaE} ΔE, more than ${MAX_DELTA_E})`;
      }
    }
    let choice: PictureRenderer;
    let reason: string;
    const speedup = cpu.ok && gpu.ok ? cpu.seconds! / gpu.seconds! : undefined;
    const percent = (x: number) => `${Math.round(Math.abs(x - 1) * 100)}%`;
    if (gpu.ok && (!cpu.ok || speedup! >= MIN_SPEEDUP)) {
      choice = "engine";
      reason = cpu.ok ? `The graphics card rendered ${percent(speedup!)} faster than the processor.` : "Rendering on the processor failed, and the graphics card works.";
    } else {
      choice = "ffmpeg";
      reason = !gpu.ok
        ? `The graphics card cannot be used: ${gpu.error!.replace(/.$/, "")}.`
        : speedup! >= 1
          ? `The graphics card was only ${percent(speedup!)} faster, so the processor, which draws every effect, stays in use.`
          : `The processor rendered ${percent(1 / speedup!)} faster than the graphics card.`;
    }
    progress("done", "Done", 1);
    return { version: 1, measuredAt: new Date().toISOString(), frames: TEST_FRAMES, frameRate: TEST_FPS, choice, backend: choice === "engine" ? "auto" : "ffmpeg", reason, adapter, results };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
