import { z } from "zod";

/**
 * The Project document is the single source of truth for an edit.
 * It is plain JSON so an AI model can read it, reason about it and modify it.
 * All times are in seconds. Positions and sizes are normalized to the frame (0-1).
 */

export const SCHEMA_VERSION = 1;

const id = z.string().min(1);
const time = z.number().min(0);
const color = z
  .string()
  .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Color must be #RRGGBB or #RRGGBBAA");

export const ColorSchema = color;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const VideoAssetSchema = z.object({
  type: z.literal("video"),
  id,
  src: z.string().min(1).describe("Path or URL to the video file"),
  duration: z.number().positive().optional().describe("Source duration in seconds (filled by probe)"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hasAudio: z.boolean().optional().describe("Whether the file has an audio stream (filled by probe)"),
  label: z.string().optional(),
});

export const AudioAssetSchema = z.object({
  type: z.literal("audio"),
  id,
  src: z.string().min(1),
  duration: z.number().positive().optional(),
  label: z.string().optional(),
});

export const ImageAssetSchema = z.object({
  type: z.literal("image"),
  id,
  src: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  label: z.string().optional(),
});

export const ColorAssetSchema = z.object({
  type: z.literal("color"),
  id,
  color,
  label: z.string().optional(),
});

export const GradientAssetSchema = z.object({
  type: z.literal("gradient"),
  id,
  colors: z.array(color).min(2).max(8),
  direction: z.enum(["vertical", "horizontal", "diagonal"]).default("vertical"),
  label: z.string().optional(),
});

export const AssetSchema = z.discriminatedUnion("type", [
  VideoAssetSchema,
  AudioAssetSchema,
  ImageAssetSchema,
  ColorAssetSchema,
  GradientAssetSchema,
]);

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export const EasingSchema = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]);

export const EffectSchema = z.object({
  type: z.string().min(1).describe("Effect id from the effects catalog, e.g. 'blur', 'kenBurns', 'cinematic'"),
  params: z.record(z.string(), z.unknown()).optional(),
  keyframes: z
    .array(
      z.object({
        time: z.number().min(0).describe("Seconds from the start of the clip or layer (timeline seconds for global effects)"),
        params: z.record(z.string(), z.unknown()).describe("Settings that change, over the effect's params"),
        easing: EasingSchema.default("ease-in-out"),
      }),
    )
    .optional()
    .describe("Settings over time (a blur that ramps up, a grade that shifts). Before the first keyframe its settings hold, after the last its last"),
});

const audioEffects = (what: string) =>
  z
    .array(EffectSchema)
    .default([])
    .describe(`Audio effects applied to ${what}, in order (ids from the audio effects catalog, e.g. 'enhanceVoice', 'denoise')`);

export const TransitionSchema = z.object({
  type: z.string().min(1).describe("Transition id from the transitions catalog, e.g. 'fade', 'slideleft'"),
  duration: z.number().positive().max(5).default(0.5),
  origin: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .optional()
    .describe("Where shape transitions such as circlereveal start (frame fractions; default center)"),
});


export const AnimationSchema = z.object({
  type: z.string().min(1).describe("Animation id from the animations catalog, e.g. 'fade', 'pop', 'slide-up'"),
  duration: z.number().positive().max(10).default(0.4),
  easing: EasingSchema.default("ease-out"),
});

export const PositionSchema = z.object({
  x: z.number().describe("Horizontal center, 0 = left edge, 1 = right edge"),
  y: z.number().describe("Vertical center, 0 = top edge, 1 = bottom edge"),
});

/** A value at a moment, reached from the previous keyframe with `easing`. */
export const keyframe = <T extends z.ZodType>(value: T) =>
  z.object({
    time: z.number().min(0).describe("Seconds from the start of the layer or clip"),
    value,
    easing: EasingSchema.default("ease-in-out").describe("How the value moves into this keyframe from the previous one"),
  });

export const LayerKeyframesSchema = z
  .object({
    position: z.array(keyframe(PositionSchema)).optional().describe("Center over time (frame fractions); replaces position while set"),
    scale: z.array(keyframe(z.number().positive().max(20))).optional().describe("Size multiplier over time (1 = the layer's own size)"),
    rotation: z.array(keyframe(z.number().min(-3600).max(3600))).optional().describe("Degrees clockwise over time"),
    opacity: z.array(keyframe(z.number().min(0).max(1))).optional().describe("Multiplies the layer's opacity over time"),
  })
  .describe("Properties that change over time. Before the first keyframe a property holds its first value, after the last its last value");

export const ClipKeyframesSchema = z
  .object({
    focus: z.array(keyframe(PositionSchema)).optional().describe("Crop focus over time for fit cover, so the crop can follow a person"),
    speed: z
      .array(keyframe(z.number().min(0.25).max(4)))
      .optional()
      .describe("Speed ramp: playback speed over the clip's footage. Times here are seconds of SOURCE footage from the clip's in point. Replaces speed while set"),
  })
  .describe("Clip properties that change over time (times from the clip's start on the timeline)");

export const FitSchema = z
  .enum(["cover", "contain", "stretch", "blur"])
  .describe("cover = fill & crop, contain = letterbox, stretch = distort, blur = contain over blurred copy");

export const TextStyleSchema = z.object({
  fontFamily: z.string().default("Arial"),
  fontSize: z.number().positive().default(64).describe("Font size in output pixels"),
  color: color.default("#FFFFFF"),
  bold: z.boolean().default(true),
  italic: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  outlineColor: color.default("#000000"),
  outlineWidth: z.number().min(0).default(3),
  shadow: z.number().min(0).default(0),
  shadowColor: color.default("#00000080"),
  background: color.optional().describe("Opaque box behind the text"),
  align: z.enum(["left", "center", "right"]).default("center"),
  letterSpacing: z.number().default(0),
});

// ---------------------------------------------------------------------------
// Clips & layers
// ---------------------------------------------------------------------------

export const ClipSchema = z.object({
  id,
  assetId: id,
  in: time.default(0).describe("Start offset into the source (seconds)"),
  duration: z
    .number()
    .positive()
    .optional()
    .describe("Source duration to use (seconds). Required for image/color/gradient assets; defaults to rest of source for video"),
  speed: z.number().min(0.25).max(4).default(1),
  reverse: z.boolean().optional().describe("Play the clip backwards (picture and sound; no captions for it). Keep reversed clips short, under ~20s"),
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  audioEffects: audioEffects("this clip's audio"),
  audioLead: z
    .number()
    .min(0)
    .optional()
    .describe("J cut: this clip's sound starts this many seconds before its picture, under the end of the previous clip (whose sound is muted there)"),
  audioTail: z
    .number()
    .min(0)
    .optional()
    .describe("L cut: this clip's sound carries on this many seconds past its picture, under the start of the next clip (whose sound is muted there)"),
  fit: FitSchema.default("cover"),
  focus: PositionSchema.optional().describe("With fit cover: where to crop when the source does not fit (x: 0 keeps the left edge, 1 the right edge; y: 0 top, 1 bottom; default center). Use it to keep the subject when reframing 16:9 to 9:16"),
  effects: z.array(EffectSchema).default([]),
  transition: TransitionSchema.optional().describe("Transition INTO this clip from the previous clip"),
  fadeIn: z.number().min(0).optional().describe("Fade from black at clip start (seconds)"),
  fadeOut: z.number().min(0).optional().describe("Fade to black at clip end (seconds)"),
  keyframes: ClipKeyframesSchema.optional(),
  label: z.string().optional(),
});

const layerBase = {
  id,
  start: time.describe("Timeline start (seconds)"),
  duration: z.number().positive(),
  animationIn: AnimationSchema.optional(),
  animationOut: AnimationSchema.optional(),
  keyframes: LayerKeyframesSchema.optional(),
  label: z.string().optional(),
};

export const MediaLayerSchema = z.object({
  ...layerBase,
  type: z.literal("media"),
  assetId: id,
  in: time.default(0),
  position: PositionSchema.default({ x: 0.5, y: 0.5 }),
  size: z
    .object({
      width: z.number().positive().describe("Width as a fraction of frame width"),
      height: z.number().positive().optional().describe("Height as a fraction of frame height; omit to keep aspect"),
    })
    .default({ width: 1 }),
  fit: FitSchema.default("cover"),
  opacity: z.number().min(0).max(1).default(1),
  cornerRadius: z.number().min(0).default(0).describe("Rounded corners in output pixels (phone screens, screenshots, picture-in-picture)"),
  shadow: z.number().min(0).default(0).describe("Soft drop shadow in output pixels, lifts the overlay off the background"),
  volume: z.number().min(0).max(4).default(0).describe("Overlay audio volume (0 = muted)"),
  audioEffects: audioEffects("the overlay's audio"),
  effects: z.array(EffectSchema).default([]),
});

export const TextLayerSchema = z.object({
  ...layerBase,
  type: z.literal("text"),
  text: z.string(),
  position: PositionSchema.default({ x: 0.5, y: 0.5 }),
  style: TextStyleSchema.default(TextStyleSchema.parse({})),
});

export const ShapeLayerSchema = z.object({
  ...layerBase,
  type: z.literal("shape"),
  shape: z
    .enum(["rect", "roundedRect", "ellipse"])
    .default("rect")
    .describe("rect, roundedRect (pills, cards, highlight boxes) or ellipse (circles, badges, spotlights)"),
  position: PositionSchema.default({ x: 0.5, y: 0.5 }),
  size: z.object({ width: z.number().positive(), height: z.number().positive() }),
  color: color.default("#000000"),
  opacity: z.number().min(0).max(1).default(1),
  radius: z.number().min(0).default(24).describe("roundedRect corner radius in output pixels (half the height makes a pill)"),
  fill: z.boolean().default(true).describe("false draws only the outline (highlight boxes, rings)"),
  strokeWidth: z.number().min(0).default(0).describe("Outline width in output pixels"),
  strokeColor: color.default("#FFFFFF"),
  shadow: z.number().min(0).default(0).describe("Soft drop shadow distance in output pixels"),
});

export const LayerSchema = z.discriminatedUnion("type", [MediaLayerSchema, TextLayerSchema, ShapeLayerSchema]);

export const AudioClipSchema = z.object({
  id,
  assetId: id,
  role: z.enum(["music", "voiceover", "sfx"]).default("music"),
  start: time.default(0).describe("Timeline start (seconds)"),
  in: time.default(0),
  duration: z.number().positive().optional().describe("Timeline seconds. Defaults to the rest of the source (or the video length if loop)"),
  speed: z.number().min(0.25).max(4).default(1).describe("Playback speed; pitch is preserved"),
  volume: z.number().min(0).max(4).default(1),
  audioEffects: audioEffects("this audio clip"),
  fadeIn: z.number().min(0).default(0),
  fadeOut: z.number().min(0).default(0),
  loop: z.boolean().default(false),
  duck: z.boolean().optional().describe("Music only: lower volume while someone speaks (default true for music)"),
  label: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Transcripts & captions
// ---------------------------------------------------------------------------

export const WordSchema = z.object({
  text: z.string(),
  start: time,
  end: time,
  confidence: z.number().min(0).max(1).optional(),
  speaker: z.string().optional(),
});

export const TranscriptSchema = z.object({
  language: z.string().optional(),
  words: z.array(WordSchema),
  /** True when word timings were estimated (e.g. from SRT cues) rather than measured. */
  estimated: z.boolean().optional(),
});

export const CaptionSegmentSchema = z.object({ text: z.string(), start: time, end: time });

export const CaptionsSchema = z.object({
  enabled: z.boolean().default(true),
  style: z.string().default("classic").describe("Caption style preset id from the caption styles catalog"),
  overrides: z.record(z.string(), z.unknown()).optional().describe("Partial caption style overrides"),
  segments: z
    .array(CaptionSegmentSchema)
    .optional()
    .describe("Manual caption segments on the timeline; when omitted captions come from asset transcripts"),
});

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const SettingsSchema = z.object({
  width: z.number().int().min(16).max(7680).default(1080),
  height: z.number().int().min(16).max(7680).default(1920),
  fps: z.number().positive().max(120).default(30),
  backgroundColor: color.default("#000000"),
  sampleRate: z.number().int().default(48000),
});

export const ExportSettingsSchema = z.object({
  videoCodec: z.string().default("libx264"),
  crf: z.number().int().min(0).max(51).default(20),
  preset: z.string().default("medium"),
  audioCodec: z.string().default("aac"),
  audioBitrate: z.string().default("192k"),
});

export const ProjectSchema = z.object({
  version: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: id.default("project"),
  name: z.string().default("Untitled"),
  settings: SettingsSchema.default(SettingsSchema.parse({})),
  assets: z.array(AssetSchema).default([]),
  clips: z.array(ClipSchema).default([]).describe("Primary track: clips play back-to-back in order"),
  layers: z.array(LayerSchema).default([]).describe("Overlays drawn on top of the primary track, in array order"),
  audio: z.array(AudioClipSchema).default([]),
  effects: z.array(EffectSchema).default([]).describe("Global effects applied to the composed primary track"),
  audioEffects: audioEffects("the final mix (master)"),
  captions: CaptionsSchema.optional(),
  transcripts: z.record(z.string(), TranscriptSchema).default({}).describe("Transcripts keyed by asset id"),
  export: ExportSettingsSchema.default(ExportSettingsSchema.parse({})),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type Asset = z.infer<typeof AssetSchema>;
export type VideoAsset = z.infer<typeof VideoAssetSchema>;
export type AudioAsset = z.infer<typeof AudioAssetSchema>;
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type Easing = z.infer<typeof EasingSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type LayerKeyframes = z.infer<typeof LayerKeyframesSchema>;
export type ClipKeyframes = z.infer<typeof ClipKeyframesSchema>;
export type Keyframe<T> = { time: number; value: T; easing: Easing };
export type Fit = z.infer<typeof FitSchema>;
export type TextStyle = z.infer<typeof TextStyleSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type MediaLayer = z.infer<typeof MediaLayerSchema>;
export type TextLayer = z.infer<typeof TextLayerSchema>;
export type ShapeLayer = z.infer<typeof ShapeLayerSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type Word = z.infer<typeof WordSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;

/** Parse and fill defaults. Throws a ZodError on invalid input. */
export function parseProject(input: unknown): Project {
  return ProjectSchema.parse(input);
}

/** JSON Schema of the project document, useful for giving to an AI model. */
export function projectJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProjectSchema, { io: "input" }) as Record<string, unknown>;
}
