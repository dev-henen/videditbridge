import type {
  Asset,
  AudioClip,
  Clip,
  Effect,
  Layer,
  Project,
  ProjectInput,
  Transcript,
  Transition,
} from "./schema.js";
import {
  AssetSchema,
  AudioClipSchema,
  ClipSchema,
  EffectSchema,
  LayerSchema,
  ProjectSchema,
  SettingsSchema,
  TransitionSchema,
} from "./schema.js";
import { computeTimeline, getAsset, timelineToSource, type Timeline } from "./timeline.js";
import { mergeRanges, type TimeRange } from "./ranges.js";
import { ASPECT_RATIOS, deepClone, dimensionsFor, newId, round3, type AspectRatio } from "./util.js";
import type { z } from "zod";

/**
 * Pure editing operations. Each takes a project and returns a new project (inputs are never mutated),
 * which makes undo/redo trivial and keeps AI tool calls side-effect free.
 */

export class EditError extends Error {}

export function createProject(input: ProjectInput & { aspectRatio?: AspectRatio } = {}): Project {
  const { aspectRatio, ...rest } = input;
  const settings = aspectRatio ? { ...dimensionsFor(aspectRatio), ...rest.settings } : rest.settings;
  return ProjectSchema.parse({ id: newId("proj"), ...rest, settings });
}

const edit = (project: Project, fn: (draft: Project) => void): Project => {
  const draft = deepClone(project);
  fn(draft);
  return draft;
};

function findClipIndex(p: Project, clipId: string): number {
  const i = p.clips.findIndex((c) => c.id === clipId);
  if (i === -1) throw new EditError(`No clip with id "${clipId}". Clip ids: ${p.clips.map((c) => c.id).join(", ") || "(none)"}`);
  return i;
}

function findLayerIndex(p: Project, layerId: string): number {
  const i = p.layers.findIndex((l) => l.id === layerId);
  if (i === -1) throw new EditError(`No layer with id "${layerId}"`);
  return i;
}

function findAudioIndex(p: Project, audioId: string): number {
  const i = p.audio.findIndex((a) => a.id === audioId);
  if (i === -1) throw new EditError(`No audio clip with id "${audioId}"`);
  return i;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function addAsset(p: Project, asset: z.input<typeof AssetSchema>): Project {
  const parsed = AssetSchema.parse(asset);
  if (p.assets.some((a) => a.id === parsed.id)) throw new EditError(`Asset id "${parsed.id}" already exists`);
  return edit(p, (d) => void d.assets.push(parsed));
}

/** Add or update an asset (by id). */
export function upsertAsset(p: Project, asset: Asset): Project {
  return edit(p, (d) => {
    const i = d.assets.findIndex((a) => a.id === asset.id);
    if (i === -1) d.assets.push(asset);
    else d.assets[i] = asset;
  });
}

export function removeAsset(p: Project, assetId: string): Project {
  const used = p.clips.some((c) => c.assetId === assetId) || p.layers.some((l) => l.type === "media" && l.assetId === assetId) || p.audio.some((a) => a.assetId === assetId);
  if (used) throw new EditError(`Asset "${assetId}" is still used by clips, layers or audio`);
  return edit(p, (d) => {
    d.assets = d.assets.filter((a) => a.id !== assetId);
    delete d.transcripts[assetId];
  });
}

export function setTranscript(p: Project, assetId: string, transcript: Transcript): Project {
  getAsset(p, assetId);
  return edit(p, (d) => void (d.transcripts[assetId] = transcript));
}

// ---------------------------------------------------------------------------
// Primary track clips
// ---------------------------------------------------------------------------

export type ClipInput = Omit<z.input<typeof ClipSchema>, "id"> & { id?: string };

/** Insert a clip into the primary track (appends by default). */
export function addClip(p: Project, clip: ClipInput, index?: number): Project {
  getAsset(p, clip.assetId);
  const parsed = ClipSchema.parse({ id: newId("clip"), ...clip });
  return edit(p, (d) => {
    d.clips.splice(index ?? d.clips.length, 0, parsed);
  });
}

export function updateClip(p: Project, clipId: string, patch: Partial<Omit<ClipInput, "id">>): Project {
  const i = findClipIndex(p, clipId);
  if (patch.assetId) getAsset(p, patch.assetId);
  return edit(p, (d) => {
    d.clips[i] = ClipSchema.parse({ ...d.clips[i], ...patch, id: clipId });
  });
}

export function removeClip(p: Project, clipId: string): Project {
  const i = findClipIndex(p, clipId);
  return edit(p, (d) => {
    d.clips.splice(i, 1);
    if (i === 0 && d.clips[0]) delete d.clips[0].transition;
  });
}

export function moveClip(p: Project, clipId: string, toIndex: number): Project {
  const i = findClipIndex(p, clipId);
  return edit(p, (d) => {
    const [c] = d.clips.splice(i, 1);
    d.clips.splice(Math.max(0, Math.min(toIndex, d.clips.length)), 0, c!);
    if (d.clips[0]) delete d.clips[0].transition;
  });
}

/** Trim a clip by setting new source in/out points (seconds in the source media). */
export function trimClip(p: Project, clipId: string, sourceIn: number, sourceOut: number): Project {
  if (sourceOut <= sourceIn) throw new EditError("sourceOut must be greater than sourceIn");
  return updateClip(p, clipId, { in: sourceIn, duration: round3(sourceOut - sourceIn) });
}

/** Split a primary clip at a timeline time into two clips. Returns the project and the new clip id. */
export function splitClip(p: Project, clipId: string, timelineTime: number): { project: Project; newClipId: string } {
  const timeline = computeTimeline(p);
  const tc = timeline.clips.find((c) => c.clip.id === clipId);
  if (!tc) throw new EditError(`No clip with id "${clipId}"`);
  if (timelineTime <= tc.start + 0.02 || timelineTime >= tc.end - 0.02) {
    throw new EditError(`Split time ${timelineTime}s is outside clip "${clipId}" (${tc.start}–${tc.end}s)`);
  }
  const srcSplit = timelineToSource(tc, timelineTime);
  const firstDur = round3(srcSplit - tc.clip.in);
  const newClipId = newId("clip");
  const project = edit(p, (d) => {
    const c = d.clips[tc.index]!;
    const second: Clip = { ...deepClone(c), id: newClipId, in: round3(srcSplit), duration: round3(tc.sourceDuration - firstDur) };
    delete second.transition;
    delete second.fadeIn;
    c.duration = firstDur;
    delete c.fadeOut;
    d.clips.splice(tc.index + 1, 0, second);
  });
  return { project, newClipId };
}

export function setTransition(p: Project, clipId: string, transition: z.input<typeof TransitionSchema> | null): Project {
  const i = findClipIndex(p, clipId);
  if (i === 0 && transition) throw new EditError("The first clip cannot have an incoming transition");
  return edit(p, (d) => {
    if (transition) d.clips[i]!.transition = TransitionSchema.parse(transition);
    else delete d.clips[i]!.transition;
  });
}

/** Apply the same transition between every pair of clips. */
export function setAllTransitions(p: Project, transition: Transition | null): Project {
  return edit(p, (d) =>
    d.clips.forEach((c, i) => {
      if (i === 0 || !transition) delete c.transition;
      else c.transition = TransitionSchema.parse(transition);
    }),
  );
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Target is a clip id, a media layer id, or "global". */
export function addEffect(p: Project, target: string, effect: Effect): Project {
  const e = EffectSchema.parse(effect);
  return edit(p, (d) => effectList(d, target).push(e));
}

export function removeEffect(p: Project, target: string, effectType: string): Project {
  return edit(p, (d) => {
    const list = effectList(d, target);
    const i = list.findIndex((e) => e.type === effectType);
    if (i === -1) throw new EditError(`"${target}" has no "${effectType}" effect`);
    list.splice(i, 1);
  });
}

function effectList(d: Project, target: string): Effect[] {
  if (target === "global") return d.effects;
  const clip = d.clips.find((c) => c.id === target);
  if (clip) return clip.effects;
  const layer = d.layers.find((l) => l.id === target);
  if (layer?.type === "media") return layer.effects;
  throw new EditError(`Effects target "${target}" must be a clip id, media layer id, or "global"`);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A layer to add; the id is generated when omitted. */
export type LayerInput = DistributiveOmit<z.input<typeof LayerSchema>, "id"> & { id?: string };

export function addLayer(p: Project, layer: LayerInput): Project {
  const parsed = LayerSchema.parse({ id: newId(layer.type), ...layer });
  if (parsed.type === "media") getAsset(p, parsed.assetId);
  return edit(p, (d) => void d.layers.push(parsed));
}

export function updateLayer(p: Project, layerId: string, patch: Record<string, unknown>): Project {
  const i = findLayerIndex(p, layerId);
  return edit(p, (d) => {
    const current = d.layers[i]!;
    const merged: Record<string, unknown> = { ...current, ...patch, id: layerId, type: current.type };
    // Merge nested style objects instead of replacing them.
    if (current.type === "text" && patch.style && typeof patch.style === "object") merged.style = { ...current.style, ...patch.style };
    d.layers[i] = LayerSchema.parse(merged);
  });
}

export function removeLayer(p: Project, layerId: string): Project {
  const i = findLayerIndex(p, layerId);
  return edit(p, (d) => void d.layers.splice(i, 1));
}

/** Change stacking order: higher index draws on top. */
export function reorderLayer(p: Project, layerId: string, toIndex: number): Project {
  const i = findLayerIndex(p, layerId);
  return edit(p, (d) => {
    const [l] = d.layers.splice(i, 1);
    d.layers.splice(Math.max(0, Math.min(toIndex, d.layers.length)), 0, l!);
  });
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type AudioInput = Omit<z.input<typeof AudioClipSchema>, "id"> & { id?: string };

export function addAudio(p: Project, audio: AudioInput): Project {
  getAsset(p, audio.assetId);
  const parsed = AudioClipSchema.parse({ id: newId("audio"), ...audio });
  return edit(p, (d) => void d.audio.push(parsed));
}

export function updateAudio(p: Project, audioId: string, patch: Partial<AudioInput>): Project {
  const i = findAudioIndex(p, audioId);
  return edit(p, (d) => {
    d.audio[i] = AudioClipSchema.parse({ ...d.audio[i], ...patch, id: audioId });
  });
}

export function removeAudio(p: Project, audioId: string): Project {
  const i = findAudioIndex(p, audioId);
  return edit(p, (d) => void d.audio.splice(i, 1));
}

// ---------------------------------------------------------------------------
// Captions & settings
// ---------------------------------------------------------------------------

export function setCaptions(p: Project, captions: { enabled?: boolean; style?: string; overrides?: Record<string, unknown>; segments?: { text: string; start: number; end: number }[] } | null): Project {
  return edit(p, (d) => {
    if (!captions) delete d.captions;
    else d.captions = { enabled: true, style: "classic", ...d.captions, ...captions };
  });
}

export function updateSettings(p: Project, patch: Partial<z.input<typeof SettingsSchema>> & { aspectRatio?: AspectRatio }): Project {
  const { aspectRatio, ...rest } = patch;
  if (aspectRatio && !(aspectRatio in ASPECT_RATIOS)) throw new EditError(`Unknown aspect ratio "${aspectRatio}"`);
  return edit(p, (d) => {
    d.settings = SettingsSchema.parse({ ...d.settings, ...(aspectRatio ? dimensionsFor(aspectRatio) : {}), ...rest });
  });
}

// ---------------------------------------------------------------------------
// Cutting
// ---------------------------------------------------------------------------

/**
 * Remove time ranges from the output timeline. Primary clips are trimmed/split,
 * and layers and audio after each cut shift earlier so everything stays in sync.
 */
export function cutTimelineRanges(p: Project, ranges: TimeRange[]): Project {
  // Process from the end so earlier ranges stay valid.
  const merged = mergeRanges(ranges).sort((a, b) => b.start - a.start);
  let project = p;
  for (const r of merged) project = cutOne(project, r);
  return project;
}

function cutOne(p: Project, range: TimeRange): Project {
  const timeline = computeTimeline(p);
  const removed = range.end - range.start;
  if (removed <= 0) return p;
  return edit(p, (d) => {
    const newClips: Clip[] = [];
    for (const tc of timeline.clips) {
      const c = d.clips[tc.index]!;
      const a = Math.max(range.start, tc.start);
      const b = Math.min(range.end, tc.end);
      if (b <= a) {
        newClips.push(c);
        continue;
      }
      const headDur = round3((a - tc.start) * c.speed);
      const tailIn = round3(timelineToSource(tc, b));
      const tailDur = round3(c.in + tc.sourceDuration - tailIn);
      if (headDur > 0.02) newClips.push({ ...c, duration: headDur, fadeOut: undefined });
      if (tailDur > 0.02) {
        const tail: Clip = { ...deepClone(c), id: headDur > 0.02 ? newId("clip") : c.id, in: tailIn, duration: tailDur };
        if (headDur > 0.02) {
          delete tail.transition;
          delete tail.fadeIn;
        }
        newClips.push(tail);
      }
    }
    d.clips = newClips.map((c) => {
      const out = { ...c };
      if (out.fadeOut === undefined) delete out.fadeOut;
      return out;
    });
    if (d.clips[0]) delete d.clips[0].transition;

    const map = (t: number) => (t <= range.start ? t : t >= range.end ? t - removed : range.start);
    // When an item starts inside the cut, its head is removed: advance its source offset to match.
    // Items that straddle the cut keep playing continuously (b-roll, music) and are just shortened.
    const headTrim = (start: number) => (start >= range.start && start < range.end ? range.end - start : 0);
    d.layers = d.layers.flatMap((l) => {
      const start = map(l.start);
      const end = map(l.start + l.duration);
      if (end - start < 0.05) return [];
      const moved = { ...l, start: round3(start), duration: round3(end - start) } as Layer;
      if (moved.type === "media") moved.in = round3(moved.in + headTrim(l.start));
      return [moved];
    });
    d.audio = d.audio.flatMap((au) => {
      const t = timeline.audio.find((x) => x.clip.id === au.id)!;
      const start = map(t.start);
      const end = map(t.end);
      if (end - start < 0.05) return [];
      return [{ ...au, start: round3(start), in: round3(au.in + headTrim(t.start)), duration: round3(end - start) } as AudioClip];
    });
  });
}

/** Remove source-time ranges from a specific clip's media (e.g. filler words found in its transcript). */
export function cutSourceRanges(p: Project, assetId: string, sourceRanges: TimeRange[], timeline: Timeline = computeTimeline(p)): Project {
  const timelineRanges: TimeRange[] = [];
  for (const tc of timeline.clips) {
    if (tc.clip.assetId !== assetId) continue;
    const srcEnd = tc.clip.in + tc.sourceDuration;
    for (const r of sourceRanges) {
      const a = Math.max(r.start, tc.clip.in);
      const b = Math.min(r.end, srcEnd);
      if (b > a) timelineRanges.push({ start: tc.start + (a - tc.clip.in) / tc.clip.speed, end: tc.start + (b - tc.clip.in) / tc.clip.speed });
    }
  }
  return cutTimelineRanges(p, timelineRanges);
}

/** Keep only the given source ranges of an asset, in order, as the primary track (e.g. highlight extraction). */
export function assembleFromRanges(
  p: Project,
  assetId: string,
  ranges: TimeRange[],
  opts: { transition?: Transition; clipDefaults?: Partial<ClipInput> } = {},
): Project {
  getAsset(p, assetId);
  return edit(p, (d) => {
    d.clips = ranges.map((r, i) =>
      ClipSchema.parse({
        ...opts.clipDefaults,
        id: newId("clip"),
        assetId,
        in: round3(r.start),
        duration: round3(r.end - r.start),
        ...(i > 0 && opts.transition ? { transition: opts.transition } : {}),
      }),
    );
  });
}
