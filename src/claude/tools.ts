import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AnimationSchema,
  EasingSchema,
  EffectSchema,
  FitSchema,
  PositionSchema,
  TextStyleSchema,
  TransitionSchema,
  type Asset,
  type Project,
} from "../core/schema.js";
import * as ops from "../core/operations.js";
import { computeTimeline, sourceToTimeline } from "../core/timeline.js";
import { isAnimated, simplifyKeys, smoothKeys } from "../core/keyframes.js";
import { validateProject } from "../core/validate.js";
import { summarizeProject } from "../core/summary.js";
import { ASPECT_RATIOS, formatTime, newId, round3, type AspectRatio } from "../core/util.js";
import { ColorSettingsSchema, SubjectRegionSchema, describeColorSettings, getEffect, listEffects, mergeColorSettings, type ColorSettings } from "../library/effects/index.js";
import { getAudioEffect, listAudioEffects } from "../library/audio-effects/index.js";
import { getTransition, listTransitions } from "../library/transitions/index.js";
import { listAnimations } from "../library/animations/index.js";
import { listCaptionStyles } from "../library/caption-styles/index.js";
import { addComponent, listComponents } from "../library/components/index.js";
import { applyTemplate, describeTemplate, getTemplate, listTemplates } from "../library/templates/index.js";
import { formatTranscript, searchTranscript, transcriptStats } from "../tools/transcript/analyze.js";
import { parseTranscript } from "../tools/transcript/parse.js";
import { cleanupSpeech } from "../tools/transcript/cleanup.js";
import { findRetakes, sentenceCutRanges } from "../tools/transcript/takes.js";
import { replaceWords, vocabularySuggestions } from "../tools/transcript/fix.js";
import { REVIEW_CHECKS, reviewEdit, textLayerBox } from "../tools/review/index.js";
import { FaceDetector, detectClipFaces, detectFacesCached, faceRegion, focusOn, personRegion, trackFaces, type ClipFaces } from "../tools/vision/index.js";
import { transcribeMedia } from "../tools/transcript/providers.js";
import { LocalWhisperTranscriber } from "../tools/transcript/local.js";
import { LOCAL_VOICES, LocalTTS, RECOMMENDED_VOICES, VOICES } from "../tools/voiceover/local.js";
import { exportCaptions } from "../tools/captions/build.js";
import { probe, runFfmpegOrThrow } from "../tools/render/ffmpeg.js";
import { render, renderContactSheet, renderFrame } from "../tools/render/render.js";
import { analyzeColor, renderScopes } from "../tools/render/color-analysis.js";
import { analyzeSamples, decodeAudio, detectBeats, formatSoundMap, soundRanges, type BeatAnalysis, type SoundKind, type SoundMap } from "../tools/audio/analyze.js";
import { renderSoundMapImage } from "../tools/audio/image.js";
import { renderSoundEffect } from "../tools/audio/sfx.js";
import { detectScenes } from "../tools/video/scenes.js";
import { getSoundEffect, listSoundEffects } from "../library/sound-effects/index.js";
import { invertRanges } from "../core/ranges.js";
import { stat } from "node:fs/promises";
import type { ActivityHandle, EditorSession } from "./session.js";

export interface ToolResult {
  text: string;
  /** Images for the model to look at (rendered frames, contact sheets). */
  images?: { path: string; mediaType: "image/png" | "image/jpeg" }[];
  data?: unknown;
  isError?: boolean;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Tools that change the project. */
  mutates: boolean;
  /** `activity` is the live activity for this call; long-running tools report progress on it. */
  run(session: EditorSession, input: z.output<S>, activity?: ActivityHandle): Promise<ToolResult>;
}

function tool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

const ok = (text: string, data?: unknown): ToolResult => ({ text, ...(data !== undefined ? { data } : {}) });
const aspect = z.enum(Object.keys(ASPECT_RATIOS) as [AspectRatio, ...AspectRatio[]]);
const empty = z.object({});

/** Commit a change and describe it briefly. */
function commit(session: EditorSession, project: Project, action: string, input: unknown, message: string): ToolResult {
  session.commit(project, action, input);
  const v = validateProject(project);
  // An empty project is a normal starting point (e.g. while importing media), not a problem to report.
  const problems = v.issues.filter((i) => i.level === "error" && !/is empty/.test(i.message)).map((i) => `${i.path}: ${i.message}`);
  const duration = (() => {
    try {
      return computeTimeline(project).duration;
    } catch {
      return undefined;
    }
  })();
  return ok(
    `${message}${duration !== undefined ? ` (video now ${duration}s)` : ""}${problems.length ? `\nProblems to fix:\n- ${problems.join("\n- ")}` : ""}`,
  );
}

function assetIdFromSrc(project: Project, src: string): string {
  const base = path.basename(src).replace(/\.[^.]+$/, "").replace(/[^\w]+/g, "_").toLowerCase() || "media";
  let id = base;
  let n = 2;
  while (project.assets.some((a) => a.id === id)) id = `${base}_${n++}`;
  return id;
}

// ---------------------------------------------------------------------------
// Sound analysis, cached per file so a long recording is decoded once
// ---------------------------------------------------------------------------

interface SoundAnalysis {
  map: SoundMap;
  beats: BeatAnalysis;
}

const soundCache = new Map<string, Promise<SoundAnalysis>>();

/** Sound map and beats of a media file, or of `range` (source seconds) within it. */
async function analyzeSound(s: EditorSession, src: string, range?: { start: number; end: number }): Promise<SoundAnalysis> {
  const file = s.resolve(src);
  const mtime = await stat(file).then((x) => x.mtimeMs, () => 0);
  const key = `${file}|${mtime}|${range ? `${range.start}-${range.end}` : "all"}`;
  let pending = soundCache.get(key);
  if (!pending) {
    pending = decodeAudio(file, { ffmpegPath: s.options.ffmpegPath, start: range?.start, duration: range ? range.end - range.start : undefined }).then((x) => ({
      map: analyzeSamples(x),
      beats: detectBeats(x),
    }));
    soundCache.set(key, pending);
    if (soundCache.size > 32) soundCache.delete(soundCache.keys().next().value!);
    pending.catch(() => soundCache.delete(key));
  }
  return pending;
}

function mediaAsset(s: EditorSession, assetId: string): Extract<Asset, { type: "video" | "audio" }> {
  const asset = s.project.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`Unknown asset "${assetId}". Assets: ${s.project.assets.map((a) => a.id).join(", ") || "(none)"}`);
  if (asset.type !== "video" && asset.type !== "audio") throw new Error(`Asset "${assetId}" is ${asset.type === "image" ? "an image" : `a ${asset.type}`} and has no sound`);
  if (asset.type === "video" && asset.hasAudio === false) throw new Error(`Video "${assetId}" has no audio track`);
  return asset;
}

/** Beat times on the timeline, from an audio clip (following its start, trim, speed and loop) or a primary-track asset. */
async function timelineBeats(s: EditorSession, source: string): Promise<{ beats: number[]; downbeats: number[]; bpm?: number; confidence: number }> {
  const timeline = computeTimeline(s.project);
  const ta = timeline.audio.find((a) => a.clip.id === source);
  if (ta) {
    const asset = mediaAsset(s, ta.clip.assetId);
    const { beats } = await analyzeSound(s, asset.src);
    if (!beats.bpm) return { beats: [], downbeats: [], confidence: beats.confidence };
    const srcLen = asset.duration ?? Infinity;
    // Looped audio plays from the top of the file (as the renderer does), repeating every srcLen.
    const loops = ta.clip.loop && Number.isFinite(srcLen);
    const from = loops ? 0 : ta.clip.in;
    const map = (list: number[]) => {
      const out: number[] = [];
      const reps = loops ? Math.ceil((ta.duration * ta.clip.speed) / srcLen) : 1;
      for (let k = 0; k < reps; k++)
        for (const b of list) {
          const src = b + k * srcLen;
          if (src < from) continue;
          const t = ta.start + (src - from) / ta.clip.speed;
          if (t <= ta.end) out.push(Math.round(t * 1000) / 1000);
        }
      return out;
    };
    return { beats: map(beats.beats), downbeats: map(beats.downbeats), bpm: Math.round(beats.bpm * ta.clip.speed * 10) / 10, confidence: beats.confidence };
  }
  const clips = timeline.clips.filter((c) => c.clip.assetId === source);
  if (!clips.length) throw new Error(`"${source}" is not an audio clip id or an asset on the primary track`);
  const asset = mediaAsset(s, source);
  const { beats } = await analyzeSound(s, asset.src);
  const map = (list: number[]) =>
    clips.flatMap((tc) => list.filter((b) => b >= tc.clip.in && b < tc.clip.in + tc.sourceDuration).map((b) => Math.round(sourceToTimeline(tc, b) * 1000) / 1000));
  return { beats: map(beats.beats), downbeats: map(beats.downbeats), bpm: beats.bpm, confidence: beats.confidence };
}

const SoundKindSchema = z.enum(["speech", "music", "sound"]);

/** How a narration was made, kept in project.metadata.narration[assetId] so it can be re-voiced. */
interface NarrationInfo {
  text: string;
  voice?: string;
  speed?: number;
  instructions?: string;
}

function rememberNarration(p: Project, assetId: string, info: NarrationInfo): Project {
  const narration = { ...((p.metadata.narration ?? {}) as Record<string, NarrationInfo>), [assetId]: info };
  return { ...p, metadata: { ...p.metadata, narration } };
}

/** The session was given a voice engine other than the built-in local one. */
function externalVoice(s: EditorSession): boolean {
  return !!s.options.tts && s.options.tts.name !== "local-kokoro";
}

/** The project's narration voice (set_voice), if any. */
function projectVoice(s: EditorSession): { voice?: string; speed?: number } {
  return (s.project.metadata.voice ?? {}) as { voice?: string; speed?: number };
}

/** Speak text with the session's provider, or the local voice model. */
async function speak(s: EditorSession, text: string, opts: { voice?: string; speed?: number; instructions?: string }, activity?: ActivityHandle) {
  const tts = s.options.tts ?? new LocalTTS({ ffmpegPath: s.options.ffmpegPath, onDownload: (p) => activity?.progress(p * 0.5) });
  const file = await s.outputPath(tts.name === "local-kokoro" ? "voiceover.wav" : "voiceover.mp3");
  return tts.synthesize(text, file, opts);
}

/** Names and terms said in the video (fix_transcript vocabulary), kept in project.metadata.vocabulary. */
function projectVocabulary(p: Project): string[] {
  const v = p.metadata.vocabulary;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Likely mishearings of the project's vocabulary in a transcript, as lines to read. */
function mishearings(p: Project, assetIds: string[]): string[] {
  const vocab = projectVocabulary(p);
  if (!vocab.length) return [];
  return assetIds.flatMap((id) =>
    vocabularySuggestions(p.transcripts[id] ?? { words: [] }, vocab).map((x) => `${id} ${x.start}-${x.end}s: "${x.heard}" may be "${x.term}"`),
  );
}

/** The built-in on-device Whisper transcriber, reporting the first-use model download on the activity. */
function localTranscriber(s: EditorSession, activity?: ActivityHandle): LocalWhisperTranscriber {
  return new LocalWhisperTranscriber({ ffmpegPath: s.options.ffmpegPath, onDownload: (p) => activity?.progress(p * 0.5) });
}

/** Render a sound effect (cached on disk) and make sure the project has it as an asset. */
async function sfxAsset(
  s: EditorSession,
  p: Project,
  type: string,
  params: Record<string, unknown> = {},
): Promise<{ project: Project; assetId: string; duration: number; peak: number }> {
  const sfx = await renderSoundEffect(type, params, path.join(s.options.outputDir, "sfx"), { ffmpegPath: s.options.ffmpegPath });
  const existing = p.assets.find((a) => "src" in a && s.resolve(a.src) === sfx.path);
  if (existing) return { project: p, assetId: existing.id, duration: sfx.duration, peak: sfx.peak };
  const id = assetIdFromSrc(p, `sfx-${type}`);
  return { project: ops.addAsset(p, { type: "audio", id, src: sfx.path, duration: sfx.duration, label: `${type} sound effect` }), assetId: id, duration: sfx.duration, peak: sfx.peak };
}

/**
 * Place the matching sound on each clip's incoming transition, peaking at the middle of the
 * transition. Sounds are labeled "transition:<clipId>" so changing a transition replaces its sound.
 */
async function transitionSounds(s: EditorSession, p: Project, clipIds: string[], override?: string): Promise<{ project: Project; placed: string[] }> {
  let project = { ...p, audio: p.audio.filter((a) => !clipIds.some((id) => a.label === `transition:${id}`)) };
  const placed: string[] = [];
  for (const id of clipIds) {
    const tc = computeTimeline(project).clips.find((c) => c.clip.id === id);
    if (!tc?.clip.transition || tc.transitionDuration <= 0) continue;
    const type = override ?? getTransition(tc.clip.transition.type)?.sound;
    if (!type) continue;
    const d = tc.transitionDuration;
    // Stretch whooshes with the transition so the swell matches the motion.
    const params = type === "whoosh" ? { duration: Math.min(1.2, Math.max(0.5, d * 2.5)) } : type === "swoosh" ? { duration: Math.min(0.6, Math.max(0.25, d * 1.5)) } : {};
    const sfx = await sfxAsset(s, project, type, params);
    project = sfx.project;
    const start = Math.max(0, Math.round((tc.start + d / 2 - sfx.peak) * 1000) / 1000);
    project = ops.addAudio(project, { assetId: sfx.assetId, role: "sfx", start, volume: 0.55, label: `transition:${id}` });
    placed.push(`${type} at ${start}s`);
  }
  return { project, placed };
}

/** The local face detector, reporting the first-use model download on the activity. */
function faceDetector(s: EditorSession, activity?: ActivityHandle): FaceDetector {
  return new FaceDetector({ ffmpegPath: s.options.ffmpegPath, onDownload: (p) => activity?.progress(p * 0.2) });
}

/** Faces in a primary clip, mapped into the edit's frame (see detectClipFaces). */
function clipFaces(s: EditorSession, clipId: string, activity?: ActivityHandle): Promise<ClipFaces> {
  return detectClipFaces(s.project, clipId, faceDetector(s, activity), { baseDir: s.options.baseDir });
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fmtBox = (b: { x0: number; y0: number; x1: number; y1: number }) => `x ${b.x0.toFixed(2)}-${b.x1.toFixed(2)}, y ${b.y0.toFixed(2)}-${b.y1.toFixed(2)}`;

/** Sound that matches a moment effect, for add_moment_effect with sound: true. */
const MOMENT_SOUNDS: Record<string, string> = { zoomPunch: "hit", impactShake: "impact", flashHits: "hit", smoothZoom: "whoosh" };

export const TOOLS: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // Inspect
  // -------------------------------------------------------------------------
  tool({
    name: "get_project",
    description:
      "Get a readable summary of the current edit (assets, clips with timeline times, layers, audio, captions) plus validation issues. Call this first and whenever you need to re-orient.",
    input: z.object({ includeJson: z.boolean().default(false).describe("Also return the raw project JSON") }),
    mutates: false,
    run: async (s, i) => {
      const v = validateProject(s.project);
      const issues = v.issues.map((x) => `${x.level === "error" ? "Error" : "Warning"}: ${x.path}: ${x.message}`).join("\n");
      return ok(`${summarizeProject(s.project)}${issues ? `\n\nIssues:\n${issues}` : "\n\nNo issues."}${i.includeJson ? `\n\nJSON:\n${JSON.stringify(s.project)}` : ""}`);
    },
  }),
  tool({
    name: "new_project",
    description: "Start a new empty project (discarding the current one; undo restores it).",
    input: z.object({ name: z.string().default("Untitled"), aspectRatio: aspect.default("9:16"), fps: z.number().default(30) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.createProject({ name: i.name, aspectRatio: i.aspectRatio, settings: { fps: i.fps } }), "new_project", i, `Created ${i.aspectRatio} project "${i.name}".`),
  }),
  tool({
    name: "set_project_settings",
    description: "Change resolution/aspect ratio, frame rate, background color or name.",
    input: z.object({
      aspectRatio: aspect.optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      fps: z.number().optional(),
      backgroundColor: z.string().optional(),
      name: z.string().optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const { name, ...settings } = i;
      let p = ops.updateSettings(s.project, settings);
      if (name) p = { ...p, name };
      return commit(s, p, "set_project_settings", i, `Settings: ${p.settings.width}x${p.settings.height} @ ${p.settings.fps}fps.`);
    },
  }),
  tool({
    name: "undo",
    description: "Undo the last edit.",
    input: empty,
    mutates: true,
    run: async (s) => {
      const a = s.undo();
      return ok(a ? `Undid "${a}".` : "Nothing to undo.");
    },
  }),
  tool({
    name: "redo",
    description: "Redo the last undone edit.",
    input: empty,
    mutates: true,
    run: async (s) => {
      const a = s.redo();
      return ok(a ? `Redid "${a}".` : "Nothing to redo.");
    },
  }),

  // -------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------
  tool({
    name: "list_templates",
    description: "Browse video templates (styles to edit toward). Filter by category, aspect ratio or a search query like 'podcast' or 'real estate'.",
    input: z.object({
      category: z.enum(["social", "youtube", "business", "education", "personal", "promo", "entertainment"]).optional(),
      aspectRatio: aspect.optional(),
      query: z.string().optional(),
    }),
    mutates: false,
    run: async (_s, i) => {
      const list = listTemplates(i);
      return ok(list.map((t) => `${t.id}: ${t.name} [${t.aspectRatio}, ${t.idealDuration[0]}-${t.idealDuration[1]}s] ${t.description}`).join("\n") || "No templates match.");
    },
  }),
  tool({
    name: "get_template",
    description: "Read a template's brief: required inputs (slots), scenes, look, and guidance on how to edit footage to match it.",
    input: z.object({ id: z.string(), includeSpec: z.boolean().default(false).describe("Also return the full JSON spec") }),
    mutates: false,
    run: async (_s, i) => {
      const t = getTemplate(i.id);
      if (!t) return { text: `Unknown template "${i.id}". Use list_templates.`, isError: true };
      return ok(`${describeTemplate(t)}${i.includeSpec ? `\n\nSpec:\n${JSON.stringify(t)}` : ""}`);
    },
  }),
  tool({
    name: "apply_template",
    description:
      "Build a new edit from a template and inputs (replaces the current project; undo restores it). Inputs map slot ids to values: text slots take strings; media slots take a path or {src, in, duration}; list slots take arrays of objects using the listed fields. Media are probed automatically. Transcripts already set on imported assets with the same src are reused for captions.",
    input: z.object({
      templateId: z.string(),
      inputs: z.record(z.string(), z.unknown()),
      aspectRatio: aspect.optional().describe("Override the template's aspect ratio"),
      theme: z.record(z.string(), z.string()).optional().describe("Theme overrides, e.g. {accentColor: '#FF0000'}"),
    }),
    mutates: true,
    run: async (s, i) => {
      const { project, warnings } = await applyTemplate(i.templateId, i.inputs as never, {
        aspectRatio: i.aspectRatio,
        theme: i.theme,
        probe: (src) => probe(s.resolve(src), { ffmpegPath: s.options.ffmpegPath }),
      });
      // Reuse transcripts from previously imported assets with the same source.
      for (const a of project.assets) {
        if (!("src" in a) || project.transcripts[a.id]) continue;
        const prev = s.project.assets.find((x) => "src" in x && s.resolve(x.src) === s.resolve(a.src) && s.project.transcripts[x.id]);
        if (prev) project.transcripts[a.id] = s.project.transcripts[prev.id]!;
      }
      const tpl = getTemplate(i.templateId)!;
      if (tpl.captions && Object.keys(project.transcripts).length && !project.captions) {
        project.captions = { enabled: true, style: tpl.captions.style, ...(tpl.captions.overrides ? { overrides: tpl.captions.overrides } : {}) };
      }
      const r = commit(s, project, "apply_template", i, `Applied template "${i.templateId}".`);
      return { ...r, text: `${r.text}${warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""}\n\n${summarizeProject(project)}` };
    },
  }),
  tool({
    name: "list_effects",
    description: "List available visual effects (color grades, retouch, bokeh and blur, light, zooms and motion, shakes, stylize) with their parameters.",
    input: z.object({ category: z.enum(["light", "color", "grade", "retouch", "blur", "stylize", "motion", "shake", "distort", "time"]).optional() }),
    mutates: false,
    run: async (_s, i) =>
      ok(
        listEffects(i.category)
          .map((e) => {
            const shape = (e.params as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
            const params = Object.entries(shape).map(([k, v]) => `${k}${v.description ? `: ${v.description}` : ""}`);
            return `${e.id} (${e.category}): ${e.description}${params.length ? ` Params: ${params.join("; ")}` : ""}`;
          })
          .join("\n"),
      ),
  }),
  tool({
    name: "list_audio_effects",
    description: "List audio effects (noise reduction, voice enhancement, EQ, dynamics, loudness, reverb, pitch, robot, telephone…) with their parameters.",
    input: z.object({ category: z.enum(["cleanup", "voice", "dynamics", "eq", "volume", "creative"]).optional() }),
    mutates: false,
    run: async (_s, i) =>
      ok(
        listAudioEffects(i.category)
          .map((e) => {
            const shape = (e.params as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
            const params = Object.entries(shape).map(([k, v]) => `${k}${v.description ? `: ${v.description}` : ""}`);
            return `${e.id} (${e.category}): ${e.description}${params.length ? ` Params: ${params.join("; ")}` : ""}`;
          })
          .join("\n"),
      ),
  }),
  tool({
    name: "list_transitions",
    description: "List transitions usable between primary-track clips.",
    input: empty,
    mutates: false,
    run: async () => ok(listTransitions().map((t) => `${t.id} (${t.category}, ~${t.defaultDuration}s): ${t.description}`).join("\n")),
  }),
  tool({
    name: "list_animations",
    description: "List entrance/exit animations for text, shape and media layers.",
    input: empty,
    mutates: false,
    run: async () => ok(listAnimations().map((a) => `${a.id}${a.media ? "" : " (text/shapes only)"}: ${a.description}`).join("\n")),
  }),
  tool({
    name: "list_caption_styles",
    description: "List caption style presets (bold-pop, karaoke, word-by-word, boxed, cinematic…).",
    input: empty,
    mutates: false,
    run: async () => ok(listCaptionStyles().map((c) => `${c.id}: ${c.name}. ${c.description} [mode ${c.mode}]`).join("\n")),
  }),
  tool({
    name: "list_components",
    description: "List reusable components (lower-third, title-card, CTA, subscribe button, quote, number badge, countdown…) and their params.",
    input: empty,
    mutates: false,
    run: async () =>
      ok(
        listComponents()
          .map((c) => {
            const shape = (c.params as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
            return `${c.id} (${c.category}, ${c.defaultDuration}s): ${c.description} Params: ${Object.keys(shape).join(", ")}`;
          })
          .join("\n"),
      ),
  }),

  // -------------------------------------------------------------------------
  // Media & primary track
  // -------------------------------------------------------------------------
  tool({
    name: "import_media",
    description: "Add a video, audio or image file to the project's assets (probes duration, size and audio). Returns the asset id.",
    input: z.object({ src: z.string().describe("File path or URL"), id: z.string().optional(), label: z.string().optional() }),
    mutates: true,
    run: async (s, i) => {
      const info = await probe(s.resolve(i.src), { ffmpegPath: s.options.ffmpegPath });
      const id = i.id ?? assetIdFromSrc(s.project, i.src);
      const asset: Asset = info.isImage
        ? { type: "image", id, src: i.src, width: info.width, height: info.height, label: i.label }
        : info.hasVideo
          ? { type: "video", id, src: i.src, duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, label: i.label }
          : { type: "audio", id, src: i.src, duration: info.duration, label: i.label };
      return commit(s, ops.addAsset(s.project, asset), "import_media", i, `Imported "${id}" (${asset.type}${info.duration ? `, ${info.duration}s` : ""}${info.width ? `, ${info.width}x${info.height}` : ""}${asset.type === "video" ? `, ${info.hasAudio ? "with" : "no"} audio` : ""}).`);
    },
  }),
  tool({
    name: "add_clip",
    description: "Add a clip to the primary track (clips play back-to-back). Use `in`/`duration` (source seconds) to trim. Images/colors need a duration.",
    input: z.object({
      assetId: z.string(),
      in: z.number().min(0).optional(),
      duration: z.number().positive().optional(),
      index: z.number().int().min(0).optional().describe("Insert position (default: end)"),
      speed: z.number().optional(),
      fit: FitSchema.optional(),
      focus: PositionSchema.optional().describe("Crop focus for fit cover: x 0 = keep left edge, 1 = right edge"),
      volume: z.number().optional(),
      muted: z.boolean().optional(),
      transition: TransitionSchema.optional().describe("Transition into this clip"),
      effects: z.array(EffectSchema).optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const { index, ...clip } = i;
      const p = ops.addClip(s.project, clip, index);
      const added = p.clips[index ?? p.clips.length - 1]!;
      return commit(s, p, "add_clip", i, `Added clip ${added.id}.`);
    },
  }),
  tool({
    name: "update_clip",
    description: "Change properties of a primary-track clip (in, duration, speed, volume, muted, fit, effects, audioEffects, transition, fadeIn, fadeOut).",
    input: z.object({ clipId: z.string(), patch: z.record(z.string(), z.unknown()) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.updateClip(s.project, i.clipId, i.patch as never), "update_clip", i, `Updated ${i.clipId}.`),
  }),
  tool({
    name: "remove_clip",
    description: "Delete a clip from the primary track.",
    input: z.object({ clipId: z.string() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.removeClip(s.project, i.clipId), "remove_clip", i, `Removed ${i.clipId}.`),
  }),
  tool({
    name: "move_clip",
    description: "Reorder a clip on the primary track.",
    input: z.object({ clipId: z.string(), toIndex: z.number().int().min(0) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.moveClip(s.project, i.clipId, i.toIndex), "move_clip", i, `Moved ${i.clipId} to position ${i.toIndex}.`),
  }),
  tool({
    name: "split_clip",
    description: "Split a primary clip in two at a timeline time (seconds).",
    input: z.object({ clipId: z.string(), time: z.number() }),
    mutates: true,
    run: async (s, i) => {
      const { project, newClipId } = ops.splitClip(s.project, i.clipId, i.time);
      return commit(s, project, "split_clip", i, `Split ${i.clipId} at ${i.time}s; second part is ${newClipId}.`);
    },
  }),
  tool({
    name: "trim_clip",
    description: "Set a clip's source in/out points (seconds in the original media).",
    input: z.object({ clipId: z.string(), sourceIn: z.number().min(0), sourceOut: z.number().positive() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.trimClip(s.project, i.clipId, i.sourceIn, i.sourceOut), "trim_clip", i, `Trimmed ${i.clipId} to ${i.sourceIn}-${i.sourceOut}s of source.`),
  }),
  tool({
    name: "set_transition",
    description:
      "Set the transition into a clip (or between all clips with all=true). type 'none' removes it. sound: true adds the sound that matches the motion (swoosh for slides and wipes, whoosh for whips and zooms, glitch for glitch cuts), peaking in the middle of the transition; or name a sound effect. Changing or removing the transition replaces its sound.",
    input: z.object({
      clipId: z.string().optional(),
      all: z.boolean().default(false),
      type: z.string(),
      duration: z.number().positive().max(5).default(0.5),
      origin: PositionSchema.optional().describe("Start point for circlereveal (frame fractions), e.g. the presenter's hand"),
      sound: z.union([z.boolean(), z.string()]).default(false).describe("true = the transition's matching sound, or a sound effect id"),
    }),
    mutates: true,
    run: async (s, i) => {
      const t = i.type === "none" ? null : { type: i.type, duration: i.duration, ...(i.origin ? { origin: i.origin } : {}) };
      if (!i.all && !i.clipId) return { text: "Provide clipId or all=true", isError: true };
      let p = i.all ? ops.setAllTransitions(s.project, t) : ops.setTransition(s.project, i.clipId!, t);
      const ids = i.all ? p.clips.slice(1).map((c) => c.id) : [i.clipId!];
      let note = "";
      if (i.sound !== false || !t) {
        // Without a transition (type none), this just removes the old sounds.
        const r = await transitionSounds(s, p, ids, typeof i.sound === "string" ? i.sound : undefined);
        p = r.project;
        if (i.sound !== false) note = r.placed.length ? ` Sound: ${r.placed.join(", ")}.` : ` No matching sound for ${i.type}.`;
      }
      return commit(s, p, "set_transition", i, `${i.all ? `Set ${i.type} between all clips` : `Transition into ${i.clipId}: ${i.type}`}.${note}`);
    },
  }),
  tool({
    name: "add_effect",
    description: "Add an effect to a clip, a media layer, or the whole video (target 'global'). See list_effects.",
    input: z.object({ target: z.string().describe("Clip id, media layer id, or 'global'"), type: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.addEffect(s.project, i.target, { type: i.type, params: i.params }), "add_effect", i, `Added ${i.type} to ${i.target}.`),
  }),
  tool({
    name: "remove_effect",
    description: "Remove an effect (by type) from a clip, media layer or 'global'.",
    input: z.object({ target: z.string(), type: z.string() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.removeEffect(s.project, i.target, i.type), "remove_effect", i, `Removed ${i.type} from ${i.target}.`),
  }),
  tool({
    name: "retouch",
    description:
      "Retouch people in a clip, a media layer, every clip, or the whole video. beauty: skin smoothing that keeps edges sharp, plus brighten and warmth, on the whole frame or only inside a face region. " +
      "backgroundBlur: portrait mode, blurring everything but the subject. subject \"person\" follows the real outline of the person on every frame (cut out on this machine; primary video clips only), which is the best choice when people move. " +
      "replaceBackground: a solid backdrop color behind the person, using the same cutout (no green screen needed). " +
      'Ellipses instead: region "face" or subject "face" place one from the faces found in each clip (covering where the face moves), or give one yourself (center x, y and width, height as frame fractions); an ellipse stays put for the whole clip. Check the result with render_frame. ' +
      "Settings merge into the target's existing retouch, so you can tweak one value at a time. Pass false to remove one.",
    input: z.object({
      target: z.string().describe('A clip id, a media layer id, "all-clips", or "global" (whole video)'),
      beauty: z
        .union([
          z.literal(false),
          z.object({
            smooth: z.number().min(0).max(100).optional().describe("Skin smoothing 0-100 (default 50; 30 subtle, 70 strong)"),
            brighten: z.number().min(0).max(100).optional().describe("Brighten skin 0-100 (default 15)"),
            warmth: z.number().min(-100).max(100).optional().describe("Warmth -100..100 (default 10)"),
            region: z
              .union([SubjectRegionSchema, z.literal("face"), z.null()])
              .optional()
              .describe('Face ellipse to limit the retouch to; "face" to find it; null for the whole frame'),
          }),
        ])
        .optional(),
      backgroundBlur: z
        .union([
          z.literal(false),
          z.object({
            amount: z.number().min(1).max(100).optional().describe("Blur strength 1-100 (default 25)"),
            subject: z
              .union([SubjectRegionSchema, z.literal("face"), z.literal("person")])
              .optional()
              .describe('"person" to follow the outline of the person frame by frame; "face" for an ellipse placed from the face; or an ellipse'),
            feather: z.number().min(0.02).max(1).optional().describe("Edge softness (default 0.35)"),
            dim: z.number().min(0).max(1).optional().describe("Darken the background 0-1 (default 0)"),
          }),
        ])
        .optional(),
      replaceBackground: z
        .union([
          z.literal(false),
          z.object({
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Backdrop color #RRGGBB (default #101216)"),
            mix: z.number().min(0).max(1).optional().describe("1 replaces the scene fully; 0.7 leaves a hint of it"),
            feather: z.number().min(0.02).max(1).optional().describe("Edge softness (default 0.25)"),
          }),
        ])
        .optional(),
    }),
    mutates: true,
    run: async (s, i, activity) => {
      if (i.beauty === undefined && i.backgroundBlur === undefined && i.replaceBackground === undefined) return { text: "Give beauty, backgroundBlur or replaceBackground settings.", isError: true };
      const targets = i.target === "all-clips" ? s.project.clips.map((c) => c.id) : [i.target];
      if (!targets.length) return { text: "There are no clips to retouch.", isError: true };
      let p = s.project;
      const done: string[] = [];
      const notes: string[] = [];
      // Ellipses placed from detected faces: the main person in each clip, wherever the face goes.
      const auto = async (target: string, kind: "face" | "person") => {
        if (!s.project.clips.some((c) => c.id === target)) throw new Error(`Automatic placement works on primary clips; "${target}" is not one. Give an ellipse instead.`);
        const found = await clipFaces(s, target, activity);
        const main = found.tracks[0];
        const box = main?.frameExtent ?? main?.frameBox;
        if (!box) return undefined;
        const region = kind === "face" ? faceRegion(box) : personRegion(box);
        notes.push(`${target}: ${kind} ellipse at (${region.x}, ${region.y}), ${region.width} x ${region.height}${found.tracks.length > 1 ? ` (main of ${found.tracks.length} faces)` : ""}`);
        return region;
      };
      const cutoutTarget = (target: string) => s.project.clips.some((c) => c.id === target && s.project.assets.find((a) => a.id === c.assetId)?.type === "video");
      for (const [type, settings] of [["beauty", i.beauty], ["backgroundBlur", i.backgroundBlur], ["backgroundReplace", i.replaceBackground]] as const) {
        if (settings === undefined) continue;
        for (const target of targets) {
          // Throws for an unknown target, so the removal below only skips a missing effect.
          const current = ops.getEffectParams(p, target, type);
          if (settings === false) {
            try {
              p = ops.removeEffect(p, target, type);
            } catch {
              // Nothing to remove on this target.
            }
            continue;
          }
          const merged: Record<string, unknown> = { ...(current ?? {}), ...settings };
          if (merged.region === null) delete merged.region;
          // "person" follows the cutout; any ellipse (given or found) turns the cutout off.
          if (type === "backgroundBlur" && "subject" in settings && settings.subject !== undefined) {
            merged.cutout = settings.subject === "person";
            if (settings.subject === "person") merged.subject = current?.subject;
          }
          if ((merged.cutout || type === "backgroundReplace") && !cutoutTarget(target))
            notes.push(`${target}: the person cutout works on primary video clips, so a fixed ellipse is used here`);
          for (const [key, kind] of [["region", "face"], ["subject", "person"]] as const) {
            if (merged[key] !== "face") continue;
            const region = await auto(target, kind);
            if (region) merged[key] = region;
            else {
              notes.push(`${target}: no face found, so ${type} was left ${current ? "as it was" : "off"}`);
              merged.skip = true;
            }
          }
          if (merged.skip) continue;
          // Validate (and fill defaults) now so a bad value fails the call instead of the render.
          p = ops.setEffectParams(p, target, type, getEffect(type)!.params.parse(merged) as Record<string, unknown>);
        }
        done.push(settings === false ? `removed ${type}` : type);
      }
      return commit(s, p, "retouch", i, `Retouch on ${i.target}: ${done.join(", ")}.${notes.length ? `\n${notes.join("\n")}` : ""}\nCheck it with render_frame.`);
    },
  }),
  tool({
    name: "detect_faces",
    description:
      "Find and follow the faces in primary clips (or in a source asset), on this machine (a small model downloads once). For each person: when they are on screen (timeline times), where the face sits in the edit's frame after the clip's crop, and how far it moves. " +
      "Use it to place titles and callouts away from faces, to check what a 9:16 crop keeps (then reframe), and for retouch with region or subject \"face\". Zooms and shakes from effects are not followed.",
    input: z.object({
      target: z.string().optional().describe("Clip id, asset id (source times and source frame), or omit for every primary clip"),
      fps: z.number().min(0.5).max(10).default(2).describe("Frames checked per second"),
    }),
    mutates: false,
    run: async (s, i, activity) => {
      const asset = i.target ? s.project.assets.find((a) => a.id === i.target) : undefined;
      if (asset) {
        if (asset.type !== "video" && asset.type !== "image") return { text: `"${asset.id}" is ${asset.type === "audio" ? "audio" : `a ${asset.type}`}, which has no faces.`, isError: true };
        const r = await detectFacesCached(faceDetector(s, activity), s.resolve(asset.src), undefined, i.fps);
        const tracks = trackFaces(r.frames);
        const lines = tracks.map((t) => `face ${t.id}: source ${formatTime(t.start)}-${formatTime(t.end)}, usually at ${fmtBox(t.box)} (${pct(t.box.x1 - t.box.x0)} of the width), moves within ${fmtBox(t.extent)}`);
        return ok(`${asset.id} (${r.width}x${r.height}, source frame fractions): ${tracks.length ? `${tracks.length} face${tracks.length > 1 ? "s" : ""}\n${lines.join("\n")}` : "no faces found"}`, { ...r, tracks });
      }
      const ids = i.target ? [i.target] : s.project.clips.filter((c) => ["video", "image"].includes(s.project.assets.find((a) => a.id === c.assetId)?.type ?? "")).map((c) => c.id);
      if (!ids.length) return { text: "There are no video or image clips to look at.", isError: true };
      const lines: string[] = [];
      const data: unknown[] = [];
      for (const [k, id] of ids.entries()) {
        const r = await clipFaces(s, id, activity);
        activity?.progress(0.2 + (0.8 * (k + 1)) / ids.length);
        data.push({ clipId: id, source: r.source, tracks: r.tracks });
        const head = `${id} (timeline ${formatTime(r.clip.start)}-${formatTime(r.clip.end)})`;
        if (!r.tracks.length) {
          lines.push(`${head}: no faces`);
          continue;
        }
        lines.push(`${head}: ${r.tracks.length} face${r.tracks.length > 1 ? "s" : ""}`);
        for (const t of r.tracks) {
          const where = t.frameBox ? `at ${fmtBox(t.frameBox)} of the frame (${pct(t.frameBox.x1 - t.frameBox.x0)} of the width)` : "cropped out of the frame";
          const moves = t.frameExtent ? `, moves within ${fmtBox(t.frameExtent)}` : "";
          const cut = t.frameExtent && (t.frameExtent.x0 < 0 || t.frameExtent.x1 > 1 || t.frameExtent.y0 < 0 || t.frameExtent.y1 > 1) ? ". Partly outside the crop: reframe it" : "";
          lines.push(`  face ${t.id} ${formatTime(t.timelineStart)}-${formatTime(t.timelineEnd)} ${where}${moves}${cut}`);
        }
      }
      return ok(`Faces in the edit's frame (fractions; x 0 left, y 0 top):\n${lines.join("\n")}`, data);
    },
  }),
  tool({
    name: "reframe",
    description:
      "Point each clip's crop at the person in it, for fit cover when the source shape differs from the video (16:9 footage in a 9:16 video). It finds the faces in each clip. " +
      "By default the crop is fixed: it keeps the main face's whole path in frame, or its usual spot when it moves more than the crop can show. With follow, the crop pans with the person like a camera operator (focus keyframes, smoothed).",
    input: z.object({
      clipIds: z.array(z.string()).optional().describe("Clips to reframe (default: every cover-fit clip whose source shape differs)"),
      follow: z.boolean().default(false).describe("Pan the crop with the person over time instead of a fixed crop"),
    }),
    mutates: true,
    run: async (s, i, activity) => {
      const out = s.project.settings;
      const ratio = out.width / out.height;
      const candidates = i.clipIds ?? s.project.clips.filter((c) => {
        const a = s.project.assets.find((x) => x.id === c.assetId);
        return c.fit === "cover" && (a?.type === "video" || a?.type === "image") && (!a.width || !a.height || Math.abs(a.width / a.height - ratio) > 0.02);
      }).map((c) => c.id);
      if (!candidates.length) return ok("No clips need reframing: every cover-fit clip already has the video's shape.");
      let p = s.project;
      const lines: string[] = [];
      for (const [k, id] of candidates.entries()) {
        const r = await clipFaces(s, id, activity);
        activity?.progress(0.2 + (0.8 * (k + 1)) / candidates.length);
        const main = r.tracks[0];
        if (!main) {
          lines.push(`${id}: no face found, crop left as it was`);
          continue;
        }
        // Keep the whole path of the face in frame when the crop is wide enough, else its usual spot.
        const width = (main.extent.x1 - main.extent.x0) * r.source.width;
        const height = (main.extent.y1 - main.extent.y0) * r.source.height;
        const k2 = Math.max(out.width / r.source.width, out.height / r.source.height);
        const fits = width * k2 <= out.width && height * k2 <= out.height;
        const focus = focusOn(fits ? main.extent : main.box, r.source, out);
        const clip = p.clips.find((c) => c.id === id)!;
        const { focus: _old, ...otherKeys } = clip.keyframes ?? {};
        if (!i.follow || main.frames.length < 2) {
          p = ops.updateClip(p, id, { focus, keyframes: Object.keys(otherKeys).length ? otherKeys : undefined });
          lines.push(`${id}: focus (${focus.x}, ${focus.y})${fits ? "" : ", centered on the face's usual spot (it moves more than the crop can follow)"}`);
          continue;
        }
        // A camera-like pan: the face's spot at each sample, smoothed, then reduced to a few moves.
        const samples = main.frames.map((f) => ({
          time: round3(Math.max(0, (r.clip.asset.type === "video" ? sourceToTimeline(r.clip, f.time) : r.clip.start) - r.clip.start)),
          value: focusOn(f.face, r.source, out),
          easing: "linear" as const,
        }));
        const keys = simplifyKeys(smoothKeys(samples, 2), 0.02);
        p = ops.updateClip(p, id, { focus, keyframes: { ...otherKeys, focus: keys } });
        lines.push(`${id}: the crop follows the face with ${keys.length} keyframes (focus x ${Math.min(...keys.map((k) => k.value.x)).toFixed(2)} to ${Math.max(...keys.map((k) => k.value.x)).toFixed(2)})`);
      }
      return commit(s, p, "reframe", i, `Reframed ${candidates.length} clip${candidates.length > 1 ? "s" : ""}:\n${lines.join("\n")}`);
    },
  }),
  tool({
    name: "set_speed",
    description:
      "Speed up or slow down a primary clip or an audio clip (0.25-4; 0.5 = half speed slow motion, 2 = double speed). Audio keeps its pitch. The clip covers the same source footage, so it gets shorter or longer on the timeline and later clips move. Captions follow automatically.",
    input: z.object({ target: z.string().describe("Clip id or audio clip id"), speed: z.number().min(0.25).max(4) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.setSpeed(s.project, i.target, i.speed), "set_speed", i, `Speed of ${i.target}: ${i.speed}x.`),
  }),

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------
  tool({
    name: "add_text",
    description: "Add a text layer (titles, labels, callouts). Position is the text center in 0-1 frame coordinates. Font size is in output pixels.",
    input: z.object({
      text: z.string(),
      start: z.number().min(0),
      duration: z.number().positive(),
      position: PositionSchema.optional(),
      style: TextStyleSchema.partial().optional(),
      animationIn: AnimationSchema.optional(),
      animationOut: AnimationSchema.optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const id = newId("text");
      return commit(s, ops.addLayer(s.project, { type: "text", id, ...i } as ops.LayerInput), "add_text", i, `Added text layer ${id}.`);
    },
  }),
  tool({
    name: "add_media_overlay",
    description: "Overlay a video or image (picture-in-picture, b-roll cutaway, logo). size.width is a fraction of frame width; give size.height too for b-roll that fills an area.",
    input: z.object({
      assetId: z.string(),
      start: z.number().min(0),
      duration: z.number().positive(),
      in: z.number().min(0).optional(),
      position: PositionSchema.optional(),
      size: z.object({ width: z.number().positive(), height: z.number().positive().optional() }).optional(),
      fit: FitSchema.optional(),
      opacity: z.number().min(0).max(1).optional(),
      cornerRadius: z.number().min(0).optional().describe("Rounded corners in pixels (phone screens, screenshots)"),
      shadow: z.number().min(0).optional().describe("Drop shadow in pixels"),
      volume: z.number().optional(),
      effects: z.array(EffectSchema).optional(),
      animationIn: AnimationSchema.optional(),
      animationOut: AnimationSchema.optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const id = newId("overlay");
      return commit(s, ops.addLayer(s.project, { type: "media", id, ...i }), "add_media_overlay", i, `Added media overlay ${id}.`);
    },
  }),
  tool({
    name: "add_shape",
    description:
      "Add a shape: rect, roundedRect (pills behind labels, cards, a highlight box around part of a screen with fill=false) or ellipse (circles, number badges, rings, spotlights). Size is in frame fractions; radius, strokeWidth and shadow are in output pixels.",
    input: z.object({
      start: z.number().min(0),
      duration: z.number().positive(),
      shape: z.enum(["rect", "roundedRect", "ellipse"]).default("rect"),
      position: PositionSchema.optional(),
      size: z.object({ width: z.number().positive(), height: z.number().positive() }),
      color: z.string().default("#000000"),
      opacity: z.number().min(0).max(1).default(1),
      radius: z.number().min(0).optional().describe("roundedRect corner radius in pixels"),
      fill: z.boolean().optional().describe("false = outline only"),
      strokeWidth: z.number().min(0).optional(),
      strokeColor: z.string().optional(),
      shadow: z.number().min(0).optional(),
      animationIn: AnimationSchema.optional(),
      animationOut: AnimationSchema.optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const id = newId("shape");
      return commit(s, ops.addLayer(s.project, { type: "shape", id, ...i }), "add_shape", i, `Added shape ${id}.`);
    },
  }),
  tool({
    name: "add_component",
    description: "Insert a reusable component (lower-third, title-card, cta, subscribe, hook-text, quote, number-badge, countdown, label, end-screen…) at a time. See list_components for params.",
    input: z.object({ component: z.string(), start: z.number().min(0), duration: z.number().positive().optional(), params: z.record(z.string(), z.unknown()).default({}) }),
    mutates: true,
    run: async (s, i) => {
      const { project, layerIds } = addComponent(s.project, i);
      return commit(s, project, "add_component", i, `Added ${i.component} (layers: ${layerIds.join(", ")}).`);
    },
  }),
  tool({
    name: "update_layer",
    description: "Change a layer's properties (text, start, duration, position, style, size, opacity, animations…). Text style is merged.",
    input: z.object({ layerId: z.string(), patch: z.record(z.string(), z.unknown()) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.updateLayer(s.project, i.layerId, i.patch), "update_layer", i, `Updated ${i.layerId}.`),
  }),
  tool({
    name: "remove_layer",
    description: "Delete a layer (text, media overlay or shape). To remove a whole component, remove each of its layers.",
    input: z.object({ layerId: z.string() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.removeLayer(s.project, i.layerId), "remove_layer", i, `Removed ${i.layerId}.`),
  }),
  tool({
    name: "animate_layer",
    description:
      "Move, scale, turn or fade a layer over time with keyframes (text, shapes and media overlays): a label that slides along with a product, a logo that grows, a title that drifts. " +
      "Give a list of keyframes per property; each has a time (timeline seconds, or seconds into the layer with relative), a value, and easing into it from the previous keyframe (default ease-in-out; linear for steady motion). " +
      "Before the first keyframe a property holds its first value, after the last its last. Pass null to remove a property's keyframes. Entrance and exit animations still play. To follow a person, use follow_face.",
    input: z.object({
      layerId: z.string(),
      position: z
        .array(z.object({ time: z.number(), x: z.number(), y: z.number(), easing: EasingSchema.optional() }))
        .min(1)
        .nullable()
        .optional()
        .describe("Center of the layer (frame fractions)"),
      scale: z.array(z.object({ time: z.number(), value: z.number().positive().max(20), easing: EasingSchema.optional() })).min(1).nullable().optional().describe("Size multiplier (1 = its own size)"),
      rotation: z.array(z.object({ time: z.number(), value: z.number().min(-3600).max(3600), easing: EasingSchema.optional() })).min(1).nullable().optional().describe("Degrees clockwise"),
      opacity: z.array(z.object({ time: z.number(), value: z.number().min(0).max(1), easing: EasingSchema.optional() })).min(1).nullable().optional().describe("Multiplies the layer's opacity"),
      relative: z.boolean().default(false).describe("Times count from the layer's start instead of the timeline"),
    }),
    mutates: true,
    run: async (s, i) => {
      const layer = s.project.layers.find((l) => l.id === i.layerId);
      if (!layer) return { text: `No layer "${i.layerId}".`, isError: true };
      const keyframes: Record<string, unknown> = { ...(layer.keyframes ?? {}) };
      const notes: string[] = [];
      for (const prop of ["position", "scale", "rotation", "opacity"] as const) {
        const given = i[prop];
        if (given === undefined) continue;
        if (given === null) {
          delete keyframes[prop];
          notes.push(`${prop} keyframes removed`);
          continue;
        }
        const keys = given.map((k) => {
          const time = round3(i.relative ? k.time : k.time - layer.start);
          if (time < -0.001 || time > layer.duration + 0.001)
            throw new Error(`A ${prop} keyframe at ${k.time}s is outside the layer (${i.relative ? `0-${layer.duration}s into it` : `${layer.start}-${round3(layer.start + layer.duration)}s on the timeline`}).`);
          const value = "x" in k ? { x: k.x, y: k.y } : k.value;
          return { time: Math.max(0, time), value, easing: k.easing ?? "ease-in-out" };
        });
        keyframes[prop] = keys.sort((a, b) => a.time - b.time);
        notes.push(`${prop} ${keys.length} keyframe${keys.length > 1 ? "s" : ""} (${keys[0]!.time}-${keys[keys.length - 1]!.time}s into the layer)`);
      }
      if (!notes.length) return { text: "Give position, scale, rotation or opacity keyframes (or null to remove them).", isError: true };
      const p = ops.updateLayer(s.project, i.layerId, { keyframes: Object.keys(keyframes).length ? keyframes : undefined });
      return commit(s, p, "animate_layer", i, `Animated ${i.layerId}: ${notes.join("; ")}. Check it with render_frame at a few times.`);
    },
  }),
  tool({
    name: "follow_face",
    description:
      "Make a layer (a name label, a callout, an arrow, a sticker) follow a person on screen: it finds the main face in the clips under the layer and sets position keyframes beside it (above, below, left, right, or on it), smoothed so it glides rather than jitters. " +
      "The layer stays inside the frame. Where no face is found it holds its last spot.",
    input: z.object({
      layerId: z.string(),
      clipId: z.string().optional().describe("Clip to follow (default: the primary clips under the layer)"),
      side: z.enum(["above", "below", "left", "right", "on"]).default("above"),
      gap: z.number().min(0).max(0.3).default(0.02).describe("Space between the face and the layer (frame fraction)"),
    }),
    mutates: true,
    run: async (s, i, activity) => {
      const layer = s.project.layers.find((l) => l.id === i.layerId);
      if (!layer) return { text: `No layer "${i.layerId}".`, isError: true };
      const { width: W, height: H } = s.project.settings;
      const end = layer.start + layer.duration;
      const clips = i.clipId ? [i.clipId] : computeTimeline(s.project).clips.filter((c) => c.start < end && c.end > layer.start && ["video", "image"].includes(c.asset.type)).map((c) => c.clip.id);
      if (!clips.length) return { text: "No video clip plays under this layer.", isError: true };
      // Half the layer's size, so it can sit beside the face and stay inside the frame.
      let hw: number;
      let hh: number;
      if (layer.type === "text") {
        const b = textLayerBox({ ...layer, keyframes: undefined }, W, H);
        [hw, hh] = [(b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2];
      } else if (layer.type === "shape") [hw, hh] = [layer.size.width / 2, layer.size.height / 2];
      else {
        const a = s.project.assets.find((x) => x.id === layer.assetId);
        const aspect = a && "width" in a && a.width && a.height ? a.height / a.width : 9 / 16;
        [hw, hh] = [layer.size.width / 2, ((layer.size.height ?? (layer.size.width * W * aspect) / H) as number) / 2];
      }
      const points: { time: number; x: number; y: number }[] = [];
      for (const id of clips) {
        const main = (await clipFaces(s, id, activity)).tracks[0];
        for (const { time, box: b } of main?.path ?? []) {
          if (time < layer.start - 0.25 || time > end + 0.25) continue;
          const [cx, cy] = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
          const spot =
            i.side === "above" ? { x: cx, y: b.y0 - i.gap - hh } : i.side === "below" ? { x: cx, y: b.y1 + i.gap + hh } : i.side === "left" ? { x: b.x0 - i.gap - hw, y: cy } : i.side === "right" ? { x: b.x1 + i.gap + hw, y: cy } : { x: cx, y: cy };
          const clamp = (v: number, half: number) => Math.min(1 - half - 0.02, Math.max(half + 0.02, v));
          points.push({ time, x: round3(clamp(spot.x, hw)), y: round3(clamp(spot.y, hh)) });
        }
      }
      if (!points.length) return { text: `No face found in ${clips.join(", ")} while ${i.layerId} is on screen.`, isError: true };
      const samples = points.map((pt) => ({ time: round3(Math.min(layer.duration, Math.max(0, pt.time - layer.start))), value: { x: pt.x, y: pt.y }, easing: "linear" as const }));
      const keys = simplifyKeys(smoothKeys(samples, 1), 0.008);
      // A label over an empty frame looks lost: fade it in when the person appears late, out when they leave early.
      const [first, last] = [keys[0]!.time, keys[keys.length - 1]!.time];
      const fade = 0.3;
      const opacity = [
        ...(first > 0.5 ? [{ time: 0, value: 0, easing: "linear" as const }, { time: round3(Math.max(0, first - fade)), value: 0, easing: "linear" as const }, { time: first, value: 1, easing: "ease-out" as const }] : []),
        ...(last < layer.duration - 0.5 ? [{ time: last, value: 1, easing: "linear" as const }, { time: round3(Math.min(layer.duration, last + fade)), value: 0, easing: "ease-in" as const }] : []),
      ];
      const notes = [first > 0.5 && `fades in at ${round3(layer.start + first)}s when the face appears`, last < layer.duration - 0.5 && `fades out at ${round3(layer.start + last)}s when it leaves`].filter(Boolean);
      const { opacity: _old, ...others } = layer.keyframes ?? {};
      const p = ops.updateLayer(s.project, i.layerId, { keyframes: { ...others, position: keys, ...(opacity.length ? { opacity } : {}) } });
      return commit(
        s,
        p,
        "follow_face",
        i,
        `${i.layerId} now follows the face ${i.side === "on" ? "" : `(${i.side} it) `}with ${keys.length} position keyframes from ${points.length} sightings${notes.length ? `; it ${notes.join(" and ")}` : ""}.`,
      );
    },
  }),
  tool({
    name: "reorder_layer",
    description:
      "Change which layer draws on top. Layers draw in list order (later on top); text and shapes always draw above media overlays. Put a layer directly below or above another layer (e.g. a dimming shape below a title), or at an index.",
    input: z.object({
      layerId: z.string(),
      below: z.string().optional().describe("Layer id to place it directly under"),
      above: z.string().optional().describe("Layer id to place it directly over"),
      toIndex: z.number().int().min(0).optional().describe("0 = bottom"),
    }),
    mutates: true,
    run: async (s, i) => {
      const others = s.project.layers.filter((l) => l.id !== i.layerId);
      const ref = i.below ?? i.above;
      let index = i.toIndex;
      if (ref) {
        const k = others.findIndex((l) => l.id === ref);
        if (k === -1) return { text: `No layer "${ref}".`, isError: true };
        index = i.below ? k : k + 1;
      }
      if (index === undefined) return { text: "Give below, above or toIndex.", isError: true };
      return commit(s, ops.reorderLayer(s.project, i.layerId, index), "reorder_layer", i, `Moved ${i.layerId} to position ${index} of ${others.length + 1}.`);
    },
  }),

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  tool({
    name: "add_audio",
    description: "Add music, voice-over or a sound effect. Music is ducked under speech by default; loop=true repeats it to the end of the video.",
    input: z.object({
      assetId: z.string(),
      role: z.enum(["music", "voiceover", "sfx"]).default("music"),
      start: z.number().min(0).default(0),
      in: z.number().min(0).optional(),
      duration: z.number().positive().optional(),
      volume: z.number().min(0).max(4).optional(),
      fadeIn: z.number().min(0).optional(),
      fadeOut: z.number().min(0).optional(),
      loop: z.boolean().optional(),
      duck: z.boolean().optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const p = ops.addAudio(s.project, i);
      return commit(s, p, "add_audio", i, `Added ${i.role} ${p.audio[p.audio.length - 1]!.id}.`);
    },
  }),
  tool({
    name: "update_audio",
    description: "Change an audio clip (volume, speed, start, fades, duck, loop, audioEffects…).",
    input: z.object({ audioId: z.string(), patch: z.record(z.string(), z.unknown()) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.updateAudio(s.project, i.audioId, i.patch as never), "update_audio", i, `Updated ${i.audioId}.`),
  }),
  tool({
    name: "remove_audio",
    description: "Delete an audio clip.",
    input: z.object({ audioId: z.string() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.removeAudio(s.project, i.audioId), "remove_audio", i, `Removed ${i.audioId}.`),
  }),
  tool({
    name: "set_volume",
    description:
      'Set the volume of a primary clip, an audio clip, a media layer, or the whole mix (target "master"). volume is a multiplier: 1 = original, 0.5 = about -6 dB, 2 = about +6 dB, 0 = silent (max 4). Or give db instead. muted applies to primary clips.',
    input: z.object({
      target: z.string().describe('Clip id, audio clip id, media layer id, or "master"'),
      volume: z.number().min(0).max(4).optional(),
      db: z.number().min(-60).max(12).optional().describe("Volume in decibels relative to the original level (0 = original), instead of volume"),
      muted: z.boolean().optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      if (i.volume === undefined && i.db === undefined && i.muted === undefined) return { text: "Give volume, db or muted.", isError: true };
      const current = (() => {
        if (i.target === "master") {
          const db = ops.getAudioEffectParams(s.project, "master", "gain")?.db;
          return typeof db === "number" ? Math.round(10 ** (db / 20) * 1000) / 1000 : 1;
        }
        const c = s.project.clips.find((x) => x.id === i.target) ?? s.project.audio.find((x) => x.id === i.target);
        if (c) return c.volume;
        const l = s.project.layers.find((x) => x.id === i.target);
        return l?.type === "media" ? l.volume : 1;
      })();
      const volume = i.volume ?? (i.db !== undefined ? Math.round(10 ** (i.db / 20) * 1000) / 1000 : current);
      return commit(s, ops.setVolume(s.project, i.target, Math.min(4, volume), { muted: i.muted }), "set_volume", i, `Volume of ${i.target}: ${volume}${i.muted !== undefined ? `, ${i.muted ? "muted" : "unmuted"}` : ""}.`);
    },
  }),
  tool({
    name: "add_audio_effect",
    description:
      'Add an audio effect to a primary clip, an audio clip, a media layer, or the final mix (target "master"). Effects run in order; put cleanup (denoise, dehum) before creative effects. See list_audio_effects.',
    input: z.object({
      target: z.string().describe('Clip id, audio clip id, media layer id, or "master"'),
      type: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const def = getAudioEffect(i.type);
      if (!def) return { text: `Unknown audio effect "${i.type}". Use list_audio_effects.`, isError: true };
      def.params.parse(i.params ?? {});
      return commit(s, ops.addAudioEffect(s.project, i.target, { type: i.type, params: i.params }), "add_audio_effect", i, `Added ${i.type} audio effect to ${i.target}.`);
    },
  }),
  tool({
    name: "remove_audio_effect",
    description: 'Remove an audio effect (by type) from a clip, audio clip, media layer or "master".',
    input: z.object({ target: z.string(), type: z.string() }),
    mutates: true,
    run: async (s, i) => commit(s, ops.removeAudioEffect(s.project, i.target, i.type), "remove_audio_effect", i, `Removed ${i.type} audio effect from ${i.target}.`),
  }),
  tool({
    name: "enhance_audio",
    description:
      "One-call cleanup for speech: removes hum, reduces background noise, enhances the voice (clarity, presence, de-essing, compression, even levels) and optionally normalizes loudness. " +
      'Target a clip, an audio clip (e.g. a voice-over), a media layer, "all-clips", or "master". Calling it again replaces the previous cleanup settings on the target.',
    input: z.object({
      target: z.string().describe('Clip id, audio clip id, media layer id, "all-clips", or "master"'),
      noiseReduction: z.number().min(0).max(100).default(40).describe("Background noise reduction 0-100 (0 = off)"),
      noiseFloor: z.number().min(-70).max(-20).optional().describe("Level of the noise in dB (default -35); raise toward -25 for loud hiss"),
      voice: z.number().min(0).max(100).default(60).describe("Voice enhancement strength 0-100 (0 = off)"),
      removeHum: z.union([z.literal(50), z.literal(60)]).optional().describe("Remove mains hum at 50 Hz or 60 Hz"),
      normalize: z.number().min(-30).max(-8).optional().describe("Normalize loudness to this LUFS target (-14 for social video, -16 for podcasts)"),
    }),
    mutates: true,
    run: async (s, i) => {
      const targets = i.target === "all-clips" ? s.project.clips.map((c) => c.id) : [i.target];
      if (!targets.length) return { text: "There are no clips to enhance.", isError: true };
      const chain: [string, Record<string, unknown> | undefined][] = [
        ["dehum", i.removeHum ? { frequency: i.removeHum } : undefined],
        ["denoise", i.noiseReduction > 0 ? { amount: i.noiseReduction, ...(i.noiseFloor !== undefined ? { noiseFloor: i.noiseFloor } : {}) } : undefined],
        // Noise is already handled by the dedicated stage above.
        ["enhanceVoice", i.voice > 0 ? { amount: i.voice, denoise: false } : undefined],
        ["normalize", i.normalize !== undefined ? { target: i.normalize } : undefined],
      ];
      let p = s.project;
      for (const target of targets) {
        for (const [type] of chain) {
          try {
            p = ops.removeAudioEffect(p, target, type);
          } catch (e) {
            // A missing effect is fine; an unknown target is not.
            if (!/has no/.test((e as Error).message)) throw e;
          }
        }
        // Prepend in reverse so the cleanup chain runs first, in order, ahead of creative effects.
        for (const [type, params] of [...chain].reverse()) if (params) p = ops.setAudioEffectParams(p, target, type, params, { prepend: true });
      }
      const applied = chain.filter(([, v]) => v).map(([t]) => t);
      return commit(s, p, "enhance_audio", i, `Audio on ${i.target}: ${applied.join(" > ") || "cleanup removed"}.`);
    },
  }),

  // -------------------------------------------------------------------------
  // Sound map, beats, scenes and sound effects
  // -------------------------------------------------------------------------
  tool({
    name: "analyze_audio",
    description:
      "Map the sound of a recording without a transcript: where someone is speaking, where it is silent, where music or other sound plays, loud moments (claps, bangs, laughs) and the beat. " +
      "Give an assetId for source times (best for raw footage, before cutting), or omit it to map every primary clip on the timeline. Returns a timeline of segments and a picture (waveform with a colored band: green speech, blue music, orange other sound, dark silence, red loud moments). " +
      "Labels come from signal analysis, not speech recognition: treat '(unsure)' segments with care and check with render_frame or your own judgement. Use the times with remove_silences, assemble_from_source, split_clip, add_sound_effect and beat_sync.",
    input: z.object({
      assetId: z.string().optional().describe("Asset to analyze (source times); omit for the current timeline"),
      start: z.number().min(0).optional().describe("Source seconds to start at (asset mode)"),
      end: z.number().positive().optional().describe("Source seconds to stop at (asset mode)"),
      image: z.boolean().default(true).describe("Also return the sound map picture"),
    }),
    mutates: false,
    run: async (s, i, activity) => {
      if (i.assetId) {
        const asset = mediaAsset(s, i.assetId);
        const range = i.start !== undefined || i.end !== undefined ? { start: i.start ?? 0, end: i.end ?? asset.duration ?? 1e9 } : undefined;
        activity?.progress(0.1);
        const { map, beats } = await analyzeSound(s, asset.src, range);
        const lines = [`Sound map of ${i.assetId} (source time${range ? `, from ${range.start}s` : ""}):`, formatSoundMap(map, { offset: range?.start })];
        if (beats.bpm) lines.push(`Beat: ${beats.bpm} BPM (confidence ${beats.confidence}), ${beats.beats.length} beats. Use detect_beats for the times.`);
        else lines.push("No steady musical beat.");
        let images: ToolResult["images"];
        if (i.image) {
          const file = await s.outputPath(`soundmap-${i.assetId}.png`);
          await renderSoundMapImage(s.resolve(asset.src), map, file, { ffmpegPath: s.options.ffmpegPath, start: range?.start, beats: beats.bpm ? beats.beats : undefined });
          images = [{ path: file, mediaType: "image/png" }];
          lines.push("Picture: the full width is the analyzed range, with a gray line every 10%.");
        }
        return { text: lines.join("\n"), images, data: { map, beats } };
      }
      // Timeline mode: each primary clip's source range, mapped to timeline time.
      const timeline = computeTimeline(s.project);
      const lines: string[] = [];
      const totals: Record<SoundKind, number> = { speech: 0, music: 0, sound: 0, silence: 0 };
      for (const tc of timeline.clips) {
        const asset = tc.asset;
        if (asset.type !== "video" || asset.hasAudio === false || tc.clip.muted) {
          lines.push(`${tc.clip.id} ${formatTime(tc.start)}-${formatTime(tc.end)}: no sound${tc.clip.muted ? " (muted)" : ""}`);
          continue;
        }
        const { map } = await analyzeSound(s, asset.src, { start: tc.clip.in, end: tc.clip.in + tc.sourceDuration });
        activity?.progress((tc.index + 1) / timeline.clips.length);
        const segs = map.segments.map((g) => {
          const a = Math.round((tc.start + g.start / tc.clip.speed) * 1000) / 1000;
          const b = Math.round((tc.start + g.end / tc.clip.speed) * 1000) / 1000;
          totals[g.kind] += b - a;
          return `${formatTime(a)}-${formatTime(b)} ${g.kind}${g.kind === "silence" ? "" : ` ${g.level} dB${g.confidence < 0.6 ? " (unsure)" : ""}`}`;
        });
        lines.push(`${tc.clip.id} (${tc.clip.assetId}, timeline ${formatTime(tc.start)}-${formatTime(tc.end)}):\n  ${segs.join("\n  ")}`);
      }
      const sum = Object.entries(totals).map(([k, v]) => `${k} ${Math.round(v * 10) / 10}s`).join(", ");
      return ok(`Sound on the timeline (clip audio only; music and voice-over tracks are not included). ${sum}.\n${lines.join("\n")}`);
    },
  }),
  tool({
    name: "detect_beats",
    description: "Find the tempo and beat times of music: an audio clip (times on the timeline) or an asset (source times). Use them to cut, punch, shake or flash on the beat (beat_sync does this for you).",
    input: z.object({ source: z.string().describe("Audio clip id (timeline times) or asset id (source times)") }),
    mutates: false,
    run: async (s, i) => {
      const onTimeline = s.project.audio.some((a) => a.id === i.source) || s.project.clips.some((c) => c.assetId === i.source);
      const r = onTimeline ? await timelineBeats(s, i.source) : (await analyzeSound(s, mediaAsset(s, i.source).src)).beats;
      if (!r.bpm) return ok(`No steady beat found in ${i.source} (confidence ${r.confidence}). It may be speech, ambient music or noise.`);
      const fmt = (l: number[]) => (l.length > 64 ? `${l.slice(0, 64).join(", ")} …(${l.length - 64} more)` : l.join(", "));
      return ok(
        `${i.source}: ${r.bpm} BPM, confidence ${r.confidence}, ${r.beats.length} beats (${onTimeline ? "timeline" : "source"} seconds).\nDownbeats (bar starts): ${fmt(r.downbeats)}\nBeats: ${fmt(r.beats)}`,
        r,
      );
    },
  }),
  tool({
    name: "remove_silences",
    description:
      "Cut dead air out of footage: removes silent stretches (or everything that is not speech) from primary clips, leaving short padding. Works without a transcript; with one, words are never cut into, so transcribe first when you can. Each kept part becomes its own clip (jump cuts). Layers, music and captions stay in sync. Run analyze_audio first to see what will go.",
    input: z.object({
      assetId: z.string().optional().describe("Only cut clips of this asset (default: every clip with sound)"),
      keep: z.array(SoundKindSchema).default(["speech", "music", "sound"]).describe('What counts as worth keeping; ["speech"] also removes music, noise and other non-speech sound'),
      minSilence: z.number().min(0.1).default(0.5).describe("Only remove gaps at least this long (seconds)"),
      padding: z.number().min(0).max(1).default(0.15).describe("Seconds kept before and after each kept part"),
    }),
    mutates: true,
    run: async (s, i, activity) => {
      const assetIds = [...new Set(s.project.clips.map((c) => c.assetId))].filter((id) => {
        if (i.assetId && id !== i.assetId) return false;
        const a = s.project.assets.find((x) => x.id === id);
        return a?.type === "video" && a.hasAudio !== false;
      });
      if (!assetIds.length) return { text: i.assetId ? `No primary clips use "${i.assetId}" with sound.` : "No primary clips with sound.", isError: true };
      let p = s.project;
      let removed = 0;
      const notes: string[] = [];
      for (const [n, id] of assetIds.entries()) {
        const asset = mediaAsset(s, id);
        const { map } = await analyzeSound(s, asset.src);
        activity?.progress((n + 1) / assetIds.length);
        // With a transcript, every word is protected too: quiet word edges ("and", trailing
        // consonants) can fall below the sound threshold, and a cut there clips the word.
        const words = s.project.transcripts[id]?.words ?? [];
        const keep = [
          ...soundRanges(map, { kinds: i.keep, padding: i.padding }),
          ...words.map((w) => ({ start: Math.max(0, w.start - Math.max(0.08, i.padding)), end: w.end + Math.max(0.12, i.padding) })),
        ];
        const cut = invertRanges(keep, 0, map.duration).filter((r) => r.end - r.start >= i.minSilence);
        if (!cut.length) {
          notes.push(`${id}: nothing to remove`);
          continue;
        }
        const before = computeTimeline(p).duration;
        p = ops.cutSourceRanges(p, id, cut);
        const gone = Math.round((before - computeTimeline(p).duration) * 100) / 100;
        removed += gone;
        notes.push(`${id}: removed ${gone}s in ${cut.length} gaps`);
      }
      const r = commit(s, p, "remove_silences", i, `Removed ${Math.round(removed * 100) / 100}s (${notes.join("; ")}).`);
      return { ...r, text: `${r.text}\nPrimary track now has ${p.clips.length} clips.` };
    },
  }),
  tool({
    name: "detect_scenes",
    description:
      "Find shot changes (cuts between camera angles or scenes) in a video asset. With split=true, the primary clips using it are split at every change inside them, so each shot becomes its own clip to trim, reorder, grade or give a transition.",
    input: z.object({
      assetId: z.string(),
      threshold: z.number().min(0.05).max(0.9).default(0.3).describe("0.3 finds clear cuts; 0.15-0.2 also finds gentle ones"),
      split: z.boolean().default(false),
    }),
    mutates: true,
    run: async (s, i) => {
      const asset = s.project.assets.find((a) => a.id === i.assetId);
      if (!asset || asset.type !== "video") return { text: `"${i.assetId}" is not a video asset.`, isError: true };
      const scenes = await detectScenes(s.resolve(asset.src), { threshold: i.threshold, ffmpegPath: s.options.ffmpegPath });
      const list = scenes.map((c) => `${c.time}s (${c.score})`).join(", ") || "none";
      if (!i.split) return ok(`${scenes.length} shot changes in ${i.assetId} (source seconds, score): ${list}`, scenes);
      let p = s.project;
      let splits = 0;
      for (const c of scenes) {
        // Skip changes within half a second of a clip edge: splitting there leaves a sliver, not a shot.
        const tc = computeTimeline(p).clips.find((x) => x.clip.assetId === i.assetId && c.time > x.clip.in + 0.5 && c.time < x.clip.in + x.sourceDuration - 0.5);
        if (!tc) continue;
        p = ops.splitClip(p, tc.clip.id, sourceToTimeline(tc, c.time)).project;
        splits++;
      }
      return commit(s, p, "detect_scenes", i, `${scenes.length} shot changes in ${i.assetId}: ${list}. Split ${splits} times; the primary track has ${p.clips.length} clips.`);
    },
  }),
  tool({
    name: "list_sound_effects",
    description: "List the built-in sound effects (whoosh, swoosh, riser, glitch, impact, hit, bass drop, pop, click, notification, error, typing, ding, success, shutter, heartbeat).",
    input: empty,
    mutates: false,
    run: async () =>
      ok(
        listSoundEffects()
          .map((e) => {
            const shape = (e.params as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
            const params = Object.entries(shape).map(([k, v]) => `${k}${v.description ? `: ${v.description}` : ""}`);
            return `${e.id} (${e.category}, ${e.duration(e.params.parse({}))}s): ${e.description}${params.length ? ` Params: ${params.join("; ")}` : ""}`;
          })
          .join("\n"),
      ),
  }),
  tool({
    name: "add_sound_effect",
    description:
      "Add a sound effect at timeline moments where something visibly happens: a pop when text appears, an impact on a reveal, a riser ending on a drop. A sound with nothing on screen to match feels random: for transitions use set_transition with sound, for zoom punches and shakes use add_moment_effect with sound. align 'peak' (default) lines the loudest point up with the time, 'end' makes the sound finish there (risers), 'start' begins it there.",
    input: z.object({
      type: z.string().describe("Sound effect id (see list_sound_effects)"),
      times: z.array(z.number().min(0)).min(1).max(64).describe("Timeline seconds"),
      align: z.enum(["peak", "start", "end"]).default("peak"),
      volume: z.number().min(0).max(4).default(0.8),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      if (!getSoundEffect(i.type)) return { text: `Unknown sound effect "${i.type}". Use list_sound_effects.`, isError: true };
      const sfx = await sfxAsset(s, s.project, i.type, i.params);
      let p = sfx.project;
      const offset = i.align === "end" ? sfx.duration : i.align === "peak" ? sfx.peak : 0;
      const starts = i.times.map((t) => Math.max(0, Math.round((t - offset) * 1000) / 1000));
      for (const start of starts) p = ops.addAudio(p, { assetId: sfx.assetId, role: "sfx", start, volume: i.volume, label: i.type });
      return commit(s, p, "add_sound_effect", i, `Added ${i.type} (${sfx.duration}s) at ${starts.join(", ")}s.`);
    },
  }),
  tool({
    name: "add_moment_effect",
    description:
      "Put a timed effect on whatever primary clip is playing at given timeline moments: zoomPunch, impactShake, flashHits or vibrate at each time, or smoothZoom / rackFocus starting at the time. Times already on the clip are kept, so you can add moments one at a time.",
    input: z.object({
      type: z.string().describe("zoomPunch, impactShake, flashHits, vibrate, smoothZoom or rackFocus"),
      times: z.array(z.number().min(0)).min(1).max(64).describe("Timeline seconds"),
      params: z.record(z.string(), z.unknown()).optional().describe("Other params of the effect, e.g. {amount: 0.2}"),
      sound: z
        .union([z.boolean(), z.string()])
        .default(false)
        .describe("true = the matching sound (hit for zoomPunch and flashHits, impact for impactShake, whoosh for smoothZoom) peaking at each moment, or a sound effect id"),
    }),
    mutates: true,
    run: async (s, i) => {
      const r = ops.placeMomentEffect(s.project, i.type, i.times, i.params);
      let project = r.project;
      let note = "";
      const type = typeof i.sound === "string" ? i.sound : i.sound ? MOMENT_SOUNDS[i.type] : undefined;
      if (i.sound !== false && !type) note = ` No matching sound for ${i.type}.`;
      if (type) {
        if (!getSoundEffect(type)) return { text: `Unknown sound effect "${type}". Use list_sound_effects.`, isError: true };
        const sfx = await sfxAsset(s, project, type);
        project = sfx.project;
        for (const t of i.times) project = ops.addAudio(project, { assetId: sfx.assetId, role: "sfx", start: Math.max(0, Math.round((t - sfx.peak) * 1000) / 1000), volume: 0.6, label: type });
        note = ` ${type} on each moment.`;
      }
      return commit(s, project, "add_moment_effect", i, `${i.type} on ${r.placed.map((x) => `${x.clipId} at ${x.times.join(", ")}s into it`).join("; ")}.${note}`);
    },
  }),
  tool({
    name: "beat_sync",
    description:
      "Edit to the music's beat. action 'cuts' moves every cut between primary clips onto the nearest beat; an effect action (zoomPunch, impactShake, flashHits, vibrate) puts that effect on the beats. " +
      "Choose every Nth beat (2 or 4 for calmer pacing; downbeats=true for bar starts only) and an optional time window. sound adds a sound effect on the same beats.",
    input: z.object({
      source: z.string().describe("Music audio clip id, or an asset on the primary track"),
      action: z.enum(["cuts", "zoomPunch", "impactShake", "flashHits", "vibrate"]),
      every: z.number().int().min(1).max(16).default(1),
      downbeats: z.boolean().default(false).describe("Use only bar starts"),
      start: z.number().min(0).optional().describe("Timeline seconds to start at"),
      end: z.number().positive().optional().describe("Timeline seconds to stop at"),
      params: z.record(z.string(), z.unknown()).optional().describe("Effect params, e.g. {amount: 0.12}"),
      sound: z.string().optional().describe("Sound effect to add on the same beats, e.g. 'hit'"),
      minClip: z.number().min(0.1).default(0.4).describe("cuts: shortest clip allowed"),
    }),
    mutates: true,
    run: async (s, i) => {
      const b = await timelineBeats(s, i.source);
      if (!b.bpm) return { text: `No steady beat in ${i.source} (confidence ${b.confidence}).`, isError: true };
      const pool = (i.downbeats ? b.downbeats : b.beats).filter((t) => (i.start === undefined || t >= i.start) && (i.end === undefined || t <= i.end));
      const times = pool.filter((_, k) => k % i.every === 0);
      if (!times.length) return { text: "No beats in that window.", isError: true };
      let p = s.project;
      let detail: string;
      if (i.action === "cuts") {
        const r = ops.snapCutsToTimes(p, times, { minClip: i.minClip });
        p = r.project;
        detail = `moved ${r.moved.length} cuts onto beats`;
      } else {
        const r = ops.placeMomentEffect(p, i.action, times.filter((t) => t < computeTimeline(p).primaryDuration), i.params);
        p = r.project;
        detail = `${i.action} on ${times.length} beats across ${r.placed.length} clips`;
      }
      if (i.sound) {
        if (!getSoundEffect(i.sound)) return { text: `Unknown sound effect "${i.sound}". Use list_sound_effects.`, isError: true };
        const sfx = await sfxAsset(s, p, i.sound);
        p = sfx.project;
        for (const t of times) p = ops.addAudio(p, { assetId: sfx.assetId, role: "sfx", start: t, volume: 0.7, label: i.sound });
        detail += `, ${i.sound} on each`;
      }
      return commit(s, p, "beat_sync", i, `Beat sync to ${i.source} (${b.bpm} BPM): ${detail}.`);
    },
  }),

  // -------------------------------------------------------------------------
  // Transcript & captions
  // -------------------------------------------------------------------------
  tool({
    name: "transcribe",
    description:
      "Transcribe an asset's speech with word timings. Enables captions, transcript search and filler removal. Runs a Whisper model on this machine unless the session has another provider (no API key; the model downloads once, then works offline). Takes roughly real time on a CPU. " +
      "Names often come out wrong: save them first with fix_transcript vocabulary, and the result lists likely mishearings to correct.",
    input: z.object({ assetId: z.string(), language: z.string().optional().describe("Language code such as 'en' or 'fr'; omit to detect") }),
    mutates: true,
    run: async (s, i, activity) => {
      const asset = s.project.assets.find((a) => a.id === i.assetId);
      if (!asset || !("src" in asset)) return { text: `Asset "${i.assetId}" not found or has no file`, isError: true };
      const provider = s.options.transcriber ?? localTranscriber(s, activity);
      // Recognizers that take a prompt (the OpenAI API) spell these names right; the local model ignores it.
      const vocab = projectVocabulary(s.project);
      const t = await transcribeMedia(s.resolve(asset.src), provider, { language: i.language, prompt: vocab.length ? vocab.join(", ") : undefined, ffmpegPath: s.options.ffmpegPath });
      const r = commit(s, ops.setTranscript(s.project, i.assetId, t), "transcribe", i, `Transcribed ${i.assetId}: ${t.words.length} words.`);
      const suspects = mishearings(s.project, [i.assetId]);
      return { ...r, text: `${r.text}\n\n${formatTranscript(t)}${suspects.length ? `\n\nPossible mishearings of the vocabulary (check, then fix_transcript):\n${suspects.join("\n")}` : ""}` };
    },
  }),
  tool({
    name: "set_transcript",
    description: "Attach a transcript to an asset from SRT, VTT, Whisper/Deepgram/AssemblyAI JSON, or {words:[{text,start,end}]}. Times are in source seconds.",
    input: z.object({ assetId: z.string(), content: z.union([z.string(), z.record(z.string(), z.unknown())]), format: z.enum(["srt", "vtt", "whisper", "deepgram", "assemblyai", "transcript"]).optional() }),
    mutates: true,
    run: async (s, i) => {
      const t = parseTranscript(i.content as string | object, i.format);
      return commit(s, ops.setTranscript(s.project, i.assetId, t), "set_transcript", i, `Set transcript for ${i.assetId}: ${t.words.length} words${t.estimated ? " (word timings estimated)" : ""}.`);
    },
  }),
  tool({
    name: "get_transcript",
    description: "Read an asset's transcript as timestamped sentences (source time) with speaking stats.",
    input: z.object({ assetId: z.string() }),
    mutates: false,
    run: async (s, i) => {
      const t = s.project.transcripts[i.assetId];
      if (!t) return { text: `No transcript for "${i.assetId}".`, isError: true };
      const st = transcriptStats(t);
      return ok(`${st.words} words, ${st.wordsPerMinute} wpm, ${st.fillerCount} fillers${st.speakers.length ? `, speakers ${st.speakers.join("/")}` : ""}\n${formatTranscript(t)}`);
    },
  }),
  tool({
    name: "search_transcript",
    description: "Find where a phrase is said. Returns source times and, if that part is in the edit, timeline times.",
    input: z.object({ query: z.string(), assetId: z.string().optional() }),
    mutates: false,
    run: async (s, i) => {
      const ids = i.assetId ? [i.assetId] : Object.keys(s.project.transcripts);
      let timeline: ReturnType<typeof computeTimeline> | undefined;
      try {
        timeline = computeTimeline(s.project);
      } catch {
        timeline = undefined;
      }
      const lines: string[] = [];
      for (const id of ids) {
        const t = s.project.transcripts[id];
        if (!t) continue;
        for (const m of searchTranscript(t, i.query)) {
          const tc = timeline?.clips.find((c) => c.clip.assetId === id && m.start >= c.clip.in && m.end <= c.clip.in + c.sourceDuration);
          const tl = tc ? ` at timeline ${formatTime(sourceToTimeline(tc, m.start))} (clip ${tc.clip.id})` : " (not in the edit)";
          lines.push(`${id} source ${m.start}-${m.end}s${tl}: "…${m.context}…"`);
        }
      }
      return ok(lines.join("\n") || `"${i.query}" not found.`);
    },
  }),
  tool({
    name: "fix_transcript",
    description:
      'Correct words the speech recognizer got wrong, keeping their timings: find and replace words or phrases ("cloud" to "Claude", "cooper netties" to "Kubernetes") in one transcript or all of them. Matching ignores case and punctuation; punctuation around a match is kept. ' +
      "Captions, search and text-based cuts all use the corrected words. vocabulary saves the names and terms said in the video: transcribe passes them to recognizers that take hints, and this tool and transcribe list words that look like mishearings of them, so you can confirm each before replacing. " +
      "An empty replace removes words from the transcript only (the video is not cut).",
    input: z.object({
      assetId: z.string().optional().describe("Transcript to fix (default: every transcript)"),
      replace: z
        .array(z.object({ find: z.string().min(1), replace: z.string() }))
        .default([])
        .describe("Applied in order"),
      vocabulary: z.array(z.string().min(1)).optional().describe("Names and terms said in the video; replaces the saved list"),
    }),
    mutates: true,
    run: async (s, i) => {
      if (i.assetId && !s.project.transcripts[i.assetId]) return { text: `No transcript for "${i.assetId}".`, isError: true };
      const ids = i.assetId ? [i.assetId] : Object.keys(s.project.transcripts);
      if (!ids.length && !i.vocabulary) return { text: "There are no transcripts. Run transcribe first.", isError: true };
      let p = s.project;
      const changes: string[] = [];
      for (const id of ids) {
        const r = replaceWords(p.transcripts[id]!, i.replace);
        if (!r.changes.length) continue;
        p = ops.setTranscript(p, id, r.transcript);
        changes.push(...r.changes.map((c) => `${id} ${c.start}-${c.end}s: "${c.from}" to "${c.to || "(removed)"}"`));
      }
      if (i.vocabulary) p = { ...p, metadata: { ...p.metadata, vocabulary: i.vocabulary } };
      const suspects = mishearings(p, ids);
      const tail = suspects.length ? `\nPossible mishearings of the vocabulary (check each, then replace):\n${suspects.join("\n")}` : projectVocabulary(p).length ? "\nNo likely mishearings of the vocabulary left." : "";
      if (!changes.length && !i.vocabulary) return ok(`${i.replace.length ? "Nothing matched." : "No replacements given."}${tail}`);
      const head = [changes.length ? `Replaced ${changes.length}:\n${changes.join("\n")}` : i.replace.length ? "Nothing matched." : "", i.vocabulary ? `Vocabulary: ${i.vocabulary.join(", ")}.` : ""].filter(Boolean).join("\n");
      const r = commit(s, p, "fix_transcript", i, head);
      return { ...r, text: `${r.text}${tail}` };
    },
  }),
  tool({
    name: "cleanup_speech",
    description: "Tighten talking-head footage using its transcript: cut filler words (um, uh…), stutters and long pauses. Layers and audio shift to stay in sync.",
    input: z.object({
      assetId: z.string(),
      fillers: z.union([z.boolean(), z.array(z.string())]).default(true).describe("true = default list, or a custom list (e.g. add 'like', 'you know')"),
      repetitions: z.boolean().default(true),
      maxPause: z.number().positive().default(0.6).describe("Pauses longer than this are shortened"),
      keepPause: z.number().min(0).default(0.2).describe("Pause left behind"),
    }),
    mutates: true,
    run: async (s, i) => {
      const { assetId, ...opts } = i;
      const r = cleanupSpeech(s.project, assetId, opts);
      const out = commit(s, r.project, "cleanup_speech", i, `Removed ${r.removed.length} segments (${r.removedDuration}s).`);
      const detail = r.removed.slice(0, 40).map((x) => `${x.start}-${x.end}s ${x.reason}${x.text ? ` "${x.text}"` : ""}`).join("\n");
      return { ...out, text: `${out.text}\n${detail}${r.removed.length > 40 ? `\n…and ${r.removed.length - 40} more` : ""}` };
    },
  }),
  tool({
    name: "find_retakes",
    description:
      "Read a transcribed recording sentence by sentence and find retakes (a line said again because the first try had a slip, or a sentence abandoned and restarted) and repeats (several sentences in a row saying nearly the same thing). " +
      "Lists every sentence with its number and source time, the groups found and the suggested sentence to keep. Read the sentences yourself too: you judge meaning better than word overlap. Then use remove_retakes.",
    input: z.object({ assetId: z.string() }),
    mutates: false,
    run: async (s, i) => {
      const t = s.project.transcripts[i.assetId];
      if (!t) return { text: `No transcript for "${i.assetId}". Run transcribe first.`, isError: true };
      const r = findRetakes(t);
      const lines = r.sentences.map((x, k) => `${k}. [${x.start}-${x.end}s]${r.remove.includes(k) ? " (suggest remove)" : ""} ${x.text}`);
      const groups = r.groups.map((g) => `${g.kind} ${g.sentences.join(", ")}: keep ${g.keep}. ${g.reason}.`);
      return ok(`Sentences of ${i.assetId} (source time):\n${lines.join("\n")}\n\n${groups.length ? `Found:\n${groups.join("\n")}\nSuggested removal: ${r.remove.join(", ")}` : "No retakes or repeats found."}`, r);
    },
  }),
  tool({
    name: "remove_retakes",
    description:
      "Cut whole sentences out of a transcribed recording, cleanly: each cut runs from just after the previous kept word to just before the next one, so the pause goes too and no kept word is clipped. Without `sentences`, removes what find_retakes suggests. Sentence numbers come from find_retakes. Layers, music and captions stay in sync.",
    input: z.object({
      assetId: z.string(),
      sentences: z.array(z.number().int().min(0)).optional().describe("Sentence numbers to remove (default: the suggested retakes and repeats)"),
    }),
    mutates: true,
    run: async (s, i) => {
      const t = s.project.transcripts[i.assetId];
      if (!t) return { text: `No transcript for "${i.assetId}". Run transcribe first.`, isError: true };
      const r = findRetakes(t);
      const remove = i.sentences ?? r.remove;
      if (!remove.length) return ok("Nothing to remove: no retakes or repeats found.");
      const bad = remove.filter((k) => !r.sentences[k]);
      if (bad.length) return { text: `No sentence ${bad.join(", ")}; there are ${r.sentences.length} (0-${r.sentences.length - 1}).`, isError: true };
      const ranges = sentenceCutRanges(t, r.sentences, remove);
      const before = computeTimeline(s.project).duration;
      const p = ops.cutSourceRanges(s.project, i.assetId, ranges);
      const gone = Math.round((before - computeTimeline(p).duration) * 100) / 100;
      const removed = remove.map((k) => `${k}. "${r.sentences[k]!.text}"`).join("\n");
      return commit(s, p, "remove_retakes", i, `Removed ${remove.length} sentences (${gone}s of the edit):\n${removed}`);
    },
  }),
  tool({
    name: "cut_ranges",
    description: "Remove time ranges from the finished timeline (timeline seconds). Everything after each cut moves earlier.",
    input: z.object({ ranges: z.array(z.object({ start: z.number().min(0), end: z.number().positive() })).min(1) }),
    mutates: true,
    run: async (s, i) => commit(s, ops.cutTimelineRanges(s.project, i.ranges), "cut_ranges", i, `Cut ${i.ranges.length} range(s).`),
  }),
  tool({
    name: "assemble_from_source",
    description: "Rebuild the primary track from chosen source ranges of one asset, in the order given (e.g. pick the best moments of a long recording by transcript).",
    input: z.object({
      assetId: z.string(),
      ranges: z.array(z.object({ start: z.number().min(0), end: z.number().positive() })).min(1),
      transition: TransitionSchema.optional(),
      fit: FitSchema.optional(),
    }),
    mutates: true,
    run: async (s, i) =>
      commit(s, ops.assembleFromRanges(s.project, i.assetId, i.ranges, { transition: i.transition, clipDefaults: i.fit ? { fit: i.fit } : undefined }), "assemble_from_source", i, `Assembled ${i.ranges.length} clips from ${i.assetId}.`),
  }),
  tool({
    name: "set_captions",
    description: "Turn captions on/off and pick a style (see list_caption_styles). Captions come from transcripts and stay synced through edits. Override style fields like position (0-1), fontSize, highlightColor, uppercase, maxWordsPerLine.",
    input: z.object({
      enabled: z.boolean().default(true),
      style: z.string().optional(),
      overrides: z.record(z.string(), z.unknown()).optional(),
      segments: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional().describe("Manual captions in timeline seconds (instead of transcripts)"),
    }),
    mutates: true,
    run: async (s, i) => commit(s, ops.setCaptions(s.project, i), "set_captions", i, `Captions ${i.enabled ? `on (${i.style ?? s.project.captions?.style ?? "classic"})` : "off"}.`),
  }),
  tool({
    name: "export_captions",
    description: "Write the captions as a subtitle sidecar file (srt, vtt or ass), e.g. for YouTube upload.",
    input: z.object({ format: z.enum(["srt", "vtt", "ass"]).default("srt"), output: z.string().optional() }),
    mutates: false,
    run: async (s, i) => {
      const out = i.output ? s.resolve(i.output) : await s.outputPath(`captions.${i.format}`);
      await writeFile(out, exportCaptions(s.project, i.format), "utf8");
      return ok(`Wrote ${out}`);
    },
  }),

  // -------------------------------------------------------------------------
  // Voice-over
  // -------------------------------------------------------------------------
  tool({
    name: "generate_voiceover",
    description:
      "Synthesize narration from text and add it as a voice-over with measured word timings for captions. Runs a neural voice on this machine unless the session has another provider (no API key; the model downloads once). " +
      "Pick a voice with list_voices and audition it with preview_voice; the project's default voice (set_voice) is used when none is given. Write it the way people talk, in short sentences; one call per section lets you place each part on the timeline.",
    input: z.object({
      text: z.string(),
      start: z.number().min(0).default(0),
      voice: z.string().optional().describe("Voice id (see list_voices); default: the project's voice, else af_heart"),
      speed: z.number().optional().describe("1 = normal, 1.1 a little brisker"),
      instructions: z.string().optional().describe("Delivery style, e.g. 'warm and upbeat' (only for an optional external voice provider; the local voice ignores it)"),
      volume: z.number().default(1),
    }),
    mutates: true,
    run: async (s, i, activity) => {
      const voice = i.voice ?? projectVoice(s).voice;
      const speed = i.speed ?? projectVoice(s).speed;
      const vo = await speak(s, i.text, { voice, speed, instructions: i.instructions }, activity);
      const id = assetIdFromSrc(s.project, "voiceover");
      let p = ops.addAsset(s.project, { type: "audio", id, src: vo.path, duration: vo.duration, label: "voice-over" });
      p = ops.setTranscript(p, id, vo.transcript);
      p = ops.addAudio(p, { assetId: id, role: "voiceover", start: i.start, volume: i.volume });
      p = rememberNarration(p, id, { text: i.text, voice, speed, instructions: i.instructions });
      return commit(s, p, "generate_voiceover", i, `Added voice-over "${id}" (${vo.duration}s, voice ${voice ?? "provider default"}) at ${i.start}s.`);
    },
  }),
  tool({
    name: "list_voices",
    description:
      "List the narration voices: the local voices that run on this machine (with accent, gender and quality grade) and the session's own provider if it has one. Grades are the voice model's published ones; prefer A to C+ for narration.",
    input: z.object({ all: z.boolean().default(false).describe("Include weaker voices (graded below C+)") }),
    mutates: false,
    run: async (s, i) => {
      const current = projectVoice(s);
      const rows = VOICES.filter((v) => i.all || RECOMMENDED_VOICES.includes(v.id)).map(
        (v) => `${v.id}: ${v.name}, ${v.accent} ${v.gender}, grade ${v.grade}${v.id === (current.voice ?? "af_heart") ? " (project voice)" : ""}`,
      );
      const provider = externalVoice(s) ? `This session uses another voice engine (${s.options.tts!.name}) with its own voice names; the local voices below are the built-in ones.\n` : "";
      return ok(`${provider}Local voices${i.all ? "" : " (recommended; all=true lists every voice)"}:\n${rows.join("\n")}`, { voices: VOICES, recommended: RECOMMENDED_VOICES });
    },
  }),
  tool({
    name: "preview_voice",
    description:
      "Speak a sample line in one or more voices and save each as a WAV file to listen to and compare, without changing the project. Use the actual opening line of the script, so the choice is made on real material.",
    input: z.object({
      voices: z.array(z.string()).min(1).max(6).describe("Voice ids to audition"),
      text: z.string().default("Here are five quick tips that will change how you use your phone.").describe("Line to speak"),
      speed: z.number().optional(),
    }),
    mutates: false,
    run: async (s, i, activity) => {
      const tts = new LocalTTS({ ffmpegPath: s.options.ffmpegPath, alignWords: false, onDownload: (p) => activity?.progress(p * 0.5) });
      const lines: string[] = [];
      for (const [k, voice] of i.voices.entries()) {
        if (!LOCAL_VOICES.includes(voice)) return { text: `Unknown voice "${voice}". Use list_voices.`, isError: true };
        const file = await s.outputPath(`voice-preview-${voice}.wav`);
        const vo = await tts.synthesize(i.text, file, { voice, speed: i.speed });
        activity?.progress(0.5 + (0.5 * (k + 1)) / i.voices.length);
        const info = VOICES.find((v) => v.id === voice)!;
        lines.push(`${voice} (${info.name}, ${info.accent} ${info.gender}, grade ${info.grade}): ${vo.duration}s ${file}`);
      }
      return ok(`Voice previews of "${i.text}":\n${lines.join("\n")}\nListen to them, then use set_voice or pass voice to generate_voiceover.`);
    },
  }),
  tool({
    name: "set_voice",
    description: "Set the project's narration voice and speed, used by generate_voiceover and revoice when no voice is given. Use revoice with all=true to apply it to narration already in the project.",
    input: z.object({ voice: z.string(), speed: z.number().min(0.5).max(2).optional() }),
    mutates: true,
    run: async (s, i) => {
      if (!externalVoice(s) && !LOCAL_VOICES.includes(i.voice)) return { text: `Unknown voice "${i.voice}". Use list_voices.`, isError: true };
      const p = { ...s.project, metadata: { ...s.project.metadata, voice: { voice: i.voice, ...(i.speed ? { speed: i.speed } : {}) } } };
      return commit(s, p, "set_voice", i, `Project voice: ${i.voice}${i.speed ? ` at ${i.speed}x` : ""}.`);
    },
  }),
  tool({
    name: "revoice",
    description:
      "Re-generate narration already in the project with a new voice, speed or wording, keeping each voice-over where it is on the timeline. Target one voice-over (its audio clip id or asset id), or all=true for every narration made with generate_voiceover. New wording changes the length: check what follows and the graphics timed to words.",
    input: z.object({
      target: z.string().optional().describe("Voice-over audio clip id or asset id"),
      all: z.boolean().default(false),
      voice: z.string().optional().describe("Default: the project's voice"),
      speed: z.number().optional(),
      text: z.string().optional().describe("New wording (one target only)"),
    }),
    mutates: true,
    run: async (s, i, activity) => {
      const narrations = (s.project.metadata.narration ?? {}) as Record<string, NarrationInfo>;
      const clips = s.project.audio.filter((a) => a.role === "voiceover" && (i.all ? narrations[a.assetId] : a.id === i.target || a.assetId === i.target));
      if (!clips.length) return { text: i.all ? "No narration made with generate_voiceover in this project." : `No voice-over "${i.target}".`, isError: true };
      if (i.text && clips.length > 1) return { text: "New wording needs a single target.", isError: true };
      let p = s.project;
      const done: string[] = [];
      for (const [k, clip] of clips.entries()) {
        const before = narrations[clip.assetId];
        const text = i.text ?? before?.text ?? s.project.transcripts[clip.assetId]?.words.map((w) => w.text).join(" ");
        if (!text) return { text: `No script or transcript for "${clip.assetId}"; give text.`, isError: true };
        const voice = i.voice ?? projectVoice(s).voice ?? before?.voice;
        const speed = i.speed ?? before?.speed ?? projectVoice(s).speed;
        const vo = await speak(s, text, { voice, speed, instructions: before?.instructions }, activity);
        activity?.progress((k + 1) / clips.length);
        const asset = p.assets.find((a) => a.id === clip.assetId)!;
        p = ops.upsertAsset(p, { ...asset, src: vo.path, duration: vo.duration } as Asset);
        p = ops.setTranscript(p, clip.assetId, vo.transcript);
        if (clip.duration !== undefined) p = ops.updateAudio(p, clip.id, { duration: vo.duration });
        p = rememberNarration(p, clip.assetId, { text, voice, speed, instructions: before?.instructions });
        done.push(`${clip.assetId} ${vo.duration}s`);
      }
      return commit(s, p, "revoice", i, `Re-voiced ${done.length} narration${done.length > 1 ? "s" : ""}${i.voice ? ` with ${i.voice}` : ""}: ${done.join(", ")}.`);
    },
  }),

  // -------------------------------------------------------------------------
  // Color
  // -------------------------------------------------------------------------
  tool({
    name: "color_adjust",
    description:
      "Color correct and grade a clip, a media layer, every clip, or the whole video. Settings merge into the target's existing color settings, so you can tweak one control at a time. " +
      "Light: exposure (stops), brightness, contrast, highlights, shadows, whites, blacks, brilliance. Color: temperature, tint, hue (degrees), saturation, vibrance, hsl per color (red, orange, yellow, green, aqua, blue, purple, magenta). " +
      "Grading: curves (master/red/green/blue point graphs or a preset), wheels (shadows/midtones/highlights tint). Finish: fade, clarity, sharpen, vignette, grain, autoCorrect. Most sliders are -100..100 with 0 = unchanged. " +
      "Correct first (exposure, white balance, contrast), then grade. Use analyze_color and render_scopes to check the result.",
    input: z.object({
      target: z.string().default("global").describe('"global" (whole video), "all-clips", a clip id, or a media layer id'),
      settings: ColorSettingsSchema.default({}),
      reset: z.array(z.string()).optional().describe('Setting names to clear back to neutral, e.g. ["hsl", "vignette"], or ["all"]'),
    }),
    mutates: true,
    run: async (s, i) => {
      const targets = i.target === "all-clips" ? s.project.clips.map((c) => c.id) : [i.target];
      if (!targets.length) return { text: "There are no clips to adjust.", isError: true };
      let p = s.project;
      let result = {} as ColorSettings;
      for (const target of targets) {
        const current = i.reset?.includes("all") ? {} : ((ops.getEffectParams(p, target, "color") ?? {}) as ColorSettings);
        const cleared = Object.fromEntries((i.reset ?? []).filter((k) => k !== "all").map((k) => [k, null]));
        result = mergeColorSettings(current, { ...cleared, ...i.settings });
        p = ops.setEffectParams(p, target, "color", result as Record<string, unknown>, { prepend: true });
      }
      return commit(s, p, "color_adjust", i, `Color on ${i.target}: ${describeColorSettings(result)}.`);
    },
  }),
  tool({
    name: "get_color",
    description: "Read the current color settings of a target (\"global\", a clip id, or a media layer id).",
    input: z.object({ target: z.string().default("global") }),
    mutates: false,
    run: async (s, i) => {
      const params = (ops.getEffectParams(s.project, i.target, "color") ?? {}) as ColorSettings;
      return ok(`${i.target}: ${describeColorSettings(params)}\n${JSON.stringify(params)}`, params);
    },
  }),
  tool({
    name: "sample_color",
    description:
      "Measure the average color of a small area of a source video or image at a source time, e.g. a green screen before chromaKey, or a brand color to match text and section cards to. x, y are frame fractions of the area's center.",
    input: z.object({
      assetId: z.string(),
      time: z.number().min(0).default(0).describe("Source seconds"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      size: z.number().min(0.002).max(0.5).default(0.02).describe("Square side as a fraction of the frame width"),
    }),
    mutates: false,
    run: async (s, i) => {
      const asset = s.project.assets.find((a) => a.id === i.assetId);
      if (!asset || (asset.type !== "video" && asset.type !== "image")) return { text: `"${i.assetId}" is not a video or image asset.`, isError: true };
      const side = `max(2\\,trunc(iw*${i.size}))`;
      const res = await runFfmpegOrThrow(
        [
          "-hide_banner", "-loglevel", "error",
          ...(asset.type === "video" ? ["-ss", String(i.time)] : []),
          "-i", s.resolve(asset.src),
          "-frames:v", "1",
          "-vf", `crop=${side}:${side}:iw*${i.x}-${side}/2:ih*${i.y}-${side}/2,scale=8:8:flags=area`,
          "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        { ffmpegPath: s.options.ffmpegPath, binaryStdout: true },
      );
      const b = res.stdoutBuffer!;
      const avg = [0, 1, 2].map((c) => {
        let sum = 0;
        for (let k = c; k < b.length; k += 3) sum += b[k]!;
        return Math.round(sum / (b.length / 3));
      });
      const hex = `#${avg.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
      return ok(`Average color at (${i.x}, ${i.y}) of ${i.assetId} at ${i.time}s: ${hex} (r ${avg[0]}, g ${avg[1]}, b ${avg[2]}).`, { hex, rgb: avg });
    },
  }),
  tool({
    name: "analyze_color",
    description:
      "Measure the edited video's color at a time: average brightness, shadow/highlight levels, contrast range, saturation and color cast, with plain-language suggestions. Use before and after color_adjust.",
    input: z.object({ time: z.number().min(0).optional().describe("Timeline time; defaults to the middle of the video") }),
    mutates: false,
    run: async (s, i) => {
      const time = i.time ?? computeTimeline(s.project).duration / 2;
      const frame = await s.outputPath(`analyze-${time.toFixed(2)}.png`);
      await renderFrame(s.project, time, { output: frame, scale: 0.5, ...s.renderOptions });
      const st = await analyzeColor(frame, { ffmpegPath: s.options.ffmpegPath });
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      return ok(
        `At ${time.toFixed(1)}s: brightness ${pct(st.luma)}, shadows ${pct(st.lumaLow)}, highlights ${pct(st.lumaHigh)} (range ${pct(st.lumaHigh - st.lumaLow)}), saturation ${pct(st.saturation)}, cast ${st.cast}.\n- ${st.notes.join("\n- ")}`,
        st,
      );
    },
  }),
  tool({
    name: "render_scopes",
    description: "Render video scopes (histogram, luma waveform, RGB parade, vectorscope) for the frame at a time and look at them, like a colorist would.",
    input: z.object({
      time: z.number().min(0).optional(),
      scopes: z.array(z.enum(["histogram", "waveform", "parade", "vectorscope"])).optional(),
    }),
    mutates: false,
    run: async (s, i, activity) => {
      const time = i.time ?? computeTimeline(s.project).duration / 2;
      const frame = await s.outputPath(`scopes-frame-${time.toFixed(2)}.png`);
      await renderFrame(s.project, time, { output: frame, scale: 0.5, ...s.renderOptions });
      activity?.progress(0.6);
      const out = await s.outputPath(`scopes-${time.toFixed(2)}.png`);
      await renderScopes(frame, out, i.scopes, { ffmpegPath: s.options.ffmpegPath });
      s.recordRender({ kind: "frame", path: frame, time });
      return { text: `Scopes at ${time.toFixed(1)}s (${(i.scopes ?? ["histogram", "waveform", "parade", "vectorscope"]).join(", ")}): ${out}`, images: [{ path: out, mediaType: "image/png" }] };
    },
  }),

  // -------------------------------------------------------------------------
  // Preview & render
  // -------------------------------------------------------------------------
  tool({
    name: "review_edit",
    description:
      "Check the edit for what a viewer notices, with timeline times, without changing anything. It renders sample frames and the audio mix in one pass and reports: " +
      "text that is hard to read against the picture, runs off the frame, or collides with captions or other text (text); text and captions where TikTok, Reels and Shorts put their buttons and captions (safe-zones); " +
      "black, frozen or repeated footage (frames); words cut off at an edit, doubled caption words, captions over silence, and speech the transcript skipped (speech); " +
      "loudness off target, peaks, and music too loud under the voice (audio); screen color a chroma key left behind (key). " +
      "It has no face detection, so check text over faces with render_frame. Run it before render_video and after big changes, fix what it finds, then run it again.",
    input: z.object({
      checks: z
        .array(z.enum(REVIEW_CHECKS as [string, ...string[]]))
        .optional()
        .describe("Only these checks (default all)"),
      platform: z
        .enum(["auto", "tiktok", "reels", "shorts", "vertical", "none"])
        .default("auto")
        .describe("Safe zones to check: auto = all three vertical apps for a portrait video, none for landscape"),
      loudnessTarget: z.number().min(-30).max(-8).default(-14).describe("Integrated loudness to aim for in LUFS: -14 social video and YouTube, -16 podcasts"),
    }),
    mutates: false,
    run: async (s, i, activity) => {
      const r = await reviewEdit(s.project, {
        checks: i.checks as never,
        platform: i.platform,
        loudnessTarget: i.loudnessTarget,
        workDir: path.join(s.options.outputDir, "review"),
        ...s.renderOptions,
        onProgress: (x) => activity?.progress(x),
      });
      const duration = computeTimeline(s.project).duration;
      const count = (sev: string) => r.issues.filter((x) => x.severity === sev).length;
      const when = (x: { start: number; end: number }) => (x.start <= 0 && x.end >= duration ? "whole video" : `${formatTime(x.start)}-${formatTime(x.end)}`);
      const lines = [
        r.issues.length ? `Found ${count("problem")} problems and ${count("warning")} warnings:` : "No problems found.",
        ...r.issues.map((x) => `${when(x)} ${x.severity} [${x.check}] ${x.message}`),
        ...(r.loudness ? [`Loudness: ${r.loudness.integrated} LUFS (target ${r.loudness.target}), true peak ${r.loudness.truePeak} dBTP.`] : []),
        ...r.notes,
      ];
      return ok(lines.join("\n"), r);
    },
  }),
  tool({
    name: "render_frame",
    description: "Render one frame of the edit at a timeline time and look at it. Use to check layout, text, captions and effects.",
    input: z.object({ time: z.number().min(0), scale: z.number().min(0.1).max(1).default(0.5) }),
    mutates: false,
    run: async (s, i) => {
      const out = await s.outputPath(`frame-${i.time.toFixed(2)}.png`);
      await renderFrame(s.project, i.time, { output: out, scale: i.scale, ...s.renderOptions });
      s.recordRender({ kind: "frame", path: out, time: i.time });
      return { text: `Frame at ${i.time}s: ${out}`, images: [{ path: out, mediaType: "image/png" }] };
    },
  }),
  tool({
    name: "render_contact_sheet",
    description: "Render a grid of frames sampled across the whole video, a one-image overview of the edit's pacing and look.",
    input: z.object({ columns: z.number().int().min(1).max(8).default(4), rows: z.number().int().min(1).max(8).default(3), thumbWidth: z.number().int().default(320) }),
    mutates: false,
    run: async (s, i) => {
      const out = await s.outputPath("contact-sheet.png");
      await renderContactSheet(s.project, { output: out, ...i, ...s.renderOptions });
      s.recordRender({ kind: "contact-sheet", path: out });
      return { text: `Contact sheet (${i.columns}x${i.rows}, read left to right, top to bottom): ${out}`, images: [{ path: out, mediaType: "image/png" }] };
    },
  }),
  tool({
    name: "render_preview",
    description: "Render a fast low-resolution preview video (shown in the live preview for the user). Optionally only a time range.",
    input: z.object({ scale: z.number().min(0.1).max(1).default(0.5), start: z.number().min(0).optional(), end: z.number().positive().optional() }),
    mutates: false,
    run: async (s, i, activity) => {
      const out = await s.outputPath("preview.mp4");
      const range = i.start !== undefined || i.end !== undefined ? { start: i.start ?? 0, end: i.end ?? Number.MAX_SAFE_INTEGER } : undefined;
      const r = await render(s.project, { output: out, scale: i.scale, range, preset: "ultrafast", extraOutputArgs: ["-crf", "30"], ...s.renderOptions, onProgress: (p) => activity?.progress(p) });
      s.recordRender({ kind: "preview", path: out });
      return ok(`Preview rendered (${r.duration}s): ${out}`);
    },
  }),
  tool({
    name: "render_video",
    description: "Render the final full-quality video file.",
    input: z.object({ output: z.string().describe("Output path, e.g. out/final.mp4") }),
    mutates: false,
    run: async (s, i, activity) => {
      const out = s.resolve(i.output);
      const r = await render(s.project, { output: out, ...s.renderOptions, onProgress: (p) => activity?.progress(p) });
      s.recordRender({ kind: "video", path: out });
      return ok(`Rendered ${r.duration}s video to ${out}`);
    },
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

/** Add a custom tool so it is listed by `toAnthropicTools()` and runnable via `executeTool`. */
export function registerTool<S extends z.ZodType>(def: ToolDefinition<S>, opts: { replace?: boolean } = {}): void {
  if (byName.has(def.name) && !opts.replace) throw new Error(`Tool "${def.name}" already registered`);
  const t = def as unknown as ToolDefinition;
  const i = TOOLS.findIndex((x) => x.name === def.name);
  if (i >= 0) TOOLS[i] = t;
  else TOOLS.push(t);
  byName.set(def.name, t);
}

/** Execute a tool by name with raw (unvalidated) input. Never throws: errors come back as isError results. */
export async function executeTool(session: EditorSession, name: string, input: unknown): Promise<ToolResult> {
  const def = byName.get(name);
  if (!def) return { text: `Unknown tool "${name}"`, isError: true };
  const parsed = def.input.safeParse(input ?? {});
  if (!parsed.success) {
    return { text: `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, isError: true };
  }
  const activity = session.startActivity(name.startsWith("render_") ? "render" : "tool", describeToolCall(name, parsed.data));
  try {
    const result = await def.run(session, parsed.data, activity);
    const summary = result.text.split("\n")[0]!;
    if (result.isError) activity.fail(summary);
    else activity.done(summary);
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    session.error(`${name}: ${message}`);
    activity.fail(message.split("\n")[0]!);
    return { text: `${name} failed: ${message}`, isError: true };
  }
}

const quote = (v: unknown, max = 40) => {
  const t = String(v ?? "");
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};

/** Plain-language label for a tool call, shown to people watching the session. */
export function describeToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "get_project":
      return "Reviewing the project";
    case "apply_template":
      return `Applying the ${quote(i.templateId)} template`;
    case "import_media":
      return `Importing ${quote(String(i.src).split(/[\\/]/).pop())}`;
    case "add_clip":
      return `Adding clip from ${quote(i.assetId)}`;
    case "add_text":
      return `Adding text ${quote(i.text)}`;
    case "add_component":
      return `Adding ${String(i.component).replace(/-/g, " ")}`;
    case "add_effect":
      return `Adding ${quote(i.type)} effect`;
    case "set_transition":
      return `Setting ${quote(i.type)} transition`;
    case "set_captions":
      return i.enabled === false ? "Turning captions off" : `Styling captions${i.style ? ` (${i.style})` : ""}`;
    case "transcribe":
      return `Transcribing ${quote(i.assetId)}`;
    case "cleanup_speech":
      return "Removing filler words and pauses";
    case "search_transcript":
      return `Searching speech for ${quote(i.query)}`;
    case "fix_transcript":
      return "Correcting the transcript";
    case "review_edit":
      return "Checking the edit for problems";
    case "detect_faces":
      return "Finding faces";
    case "reframe":
      return i.follow ? "Panning crops to follow faces" : "Reframing clips around faces";
    case "animate_layer":
      return `Animating ${quote(i.layerId)}`;
    case "follow_face":
      return `Making ${quote(i.layerId)} follow a face`;
    case "generate_voiceover":
      return `Recording voice-over ${quote(i.text, 30)}`;
    case "render_frame":
      return `Rendering frame at ${i.time}s`;
    case "color_adjust": {
      const keys = Object.keys((i.settings as object) ?? {});
      return keys.length ? `Adjusting color: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""}` : "Adjusting color";
    }
    case "analyze_color":
      return "Measuring color and exposure";
    case "render_scopes":
      return "Rendering color scopes";
    case "render_contact_sheet":
      return "Rendering overview of the whole video";
    case "render_preview":
      return "Rendering preview video";
    case "render_video":
      return `Rendering final video ${quote(i.output)}`;
    default: {
      const words = name.replace(/_/g, " ");
      return words[0]!.toUpperCase() + words.slice(1);
    }
  }
}

/** Tool definitions in the Claude Messages API format (`tools` parameter). */
export function toAnthropicTools(tools: ToolDefinition[] = TOOLS): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema };
  });
}

/** Convert a ToolResult into Claude `tool_result` content blocks (text + base64 images). */
export async function toToolResultContent(
  result: ToolResult,
): Promise<({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } })[]> {
  const blocks: ({ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } })[] = [
    { type: "text", text: result.text },
  ];
  for (const img of result.images ?? []) {
    const data = (await readFile(img.path)).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data } });
  }
  return blocks;
}
