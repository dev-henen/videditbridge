import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import type { MediaLayer, Project } from "../../core/schema.js";
import { deepClone } from "../../core/util.js";
import { withProjectPaths } from "../../core/operations.js";
import { ASS_FILE, compileProject, even, renderSize, type CompileOptions, type CompiledRender } from "./compile.js";
import { FrameSession, enginePath, runPlan } from "./engine.js";
import { contactSheetFrames, engineBridged, engineUnsupported, planProject, type EnginePlan, type PieceInputs } from "./plan.js";
import { planSegments, pruneCache, segmentProject, touchSegments, type SegmentPlan } from "./cache.js";
import { detectHardwareEncoder, wantsHardware } from "./hardware.js";
import { computeTimeline } from "../../core/timeline.js";
import { colorMatrixOf, colorSpaceFromTags } from "../../library/color/index.js";
import { ensureColorTables } from "./color-space.js";
import { effectObjects, effectRemovals, removalKey, usesDepthMask, usesFaceMask, usesPersonMask, usesSkyMask, type RemovalSpec } from "../../library/effects/index.js";
import { maskNeeds } from "../../library/effects/masks.js";
import { ObjectSegmenter, objectMaskFile, writeObjectMask, type ObjectSpec, type ObjectTrack } from "../vision/objects.js";
import { PersonSegmenter, maskFile } from "../vision/segment.js";
import { faceMaskFile, writeFaceMask } from "../vision/facemask.js";
import { FaceDetector } from "../vision/faces.js";
import { SkySegmenter, skyMaskFile, writeSkyMask, type SkyTrack } from "../vision/sky.js";
import { DepthEstimator, depthFile, writeDepth, type DepthTrack } from "../vision/depth.js";
import { Inpainter, removalFile, removalMasks, writeRemoval, type RemovalTrack } from "../vision/removal.js";
import { Interpolator, clipFrameTimes, framePlan, interpolatedFile, needsFrames, writeInterpolated, type InterpolateTrack } from "../video/interpolate.js";
import { withProxies } from "./proxy.js";
import { hasFilter, probe, resolveFfmpegPath, runFfmpegOrThrow, type FfmpegOptions, type ProbeResult } from "./ffmpeg.js";
import { prepareFonts, prepareFontsRecent } from "../fonts/index.js";

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
  /**
   * Which renderer draws the picture: "ffmpeg" (the CPU filter graph), "engine" (the
   * GPU render engine, an error when it cannot render), or "auto" (the engine, and FFmpeg when the
   * engine is not built, the options need FFmpeg, or the engine fails). The engine takes what it does
   * not draw itself from FFmpeg as pieces (engineGaps). Default: setDefaultBackend's, "auto" until it
   * is called. See the render engine guide.
   */
  backend?: RenderBackend;
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
  const ready = opts.probe === false ? p : await probeAssets(p, opts);
  // Camera log and HDR footage convert through tables both renderers read.
  await ensureColorTables(ready);
  return ready;
}

const probed = new Map<string, Promise<ProbeResult>>();

/** Fill in missing asset metadata (duration, dimensions, audio presence, color matrix) by probing files. */
export async function probeAssets(project: Project, opts: FfmpegOptions & { baseDir?: string } = {}): Promise<Project> {
  const out = deepClone(project);
  const baseDir = opts.baseDir ?? process.cwd();
  await Promise.all(
    out.assets.map(async (asset) => {
      if (asset.type === "color" || asset.type === "gradient") return;
      const needs =
        asset.type === "video"
          ? asset.duration === undefined || asset.hasAudio === undefined || asset.width === undefined || asset.colorMatrix === undefined
          : asset.type === "audio"
            ? asset.duration === undefined
            : asset.width === undefined;
      if (!needs || /^[a-z]+:\/\//i.test(asset.src)) return;
      // A project saved before colorMatrix was kept asks on every render: once per file is enough.
      const file = path.resolve(baseDir, asset.src);
      if (!probed.has(file)) probed.set(file, probe(file, opts));
      const info = await probed.get(file)!.catch((e) => {
        probed.delete(file);
        throw e;
      });
      if (asset.type === "video") {
        asset.colorMatrix ??= colorMatrixOf(info);
        asset.duration ??= info.duration;
        asset.hasAudio ??= info.hasAudio;
        asset.width ??= info.width;
        asset.height ??= info.height;
        // HDR is tagged in the file; camera log is set with set_color_space.
        const tagged = colorSpaceFromTags(info.colorTransfer);
        if (tagged) asset.colorSpace ??= tagged;
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
  kind: "person" | "face" | "object" | "sky" | "depth" | "removal" | "interpolate";
  clipId: string;
  /** Object masks: the tracked object. */
  objectId?: string;
  object?: ObjectSpec;
  /** Removals: what goes, and the mask videos of its objects (jobs planned before this one). */
  removal?: { spec: RemovalSpec; objectFiles: string[] };
  /** Interpolation: the source time of every frame the clip shows, ascending (see clipFrameTimes). */
  times?: number[];
  /** Object, sky, depth and removal jobs: where their track goes. */
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
 * The person cutout, face, object, sky, depth and removal files of each clip whose effects use them
 * (see PersonSegmenter, writeFaceMask, writeObjectMask, writeSkyMask, writeDepth and writeRemoval),
 * kept in the cache folder (or the system temp folder). Only names them; makeMasks makes the missing ones.
 */
async function planMasks(p: Project, opts: Omit<RenderOptions, "output">, extra: { clipId: string; objectId?: string; sky?: boolean; depth?: boolean; removal?: RemovalSpec }[] = []): Promise<MaskJob[]> {
  const jobs: MaskJob[] = [];
  const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "masks");
  for (const tc of computeTimeline(p).clips) {
    const person = tc.clip.effects.some(usesPersonMask);
    const face = tc.clip.effects.some(usesFaceMask);
    const wanted = extra.filter((x) => x.clipId === tc.clip.id);
    // Removals, each once, and the objects they take out.
    const removals = [...new Map([...tc.clip.effects.flatMap(effectRemovals), ...wanted.flatMap((x) => (x.removal ? [x.removal] : []))].map((r) => [removalKey(r), r])).values()];
    for (const id of removals.flatMap((r) => r.objects)) {
      const o = p.objects[id];
      if (!o) throw new Error(`Clip "${tc.clip.id}" removes object "${id}", which no longer exists; select it again or take it out with remove_object`);
      if (o.assetId !== tc.asset.id) throw new Error(`Clip "${tc.clip.id}" removes object "${id}", which was selected in ${o.assetId}, another video; select it in this clip's video`);
    }
    // Objects selected in this clip's video (an object from another video has no mask here).
    const objects = [...new Set([...tc.clip.effects.flatMap(effectObjects), ...wanted.flatMap((x) => (x.objectId ? [x.objectId] : [])), ...removals.flatMap((r) => r.objects)])].filter((id) => p.objects[id]?.assetId === tc.asset.id);
    const sky = tc.clip.effects.some(usesSkyMask) || wanted.some((x) => x.sky);
    const depth = tc.clip.effects.some(usesDepthMask) || wanted.some((x) => x.depth);
    const smooth = tc.asset.type === "video" && !!tc.clip.interpolate;
    // Depth and removals also work on photos (a 2.5D move, a logo taken out); the other masks need video.
    if (!(tc.asset.type === "video" || (tc.asset.type === "image" && (depth || removals.length))) || !(person || face || sky || depth || objects.length || removals.length || smooth)) continue;
    const src = /^[a-z]+:\/\//i.test(tc.asset.src) ? tc.asset.src : path.resolve(opts.baseDir ?? process.cwd(), tc.asset.src);
    // One mask frame per output frame, counted in source time.
    // A speed ramp needs the rate of its fastest moment.
    const fastest = tc.clip.keyframes?.speed?.length ? Math.max(...tc.clip.keyframes.speed.map((k) => k.value)) : tc.clip.speed;
    const fps = Math.min(60, Math.max(1, Math.round(p.settings.fps * fastest)));
    const range = { start: tc.clip.in, end: tc.clip.in + tc.sourceDuration };
    const clipId = tc.clip.id;
    const objectFiles = new Map<string, string>();
    if (tc.asset.type === "image") {
      if (depth) jobs.push({ kind: "depth", clipId, ...(await depthFile(dir, src, range, fps)), src, range, fps });
    } else {
      if (person) jobs.push({ kind: "person", clipId, ...(await maskFile(dir, src, range, fps)), src, range, fps });
      if (face) jobs.push({ kind: "face", clipId, ...(await faceMaskFile(dir, src, range, fps)), src, range, fps });
      if (sky) jobs.push({ kind: "sky", clipId, ...(await skyMaskFile(dir, src, range, fps)), src, range, fps });
      if (depth) jobs.push({ kind: "depth", clipId, ...(await depthFile(dir, src, range, fps)), src, range, fps });
      for (const objectId of objects) {
        const object = p.objects[objectId]!;
        const job: MaskJob = { kind: "object", clipId, objectId, object, ...(await objectMaskFile(dir, src, range, fps, object)), src, range, fps };
        objectFiles.set(objectId, job.file);
        jobs.push(job);
      }
    }
    // After the object masks they read.
    for (const spec of removals) {
      const files = await removalFile(dir, src, range, fps, spec, p.objects);
      jobs.push({ kind: "removal", clipId, removal: { spec, objectFiles: spec.objects.map((id) => objectFiles.get(id)!) }, ...files, src, range, fps });
    }
    // Smooth motion, only where the clip shows frames its footage does not have. Making them takes
    // minutes, so quick previews (on proxies) use them once prepared and repeat frames until then.
    if (smooth) {
      const sourceFps = (await probe(src, opts)).fps;
      const times = clipFrameTimes(tc, p.settings.fps);
      if (sourceFps && needsFrames(framePlan(times, sourceFps))) {
        const files = await interpolatedFile(dir, src, times, p.settings.fps);
        if (files.exists || !opts.proxies) jobs.push({ kind: "interpolate", clipId, times, ...files, src, range, fps: p.settings.fps });
      }
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

/**
 * Estimate depth in primary clips into the same cache files renders use (a few seconds per clip
 * second on a laptop), so a later render with depth effects does not estimate again. Returns each
 * clip's depth track (keyframes, near and far distances, in the clip's source time).
 */
export async function depthInClips(project: Project, clipIds: string[], opts: Omit<RenderOptions, "output" | "range">): Promise<{ clipId: string; file: string; track: DepthTrack }[]> {
  const p = await readyToRender(project, opts);
  const jobs = (await planMasks(p, opts, clipIds.map((clipId) => ({ clipId, depth: true })))).filter((j) => j.kind === "depth" && clipIds.includes(j.clipId));
  jobs.forEach((j, k) => (j.onProgress = opts.onProgress && ((f) => opts.onProgress!((k + f) / jobs.length))));
  await makeMasks(jobs, jobs.map((j) => j.clipId), opts);
  opts.onProgress?.(1);
  return Promise.all(jobs.map(async (j) => ({ clipId: j.clipId, file: j.file, track: JSON.parse(await readFile(j.track!, "utf8")) as DepthTrack })));
}

/**
 * Prepare a removal in primary clips into the same cache files renders use (its objects tracked
 * first where they are not yet), so a later render does not prepare it again. Returns each clip's
 * removal track (camera, area, shares filled from real frames and generated, in source time).
 */
export async function removalInClips(project: Project, clipIds: string[], spec: RemovalSpec, opts: Omit<RenderOptions, "output" | "range">): Promise<{ clipId: string; file: string; track: RemovalTrack }[]> {
  const p = await readyToRender(project, opts);
  const key = removalKey(spec);
  const all = await planMasks(p, opts, clipIds.map((clipId) => ({ clipId, removal: spec })));
  const removals = all.filter((j) => j.kind === "removal" && clipIds.includes(j.clipId) && removalKey(j.removal!.spec) === key);
  // The objects' masks are made on the way; progress counts them as half of their clip's removal.
  const jobs = all.filter((j) => clipIds.includes(j.clipId) && (removals.includes(j) || (j.kind === "object" && spec.objects.includes(j.objectId!))));
  const weight = (j: MaskJob) => (j.exists ? 0 : j.kind === "object" ? 0.5 : 1);
  const total = jobs.reduce((n, j) => n + weight(j), 0) || 1;
  let done = 0;
  for (const j of jobs) {
    const [base, w] = [done, weight(j)];
    j.onProgress = opts.onProgress && ((f) => opts.onProgress!((base + w * f) / total));
    done += w;
  }
  await makeMasks(jobs, clipIds, opts);
  opts.onProgress?.(1);
  return Promise.all(removals.map(async (j) => ({ clipId: j.clipId, file: j.file, track: JSON.parse(await readFile(j.track!, "utf8")) as RemovalTrack })));
}

/**
 * Make the in-between frames of primary clips with `interpolate` set, into the same cache files
 * renders use (about half a second a frame at 1080p on a laptop's graphics card). Returns each
 * prepared clip's track; clips that show no frames their footage lacks are left out.
 */
export async function interpolateInClips(project: Project, clipIds: string[], opts: Omit<RenderOptions, "output" | "range">): Promise<{ clipId: string; file: string; track: InterpolateTrack }[]> {
  const p = await readyToRender(project, opts);
  const jobs = (await planMasks(p, { ...opts, proxies: false })).filter((j) => j.kind === "interpolate" && clipIds.includes(j.clipId));
  jobs.forEach((j, k) => (j.onProgress = opts.onProgress && ((f) => opts.onProgress!((k + f) / jobs.length))));
  await makeMasks(jobs, clipIds, opts);
  opts.onProgress?.(1);
  return Promise.all(jobs.map(async (j) => ({ clipId: j.clipId, file: j.file, track: JSON.parse(await readFile(j.track!, "utf8")) as InterpolateTrack })));
}

/** Make the missing masks of the clips in `only` (a few seconds per clip second on a laptop). */
async function makeMasks(jobs: MaskJob[], only: Iterable<string>, opts: Omit<RenderOptions, "output">): Promise<void> {
  const ids = new Set(only);
  let segmenter: PersonSegmenter | undefined;
  let detector: FaceDetector | undefined;
  let objects: ObjectSegmenter | undefined;
  let skies: SkySegmenter | undefined;
  let depths: DepthEstimator | undefined;
  let inpainter: Inpainter | undefined;
  let interpolator: Interpolator | undefined;
  for (const job of jobs) {
    if (job.exists || !ids.has(job.clipId)) continue;
    if (job.kind === "interpolate") {
      interpolator ??= new Interpolator({ ffmpegPath: opts.ffmpegPath });
      await writeInterpolated(job.src, { file: job.file, track: job.track! }, { times: job.times!, fps: job.fps, interpolator, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress: job.onProgress });
    } else if (job.kind === "removal") {
      inpainter ??= new Inpainter({ ffmpegPath: opts.ffmpegPath });
      const { spec, objectFiles } = job.removal!;
      await writeRemoval(job.src, { file: job.file, track: job.track! }, {
        ...job.range,
        fps: job.fps,
        masks: removalMasks(spec.regions, objectFiles, job.fps, { ffmpegPath: opts.ffmpegPath }),
        grow: spec.grow,
        feather: spec.feather,
        inpainter,
        ffmpegPath: opts.ffmpegPath,
        signal: opts.signal,
        onProgress: job.onProgress,
      });
    } else if (job.kind === "object") {
      objects ??= new ObjectSegmenter();
      await writeObjectMask(job.src, { file: job.file, track: job.track! }, { ...job.range, fps: job.fps, time: job.object!.time, prompt: job.object!, segmenter: objects, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress: job.onProgress });
    } else if (job.kind === "depth") {
      depths ??= new DepthEstimator({ ffmpegPath: opts.ffmpegPath });
      await writeDepth(job.src, { file: job.file, track: job.track! }, { ...job.range, fps: job.fps, estimator: depths, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress: job.onProgress });
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

type MaskFiles = Pick<CompileOptions, "masks" | "faceMasks" | "objectMasks" | "skyMasks" | "depthMasks" | "removals" | "interpolated" | "subjectMask" | "skyMatte" | "objectMattes">;

const maskFiles = (jobs: MaskJob[]): MaskFiles => {
  const of = (kind: MaskJob["kind"]) => Object.fromEntries(jobs.filter((j) => j.kind === kind).map((j) => [j.clipId, j.file]));
  const objectMasks: Record<string, Record<string, string>> = {};
  for (const j of jobs) if (j.kind === "object") (objectMasks[j.clipId] ??= {})[j.objectId!] = j.file;
  const removals: Record<string, Record<string, string>> = {};
  for (const j of jobs) if (j.kind === "removal") (removals[j.clipId] ??= {})[removalKey(j.removal!.spec)] = j.file;
  return { masks: of("person"), faceMasks: of("face"), objectMasks, skyMasks: of("sky"), depthMasks: of("depth"), removals, interpolated: of("interpolate") };
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
  // From the originals, like the other masks, so previews (on proxies) and exports share them.
  const finished = { ...(await finishedMattes(original, opts)), ...(await objectMattes(original, opts)) };
  return { project: p, segments, share, masks: { ...maskFiles(jobs), ...finished }, rubberband, fonts };
}

/**
 * Mattes of the finished main picture (clips, transitions and whole-video effects, without layers or
 * sound): the person cutout, for media layers behind the subject or masked to a person, and the sky,
 * for media layers masked to it. The picture is rendered once at half size for the models, and the
 * mattes are kept in the cache until the main picture changes.
 */
async function finishedMattes(p: Project, opts: Omit<RenderOptions, "output">): Promise<Pick<CompileOptions, "subjectMask" | "skyMatte">> {
  const media = p.layers.filter((l): l is MediaLayer => l.type === "media");
  const person = media.some((l) => l.behindSubject || maskNeeds(l.mask, "person"));
  const sky = media.some((l) => maskNeeds(l.mask, "sky"));
  if (!person && !sky) return {};
  const { key, ...files } = finishedMatteFiles(p, opts.cacheDir);
  const dir = path.dirname(files.subjectMask);
  const ready = (file: string) => stat(file).then((s) => s.size > 0, () => false);
  const missing = { person: person && !(await ready(files.subjectMask)), sky: sky && !(await ready(files.skyMatte)) };
  if (missing.person || missing.sky) {
    // Renders that start while they are being made (a frame during a preview) wait for the same job.
    const id = `${key}:${missing.person}:${missing.sky}`;
    let making = makingMattes.get(id);
    if (!making) {
      making = (async () => {
        await mkdir(dir, { recursive: true });
        const picture = path.join(dir, `finished-${key}-${Number(missing.person)}${Number(missing.sky)}-plate.mp4`);
        const plate: Project = { ...p, layers: [], audio: [] };
        // Only looked at by the models, so made the quick way: half size, from proxies, fast encode.
        const { duration } = await render(plate, { ...opts, output: picture, scale: 0.5, proxies: true, preset: "ultrafast", range: undefined, onProgress: undefined, hardware: false });
        const range = { start: 0, end: duration, fps: p.settings.fps, signal: opts.signal };
        try {
          if (missing.person) await new PersonSegmenter({ ffmpegPath: opts.ffmpegPath }).writeMask(picture, files.subjectMask, range);
          if (missing.sky) {
            const track = files.skyMatte.replace(/\.mkv$/, ".json");
            await writeSkyMask(picture, { file: files.skyMatte, track }, { ...range, segmenter: new SkySegmenter({ ffmpegPath: opts.ffmpegPath }), ffmpegPath: opts.ffmpegPath });
          }
        } finally {
          await rm(picture, { force: true });
        }
      })();
      makingMattes.set(id, making);
      making.then(
        () => makingMattes.delete(id),
        () => makingMattes.delete(id),
      );
    }
    await making;
  }
  return { subjectMask: person ? files.subjectMask : undefined, skyMatte: sky ? files.skyMatte : undefined };
}

/** A mask that selects nothing (a full-frame rectangle minus itself). */
const NOTHING = { kind: "shape", shape: { type: "rect", x: 0.5, y: 0.5, width: 2, height: 2 }, combine: [{ kind: "shape", shape: { type: "rect", x: 0.5, y: 0.5, width: 2, height: 2 }, op: "subtract" }] };

/**
 * Mattes of tracked objects in timeline time, for media layers drawn behind an object (behindObject):
 * the edit's primary track rendered with each clip of the object's video showing the object's matte
 * (white on black, through the clip's own timing, speed and fit) and every other clip black, with the
 * transitions, without layers, whole-video effects or sound. Half size, kept in the cache until that
 * picture or the object changes.
 */
async function objectMattes(p: Project, opts: Omit<RenderOptions, "output">): Promise<Pick<CompileOptions, "objectMattes">> {
  const ids = [...new Set(p.layers.flatMap((l) => (l.type === "media" && l.behindObject ? [l.behindObject] : [])))];
  if (!ids.length) return {};
  const out: Record<string, string> = {};
  for (const id of ids) {
    const object = p.objects[id];
    if (!object) throw new Error(`A layer is behind object "${id}", which does not exist; select it with select_object`);
    const plate: Project = {
      ...p,
      layers: [],
      audio: [],
      effects: [],
      export: { ...p.export, crf: 12 },
      clips: p.clips.map((c) => ({ ...c, keyframes: c.keyframes?.speed ? { speed: c.keyframes.speed } : undefined, effects: [{ type: "maskView", params: { mask: c.assetId === object.assetId ? { kind: "object", object: id } : NOTHING } }] }) as Project["clips"][number]),
    };
    const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "masks");
    const key = createHash("sha256").update(JSON.stringify({ v: 1, settings: p.settings, assets: p.assets, clips: plate.clips, object })).digest("hex").slice(0, 32);
    const file = path.join(dir, `object-${key}.mkv`);
    if (!(await stat(file).then((s) => s.size > 0, () => false))) {
      let making = makingMattes.get(file);
      if (!making) {
        making = (async () => {
          await mkdir(dir, { recursive: true });
          const picture = path.join(dir, `object-${key}-plate.mp4`);
          await render(plate, { ...opts, output: picture, scale: 0.5, proxies: false, preset: "ultrafast", range: undefined, onProgress: undefined, hardware: false, backend: "ffmpeg" });
          try {
            // Gray, full range: white is 255 and black 0, as the other mattes.
            const temp = `${file}.tmp.mkv`;
            await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-i", picture, "-an", "-vf", "scale=out_range=full,format=gray", "-c:v", "ffv1", temp], opts);
            await rename(temp, file);
          } finally {
            await rm(picture, { force: true });
          }
        })();
        makingMattes.set(file, making);
        making.then(
          () => makingMattes.delete(file),
          () => makingMattes.delete(file),
        );
      }
      await making;
    }
    out[id] = file;
  }
  return { objectMattes: out };
}

/**
 * Where the mattes of a project's finished main picture are kept (see finishedMattes): they change
 * only with what makes that picture (settings, assets, clips and whole-video effects).
 */
export function finishedMatteFiles(p: Project, cacheDir?: string): { key: string; subjectMask: string; skyMatte: string } {
  const dir = path.join(cacheDir ?? path.join(tmpdir(), "ave-cache"), "masks");
  // Assets only layers use (graphics, particles) are not in that picture: redrawing them keeps the mattes.
  const picture = JSON.stringify([p.clips, p.effects]);
  const assets = p.assets.filter((a) => picture.includes(JSON.stringify(a.id)));
  const key = createHash("sha256")
    .update(JSON.stringify({ v: 2, settings: p.settings, assets, clips: p.clips, effects: p.effects, customEffects: p.customEffects }))
    .digest("hex")
    .slice(0, 32);
  return { key, subjectMask: path.join(dir, `subject-${key}.mkv`), skyMatte: path.join(dir, `sky-${key}.mkv`) };
}

/** Mattes of finished pictures being made, by picture and kinds. */
const makingMattes = new Map<string, Promise<void>>();

/** Clips rendered into the cache at once. Filters already use several threads, so this stays small. */
const SEGMENT_JOBS = Math.max(1, Math.min(3, Math.floor(availableParallelism() / 2)));

/** Render one clip's picture into the cache, through a temporary file so a crash never leaves a broken entry. */
async function renderSegment(p: Project, seg: SegmentPlan, opts: Omit<RenderOptions, "output">, masks: MaskFiles, onProgress?: (fraction: number) => void): Promise<void> {
  const one = segmentProject(p, seg.clip.clip);
  const part = seg.file.replace(/\.mkv$/, `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`);
  const compiled = compileProject(one, { output: part, scale: opts.scale, baseDir: opts.baseDir, fontsDir: opts.fontsDir, segment: true, ...masks });
  try {
    await execute(compiled, { output: part, ffmpegPath: opts.ffmpegPath, signal: opts.signal, onProgress });
    // Two renders can make the same entry at once (a frame while a preview runs). On Windows the
    // second rename fails while the first entry is being read; theirs is the same picture, so keep it.
    await rename(part, seg.file).catch(async (e) => {
      if (!(await stat(seg.file).then((s) => s.size > 0, () => false))) throw e;
    });
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

export type RenderBackend = "ffmpeg" | "engine" | "auto";

let defaultBackend: RenderBackend = "auto";
let defaultFrameBackend: RenderBackend = "auto";

/**
 * The backend of renders that do not name one, and of single frames (renderFrame), which can differ.
 * Both are "auto" (the engine, falling back to FFmpeg) until the app's first-run performance test
 * finds the engine does not work on this machine and sets "ffmpeg".
 */
export function setDefaultBackend(backend: RenderBackend, frames: RenderBackend = backend): void {
  defaultBackend = backend;
  defaultFrameBackend = frames;
}

/** The backend single frames use when a render does not name one (`setDefaultBackend`). */
export function frameBackend(): RenderBackend {
  return defaultFrameBackend;
}

/** Why the engine cannot render this project with these options (empty when it can). */
export function engineBlockers(p: Project, opts: Pick<RenderOptions, "range" | "proxies">): string[] {
  return [...(opts.range ? ["a time range"] : []), ...(opts.proxies ? ["proxies"] : []), ...(enginePath() ? [] : ["the engine is not built (npm run native)"]), ...engineUnsupported(p)];
}

/**
 * The masks and mattes the engine's pieces read (planProject's pieceInputs): what the FFmpeg backend
 * draws for the engine needs them as a render on the backend does, made the same way and shared
 * with it through the cache folder.
 */
async function enginePieceInputs(p: Project, opts: Omit<RenderOptions, "output">): Promise<PieceInputs> {
  if (!engineBridged(p).length) return {};
  const jobs = await planMasks(p, opts);
  await makeMasks(jobs, p.clips.map((c) => c.id), opts);
  return { ...maskFiles(jobs), ...(await finishedMattes(p, opts)), ...(await objectMattes(p, opts)) };
}

/** Write the files a plan's pieces read into its work folder. */
async function writePlanFiles(plan: EnginePlan, workDir: string): Promise<void> {
  for (const f of plan.files ?? []) await writeFile(path.join(workDir, f.name), f.content, "utf8");
}

/**
 * Render on the GPU engine: the sound and the text overlay come from the FFmpeg backend (the sound
 * mix alone, without decoding any video: audioOnly), the picture from the engine, which muxes both.
 */
async function renderOnEngine(p: Project, opts: RenderOptions): Promise<RenderResult> {
  const fonts = await prepareFonts(opts.fontsDir, p);
  const rubberband = p.clips.some((c) => c.keyframes?.speed?.length) && (await hasFilter("rubberband", opts));
  const workDir = await mkdtemp(path.join(tmpdir(), "ave-engine-"));
  try {
    const mix = path.join(workDir, "mix.wav");
    const sound = compileProject(p, { ...opts, ...fonts, rubberband, scale: 0.05, output: "", audioOnly: true, analysis: { audio: { mix } } });
    for (const f of sound.files) await writeFile(path.join(workDir, f.name), f.content, "utf8");
    await runFfmpegOrThrow(sound.args, { ffmpegPath: opts.ffmpegPath, cwd: workDir, signal: opts.signal });
    opts.onProgress?.(0.1);
    const hardwareEncoder =
      opts.hardware !== false && wantsHardware(p.export.videoCodec, opts.preset ?? p.export.preset) ? await detectHardwareEncoder(opts) : undefined;
    const planned = planProject(p, {
      ...opts,
      ffmpeg: resolveFfmpegPath(opts),
      audio: mix,
      overlay: sound.files.some((f) => f.name === ASS_FILE),
      fontsDir: fonts.fontsDir,
      hardwareEncoder,
      pieceInputs: await enginePieceInputs(p, opts),
    });
    if (!planned.plan) throw new Error(`The render engine cannot draw: ${planned.unsupported.join("; ")}`);
    await writePlanFiles(planned.plan, workDir);
    await mkdir(path.dirname(path.resolve(opts.output)), { recursive: true });
    await runPlan({ ...planned.plan, cwd: workDir }, { signal: opts.signal, onProgress: opts.onProgress && ((f) => opts.onProgress!(0.1 + 0.9 * f)) });
    opts.onProgress?.(1);
    const args = planned.plan.output.args;
    return { output: path.resolve(opts.output), duration: sound.duration, workDir: opts.keepWorkDir ? workDir : undefined, args };
  } finally {
    // A failed engine can leave its decoders closing for a moment (Windows then locks the folder): that must not hide the error.
    if (!opts.keepWorkDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

/** Frame sessions of the preview engine, by plan, most recently used last (a few edits back stay ready). */
const frameSessions = new Map<string, Promise<{ session: FrameSession; workDir: string }>>();
const FRAME_SESSIONS = 3;

/**
 * Close the preview engine's frame sessions and remove their work folders. Their decoders keep the
 * media open (Windows then locks the files), so the app's host calls this when a project closes;
 * the next frame opens a session again.
 */
export async function closeFrameSessions(): Promise<void> {
  const open = [...frameSessions.values()];
  frameSessions.clear();
  await Promise.all(open.map((o) => o.then(({ session, workDir }) => session.close().finally(() => rm(workDir, { recursive: true, force: true })), () => undefined)));
}

/**
 * The preview engine's session for this version of the project (planned once and kept open, with
 * a few versions back), and its frame at `time`. The engine draws the text and captions itself
 * (libass in a decoder that stays open, the same ASS file as the FFmpeg backend). Video clips start
 * their decoder at the frame wanted, so a frame anywhere in the edit is quick.
 */
async function engineFrameSession(p: Project, time: number, opts: Omit<RenderOptions, "range" | "onProgress" | "output">): Promise<{ session: FrameSession; n: number; fps: number; frames: number }> {
  const fonts = await prepareFontsRecent(opts.fontsDir, p);
  // compileProject is pure: it gives the ASS file without running anything.
  // Sound only: the text does not need the picture, and the picture's masks (objects, sky) are not made here.
  const ass = compileProject(p, { ...opts, ...fonts, audioOnly: true, output: "" }).files.find((f) => f.name === ASS_FILE);
  // Previews are 8-bit (picture files, the app's shared frames), whatever the export's bit depth.
  const planned = planProject({ ...p, export: { ...p.export, bitDepth: undefined } }, { ...opts, output: "unused.mp4", ffmpeg: resolveFfmpegPath(opts), textLayer: !!ass, fontsDir: fonts.fontsDir, pieceInputs: await enginePieceInputs(p, opts) });
  if (!planned.plan) throw new Error(`The render engine cannot draw: ${planned.unsupported.join("; ")}`);
  const plan = planned.plan;
  const key = createHash("sha256").update(JSON.stringify([plan.items, plan.clips, plan.layers, plan.effects, plan.width, plan.height, ass?.content, plan.files])).digest("hex");
  let open = frameSessions.get(key);
  if (open) {
    const s = await open.catch(() => undefined);
    if (!s?.session.alive) open = undefined;
  }
  if (!open) {
    open = (async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "ave-frames-"));
      if (ass) await writeFile(path.join(workDir, ASS_FILE), ass.content, "utf8");
      await writePlanFiles(plan, workDir);
      return { session: await FrameSession.open({ ...plan, cwd: workDir }), workDir };
    })();
    frameSessions.set(key, open);
    open.catch(() => frameSessions.delete(key));
  } else {
    frameSessions.delete(key);
    frameSessions.set(key, open);
  }
  // Keep a few: the oldest close and lose their work folders.
  while (frameSessions.size > FRAME_SESSIONS) {
    const [oldKey, old] = frameSessions.entries().next().value!;
    frameSessions.delete(oldKey);
    void old.then(({ session, workDir }) => session.close().finally(() => rm(workDir, { recursive: true, force: true })), () => undefined);
  }
  const { session } = await open;
  // As an output seek picks it in the FFmpeg backend: the first frame at or after `time`.
  return { session, n: Math.min(plan.frames - 1, Math.max(0, Math.ceil(time * plan.fps - 1e-6))), fps: plan.fps, frames: plan.frames };
}

/** Render one frame on the GPU engine into a picture file: a short ffmpeg run writes the engine's frame. */
async function frameOnEngine(p: Project, time: number, opts: Omit<RenderOptions, "range" | "onProgress">): Promise<string> {
  const { session, n } = await engineFrameSession(p, time, opts);
  const { width, height } = renderSize(p, opts.scale);
  const output = path.resolve(opts.output);
  await mkdir(path.dirname(output), { recursive: true });
  await session.frame(n, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-update", "1", output]);
  return output;
}

/** A frame the engine wrote into a memory-mapped file (`renderFrameShared`). */
export interface SharedFrame {
  /** The file: a 32-byte header, then width x height BGRA pixels (native/ave-render/src/shared.rs). */
  shared: string;
  width: number;
  height: number;
  /** Counts up with every frame written into the file. */
  sequence: number;
}

/**
 * Render one frame on the GPU engine into the memory-mapped file `shared` (made as needed), for
 * the app's viewer: no picture file and no ffmpeg run, and the app copies the pixels out. Throws
 * when the engine cannot draw the project (use `renderFrame` then).
 */
export async function renderFrameShared(project: Project, time: number, opts: Omit<RenderOptions, "range" | "onProgress" | "output"> & { shared: string }): Promise<SharedFrame> {
  const p = await readyToRender(project, { ...opts, output: opts.shared });
  const blockers = frameBlockers(p);
  if (blockers.length) throw new Error(`The render engine cannot render this: ${blockers.join("; ")}`);
  const { session, n } = await engineFrameSession(p, time, opts);
  const shared = path.resolve(opts.shared);
  await mkdir(path.dirname(shared), { recursive: true });
  const r = await session.frameShared(n, shared);
  return { shared, width: r.width, height: r.height, sequence: r.sequence };
}

/**
 * Run `onEngine` when `backend` sends this render to the engine, or undefined when FFmpeg should
 * draw it: the backend is "ffmpeg", the engine cannot render it, or (for "auto") it failed, which is
 * reported on stderr. "engine" never falls back.
 */
async function viaEngine<T>(backend: RenderBackend, blockers: string[], onEngine: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (backend === "ffmpeg") return undefined;
  if (blockers.length) {
    if (backend === "engine") throw new Error(`The render engine cannot render this: ${blockers.join("; ")}`);
    return undefined;
  }
  try {
    return await onEngine();
  } catch (e) {
    if (backend === "engine" || signal?.aborted) throw e;
    console.error(`The render engine failed, so FFmpeg renders this instead: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Why the engine cannot draw single frames and contact sheets of this project (empty when it can). */
const frameBlockers = (p: Project) => [...(enginePath() ? [] : ["the engine is not built (npm run native)"]), ...engineUnsupported(p)];

/** Render a project to a video file. */
export async function render(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const p = await readyToRender(project, opts);
  const done = await viaEngine(opts.backend ?? defaultBackend, engineBlockers(p, opts), () => renderOnEngine(p, opts), opts.signal);
  if (done) return done;
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
  const done = await viaEngine(opts.backend ?? defaultFrameBackend, frameBlockers(p), () => frameOnEngine(p, time, opts), opts.signal);
  if (done) return done;
  // One frame does not pay for caching clips, but uses those already cached.
  const { project: q, segments, masks, fonts } = await prepare(p, opts, false);
  const compiled = compileProject(q, { ...opts, ...fonts, segments, ...masks, frameAt: time });
  await execute(compiled, opts);
  return path.resolve(opts.output);
}

/**
 * A contact sheet on the preview engine: the frames FFmpeg's `select` would pick (`contactSheetFrames`)
 * drawn by the engine, then scaled and tiled by one short ffmpeg run, as the backend tiles them. The
 * engine only draws those frames, where FFmpeg runs its graph over the whole edit.
 */
async function sheetOnEngine(p: Project, opts: Omit<RenderOptions, "range" | "onProgress"> & { columns?: number; rows?: number; thumbWidth?: number }): Promise<string> {
  const [columns, rows, thumbWidth] = [opts.columns ?? 4, opts.rows ?? 3, opts.thumbWidth ?? 360];
  const { session, fps } = await engineFrameSession(p, 0, opts);
  const { width, height } = renderSize(p, opts.scale);
  const list = contactSheetFrames(computeTimeline(p).duration, fps, columns * rows);
  const output = path.resolve(opts.output);
  await mkdir(path.dirname(output), { recursive: true });
  await session.frames(list, [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    "-vf", `scale=${even(thumbWidth)}:-2,tile=${columns}x${rows}:padding=4:margin=4`,
    "-frames:v", "1", "-update", "1", output,
  ]);
  return output;
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
  // Like single frames: on the preview engine where previews go there, or when asked.
  const done = await viaEngine(opts.backend ?? defaultFrameBackend, frameBlockers(p), () => sheetOnEngine(p, opts), opts.signal);
  if (done) return done;
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

/** Plays an edit on the preview engine: frames by number into a shared frame file (`framePlayer`). */
export interface FramePlayer {
  fps: number;
  frames: number;
  /** Draw frame `n` into the memory-mapped file `shared` (as `renderFrameShared` does). */
  draw(n: number, shared: string): Promise<SharedFrame>;
}

/**
 * Open the preview engine's session for this version of the edit, for live playback in the app:
 * frames are drawn by number into a shared frame file, with no planning per frame. Throws when the
 * engine cannot draw the project.
 */
export async function framePlayer(project: Project, opts: Omit<RenderOptions, "range" | "onProgress" | "output">): Promise<FramePlayer> {
  const p = await readyToRender(project, { ...opts, output: "player" });
  const blockers = frameBlockers(p);
  if (blockers.length) throw new Error(`The render engine cannot render this: ${blockers.join("; ")}`);
  const { session, fps, frames } = await engineFrameSession(p, 0, opts);
  return {
    fps,
    frames,
    draw: async (n, shared) => {
      const file = path.resolve(shared);
      const r = await session.frameShared(Math.min(frames - 1, Math.max(0, Math.round(n))), file);
      return { shared: file, width: r.width, height: r.height, sequence: r.sequence };
    },
  };
}

/** The finished sound of an edit as a WAV file at `output`, mixed as renders mix it (for live playback). */
export async function renderSoundMix(project: Project, opts: Omit<RenderOptions, "range" | "onProgress">): Promise<string> {
  const p = await readyToRender(project, opts);
  const fonts = await prepareFonts(opts.fontsDir, p);
  const rubberband = p.clips.some((c) => c.keyframes?.speed?.length) && (await hasFilter("rubberband", opts));
  const output = path.resolve(opts.output);
  await mkdir(path.dirname(output), { recursive: true });
  const workDir = await mkdtemp(path.join(tmpdir(), "ave-mix-"));
  try {
    const sound = compileProject(p, { ...opts, ...fonts, rubberband, scale: 0.05, output: "", audioOnly: true, analysis: { audio: { mix: output } } });
    for (const f of sound.files) await writeFile(path.join(workDir, f.name), f.content, "utf8");
    await runFfmpegOrThrow(sound.args, { ffmpegPath: opts.ffmpegPath, cwd: workDir, signal: opts.signal });
    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
