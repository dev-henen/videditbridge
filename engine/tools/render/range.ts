import type { Clip, Project } from "../../core/schema.js";
import { computeTimeline } from "../../core/timeline.js";
import { deepClone } from "../../core/util.js";

/** The black stand-in's asset id: a plain color, no decoding and no effects. */
export const RANGE_STAND_IN = "__range_stand_in";

/**
 * The project as a render of `range` needs it, with every time where it was. A range render still
 * runs the graph from the start (the output seeks), so without this every clip before the range is
 * decoded and filtered for nothing, and one that fails there fails a preview of a later part.
 *
 * - Primary clips that end before the clip just ahead of the range become black stand-ins of the
 *   same timeline length and transition, so every later clip starts where it did. The clip just ahead
 *   stays real: its transition and sound tail can reach into the range.
 * - Clips more than one past the range are left out (the one just after can overlap its end).
 * - Layers, sounds and captions wholly outside the range are left out.
 */
export function forRange(project: Project, range: { start: number; end: number }): Project {
  const timeline = computeTimeline(project);
  const first = timeline.clips.findIndex((c) => c.end > range.start);
  if (first < 0) return project;
  const lastIn = timeline.clips.reduce((last, c, k) => (c.start < range.end ? k : last), -1);
  const keepFrom = Math.max(0, first - 1);
  const keepTo = Math.min(timeline.clips.length - 1, lastIn + 1);
  const p = deepClone(project);
  let standIns = 0;
  const clips: Clip[] = [];
  for (const tc of timeline.clips) {
    if (tc.index > keepTo) break;
    if (tc.index >= keepFrom) {
      clips.push(p.clips[tc.index]!);
      continue;
    }
    standIns++;
    // Its timeline length at speed 1; the transition into it keeps the overlap with the clip before.
    const t = p.clips[tc.index]!.transition;
    clips.push({ id: tc.clip.id, assetId: RANGE_STAND_IN, in: 0, duration: tc.duration, speed: 1, volume: 1, muted: true, fit: "cover", effects: [], audioEffects: [], ...(t ? { transition: t } : {}) } as Clip);
  }
  if (standIns) p.assets.push({ type: "color", id: RANGE_STAND_IN, color: "#000000" });
  p.clips = clips;
  const outside = (start: number, end: number) => end <= range.start || start >= range.end;
  p.layers = p.layers.filter((l) => !outside(l.start, l.start + l.duration));
  const audioIds = new Set(timeline.audio.filter((a) => outside(a.start, a.end)).map((a) => a.clip.id));
  p.audio = p.audio.filter((a) => !audioIds.has(a.id));
  return p;
}
