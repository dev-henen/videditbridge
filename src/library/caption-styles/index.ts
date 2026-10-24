import { z } from "zod";
import { ColorSchema } from "../../core/schema.js";

export const CaptionModeSchema = z
  .enum(["static", "highlight", "karaoke", "word", "reveal"])
  .describe(
    "static = whole phrase; highlight = phrase with the spoken word colored; karaoke = color sweeps across words; word = one word at a time; reveal = words appear as spoken",
  );

export const CaptionStyleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  mode: CaptionModeSchema.default("static"),
  fontFamily: z.string().default("Arial"),
  /** Size at a 1080px short side; scaled to the actual resolution. */
  fontSize: z.number().positive().default(64),
  bold: z.boolean().default(true),
  italic: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  color: ColorSchema.default("#FFFFFF"),
  highlightColor: ColorSchema.default("#FFE600"),
  outlineColor: ColorSchema.default("#000000"),
  outlineWidth: z.number().min(0).default(4),
  shadow: z.number().min(0).default(0),
  shadowColor: ColorSchema.default("#00000099"),
  background: ColorSchema.optional().describe("Box color behind captions"),
  /** Scale of the active word in highlight/word modes. */
  highlightScale: z.number().min(1).max(2).default(1),
  animation: z.enum(["none", "pop", "fade", "slide-up", "zoom"]).default("none"),
  /** Vertical center of the caption block (0 = top, 1 = bottom). */
  position: z.number().min(0).max(1).default(0.78),
  maxWordsPerLine: z.number().int().positive().default(4),
  maxCharsPerLine: z.number().int().positive().default(24),
  maxLines: z.number().int().positive().default(2),
  /** Break the phrase after this many seconds. */
  maxDuration: z.number().positive().default(3),
  letterSpacing: z.number().default(0),
});

export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;
export type CaptionStyleInput = z.input<typeof CaptionStyleSchema>;

const preset = (s: CaptionStyleInput): CaptionStyle => CaptionStyleSchema.parse(s);

export const CAPTION_STYLES: CaptionStyle[] = [
  preset({
    id: "classic",
    name: "Classic Subtitles",
    description: "Clean white subtitles with a thin outline at the bottom. Works everywhere (YouTube, interviews, docs).",
    mode: "static",
    fontSize: 52,
    bold: false,
    outlineWidth: 2.5,
    shadow: 1,
    position: 0.86,
    maxWordsPerLine: 8,
    maxCharsPerLine: 42,
    maxLines: 2,
    maxDuration: 4,
  }),
  preset({
    id: "bold-pop",
    name: "Bold Pop (Hormozi style)",
    description:
      "Big uppercase heavy words, thick outline, spoken word highlighted in yellow and scaled up. The viral short-form look.",
    mode: "highlight",
    fontFamily: "Arial Black",
    fontSize: 82,
    uppercase: true,
    outlineWidth: 6,
    shadow: 2,
    highlightColor: "#FFE600",
    highlightScale: 1.15,
    animation: "pop",
    position: 0.7,
    maxWordsPerLine: 3,
    maxCharsPerLine: 16,
    maxLines: 2,
    maxDuration: 1.8,
  }),
  preset({
    id: "green-highlight",
    name: "Green Highlight",
    description: "Uppercase captions where the active word turns bright green. High-energy social style.",
    mode: "highlight",
    fontFamily: "Arial Black",
    fontSize: 76,
    uppercase: true,
    outlineWidth: 5,
    highlightColor: "#39FF14",
    highlightScale: 1.1,
    animation: "pop",
    position: 0.72,
    maxWordsPerLine: 3,
    maxCharsPerLine: 16,
    maxDuration: 2,
  }),
  preset({
    id: "karaoke",
    name: "Karaoke Sweep",
    description: "Color fills each word as it is spoken. Great for music, lyrics and tutorials.",
    mode: "karaoke",
    fontSize: 68,
    color: "#FFFFFF",
    highlightColor: "#00D1FF",
    outlineWidth: 4,
    position: 0.8,
    maxWordsPerLine: 5,
    maxCharsPerLine: 28,
    maxDuration: 3,
  }),
  preset({
    id: "word-by-word",
    name: "Word by Word",
    description: "One big word at a time in the center of the screen. Punchy, fast-paced, retention-focused.",
    mode: "word",
    fontFamily: "Impact",
    fontSize: 120,
    uppercase: true,
    bold: false,
    outlineWidth: 6,
    highlightScale: 1.0,
    animation: "pop",
    position: 0.5,
    maxWordsPerLine: 1,
    maxLines: 1,
  }),
  preset({
    id: "reveal",
    name: "Progressive Reveal",
    description: "Words appear one by one as they are spoken while the phrase builds up.",
    mode: "reveal",
    fontSize: 70,
    outlineWidth: 4,
    position: 0.75,
    maxWordsPerLine: 4,
    maxDuration: 2.5,
  }),
  preset({
    id: "boxed",
    name: "Boxed",
    description: "Text on a solid dark box. Highly legible over busy footage; news/explainer feel.",
    mode: "static",
    fontSize: 58,
    background: "#000000CC",
    outlineWidth: 10,
    position: 0.82,
    maxWordsPerLine: 6,
    maxCharsPerLine: 32,
    maxDuration: 3,
  }),
  preset({
    id: "boxed-highlight",
    name: "Boxed Highlight",
    description: "White box with black text and the active word in brand color. Clean, modern, LinkedIn-friendly.",
    mode: "highlight",
    fontSize: 60,
    color: "#111111",
    highlightColor: "#6C47FF",
    background: "#FFFFFFF2",
    outlineWidth: 12,
    position: 0.8,
    maxWordsPerLine: 5,
    maxCharsPerLine: 26,
    maxDuration: 2.5,
  }),
  preset({
    id: "minimal",
    name: "Minimal",
    description: "Small, light, lowercase-friendly captions with a soft shadow. Aesthetic vlogs and lifestyle.",
    mode: "static",
    fontSize: 46,
    bold: false,
    outlineWidth: 0,
    shadow: 2,
    shadowColor: "#000000AA",
    position: 0.85,
    maxWordsPerLine: 7,
    maxCharsPerLine: 36,
    maxDuration: 3.5,
  }),
  preset({
    id: "neon",
    name: "Neon Glow",
    description: "Bright cyan text with a glowing magenta outline. Gaming, nightlife, tech.",
    mode: "highlight",
    fontSize: 72,
    uppercase: true,
    color: "#E0FFFF",
    highlightColor: "#00FFFF",
    outlineColor: "#FF00FF",
    outlineWidth: 3,
    shadow: 4,
    shadowColor: "#FF00FF88",
    highlightScale: 1.08,
    animation: "fade",
    position: 0.75,
    maxWordsPerLine: 3,
    maxDuration: 2,
  }),
  preset({
    id: "cinematic",
    name: "Cinematic",
    description: "Elegant serif italics, small and low. Documentaries, film, storytelling.",
    mode: "static",
    fontFamily: "Georgia",
    fontSize: 46,
    bold: false,
    italic: true,
    outlineWidth: 1,
    shadow: 2,
    animation: "fade",
    position: 0.88,
    maxWordsPerLine: 9,
    maxCharsPerLine: 48,
    maxLines: 2,
    maxDuration: 4.5,
  }),
  preset({
    id: "comic",
    name: "Comic",
    description: "Chunky yellow text with heavy black outline. Memes, comedy, kids content.",
    mode: "highlight",
    fontFamily: "Comic Sans MS",
    fontSize: 78,
    color: "#FFE600",
    highlightColor: "#FF3B30",
    outlineWidth: 6,
    highlightScale: 1.2,
    animation: "pop",
    position: 0.72,
    maxWordsPerLine: 3,
    maxDuration: 2,
  }),
  preset({
    id: "subtle-highlight",
    name: "Subtle Highlight",
    description: "Sentence-case captions with the active word in soft yellow. Professional talking heads and courses.",
    mode: "highlight",
    fontSize: 60,
    outlineWidth: 3,
    shadow: 1,
    highlightColor: "#FFD54A",
    position: 0.8,
    maxWordsPerLine: 5,
    maxCharsPerLine: 30,
    maxDuration: 2.8,
  }),
  preset({
    id: "typewriter",
    name: "Typewriter Mono",
    description: "Monospace words revealed as spoken on a dark box. Tech, coding, hacker aesthetic.",
    mode: "reveal",
    fontFamily: "Courier New",
    fontSize: 56,
    color: "#00FF88",
    background: "#000000DD",
    outlineWidth: 10,
    position: 0.8,
    maxWordsPerLine: 5,
    maxCharsPerLine: 28,
  }),
];

const byId = new Map(CAPTION_STYLES.map((s) => [s.id, s]));

export function getCaptionStyle(id: string): CaptionStyle | undefined {
  return byId.get(id);
}

export function listCaptionStyles(): CaptionStyle[] {
  return CAPTION_STYLES;
}

/** Resolve a preset id plus partial overrides into a full style. */
export function resolveCaptionStyle(id: string, overrides?: Record<string, unknown>): CaptionStyle {
  const base = getCaptionStyle(id);
  if (!base) throw new Error(`Unknown caption style "${id}". Available: ${CAPTION_STYLES.map((s) => s.id).join(", ")}`);
  return overrides ? CaptionStyleSchema.parse({ ...base, ...overrides, id: base.id }) : base;
}

export function registerCaptionStyle(style: CaptionStyleInput): CaptionStyle {
  const parsed = CaptionStyleSchema.parse(style);
  if (byId.has(parsed.id)) throw new Error(`Caption style "${parsed.id}" already registered`);
  CAPTION_STYLES.push(parsed);
  byId.set(parsed.id, parsed);
  return parsed;
}
