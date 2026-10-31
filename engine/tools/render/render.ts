import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { deepClone } from "../../core/util.js";
import { withProjectPaths } from "../../core/operations.js";
import { compileProject, type CompileOptions, type CompiledRender } from "./compile.js";
import { planSegments, pruneCache, segmentProject, touchSegments, type SegmentPlan } from "./cache.js";
import { detectHardwareEncoder, wantsHardware } from "./hardware.js";
import { computeTimeline } from "../../core/timeline.js";
import { effectObjects, usesFaceMask, usesPersonMask, usesSkyMask } from "../../library/effects/index.js";
import { ObjectSegmenter, objectMaskFile, writeObjectMask, type ObjectSpec, type ObjectTrack } from "../vision/objects.js";
import { PersonSegmenter, maskFile } from "../vision/segment.js";
import { faceMaskFile, writeFaceMask } from "../vision/facemask.js";
import { FaceDetector } from "../vision/faces.js";
import { SkySegmenter, skyMaskFile, writeSkyMask, type SkyTrack } from "../vision/sky.js";
import { withProxies } from "./proxy.js";
import { hasFilter, probe, runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";
import { prepareFonts } from "../fonts/index.js";

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
  /**
   * Read big videos (over 1920 px) from small proxy copies in the cache folder, for previews and
   * frames. Missing proxies are made in the background, so the first preview uses the originals.
   * Leave it off for final renders (default false).
   */
  proxies?: boolean;
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

/**
 * The project as a render reads it: asset paths in the project form (forward slashes, relative
 * inside the media folder, so projects saved on Windows render on macOS and Linux), probed unless
 * `probe` is false.
 */
async function readyToRender(project: Project, opts: RenderOptions | Omit<RenderOptions, "output" | "range">): Promise<Project> {
  const p = withProjectPaths(project, path.resolve(opts.baseDir ?? process.cwd()));
  return opts.probe === false ? p : probeAssets(p, opts);
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
  kind: "person" | "face" | "object" | "sky";
  clipId: string;
  /** Object masks: the tracked object. */
  objectId?: string;
  object?: ObjectSpec;
  /** Object and sky masks: where their track goes. */
  track?: string;
  /** Progress of making this mask, 0..1. */
  onProgress?: (p: number) => void;
  file: string;
  exists: boolean;
  src: string;
  range: { start: number; end: number };
  fps: number;
}

/**
 * The person cutout, face, object and sky mask files of each video clip whose effects use them (see
 * PersonSegmenter, writeFaceMask, writeObjectMask and writeSkyMask), kept in the cache folder (or the system temp folder). Only names them; makeMasks
 * makes the missing ones.
 */
async function planMasks(p: Project, opts: Omit<RenderOptions, "output">, extra: { clipId: string; objectId?: string; sky?: boolean }[] = []): Promise<MaskJob[]> {
  const jobs: MaskJob[] = [];
  const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "masks");
  for (const tc of computeTimeline(p).clips) {
    const person = tc.clip.effects.some(usesPersonMask);
    const face = tc.clip.effects.some(usesFaceMask);
    // Objects selected in this clip's video (an object from another video has no mask here).
    const wanted = extra.filter((x) => x.clipId === tc.clip.id);
    const objects = [...new Set([...tc.clip.effects.flatMap(effectObjects), ...wanted.flatMap((x) => (x.objectId ? [x.objectId] : []))])].filter((id) => p.objects[id]?.assetId === tc.asset.id);
    const sky = tc.clip.effects.some(usesSkyMask) || wanted.some((x) => x.sky);
    if (tc.asset.type !== "video" || !(person || face || sky || objects.length)) continue;
    const src = /^[a-z]+:\/\//i.test(tc.asset.src) ? tc.asset.src : path.resolve(opts.baseDir ?? process.cwd(), tc.asset.src);
    // One mask frame per output frame, counted in source time.
    // A speed ramp needs the rate of its fastest moment.
    const fastest = tc.clip.keyframes?.speed?.length ? Math.max(...tc.clip.keyframes.speed.map((k) => k.value)) : tc.clip.speed;
    const fps = Math.min(60, Math.max(1, Math.round(p.settings.fps * fastest)));
    const range = { start: tc.clip.in, end: tc.clip.in + tc.sourceDuration };
    const clipId = tc.clip.id;
    if (person) jobs.push({ kind: "person", clipId, ...(await maskFile(dir, src, range, fps)), src, range, fps });
    if (face) jobs.push({ kind: "face", clipId, ...(await faceMaskFile(dir, src, range, fps)), src, range, fps });
    if (sky) jobs.push({ kind: "sky", clipId, ...(await skyMaskFile(dir, src, range, fps)), src, range, fps });
    for (const objectId of objects) {
      const object = p.objects[objectId]!;
      jobs.push({ kind: "object", clipId, objectId, object, ...(await objectMaskFile(dir, src, range, fps, object)), src, range, fps });
    }
  }
  return jobs;
}

/**
 * Track an object through primary clips of its video (all of them, or `clipIds`), into the same cache
 * files renders use, so a later render with the object's mask does not track again. Returns each
 * clip's track (boxes, confidence and keyframes, in the clip's source time).
 */
export async function trackObjectInClips(
  project: Project,
  objectId: string,
  opts: Omit<RenderOptions, "output" | "range"> & { clipIds?: string[] },
): Promise<{ clipId: string; file: string; track: ObjectTrack }[]> {
  const p = await readyToRender(project, opts);
  const object = p.objects[objectId];
  if (!object) throw new Error(`No object "${objectId}"; make one with select_object`);
  const clips = computeTimeline(p).clips.filter((tc) => tc.asset.id === object.assetId && (!opts.clipIds || opts.clipIds.includes(tc.clip.id)));
  if (!clips.length) throw new Error(`No primary clip shows ${object.assetId}, the video "${objectId}" was selected in`);
  const jobs = (await planMasks(p, opts, clips.map((tc) => ({ clipId: tc.clip.id, objectId })))).filter((j) => j.kind === "object" && j.objectId === objectId);
  jobs.forEach((j, k) => (j.onProgress = opts.onProgress && ((f) => opts.onProgress!((k + f) / jobs.length))));
  await makeMasks(jobs, jobs.map((j) => j.clipId), opts);
  opts.onProgress?.(1);
  return Promise.all(jobs.map(async (j) => ({ clipId: j.clipId, file: j.file, track: JSON.parse(await readFile(j.track!, "utf8")) as ObjectTrack })));
}

/**
 * Find the sky in primary clips into the same cache files renders use (a few seconds per clip second
 * on a laptop), so a later render with a sky mask does not look again. Returns each clip's sky track
 * (share of sky, camera motion and colors, in the clip's source time).
 */
export async function skyInClips(project: Project, clipIds: string[], opts: Omit<RenderOptions, "output" | "range">): Promise<{ clipId: string; file: string; track: SkyTrack }[]> {
  const p = await readyToRender(project, opts);
  const jobs = (await planMasks(p, opts, clipIds.map((clipId) => ({ clipId, sky: true })))).filter((j) => j.kind === "sky" && clipIds.includes(j.clipId));
  jobs.forEach((j, k) => (j.onProgress = opts.onProgress && ((f) => opts.onProgress!((k + f) / jobs.length))));
  await makeMasks(jobs, jobs.map((j) => j.clipId), opts);
  opts.onProgress?.(1);
  return Promise.all(jobs.map(async (j) => ({ clipId: j.clipId, file: j.file, track: JSON.parse(await readFile(j.track!, "utf8")) as SkyTrack })));
}

/** Make the missing masks of the clips in `only` (a few seconds per clip second on a laptop). */
async function makeMasks(jobs: MaskJob[], only: Iterable<string>, opts: Omit<RenderOptions, "output">): Promise<void> {
  const ids = new Set(only);
  let segmenter: PersonSegmenter | undefined;
  let detector: FaceDetector | undefined;
  let objects: ObjectSegmenter | undefined;
  let skies: SkySegmenter | undefined;
  for (const job of jobs) {
    if (job.exists || !ids.has(job.clipId)) continue;
    if (job.kind === "object") {
      objects ??= new ObjectSegmenter();
      await writeObjectMask(job.src, { file: job.file, track: job.track! }, { ...job.range, fps: job.fps, time: job.object!.time, prompt: job.object!, segmenter: objects, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress: job.onProgress });
    } else if (job.kind === "sky") {
      skies ??= new SkySegmenter({ ffmpegPath: opts.ffmpegPath });
      await writeSkyMask(job.src, { file: job.file, track: job.track! }, { ...job.range, fps: job.fps, segmenter: skies, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress: job.onProgress });
    } else if (job.kind === "person") {
      segmenter ??= new PersonSegmenter({ ffmpegPath: opts.ffmpegPath });
      await segmenter.writeMask(job.src, job.file, { ...job.range, fps: job.fps, signal: opts.signal });
    } else {
      detector ??= new FaceDetector({ ffmpegPath: opts.ffmpegPath });
      await writeFaceMask(job.src, job.file, { ...job.range, fps: job.fps, detector, ffmpegPath: opts.ffmpegPath, signal: opts.signal });
    }
    job.exists = true;
  }
}

type MaskFiles = Pick<CompileOptions, "masks" | "faceMasks" | "objectMasks" | "skyMasks" | "subjectMask">;

const maskFiles = (jobs: MaskJob[]): MaskFiles => {
  const of = (kind: MaskJob["kind"]) => Object.fromEntries(jobs.filter((j) => j.kind === kind).map((j) => [j.clipId, j.file]));
  const objectMasks: Record<string, Record<string, string>> = {};
  for (const j of jobs) if (j.kind === "object") (objectMasks[j.clipId] ??= {})[j.objectId!] = j.file;
  return { masks: of("person"), faceMasks: of("face"), objectMasks, skyMasks: of("sky") };
};

/** Masks and cached clips for a render: `create` fills the cache; clips not taken from it get their masks made. */
async function prepare(original: Project, opts: Omit<RenderOptions, "output">, create: boolean, until?: number) {
  // Masks come from the originals either way, so they are shared with full renders.
  const jobs = await planMasks(original, opts);
  const p = opts.proxies ? await withProxies(original, opts) : original;
  const { segments, share } = await cachedSegments(p, opts, create, until, jobs);
  await makeMasks(jobs, p.clips.filter((c) => !segments?.[c.id]).map((c) => c.id), opts);
  // Speed ramps sound best through rubberband, when this FFmpeg build has it.
  const rubberband = p.clips.some((c) => c.keyframes?.speed?.length) && (await hasFilter("rubberband", opts));
  // Always give libass the fonts folder with the bundled fonts, and replace system fonts this machine lacks.
  const fonts = await prepareFonts(opts.fontsDir, p);
  // From the originals, like the other masks, so previews (on proxies) and exports share it.
  const subjectMask = await subjectMatte(original, opts);
  return { project: p, segments, share, masks: { ...maskFiles(jobs), subjectMask }, rubberband, fonts };
}

/**
 * The person cutout of the finished main picture (clips, transitions and whole-video effects, without
 * layers or sound), for media layers drawn behind the subject: the picture is rendered once at half
 * size and segmented, and the cutout is kept in the cache until the main picture changes.
 */
async function subjectMatte(p: Project, opts: Omit<RenderOptions, "output">): Promise<string | undefined> {
  if (!p.layers.some((l) => l.type === "media" && l.behindSubject)) return undefined;
  const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "masks");
  const key = createHash("sha256")
    .update(JSON.stringify({ v: 1, settings: p.settings, assets: p.assets, clips: p.clips, effects: p.effects, customEffects: p.customEffects }))
    .digest("hex")
    .slice(0, 32);
  const file = path.join(dir, `subject-${key}.mkv`);
  if (await stat(file).then((s) => s.size > 0, () => false)) return file;
  await mkdir(dir, { recursive: true });
  const picture = path.join(dir, `subject-${key}-plate.mp4`);
  const plate: Project = { ...p, layers: [], audio: [] };
  // Only looked at by the model, so made the quick way: half size, from proxies, fast encode.
  const { duration } = await render(plate, { ...opts, output: picture, scale: 0.5, proxies: true, preset: "ultrafast", range: undefined, onProgress: undefined, hardware: false });
  try {
    await new PersonSegmenter({ ffmpegPath: opts.ffmpegPath }).writeMask(picture, file, { start: 0, end: duration, fps: p.settings.fps, signal: opts.signal });
  } finally {
    await rm(picture, { force: true });
  }
  return file;
}

/** Clips rendered into the cache at once. Filters already use several threads, so this stays small. */
const SEGMENT_JOBS = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)));

/** Render one clip's picture into the cache, through a temporary file so a crash never leaves a broken entry. */
async function renderSegment(p: Project, seg: SegmentPlan, opts: Omit<RenderOptions, "output">, masks: MaskFiles, onProgress?: (fraction: number) => void): Promise<void> {
  const one = segmentProject(p, seg.clip.clip);
  const part = seg.file.replace(/\.mkv$/, `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`);
  const compiled = compileProject(one, { output: part, scale: opts.scale, baseDir: opts.baseDir, fontsDir: opts.fontsDir, segment: true, ...masks });
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
  jobs: MaskJob[] = [],
): Promise<{ segments?: Record<string, string>; share: number }> {
  if (!opts.cacheDir) return { share: 0 };
  await mkdir(opts.cacheDir, { recursive: true });
  const masks = maskFiles(jobs);
  const plan = await planSegments(p, { cacheDir: opts.cacheDir, baseDir: opts.baseDir, fontsDir: opts.fontsDir, scale: opts.scale, ...masks });
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
  const p = await readyToRender(project, opts);
  const { project: q, segments, share, masks, rubberband, fonts } = await prepare(p, opts, true, opts.range?.end);
  const hardwareEncoder =
    opts.hardware !== false && wantsHardware(p.export.videoCodec, opts.preset ?? p.export.preset) ? await detectHardwareEncoder(opts) : undefined;
  let compiled = compileProject(q, { ...opts, ...fonts, segments, ...masks, rubberband, hardwareEncoder });
  let workDir: string | undefined;
  try {
    ({ workDir } = await execute(compiled, { ...opts, ...after(opts, share) }));
  } catch (e) {
    // A graphics driver can refuse a stream its test encode accepted (size limits, busy device).
    if (!hardwareEncoder || opts.signal?.aborted) throw e;
    compiled = compileProject(q, { ...opts, ...fonts, segments, ...masks, rubberband });
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
  const p = await readyToRender(project, opts);
  // One frame does not pay for caching clips, but uses those already cached.
  const { project: q, segments, masks, fonts } = await prepare(p, opts, false);
  const compiled = compileProject(q, { ...opts, ...fonts, segments, ...masks, frameAt: time });
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
  const p = await readyToRender(project, opts);
  const { project: q, segments, masks, fonts } = await prepare(p, opts, true);
  const compiled = compileProject(q, {
    ...opts,
    ...fonts,
    segments,
    ...masks,
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
  const p = await readyToRender(project, opts);
  const { project: q, segments, share, masks, rubberband, fonts } = await prepare(p, opts, true);
  const compiled = compileProject(q, { ...opts, ...fonts, segments, ...masks, rubberband, output: "", analysis: { framesAt: opts.framesAt, audio: opts.audio } });
  const audio = opts.audio ? [opts.audio.mix, opts.audio.voice, opts.audio.music].filter((f): f is string => !!f) : [];
  const { stdout } = await execute(compiled, { ...opts, ...after(opts, share), output: "" }, audio);
  opts.onProgress?.(1);
  const size = compiled.width * compiled.height * 3;
  const times = compiled.frameTimes ?? [];
  const frames: AnalysisFrame[] = [];
  for (let i = 0; stdout && i < times.length && (i + 1) * size <= stdout.length; i++) frames.push({ time: times[i]!, rgb: stdout.subarray(i * size, (i + 1) * size) });
  return { width: compiled.width, height: compiled.height, frames };
}
