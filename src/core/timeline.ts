import type { Asset, AudioClip, Clip, Project } from "./schema.js";
import { round3 } from "./util.js";

export interface TimedClip {
  clip: Clip;
  index: number;
  asset: Asset;
  /** Source seconds consumed. */
  sourceDuration: number;
  /** Seconds on the timeline (sourceDuration / speed). */
  duration: number;
  /** Timeline start. Overlaps the previous clip by the transition duration. */
  start: number;
  end: number;
  /** Effective (clamped) incoming transition duration. */
  transitionDuration: number;
}

export interface TimedAudio {
  clip: AudioClip;
  asset: Asset;
  start: number;
  duration: number;
  end: number;
}

export interface Timeline {
  clips: TimedClip[];
  audio: TimedAudio[];
  /** Length of the primary track. */
  primaryDuration: number;
  /** Final output length. */
  duration: number;
}

export class TimelineError extends Error {}

export function getAsset(project: Project, assetId: string): Asset {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) throw new TimelineError(`Unknown asset "${assetId}"`);
  return asset;
}

/** Source duration a clip consumes; throws when it cannot be determined. */
export function clipSourceDuration(clip: Clip, asset: Asset): number {
  if (clip.duration !== undefined) return clip.duration;
  if (asset.type === "video" || asset.type === "audio") {
    if (asset.duration === undefined) {
      throw new TimelineError(
        `Clip "${clip.id}" has no duration and asset "${asset.id}" has no known duration (probe the asset first)`,
      );
    }
    return Math.max(0, asset.duration - clip.in);
  }
  throw new TimelineError(`Clip "${clip.id}" uses a ${asset.type} asset and needs an explicit duration`);
}

/** Longest transition allowed between two clips of the given durations. */
export function maxTransition(prev: number, next: number): number {
  return Math.max(0, Math.min(prev, next) - 0.05);
}

/** Resolve every clip and audio clip to absolute timeline positions. */
export function computeTimeline(project: Project): Timeline {
  const clips: TimedClip[] = [];
  let cursor = 0;
  project.clips.forEach((clip, index) => {
    const asset = getAsset(project, clip.assetId);
    const sourceDuration = clipSourceDuration(clip, asset);
    const duration = round3(sourceDuration / clip.speed);
    const prev = clips[index - 1];
    const transitionDuration =
      prev && clip.transition ? round3(Math.min(clip.transition.duration, maxTransition(prev.duration, duration))) : 0;
    const start = round3(cursor - transitionDuration);
    clips.push({ clip, index, asset, sourceDuration, duration, start, end: round3(start + duration), transitionDuration });
    cursor = round3(start + duration);
  });
  const primaryDuration = cursor;

  const layerEnd = project.layers.reduce((m, l) => Math.max(m, l.start + l.duration), 0);
  // Without a primary track the video lasts as long as its layers.
  const visualDuration = primaryDuration > 0 ? primaryDuration : layerEnd;

  const audio: TimedAudio[] = project.audio.map((clip) => {
    const asset = getAsset(project, clip.assetId);
    let duration: number;
    if (clip.duration !== undefined) duration = clip.duration;
    else if (clip.loop) duration = Math.max(0, visualDuration - clip.start);
    else if ((asset.type === "audio" || asset.type === "video") && asset.duration !== undefined)
      duration = Math.max(0, asset.duration - clip.in);
    else throw new TimelineError(`Audio clip "${clip.id}" needs a duration (probe asset "${asset.id}" first)`);
    return { clip, asset, start: clip.start, duration: round3(duration), end: round3(clip.start + duration) };
  });

  const audioEnd = audio.reduce((m, a) => Math.max(m, a.end), 0);
  const duration = round3(visualDuration > 0 ? visualDuration : audioEnd);
  return { clips, audio, primaryDuration, duration };
}

/** Which primary clip is visible at a timeline time (the incoming clip wins during transitions). */
export function clipAtTime(timeline: Timeline, t: number): TimedClip | undefined {
  for (let i = timeline.clips.length - 1; i >= 0; i--) {
    const c = timeline.clips[i]!;
    if (t >= c.start && t < c.end) return c;
  }
  return undefined;
}

/** Map a source time inside a clip to a timeline time. */
export function sourceToTimeline(tc: TimedClip, sourceTime: number): number {
  return tc.start + (sourceTime - tc.clip.in) / tc.clip.speed;
}

/** Map a timeline time inside a clip back to its source time. */
export function timelineToSource(tc: TimedClip, t: number): number {
  return tc.clip.in + (t - tc.start) * tc.clip.speed;
}
