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
  svg: z.string().optional().describe("SVG source of an animated graphic drawn with create_graphic"),
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
  svg: z.string().optional().describe("SVG source of a graphic drawn with create_graphic"),
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

const range01 = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

/** What a mask selects, without modifiers. */
const maskSelection = {
  kind: z
    .enum(["person", "face", "object", "key", "luma", "shape"])
    .describe(
      "person = the person's cutout, face = soft ellipses following every face, object = a tracked object from select_object (all three found per frame; primary video clips only), key = an HSL qualifier on hue, saturation and luma ranges, luma = a brightness range only, shape = a fixed ellipse or rectangle",
    ),
  object: z.string().optional().describe("object: the id of a tracked object (project.objects, made with select_object)"),
  hue: z
    .tuple([z.number().min(0).max(360), z.number().min(0).max(360)])
    .optional()
    .describe("key: hue range in degrees, going clockwise from the first to the second, so [340, 20] selects reds. 0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 210 sky blue, 240 blue, 300 magenta; skin is about [5, 45]. Omit for any hue"),
  saturation: range01.optional().describe("key: saturation range 0..1 (HSV); [0.15, 1] skips grays, whose hue is unreliable. Omit for any"),
  luma: range01.optional().describe("key and luma: brightness range 0..1, e.g. [0.7, 1] for highlights, [0, 0.25] for shadows. Omit for any"),
  softness: z.number().min(0).max(1).default(0.2).describe("key and luma: how gradually the ranges fall off at their ends (0 = hard edge)"),
  shape: z
    .object({
      type: z.enum(["ellipse", "rect"]).default("ellipse"),
      x: z.number().min(0).max(1).describe("Center x as a frame fraction"),
      y: z.number().min(0).max(1).describe("Center y as a frame fraction"),
      width: z.number().positive().max(2).describe("Width as a fraction of frame width"),
      height: z.number().positive().max(2).describe("Height as a fraction of frame height"),
    })
    .optional()
    .describe("shape: the area, fixed for the whole clip"),
  invert: z.boolean().default(false).describe("Select everything except this"),
};

export const MaskPartSchema = z.object({
  ...maskSelection,
  op: z.enum(["add", "intersect", "subtract"]).describe("add = either mask, intersect = only where both select, subtract = the main mask minus this one"),
});

export const MaskSchema = z
  .object({
    ...maskSelection,
    feather: z.number().min(0).max(0.2).default(0.01).describe("Edge softness as a fraction of frame height (0.01 is subtle, 0.05 very soft)"),
    grow: z.number().min(-0.05).max(0.05).default(0).describe("Grow (+) or shrink (-) the selection by a fraction of frame height"),
    smooth: z.number().int().min(0).max(10).default(0).describe("Average the matte over this many frames to stop flicker (0 = off)"),
    denoise: z.boolean().default(false).describe("key and luma: clean speckles from noisy footage with a small median"),
    combine: z.array(MaskPartSchema).max(4).optional().describe("More masks merged into this one, in order, e.g. a key intersected with a shape"),
  })
  .describe("Limits an effect to part of the frame. Check it with render_mask before relying on it");

export const EffectSchema = z.object({
  type: z.string().min(1).describe("Effect id from the effects catalog, e.g. 'blur', 'kenBurns', 'cinematic'"),
  params: z.record(z.string(), z.unknown()).optional(),
  mask: MaskSchema.optional().describe("Apply the effect only where this mask selects (a grade on the sky, a glow on one object, sharpening on a face)"),
  label: z.string().optional().describe("Name of this effect, e.g. a secondary correction 'deeper sky'"),
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
    rotateX: z.array(keyframe(z.number().min(-3600).max(3600))).optional().describe("3D tilt in degrees over time (media and graphic layers): + tips the top away"),
    rotateY: z.array(keyframe(z.number().min(-3600).max(3600))).optional().describe("3D turn in degrees over time (media and graphic layers): + turns the right side away"),
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

export const BlendModeSchema = z
  .enum(["normal", "screen", "add", "multiply", "overlay", "softlight", "lighten", "darken", "colordodge", "difference"])
  .describe(
    "How the layer mixes with the picture under it. screen and add brighten (fire, sparks, light leaks and flares shot on black: the black disappears), multiply darkens (shadows, paper textures shot on white), overlay and softlight add contrast and texture, lighten and darken keep the brighter or darker pixel, colordodge burns in bright light, difference inverts where the layer is bright",
  );

export const FitSchema = z
  .enum(["cover", "contain", "stretch", "blur"])
  .describe("cover = fill & crop, contain = letterbox, stretch = distort, blur = contain over blurred copy");

export const TextStyleSchema = z.object({
  fontFamily: z.string().default("Arimo"),
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
  blend: BlendModeSchema.default("normal"),
  cornerRadius: z.number().min(0).default(0).describe("Rounded corners in output pixels (phone screens, screenshots, picture-in-picture)"),
  shadow: z.number().min(0).default(0).describe("Soft drop shadow in output pixels, lifts the overlay off the background"),
  rotateX: z.number().min(-89).max(89).default(0).describe("3D tilt in degrees: + tips the top away from the viewer"),
  rotateY: z.number().min(-89).max(89).default(0).describe("3D turn in degrees: + turns the right side away from the viewer"),
  perspective: z.number().min(0.5).max(20).default(2).describe("Camera distance in layer widths for 3D rotation: smaller is a stronger 3D look"),
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

/** A thing selected in a source video, followed through every clip of it (select_object). */
export const TrackedObjectSchema = z
  .object({
    assetId: id.describe("The video asset it is in"),
    time: time.describe("Source seconds of the frame it was selected on"),
    point: PositionSchema.optional().describe("A point on it (frame fractions)"),
    box: z
      .object({ x0: z.number().min(0).max(1), y0: z.number().min(0).max(1), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1) })
      .optional()
      .describe("A box around it (frame fractions); the most reliable prompt"),
    text: z.string().optional().describe("What it is, e.g. 'the red car'; found by a detector when no point or box is given"),
    label: z.string().optional(),
  })
  .refine((o) => o.point || o.box || o.text, "An object needs a point, a box or a text");

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
  customEffects: z
    .record(z.string(), z.object({ filter: z.string(), description: z.string().default("") }))
    .default({})
    .describe("Effects made with create_effect, by name: add one with the custom effect and its name"),
  audioEffects: audioEffects("the final mix (master)"),
  captions: CaptionsSchema.optional(),
  transcripts: z.record(z.string(), TranscriptSchema).default({}).describe("Transcripts keyed by asset id"),
  objects: z.record(z.string(), TrackedObjectSchema).default({}).describe("Tracked objects by id (select_object); masks use them with kind 'object'"),
  export: ExportSettingsSchema.default(ExportSettingsSchema.parse({})),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type Asset = z.infer<typeof AssetSchema>;
export type VideoAsset = z.infer<typeof VideoAssetSchema>;
export type AudioAsset = z.infer<typeof AudioAssetSchema>;
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Mask = z.infer<typeof MaskSchema>;
export type TrackedObject = z.infer<typeof TrackedObjectSchema>;
export type MaskPart = z.infer<typeof MaskPartSchema>;
export type BlendMode = z.infer<typeof BlendModeSchema>;
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
