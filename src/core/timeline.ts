import type { Asset, AudioClip, Clip, Project } from "./schema.js";
import { round3 } from "./util.js";
import { numberAt } from "./keyframes.js";

/** How footage maps to the timeline in a clip whose speed changes over time (speed keyframes). */
export interface SpeedMap {
  /** Seconds on the timeline. */
  duration: number;
  /** Timeline seconds from the clip's start for `u` seconds of source from its in point. */
  toTimeline(u: number): number;
  /** The reverse. */
  toSource(t: number): number;
  /** Speed at `u` seconds of source from the in point. */
  speedAt(u: number): number;
}

const speedMaps = new WeakMap<Clip, Map<number, SpeedMap>>();

/**
 * The time map of a speed-ramped clip: timeline time is the integral of 1/speed over the footage,
 * tabulated finely (every 10 ms of source) and interpolated. Undefined without speed keyframes.
 */
export function speedMap(clip: Clip, sourceDuration: number): SpeedMap | undefined {
  const keys = clip.keyframes?.speed;
  if (!keys?.length) return undefined;
  let byDuration = speedMaps.get(clip);
  const cached = byDuration?.get(sourceDuration);
  if (cached) return cached;
  const speedAt = (u: number) => numberAt(keys, u);
  const n = Math.max(16, Math.min(20000, Math.ceil(sourceDuration / 0.01)));
  const h = sourceDuration / n;
  const T = [0];
  for (let i = 1; i <= n; i++) T.push(T[i - 1]! + h / speedAt((i - 0.5) * h));
  const total = T[n]!;
  const map: SpeedMap = {
    duration: total,
    speedAt,
    toTimeline: (u) => {
      if (u <= 0) return u / speedAt(0);
      if (u >= sourceDuration) return total + (u - sourceDuration) / speedAt(sourceDuration);
      const i = Math.min(n - 1, Math.floor(u / h));
      return T[i]! + ((u - i * h) / h) * (T[i + 1]! - T[i]!);
    },
    toSource: (t) => {
      if (t <= 0) return t * speedAt(0);
      if (t >= total) return sourceDuration + (t - total) * speedAt(sourceDuration);
      let [lo, hi] = [0, n];
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (T[mid]! <= t) lo = mid;
        else hi = mid;
      }
      return (lo + (t - T[lo]!) / (T[lo + 1]! - T[lo]!)) * h;
    },
  };
  if (!byDuration) speedMaps.set(clip, (byDuration = new Map()));
  byDuration.set(sourceDuration, map);
  return map;
}

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
  /** Speed-ramped clips: how footage maps to timeline time. */
  speedMap?: SpeedMap;
  /** J cut actually played (clamped to the footage before the clip and the previous clip's length). */
  audioLead?: number;
  /** L cut actually played (clamped to the footage after the clip and the next clip's length). */
  audioTail?: number;
}

/** Whether a primary clip plays its own sound. */
export function clipHasSound(tc: Pick<TimedClip, "clip" | "asset">): boolean {
  return tc.asset.type === "video" && tc.asset.hasAudio !== false && !tc.clip.muted && tc.clip.volume > 0;
}

export interface TimedAudio {
  clip: AudioClip;
  asset: Asset;
  start: number;
  /** Seconds on the timeline (source seconds / speed). */
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
    const map = asset.type === "video" ? speedMap(clip, sourceDuration) : undefined;
    const duration = round3(map ? map.duration : sourceDuration / clip.speed);
    const prev = clips[index - 1];
    const transitionDuration =
      prev && clip.transition ? round3(Math.min(clip.transition.duration, maxTransition(prev.duration, duration))) : 0;
    const start = round3(cursor - transitionDuration);
    clips.push({ clip, index, asset, sourceDuration, duration, start, end: round3(start + duration), transitionDuration, ...(map ? { speedMap: map } : {}) });
    cursor = round3(start + duration);
  });
  const primaryDuration = cursor;

  // J and L cuts: sound from just outside a clip's source range, played under its neighbor.
  for (const tc of clips) {
    if (!clipHasSound(tc)) continue;
    const prev = clips[tc.index - 1];
    const next = clips[tc.index + 1];
    const speed = tc.clip.speed;
    const lead = prev ? Math.min(tc.clip.audioLead ?? 0, tc.clip.in / speed, prev.duration - 0.05) : 0;
    const total = tc.asset.type === "video" ? tc.asset.duration : undefined;
    const after = total === undefined ? Infinity : Math.max(0, total - tc.clip.in - tc.sourceDuration) / speed;
    const tail = next ? Math.min(tc.clip.audioTail ?? 0, after, next.duration - 0.05) : 0;
    if (lead > 0.01) tc.audioLead = round3(lead);
    if (tail > 0.01) tc.audioTail = round3(tail);
  }

  const layerEnd = project.layers.reduce((m, l) => Math.max(m, l.start + l.duration), 0);
  // Without a primary track the video lasts as long as its layers.
  const visualDuration = primaryDuration > 0 ? primaryDuration : layerEnd;

  const audio: TimedAudio[] = project.audio.map((clip) => {
    const asset = getAsset(project, clip.assetId);
    let duration: number;
    if (clip.duration !== undefined) duration = clip.duration;
    else if (clip.loop) duration = Math.max(0, visualDuration - clip.start);
    else if ((asset.type === "audio" || asset.type === "video") && asset.duration !== undefined)
      duration = Math.max(0, asset.duration - clip.in) / clip.speed;
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
  return tc.start + (tc.speedMap ? tc.speedMap.toTimeline(sourceTime - tc.clip.in) : (sourceTime - tc.clip.in) / tc.clip.speed);
}

/** Map a timeline time inside a clip back to its source time. */
export function timelineToSource(tc: TimedClip, t: number): number {
  return tc.clip.in + (tc.speedMap ? tc.speedMap.toSource(t - tc.start) : (t - tc.start) * tc.clip.speed);
}
