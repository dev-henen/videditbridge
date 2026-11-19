import type { Animation, TextStyle } from "../../core/schema.js";

/**
 * Named looks for titles and on-screen words (add_text preset, add_beat_text): a font, colors,
 * outline and glow, a size relative to the frame, and how the words come in and go. Fonts are the
 * bundled open fonts, so titles look the same on every system.
 */
export interface TitleStyle {
  id: string;
  name: string;
  /** Read by Claude: what it looks like and what it suits. */
  description: string;
  style: Partial<TextStyle>;
  /** Font size as a share of the frame's shorter side. */
  size: number;
  animationIn: Animation;
  animationOut: Animation;
}

const anim = (type: string, duration: number): Animation => ({ type, duration }) as Animation;

export const TITLE_STYLES: TitleStyle[] = [
  {
    id: "neon",
    name: "Neon",
    description: "Tall condensed capitals in white with a hot pink outline and a soft pink glow, spaced wide. Night scenes, dance and music videos, club and city footage.",
    style: { fontFamily: "Anton", uppercase: true, color: "#FFFFFF", outlineColor: "#FF2E93", outlineWidth: 3, shadow: 8, shadowColor: "#FF2E93AA", letterSpacing: 4 },
    size: 0.11,
    animationIn: anim("blur", 0.35),
    animationOut: anim("fade", 0.3),
  },
  {
    id: "impact",
    name: "Impact",
    description: "Heavy black-letter capitals in white with a thick black outline, slammed in from above. Hype moments, drops, sports, reaction videos; reads on any picture.",
    style: { fontFamily: "Archivo Black", uppercase: true, color: "#FFFFFF", outlineColor: "#000000", outlineWidth: 6, shadow: 0 },
    size: 0.1,
    animationIn: anim("drop", 0.3),
    animationOut: anim("zoom", 0.2),
  },
  {
    id: "glitch",
    name: "Glitch",
    description: "Condensed capitals in white with a cyan outline and a magenta shadow offset like a split signal, stretched in. Tech, gaming, electronic music, fast edits.",
    style: { fontFamily: "Anton", uppercase: true, color: "#FFFFFF", outlineColor: "#00E5FF", outlineWidth: 2, shadow: 5, shadowColor: "#FF00AACC", letterSpacing: 2 },
    size: 0.1,
    animationIn: anim("stretch", 0.25),
    animationOut: anim("fade", 0.2),
  },
  {
    id: "clean",
    name: "Clean",
    description: "Plain bold sans in white with a light shadow, sliding up gently. Lifestyle, travel, tutorials and calm openers; quiet next to busy footage.",
    style: { fontFamily: "Arimo", bold: true, uppercase: false, color: "#FFFFFF", outlineWidth: 0, shadow: 3, shadowColor: "#00000099" },
    size: 0.07,
    animationIn: anim("slide-up", 0.35),
    animationOut: anim("fade", 0.3),
  },
  {
    id: "label",
    name: "Label",
    description: "Bold dark text on a white box, popping in. Callouts, names, prices and lists: always readable, looks like a sticker.",
    style: { fontFamily: "Arimo", bold: true, uppercase: false, color: "#111111", outlineWidth: 0, shadow: 0, background: "#FFFFFF" },
    size: 0.06,
    animationIn: anim("pop", 0.3),
    animationOut: anim("fade", 0.2),
  },
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Serif capitals in warm white, widely spaced, fading in slowly. Trailers, travel films, weddings and moody openers.",
    style: { fontFamily: "Gelasio", uppercase: true, bold: false, color: "#F4EDE4", outlineWidth: 0, shadow: 2, shadowColor: "#00000080", letterSpacing: 8 },
    size: 0.07,
    animationIn: anim("fade", 0.8),
    animationOut: anim("fade", 0.8),
  },
];

export function getTitleStyle(id: string): TitleStyle | undefined {
  return TITLE_STYLES.find((t) => t.id === id);
}

/** A title style's text style at a frame size, with `style` laid over it. */
export function titleStyleFor(t: TitleStyle, width: number, height: number, style: Partial<TextStyle> = {}): Partial<TextStyle> {
  return { ...t.style, fontSize: Math.round(Math.min(width, height) * t.size), ...style };
}
