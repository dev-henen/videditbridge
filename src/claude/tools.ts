import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AnimationSchema,
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
import { validateProject } from "../core/validate.js";
import { summarizeProject } from "../core/summary.js";
import { ASPECT_RATIOS, formatTime, newId, type AspectRatio } from "../core/util.js";
import { listEffects } from "../library/effects/index.js";
import { listTransitions } from "../library/transitions/index.js";
import { listAnimations } from "../library/animations/index.js";
import { listCaptionStyles } from "../library/caption-styles/index.js";
import { addComponent, listComponents } from "../library/components/index.js";
import { applyTemplate, describeTemplate, getTemplate, listTemplates } from "../library/templates/index.js";
import { formatTranscript, searchTranscript, transcriptStats } from "../tools/transcript/analyze.js";
import { parseTranscript } from "../tools/transcript/parse.js";
import { cleanupSpeech } from "../tools/transcript/cleanup.js";
import { transcribeMedia } from "../tools/transcript/providers.js";
import { exportCaptions } from "../tools/captions/build.js";
import { probe } from "../tools/render/ffmpeg.js";
import { render, renderContactSheet, renderFrame } from "../tools/render/render.js";
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
  const problems = v.issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`);
  const duration = (() => {
    try {
      return computeTimeline(project).duration;
    } catch {
      return undefined;
    }
  })();
  return ok(
    `${message}${duration !== undefined ? ` (video now ${duration}s)` : ""}${problems.length ? `\n⚠ Problems to fix:\n- ${problems.join("\n- ")}` : ""}`,
  );
}

function assetIdFromSrc(project: Project, src: string): string {
  const base = path.basename(src).replace(/\.[^.]+$/, "").replace(/[^\w]+/g, "_").toLowerCase() || "media";
  let id = base;
  let n = 2;
  while (project.assets.some((a) => a.id === id)) id = `${base}_${n++}`;
  return id;
}

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
      const issues = v.issues.map((x) => `${x.level === "error" ? "✗" : "⚠"} ${x.path}: ${x.message}`).join("\n");
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
      return ok(list.map((t) => `${t.id} — ${t.name} [${t.aspectRatio}, ${t.idealDuration[0]}–${t.idealDuration[1]}s] ${t.description}`).join("\n") || "No templates match.");
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
    description: "List available visual effects (color grades, blur, zoom/motion, stylize) with their parameters.",
    input: z.object({ category: z.enum(["color", "grade", "blur", "stylize", "motion", "distort", "time"]).optional() }),
    mutates: false,
    run: async (_s, i) =>
      ok(
        listEffects(i.category)
          .map((e) => {
            const shape = (e.params as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
            const params = Object.entries(shape).map(([k, v]) => `${k}${v.description ? `: ${v.description}` : ""}`);
            return `${e.id} (${e.category}) — ${e.description}${params.length ? ` Params: ${params.join("; ")}` : ""}`;
          })
          .join("\n"),
      ),
  }),
  tool({
    name: "list_transitions",
    description: "List transitions usable between primary-track clips.",
    input: empty,
    mutates: false,
    run: async () => ok(listTransitions().map((t) => `${t.id} (${t.category}, ~${t.defaultDuration}s) — ${t.description}`).join("\n")),
  }),
  tool({
    name: "list_animations",
    description: "List entrance/exit animations for text, shape and media layers.",
    input: empty,
    mutates: false,
    run: async () => ok(listAnimations().map((a) => `${a.id}${a.media ? "" : " (text/shapes only)"} — ${a.description}`).join("\n")),
  }),
  tool({
    name: "list_caption_styles",
    description: "List caption style presets (bold-pop, karaoke, word-by-word, boxed, cinematic…).",
    input: empty,
    mutates: false,
    run: async () => ok(listCaptionStyles().map((c) => `${c.id} — ${c.name}: ${c.description} [mode ${c.mode}]`).join("\n")),
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
            return `${c.id} (${c.category}, ${c.defaultDuration}s) — ${c.description} Params: ${Object.keys(shape).join(", ")}`;
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
    description: "Change properties of a primary-track clip (in, duration, speed, volume, muted, fit, effects, transition, fadeIn, fadeOut).",
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
    run: async (s, i) => commit(s, ops.trimClip(s.project, i.clipId, i.sourceIn, i.sourceOut), "trim_clip", i, `Trimmed ${i.clipId} to ${i.sourceIn}–${i.sourceOut}s of source.`),
  }),
  tool({
    name: "set_transition",
    description: "Set the transition into a clip (or between all clips with all=true). type 'none' removes it.",
    input: z.object({ clipId: z.string().optional(), all: z.boolean().default(false), type: z.string(), duration: z.number().positive().max(5).default(0.5) }),
    mutates: true,
    run: async (s, i) => {
      const t = i.type === "none" ? null : { type: i.type, duration: i.duration };
      if (i.all) return commit(s, ops.setAllTransitions(s.project, t), "set_transition", i, `Set ${i.type} between all clips.`);
      if (!i.clipId) return { text: "Provide clipId or all=true", isError: true };
      return commit(s, ops.setTransition(s.project, i.clipId, t), "set_transition", i, `Transition into ${i.clipId}: ${i.type}.`);
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

  // -------------------------------------------------------------------------
  // Layers
  // -------------------------------------------------------------------------
  tool({
    name: "add_text",
    description: "Add a text layer (titles, labels, callouts). Position is the text center in 0–1 frame coordinates. Font size is in output pixels.",
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
    description: "Add a colored rectangle (backgrounds behind text, bars, dimming panels).",
    input: z.object({
      start: z.number().min(0),
      duration: z.number().positive(),
      position: PositionSchema.optional(),
      size: z.object({ width: z.number().positive(), height: z.number().positive() }),
      color: z.string().default("#000000"),
      opacity: z.number().min(0).max(1).default(1),
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
    description: "Change an audio clip (volume, start, fades, duck, loop…).",
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

  // -------------------------------------------------------------------------
  // Transcript & captions
  // -------------------------------------------------------------------------
  tool({
    name: "transcribe",
    description: "Transcribe an asset's speech with word timings (needs a transcription provider). Enables captions, search and filler removal.",
    input: z.object({ assetId: z.string(), language: z.string().optional() }),
    mutates: true,
    run: async (s, i) => {
      if (!s.options.transcriber) return { text: "No transcription provider configured. Use set_transcript with an existing SRT/VTT/JSON transcript.", isError: true };
      const asset = s.project.assets.find((a) => a.id === i.assetId);
      if (!asset || !("src" in asset)) return { text: `Asset "${i.assetId}" not found or has no file`, isError: true };
      const t = await transcribeMedia(s.resolve(asset.src), s.options.transcriber, { language: i.language, ffmpegPath: s.options.ffmpegPath });
      const r = commit(s, ops.setTranscript(s.project, i.assetId, t), "transcribe", i, `Transcribed ${i.assetId}: ${t.words.length} words.`);
      return { ...r, text: `${r.text}\n\n${formatTranscript(t)}` };
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
          const tl = tc ? ` → timeline ${formatTime(sourceToTimeline(tc, m.start))} (clip ${tc.clip.id})` : " (not in the edit)";
          lines.push(`${id} source ${m.start}–${m.end}s${tl}: "…${m.context}…"`);
        }
      }
      return ok(lines.join("\n") || `"${i.query}" not found.`);
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
      const detail = r.removed.slice(0, 40).map((x) => `${x.start}–${x.end}s ${x.reason}${x.text ? ` "${x.text}"` : ""}`).join("\n");
      return { ...out, text: `${out.text}\n${detail}${r.removed.length > 40 ? `\n…and ${r.removed.length - 40} more` : ""}` };
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
    description: "Turn captions on/off and pick a style (see list_caption_styles). Captions come from transcripts and stay synced through edits. Override style fields like position (0–1), fontSize, highlightColor, uppercase, maxWordsPerLine.",
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
    description: "Synthesize narration from text (needs a TTS provider), add it as a voice-over with word timings for captions.",
    input: z.object({
      text: z.string(),
      start: z.number().min(0).default(0),
      voice: z.string().optional(),
      speed: z.number().optional(),
      instructions: z.string().optional().describe("Delivery style, e.g. 'warm and upbeat'"),
      volume: z.number().default(1),
    }),
    mutates: true,
    run: async (s, i) => {
      if (!s.options.tts) return { text: "No TTS provider configured.", isError: true };
      const file = await s.outputPath("voiceover.mp3");
      const vo = await s.options.tts.synthesize(i.text, file, { voice: i.voice, speed: i.speed, instructions: i.instructions });
      const id = assetIdFromSrc(s.project, "voiceover");
      let p = ops.addAsset(s.project, { type: "audio", id, src: vo.path, duration: vo.duration });
      p = ops.setTranscript(p, id, vo.transcript);
      p = ops.addAudio(p, { assetId: id, role: "voiceover", start: i.start, volume: i.volume });
      return commit(s, p, "generate_voiceover", i, `Added voice-over "${id}" (${vo.duration}s) at ${i.start}s.`);
    },
  }),

  // -------------------------------------------------------------------------
  // Preview & render
  // -------------------------------------------------------------------------
  tool({
    name: "render_frame",
    description: "Render one frame of the edit at a timeline time and look at it. Use to check layout, text, captions and effects.",
    input: z.object({ time: z.number().min(0), scale: z.number().min(0.1).max(1).default(0.5) }),
    mutates: false,
    run: async (s, i) => {
      const out = await s.outputPath(`frame-${i.time.toFixed(2)}.png`);
      await renderFrame(s.project, i.time, { output: out, scale: i.scale, baseDir: s.options.baseDir, ffmpegPath: s.options.ffmpegPath, fontsDir: s.options.fontsDir });
      s.recordRender({ kind: "frame", path: out, time: i.time });
      return { text: `Frame at ${i.time}s: ${out}`, images: [{ path: out, mediaType: "image/png" }] };
    },
  }),
  tool({
    name: "render_contact_sheet",
    description: "Render a grid of frames sampled across the whole video — a one-image overview of the edit's pacing and look.",
    input: z.object({ columns: z.number().int().min(1).max(8).default(4), rows: z.number().int().min(1).max(8).default(3), thumbWidth: z.number().int().default(320) }),
    mutates: false,
    run: async (s, i) => {
      const out = await s.outputPath("contact-sheet.png");
      await renderContactSheet(s.project, { output: out, ...i, baseDir: s.options.baseDir, ffmpegPath: s.options.ffmpegPath, fontsDir: s.options.fontsDir });
      s.recordRender({ kind: "contact-sheet", path: out });
      return { text: `Contact sheet (${i.columns}x${i.rows}, left→right, top→bottom): ${out}`, images: [{ path: out, mediaType: "image/png" }] };
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
      const r = await render(s.project, { output: out, scale: i.scale, range, preset: "ultrafast", extraOutputArgs: ["-crf", "30"], baseDir: s.options.baseDir, ffmpegPath: s.options.ffmpegPath, fontsDir: s.options.fontsDir, onProgress: (p) => activity?.progress(p) });
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
      const r = await render(s.project, { output: out, baseDir: s.options.baseDir, ffmpegPath: s.options.ffmpegPath, fontsDir: s.options.fontsDir, onProgress: (p) => activity?.progress(p) });
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
    case "generate_voiceover":
      return `Recording voice-over ${quote(i.text, 30)}`;
    case "render_frame":
      return `Rendering frame at ${i.time}s`;
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
