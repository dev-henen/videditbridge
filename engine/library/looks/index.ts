/**
 * Look presets (docs/design/cinematic-grade-and-vfx.md, section 4.4): a primary grade combined with
 * film look effects, as data. apply_look puts them on a clip, a layer or the whole video, labeled
 * so the next look replaces them, after the edit's own grade. Names describe a character; no film
 * stock or film title is claimed.
 */

import type { Effect } from "../../core/schema.js";
import type { ColorSettings } from "../effects/color.js";

export interface LookPreset {
  id: string;
  name: string;
  /** For Claude: what it looks like and when to use it. */
  description: string;
  /** The look's grade (the color panel's settings), on the picture after the edit's own grade. */
  color?: ColorSettings;
  /** Film look effects after it, in order. */
  effects: { type: string; params?: Record<string, unknown> }[];
}

export const LOOKS: LookPreset[] = [
  {
    id: "blockbuster",
    name: "Teal and orange blockbuster",
    description: "Warm skin against teal shadows and backgrounds, punchy contrast, a print-like curve and fine grain: the big action and adventure look. Best with people in the frame; heavy on scenes without skin.",
    color: { contrast: 18, saturation: 8, wheels: { shadows: { hue: 190, amount: 35 }, highlights: { hue: 30, amount: 25 } } },
    effects: [
      { type: "printFilm", params: { strength: 0.6, warmth: 0.6 } },
      { type: "halation", params: { strength: 0.3 } },
      { type: "filmGrain", params: { amount: 15, stock: "fine" } },
    ],
  },
  {
    id: "warm-70s-print",
    name: "Warm 70s print",
    description: "Faded, warm and soft: lifted blacks, golden highlights, coarse grain, glowing highlights and a slight gate weave, like a projected print from the seventies. For nostalgia, memories, travel and music videos.",
    color: { temperature: 22, saturation: -12, fade: 18 },
    effects: [
      { type: "printFilm", params: { strength: 1, warmth: 0.85 } },
      { type: "halation", params: { strength: 0.5 } },
      { type: "filmGrain", params: { amount: 35, stock: "coarse" } },
      { type: "gateWeave", params: { amount: 0.7 } },
    ],
  },
  {
    id: "cold-thriller",
    name: "Cold thriller",
    description: "Cool, desaturated and contrasty, with green-teal shadows: tension, crime, sci-fi and night interiors. Skin goes pale; avoid for warm or friendly content.",
    color: { temperature: -25, tint: -6, saturation: -25, contrast: 22, wheels: { shadows: { hue: 165, amount: 30 } } },
    effects: [{ type: "filmGrain", params: { amount: 20, stock: "medium" } }],
  },
  {
    id: "bleach-bypass",
    name: "Bleach bypass",
    description: "Silvery, low saturation and hard contrast, as when the bleach step is skipped in film processing: gritty war, drama and sports. Strong; lower the strength for a hint of it.",
    color: { saturation: -55, contrast: 35, blacks: -10 },
    effects: [
      { type: "printFilm", params: { strength: 0.5, warmth: 0.2 } },
      { type: "filmGrain", params: { amount: 25, stock: "medium" } },
    ],
  },
  {
    id: "dreamy",
    name: "Dreamy glow",
    description: "Soft, bright and warm, with glowing highlights and gentle contrast: weddings, romance, beauty and slow, peaceful moments.",
    color: { contrast: -12, fade: 12, temperature: 10, saturation: -5 },
    effects: [
      { type: "bloom", params: { strength: 0.5 } },
      { type: "halation", params: { strength: 0.2 } },
    ],
  },
  {
    id: "night-anamorphic",
    name: "Anamorphic night",
    description: "Cool night with horizontal blue streaks through the lights and medium grain: city streets, cars and neon. Needs bright points of light in the frame to show its streaks.",
    color: { temperature: -15, contrast: 15, saturation: 5 },
    effects: [
      { type: "anamorphicFlare", params: { strength: 0.7 } },
      { type: "filmGrain", params: { amount: 20, stock: "medium" } },
    ],
  },
];

export function getLook(id: string): LookPreset | undefined {
  return LOOKS.find((l) => l.id === id);
}

/** Numbers that scale with a look's strength: the color panel's sliders and the effects' strengths. */
const STRENGTH_KEYS = new Set(["strength", "amount"]);

function scaleColor(c: ColorSettings, k: number): ColorSettings {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(c)) {
    if (typeof v === "number") out[key] = Math.round(v * k * 100) / 100;
    else if (key === "wheels" && v) out[key] = Object.fromEntries(Object.entries(v as Record<string, { hue: number; amount: number }>).map(([zone, w]) => [zone, { hue: w.hue, amount: Math.round(w.amount * k) }]));
    else out[key] = v;
  }
  return out as ColorSettings;
}

/** A look as effects at a strength (0..1), labeled as the look's. */
export function lookEffects(look: LookPreset, strength = 1, label = "look"): Effect[] {
  const k = Math.min(1, Math.max(0, strength));
  const effects: Effect[] = [];
  if (look.color) effects.push({ type: "color", params: scaleColor(look.color, k) as Record<string, unknown>, label } as Effect);
  for (const e of look.effects) {
    const params = Object.fromEntries(Object.entries(e.params ?? {}).map(([key, v]) => [key, STRENGTH_KEYS.has(key) && typeof v === "number" ? Math.round(v * k * 100) / 100 : v]));
    effects.push({ type: e.type, params, label } as Effect);
  }
  return effects;
}
