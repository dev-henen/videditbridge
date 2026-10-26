import { stat } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { computeTimeline, sourceToTimeline, type TimedClip } from "../../core/timeline.js";
import { round3 } from "../../core/util.js";
import { FaceDetector, sourceToFrame, trackFaces, type Box, type FaceFrame, type FaceTrack } from "./faces.js";

export interface ClipFaceTrack extends FaceTrack {
  /** Timeline seconds. */
  timelineStart: number;
  timelineEnd: number;
  /** Median box in the edit's frame (after the clip's fit and crop); undefined when cropped out. */
  frameBox?: Box;
  /** Box holding the face at every sampled moment, in the edit's frame. */
  frameExtent?: Box;
}

export interface ClipFaces {
  clip: TimedClip;
  /** Upright source picture size. */
  source: { width: number; height: number };
  /** Source-time samples, for callers that need every detection. */
  frames: FaceFrame[];
  /** People, largest and longest first. */
  tracks: ClipFaceTrack[];
}

const cache = new Map<string, Promise<{ width: number; height: number; frames: FaceFrame[] }>>();

/** Faces in a source range of a file, cached per file version, range and sampling rate. */
export async function detectFacesCached(
  detector: FaceDetector,
  file: string,
  range: { start: number; end: number } | undefined,
  fps: number,
): Promise<{ width: number; height: number; frames: FaceFrame[] }> {
  const mtime = await stat(file).then((s) => s.mtimeMs, () => 0);
  const key = `${file}|${mtime}|${range ? `${round3(range.start)}-${round3(range.end)}` : "all"}|${fps}`;
  let p = cache.get(key);
  if (!p) {
    p = detector.detectFile(file, { ...range, fps });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return p;
}

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/**
 * The faces in a primary clip: detected over the source footage it uses, followed over time, and
 * mapped into the edit's frame through the clip's fit and crop focus, with timeline times.
 * Effects that move the picture (zooms, shakes) are not followed.
 */
export async function detectClipFaces(
  project: Project,
  clipId: string,
  detector: FaceDetector,
  opts: { baseDir?: string; fps?: number } = {},
): Promise<ClipFaces> {
  const tc = computeTimeline(project).clips.find((c) => c.clip.id === clipId);
  if (!tc) throw new Error(`No primary clip "${clipId}"`);
  const asset = tc.asset;
  if (asset.type !== "video" && asset.type !== "image") throw new Error(`Clip "${clipId}" shows a ${asset.type}, which has no faces to find`);
  const file = /^[a-z]+:\/\//i.test(asset.src) ? asset.src : path.resolve(opts.baseDir ?? process.cwd(), asset.src);
  const range = asset.type === "video" ? { start: tc.clip.in, end: tc.clip.in + tc.sourceDuration } : undefined;
  const { width, height, frames } = await detectFacesCached(detector, file, range, opts.fps ?? 2);
  const out = project.settings;
  const tracks = trackFaces(frames).map((t): ClipFaceTrack => {
    const frameBox = sourceToFrame(t.box, { width, height }, out, tc.clip.fit, tc.clip.focus);
    const frameExtent = sourceToFrame(t.extent, { width, height }, out, tc.clip.fit, tc.clip.focus);
    const toTimeline = (s: number) => round3(asset.type === "video" ? sourceToTimeline(tc, s) : tc.start);
    return { ...t, timelineStart: toTimeline(t.start), timelineEnd: asset.type === "video" ? toTimeline(t.end) : tc.end, ...(frameBox ? { frameBox } : {}), ...(frameExtent ? { frameExtent } : {}) };
  });
  tracks.sort((a, b) => b.frames.length * area(b.box) - a.frames.length * area(a.box));
  return { clip: tc, source: { width, height }, frames, tracks };
}
