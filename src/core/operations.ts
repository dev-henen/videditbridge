import type {
  Asset,
  AudioClip,
  Clip,
  Effect,
  Keyframe,
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
import { clipAtTime, computeTimeline, getAsset, sourceToTimeline, timelineToSource, type TimedClip, type Timeline } from "./timeline.js";
import { numberAt, positionAt } from "./keyframes.js";
import { getEffect } from "../library/effects/index.js";
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

/**
 * The keyframes of a piece of a clip that keeps `from`..`to` seconds of its source (counted from
 * its in point). Speed keyframes count source time and crop keyframes timeline time, both from the
 * piece's own start, so they shift; a keyframe at each end holds the value there.
 */
function sliceKeyframes(tc: TimedClip, from: number, to: number): Clip["keyframes"] {
  const k = tc.clip.keyframes;
  if (!k) return undefined;
  const out: NonNullable<Clip["keyframes"]> = {};
  // Whole segments keep their keyframes and easing. The part of an eased segment the cut falls in
  // becomes short straight steps (every 0.1 s), so the curve, and so the clip's timing, stays the same.
  const piece = <T>(keys: Keyframe<T>[], a: number, b: number, at: (t: number) => T): Keyframe<T>[] => {
    const inner = keys.filter((x) => x.time > a && x.time < b);
    const out: Keyframe<T>[] = [];
    const steps = (from: number, to: number) => {
      for (let t = from; t < to - 1e-6; t = round3(t + 0.1)) out.push({ time: round3(t - a), value: at(t), easing: "linear" });
    };
    steps(a, inner[0]?.time ?? b);
    inner.forEach((x, i) => out.push({ ...x, time: round3(x.time - a), ...(i === 0 ? { easing: "linear" as const } : {}) }));
    if (inner.length) steps(inner[inner.length - 1]!.time + 0.1, b);
    out.push({ time: round3(b - a), value: at(b), easing: "linear" });
    return out;
  };
  if (k.speed?.length) out.speed = piece(k.speed, from, to, (u) => round3(numberAt(k.speed!, u)));
  if (k.focus?.length) {
    // Crop keyframes count timeline time from the clip's start.
    const a = sourceToTimeline(tc, tc.clip.in + from) - tc.start;
    const b = sourceToTimeline(tc, tc.clip.in + to) - tc.start;
    out.focus = piece(k.focus, a, b, (t) => {
      const p = positionAt(k.focus!, t);
      return { x: round3(p.x), y: round3(p.y) };
    });
  }
  return Object.keys(out).length ? out : undefined;
}

/** Split a primary clip at a timeline time into two clips. Returns the project and the new clip id. */
export function splitClip(p: Project, clipId: string, timelineTime: number): { project: Project; newClipId: string } {
  const timeline = computeTimeline(p);
  const tc = timeline.clips.find((c) => c.clip.id === clipId);
  if (!tc) throw new EditError(`No clip with id "${clipId}"`);
  if (timelineTime <= tc.start + 0.02 || timelineTime >= tc.end - 0.02) {
    throw new EditError(`Split time ${timelineTime}s is outside clip "${clipId}" (${tc.start}-${tc.end}s)`);
  }
  const srcSplit = timelineToSource(tc, timelineTime);
  const firstDur = round3(srcSplit - tc.clip.in);
  const newClipId = newId("clip");
  const project = edit(p, (d) => {
    const c = d.clips[tc.index]!;
    const second: Clip = { ...deepClone(c), id: newClipId, in: round3(srcSplit), duration: round3(tc.sourceDuration - firstDur) };
    delete second.transition;
    delete second.fadeIn;
    second.keyframes = sliceKeyframes(tc, firstDur, tc.sourceDuration);
    c.keyframes = sliceKeyframes(tc, 0, firstDur);
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

/** The params of the first effect of a type on a target, if any. */
export function getEffectParams(p: Project, target: string, effectType: string): Record<string, unknown> | undefined {
  return effectList(p, target).find((e) => e.type === effectType)?.params;
}

/**
 * Set the params of the first effect of a type on a target, adding the effect if it isn't there.
 * `prepend` adds a new effect first in the chain (color correction belongs before stylizing).
 */
export function setEffectParams(p: Project, target: string, effectType: string, params: Record<string, unknown>, opts: { prepend?: boolean } = {}): Project {
  return edit(p, (d) => {
    const list = effectList(d, target);
    const existing = list.find((e) => e.type === effectType);
    if (existing) existing.params = params;
    else if (opts.prepend) {
      // "First" still comes after keying: a green screen must be keyed on the original colors.
      const keyed = list.reduce((last, e, k) => (KEYING_EFFECTS.has(e.type) ? k + 1 : last), 0);
      list.splice(keyed, 0, EffectSchema.parse({ type: effectType, params }));
    } else list.push(EffectSchema.parse({ type: effectType, params }));
  });
}

/** Set or clear (`null`) the keyframes of an effect already on a target. */
export function setEffectKeyframes(p: Project, target: string, effectType: string, keyframes: Effect["keyframes"] | null): Project {
  return edit(p, (d) => {
    const effect = effectList(d, target).find((e) => e.type === effectType);
    if (!effect) throw new EditError(`"${target}" has no ${effectType} effect; add it first`);
    if (keyframes?.length) effect.keyframes = [...keyframes].sort((a, b) => a.time - b.time);
    else delete effect.keyframes;
  });
}

/** Effects that must see the untouched source colors, so prepended effects go after them. */
const KEYING_EFFECTS = new Set(["chromaKey"]);

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
// Audio effects, speed & volume
// ---------------------------------------------------------------------------

/** Target is a clip id, an audio clip id, a media layer id, or "master" (the final mix). */
export function addAudioEffect(p: Project, target: string, effect: Effect): Project {
  const e = EffectSchema.parse(effect);
  return edit(p, (d) => void audioEffectList(d, target).push(e));
}

/** The params of the first audio effect of a type on a target, if any. */
export function getAudioEffectParams(p: Project, target: string, effectType: string): Record<string, unknown> | undefined {
  return audioEffectList(p, target).find((e) => e.type === effectType)?.params;
}

/**
 * Set the params of the first audio effect of a type on a target, adding the effect if it isn't there.
 * `prepend` adds a new effect first (cleanup belongs before creative effects).
 */
export function setAudioEffectParams(p: Project, target: string, effectType: string, params: Record<string, unknown>, opts: { prepend?: boolean } = {}): Project {
  return edit(p, (d) => {
    const list = audioEffectList(d, target);
    const existing = list.find((e) => e.type === effectType);
    if (existing) existing.params = params;
    else if (opts.prepend) list.unshift(EffectSchema.parse({ type: effectType, params }));
    else list.push(EffectSchema.parse({ type: effectType, params }));
  });
}

export function removeAudioEffect(p: Project, target: string, effectType: string): Project {
  return edit(p, (d) => {
    const list = audioEffectList(d, target);
    const i = list.findIndex((e) => e.type === effectType);
    if (i === -1) throw new EditError(`"${target}" has no "${effectType}" audio effect`);
    list.splice(i, 1);
  });
}

function audioEffectList(d: Project, target: string): Effect[] {
  if (target === "master") return d.audioEffects;
  const clip = d.clips.find((c) => c.id === target);
  if (clip) return clip.audioEffects;
  const audio = d.audio.find((a) => a.id === target);
  if (audio) return audio.audioEffects;
  const layer = d.layers.find((l) => l.id === target);
  if (layer?.type === "media") return layer.audioEffects;
  throw new EditError(`Audio effects target "${target}" must be a clip id, audio clip id, media layer id, or "master"`);
}

/**
 * Change playback speed of a primary clip or an audio clip (0.25-4, pitch preserved).
 * The source range stays the same, so the clip gets shorter or longer on the timeline.
 */
export function setSpeed(p: Project, target: string, speed: number): Project {
  if (!(speed >= 0.25 && speed <= 4)) throw new EditError("Speed must be between 0.25 and 4");
  return edit(p, (d) => {
    const clip = d.clips.find((c) => c.id === target);
    if (clip) {
      // A steady speed replaces a speed ramp.
      clip.speed = speed;
      if (clip.keyframes?.speed) {
        delete clip.keyframes.speed;
        if (!Object.keys(clip.keyframes).length) delete clip.keyframes;
      }
      return;
    }
    const audio = d.audio.find((a) => a.id === target);
    if (!audio) throw new EditError(`Speed target "${target}" must be a clip id or audio clip id`);
    // An explicit duration is timeline time; keep the same source range at the new speed.
    if (audio.duration !== undefined) audio.duration = round3((audio.duration * audio.speed) / speed);
    audio.speed = speed;
  });
}

/**
 * Set the volume of a clip, audio clip or media layer (linear gain, 1 = original, 0-4),
 * or of the whole mix with target "master" (stored as a master "gain" audio effect).
 */
export function setVolume(p: Project, target: string, volume: number, opts: { muted?: boolean } = {}): Project {
  if (!(volume >= 0 && volume <= 4)) throw new EditError("Volume must be between 0 and 4 (1 = original level)");
  if (target === "master") {
    const db = volume === 0 ? -60 : round3(20 * Math.log10(volume));
    return volume === 1 && !p.audioEffects.some((e) => e.type === "gain")
      ? p
      : setAudioEffectParams(p, "master", "gain", { db: Math.max(-60, Math.min(24, db)) });
  }
  return edit(p, (d) => {
    const clip = d.clips.find((c) => c.id === target);
    if (clip) {
      clip.volume = volume;
      if (opts.muted !== undefined) clip.muted = opts.muted;
      return;
    }
    const audio = d.audio.find((a) => a.id === target);
    if (audio) return void (audio.volume = volume);
    const layer = d.layers.find((l) => l.id === target);
    if (layer?.type === "media") return void (layer.volume = volume);
    throw new EditError(`Volume target "${target}" must be a clip id, audio clip id, media layer id, or "master"`);
  });
}

// ---------------------------------------------------------------------------
// Moments: effects and cuts placed at timeline times
// ---------------------------------------------------------------------------

/**
 * Put a timed effect on the primary clips playing at the given timeline times. Effects with a
 * `times` list (zoomPunch, impactShake, flashHits, vibrate) get each time converted to their
 * clip's own time and merged with moments already there; effects with a `start` (smoothZoom,
 * rackFocus) start at the first time that falls in each clip. Other params are merged in.
 */
export function placeMomentEffect(
  p: Project,
  effectType: string,
  times: number[],
  params: Record<string, unknown> = {},
): { project: Project; placed: { clipId: string; times: number[] }[] } {
  const def = getEffect(effectType);
  if (!def) throw new EditError(`Unknown effect "${effectType}"`);
  const shape = (def.params as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const key = "times" in shape ? "times" : "start" in shape ? "start" : undefined;
  if (!key) throw new EditError(`Effect "${effectType}" has no times or start to place; use add_effect instead`);
  const timeline = computeTimeline(p);
  const byClip = new Map<number, number[]>();
  for (const t of [...times].sort((a, b) => a - b)) {
    const tc = clipAtTime(timeline, t);
    if (!tc) continue;
    const list = byClip.get(tc.index) ?? [];
    list.push(round3(t - tc.start));
    byClip.set(tc.index, list);
  }
  if (!byClip.size) throw new EditError(`None of the times fall on a primary clip (video is ${timeline.primaryDuration}s)`);
  const placed: { clipId: string; times: number[] }[] = [];
  const project = edit(p, (d) => {
    for (const [index, local] of byClip) {
      const clip = d.clips[index]!;
      const existing = clip.effects.find((e) => e.type === effectType);
      const merged: Record<string, unknown> = { ...(existing?.params ?? {}), ...params };
      if (key === "times") {
        const before = Array.isArray(existing?.params?.times) ? (existing!.params!.times as number[]) : [];
        merged.times = [...new Set([...before, ...local])].sort((a, b) => a - b).slice(0, 64);
      } else merged.start = local[0];
      const parsed = def.params.parse(merged) as Record<string, unknown>;
      if (existing) existing.params = parsed;
      else clip.effects.push(EffectSchema.parse({ type: effectType, params: parsed }));
      placed.push({ clipId: clip.id, times: local });
    }
  });
  return { project, placed };
}

/**
 * Move each cut between primary clips to the nearest of the given timeline times (for example
 * beats), by lengthening or shortening the clip before it. Clips stay at least `minClip` long
 * and never run past the end of their source.
 */
export function snapCutsToTimes(
  p: Project,
  times: number[],
  opts: { minClip?: number } = {},
): { project: Project; moved: { clipId: string; from: number; to: number }[] } {
  const minClip = opts.minClip ?? 0.4;
  const sorted = [...times].sort((a, b) => a - b);
  const moved: { clipId: string; from: number; to: number }[] = [];
  let project = p;
  for (let i = 0; i < project.clips.length - 1; i++) {
    const tc = computeTimeline(project).clips[i]!;
    const clip = tc.clip;
    const asset = tc.asset;
    const maxSource = asset.type === "video" && asset.duration !== undefined ? asset.duration - clip.in : Infinity;
    const maxEnd = sourceToTimeline(tc, clip.in + maxSource);
    let best: number | undefined;
    for (const t of sorted) {
      if (t < tc.start + minClip || t > maxEnd + 1e-6) continue;
      if (best === undefined || Math.abs(t - tc.end) < Math.abs(best - tc.end)) best = t;
    }
    if (best === undefined || Math.abs(best - tc.end) < 0.01) continue;
    const to = best;
    project = edit(project, (d) => void (d.clips[i]!.duration = round3(timelineToSource(tc, to) - clip.in)));
    moved.push({ clipId: clip.id, from: tc.end, to: round3(to) });
  }
  return { project, moved };
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
      const headDur = round3(timelineToSource(tc, a) - tc.clip.in);
      const tailIn = round3(timelineToSource(tc, b));
      const tailDur = round3(c.in + tc.sourceDuration - tailIn);
      if (headDur > 0.02) newClips.push({ ...c, duration: headDur, fadeOut: undefined, keyframes: sliceKeyframes(tc, 0, headDur) });
      if (tailDur > 0.02) {
        const tail: Clip = { ...deepClone(c), id: headDur > 0.02 ? newId("clip") : c.id, in: tailIn, duration: tailDur, keyframes: sliceKeyframes(tc, tailIn - c.in, tc.sourceDuration) };
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
      if (b > a) timelineRanges.push({ start: sourceToTimeline(tc, a), end: sourceToTimeline(tc, b) });
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
