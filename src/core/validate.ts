import type { Effect, Project } from "./schema.js";
import { ProjectSchema } from "./schema.js";
import { getEffect } from "../library/effects/index.js";
import { getAudioEffect } from "../library/audio-effects/index.js";
import { getTransition } from "../library/transitions/index.js";
import { getAnimation } from "../library/animations/index.js";
import { getCaptionStyle, CaptionStyleSchema } from "../library/caption-styles/index.js";
import { computeTimeline, TimelineError } from "./timeline.js";

export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Check a project for problems an AI (or human) should fix before rendering. */
export function validateProject(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });
  const warn = (path: string, message: string) => issues.push({ level: "warning", path, message });

  const parsed = ProjectSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(i.path.join("."), i.message);
    return { ok: false, issues };
  }
  const p: Project = parsed.data;

  const ids = new Map<string, string>();
  const checkId = (id: string, path: string) => {
    if (ids.has(id)) err(path, `Duplicate id "${id}" (also used at ${ids.get(id)})`);
    else ids.set(id, path);
  };
  p.assets.forEach((a, i) => checkId(a.id, `assets.${i}`));
  p.clips.forEach((c, i) => checkId(c.id, `clips.${i}`));
  p.layers.forEach((l, i) => checkId(l.id, `layers.${i}`));
  p.audio.forEach((a, i) => checkId(a.id, `audio.${i}`));

  const assetIds = new Set(p.assets.map((a) => a.id));
  const checkEffects = (effects: Effect[], path: string, audio = false) =>
    effects.forEach((e, i) => {
      const def = audio ? getAudioEffect(e.type) : getEffect(e.type);
      if (!def) return err(`${path}.${i}`, `Unknown ${audio ? "audio " : ""}effect "${e.type}"`);
      const r = def.params.safeParse(e.params ?? {});
      if (!r.success) err(`${path}.${i}.params`, r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
    });
  const checkAnim = (type: string | undefined, path: string, media = false) => {
    if (!type) return;
    const def = getAnimation(type);
    if (!def) err(path, `Unknown animation "${type}"`);
    else if (media && !def.media) warn(path, `Animation "${type}" is not supported on media layers; it will render as a fade`);
  };

  p.clips.forEach((c, i) => {
    const asset = p.assets.find((a) => a.id === c.assetId);
    if (!asset) return err(`clips.${i}.assetId`, `Unknown asset "${c.assetId}"`);
    if (asset.type === "audio") err(`clips.${i}.assetId`, `Clip uses audio asset "${asset.id}"; add it to "audio" instead`);
    if (asset.type === "video" && asset.duration !== undefined) {
      if (c.in >= asset.duration) err(`clips.${i}.in`, `in (${c.in}s) is past the end of "${asset.id}" (${asset.duration}s)`);
      else if (c.duration !== undefined && c.in + c.duration > asset.duration + 0.05)
        err(`clips.${i}.duration`, `in + duration (${c.in + c.duration}s) exceeds source length ${asset.duration}s`);
    }
    if (c.transition) {
      if (i === 0) warn(`clips.${i}.transition`, "The first clip's transition is ignored");
      if (!getTransition(c.transition.type)) err(`clips.${i}.transition.type`, `Unknown transition "${c.transition.type}"`);
    }
    checkEffects(c.effects, `clips.${i}.effects`);
    checkEffects(c.audioEffects, `clips.${i}.audioEffects`, true);
  });

  p.layers.forEach((l, i) => {
    if (l.type === "media") {
      if (!assetIds.has(l.assetId)) err(`layers.${i}.assetId`, `Unknown asset "${l.assetId}"`);
      checkEffects(l.effects, `layers.${i}.effects`);
      checkEffects(l.audioEffects, `layers.${i}.audioEffects`, true);
    }
    if (l.type === "text" && !l.text.trim()) warn(`layers.${i}.text`, "Empty text layer");
    checkAnim(l.animationIn?.type, `layers.${i}.animationIn`, l.type === "media");
    checkAnim(l.animationOut?.type, `layers.${i}.animationOut`, l.type === "media");
    if ("position" in l && (l.position.x < -0.5 || l.position.x > 1.5 || l.position.y < -0.5 || l.position.y > 1.5))
      warn(`layers.${i}.position`, "Layer is positioned far outside the frame");
  });

  p.audio.forEach((a, i) => {
    const asset = p.assets.find((x) => x.id === a.assetId);
    if (!asset) err(`audio.${i}.assetId`, `Unknown asset "${a.assetId}"`);
    else if (asset.type !== "audio" && asset.type !== "video") err(`audio.${i}.assetId`, `Asset "${asset.id}" (${asset.type}) has no audio`);
    checkEffects(a.audioEffects, `audio.${i}.audioEffects`, true);
  });

  checkEffects(p.effects, "effects");
  checkEffects(p.audioEffects, "audioEffects", true);

  if (p.captions) {
    if (!getCaptionStyle(p.captions.style)) err("captions.style", `Unknown caption style "${p.captions.style}"`);
    else if (p.captions.overrides) {
      const r = CaptionStyleSchema.partial().safeParse(p.captions.overrides);
      if (!r.success) err("captions.overrides", r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
    }
    if (p.captions.enabled && !p.captions.segments?.length) {
      const hasTranscript = p.clips.some((c) => p.transcripts[c.assetId]) || p.audio.some((a) => a.role === "voiceover" && p.transcripts[a.assetId]);
      if (!hasTranscript) warn("captions", "Captions are enabled but no clip or voice-over has a transcript");
    }
  }
  for (const id of Object.keys(p.transcripts)) {
    if (!assetIds.has(id)) warn(`transcripts.${id}`, `Transcript for unknown asset "${id}"`);
  }

  if (!issues.some((i) => i.level === "error")) {
    try {
      const t = computeTimeline(p);
      if (t.duration <= 0) err("clips", "Project is empty: add clips, layers or audio");
      t.clips.forEach((tc) => {
        if (tc.clip.transition && tc.transitionDuration < tc.clip.transition.duration - 0.001)
          warn(`clips.${tc.index}.transition.duration`, `Transition shortened to ${tc.transitionDuration}s to fit the neighbouring clips`);
      });
      p.layers.forEach((l, i) => {
        if (l.start >= t.duration) warn(`layers.${i}.start`, `Layer starts at ${l.start}s, after the video ends (${t.duration}s)`);
        else if (t.primaryDuration > 0 && l.start + l.duration > t.duration + 0.01)
          warn(`layers.${i}.duration`, `Layer runs past the end of the video (${t.duration}s) and will be cut`);
      });
      t.audio.forEach((ta, i) => {
        if (ta.start >= t.duration) warn(`audio.${i}.start`, `Audio starts after the video ends`);
      });
    } catch (e) {
      if (e instanceof TimelineError) err("timeline", e.message);
      else throw e;
    }
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}
