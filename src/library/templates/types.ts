import { z } from "zod";
import { AnimationSchema, EffectSchema, FitSchema, PositionSchema, TextStyleSchema, TranscriptSchema, TransitionSchema } from "../../core/schema.js";
import { ASPECT_RATIOS } from "../../core/util.js";

/**
 * A template is a JSON recipe for a style of video. It declares the inputs it needs (slots),
 * the look (theme, captions, grade, transitions) and an ordered list of scenes.
 * Text values may contain placeholders: {{slotId}}, {{item.field}}, {{index}}, {{theme.key}}.
 */

const aspect = z.enum(Object.keys(ASPECT_RATIOS) as [keyof typeof ASPECT_RATIOS, ...(keyof typeof ASPECT_RATIOS)[]]);

export const SlotSpecSchema = z.object({
  id: z.string(),
  kind: z.enum(["video", "image", "media", "audio", "text", "list"]).describe("media = video or image; list = array of objects"),
  description: z.string(),
  required: z.boolean().default(false),
  multiple: z.boolean().default(false).describe("Accepts an array of media"),
  fields: z.record(z.string(), z.string()).optional().describe("For list slots: field name → description"),
  example: z.unknown().optional(),
});

export const ThemeSchema = z.object({
  fontFamily: z.string().default("Arial"),
  headingFont: z.string().default("Arial Black"),
  primaryColor: z.string().default("#FFFFFF"),
  accentColor: z.string().default("#FFE600"),
  backgroundColor: z.string().default("#000000"),
  textColor: z.string().default("#FFFFFF"),
});

export const TextPresetSchema = z.enum(["title", "subtitle", "heading", "body", "caption", "kicker", "big-number", "footer"]);

export const SceneTextSchema = z.object({
  text: z.string(),
  preset: TextPresetSchema.default("title"),
  position: PositionSchema.optional(),
  style: TextStyleSchema.partial().optional(),
  start: z.number().min(0).default(0).describe("Offset from scene start"),
  duration: z.number().positive().optional().describe("Defaults to the rest of the scene"),
  animationIn: AnimationSchema.optional(),
  animationOut: AnimationSchema.optional(),
});

export const SceneComponentSchema = z.object({
  component: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  start: z.number().min(0).default(0),
  duration: z.number().positive().optional(),
});

export const SceneOverlaySchema = z.object({
  media: z.string().describe("Placeholder for a media slot, e.g. {{broll}}"),
  position: PositionSchema.default({ x: 0.5, y: 0.5 }),
  size: z.object({ width: z.number().positive(), height: z.number().positive().optional() }).default({ width: 1 }),
  fit: FitSchema.default("cover"),
  start: z.number().min(0).default(0),
  duration: z.number().positive().optional(),
  opacity: z.number().min(0).max(1).default(1),
  effects: z.array(EffectSchema).default([]),
  animationIn: AnimationSchema.optional(),
  animationOut: AnimationSchema.optional(),
});

export const SceneBackgroundSchema = z.union([
  z.object({
    media: z.string().describe("Placeholder for a media slot: {{main}}, {{item.media}}, {{photos}}"),
    consume: z.boolean().default(false).describe("Continue from where the previous scene using this media stopped"),
    fit: FitSchema.optional(),
    muted: z.boolean().default(false),
    volume: z.number().default(1),
    speed: z.number().default(1),
  }),
  z.object({ color: z.string() }),
  z.object({ gradient: z.array(z.string()).min(2), direction: z.enum(["vertical", "horizontal", "diagonal"]).default("vertical") }),
]);

export const SceneSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string().describe("What this scene must achieve, guidance for the AI"),
  repeat: z.string().optional().describe("Repeat this scene once per item of the given list/media slot"),
  optional: z.boolean().default(false).describe("Skip when the slots it references are empty"),
  duration: z.number().positive().default(3),
  fitMedia: z.boolean().default(false).describe("Use the background media's natural length (capped by maxDuration)"),
  maxDuration: z.number().positive().optional(),
  durationFrom: z
    .string()
    .optional()
    .describe("Placeholder giving the scene length: a number ({{item.seconds}}) or media with a known duration ({{voiceover}})"),
  background: SceneBackgroundSchema.default({ color: "{{theme.backgroundColor}}" }),
  effects: z.array(EffectSchema).default([]),
  transition: TransitionSchema.nullable().optional().describe("Transition into this scene; null = hard cut; omitted = template default"),
  texts: z.array(SceneTextSchema).default([]),
  components: z.array(SceneComponentSchema).default([]),
  overlays: z.array(SceneOverlaySchema).default([]),
});

export const TemplateSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(["social", "youtube", "business", "education", "personal", "promo", "entertainment"]),
  tags: z.array(z.string()).default([]),
  platforms: z.array(z.string()).default([]),
  aspectRatio: aspect,
  fps: z.number().default(30),
  idealDuration: z.tuple([z.number(), z.number()]).describe("Recommended total length in seconds [min, max]"),
  aiGuidance: z.string().describe("How an AI should edit to match this template: pacing, cuts, tone"),
  slots: z.array(SlotSpecSchema),
  theme: ThemeSchema.default(ThemeSchema.parse({})),
  captions: z.object({ style: z.string(), overrides: z.record(z.string(), z.unknown()).optional() }).optional(),
  transition: TransitionSchema.optional().describe("Default transition between scenes"),
  grade: z.array(EffectSchema).default([]).describe("Global effects / color grade"),
  music: z
    .object({ slot: z.string(), volume: z.number().default(0.25), fadeIn: z.number().default(0.5), fadeOut: z.number().default(1.5), duck: z.boolean().default(true) })
    .optional(),
  voiceover: z.object({ slot: z.string(), volume: z.number().default(1) }).optional(),
  scenes: z.array(SceneSpecSchema).min(1),
});

export type SlotSpec = z.infer<typeof SlotSpecSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type SceneSpec = z.infer<typeof SceneSpecSchema>;
export type TemplateSpec = z.infer<typeof TemplateSpecSchema>;
export type TemplateSpecInput = z.input<typeof TemplateSpecSchema>;

/** A media input for a slot: a path, or a path with trim/metadata. */
export const MediaInputSchema = z.union([
  z.string(),
  z.object({
    src: z.string(),
    in: z.number().min(0).optional(),
    duration: z.number().positive().optional().describe("Seconds to use (or the media length if known)"),
    hasAudio: z.boolean().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    transcript: TranscriptSchema.optional().describe("Word-timed transcript (enables captions)"),
  }),
]);
export type MediaInput = z.infer<typeof MediaInputSchema>;

export type SlotValue = string | MediaInput | MediaInput[] | Record<string, unknown>[];
export type TemplateInputs = Record<string, SlotValue | undefined>;
