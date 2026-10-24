import { z } from "zod";
import { clamp, round3 } from "../../core/util.js";

/**
 * Lightroom-style color controls compiled to FFmpeg filters.
 * Slider values use familiar ranges: most are -100..100 with 0 = unchanged.
 */

const slider = (desc: string, min = -100, max = 100) => z.number().min(min).max(max).optional().describe(desc);

export const HSL_RANGES = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type HslRange = (typeof HSL_RANGES)[number];

/** huesaturation color flags for each named range. */
const HSL_FLAGS: Record<HslRange, string> = {
  red: "r",
  orange: "r+y",
  yellow: "y",
  green: "g",
  aqua: "c",
  blue: "b",
  purple: "b+m",
  magenta: "m",
};

const HslAdjustSchema = z.object({
  hue: slider("Shift this color's hue (-100..100 = about -60°..+60°)"),
  saturation: slider("More or less saturated"),
  luminance: slider("Brighter or darker"),
});

const CurvePointsSchema = z
  .array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]))
  .min(2)
  .describe("Curve points [input, output] in 0..1, e.g. [[0,0],[0.25,0.2],[0.75,0.8],[1,1]] for an S-curve");

const WheelSchema = z.object({
  hue: z.number().min(0).max(360).describe("Tint direction in degrees: 0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 210 teal-blue, 240 blue, 300 magenta"),
  amount: z.number().min(0).max(100).describe("Tint strength 0..100"),
});

export const ColorSettingsSchema = z.object({
  // Light
  exposure: z.number().min(-3).max(3).optional().describe("Exposure in stops (-3..3)"),
  brightness: slider("Overall brightness"),
  contrast: slider("Contrast"),
  highlights: slider("Recover (−) or boost (+) bright areas"),
  shadows: slider("Lift (+) or deepen (−) dark areas"),
  whites: slider("Set the white point: + brighter whites, − pull whites down"),
  blacks: slider("Set the black point: + lifted blacks, − crushed blacks"),
  brilliance: slider("Balance the image: + brightens shadows and tames highlights, − adds punch"),
  // Color
  temperature: slider("White balance: − cooler/blue, + warmer/yellow"),
  tint: slider("White balance: − greener, + more magenta"),
  hue: z.number().min(-180).max(180).optional().describe("Rotate all hues in degrees"),
  saturation: slider("Saturation of all colors (−100 = black & white)"),
  vibrance: slider("Smart saturation: boosts muted colors more than already-saturated ones and protects skin"),
  hsl: z
    .object(Object.fromEntries(HSL_RANGES.map((r) => [r, HslAdjustSchema.optional()])) as Record<HslRange, z.ZodOptional<typeof HslAdjustSchema>>)
    .optional()
    .describe("Per-color hue/saturation/luminance, e.g. {blue: {saturation: 30}, orange: {luminance: 10}}"),
  // Grading
  curves: z
    .object({
      master: CurvePointsSchema.optional(),
      red: CurvePointsSchema.optional(),
      green: CurvePointsSchema.optional(),
      blue: CurvePointsSchema.optional(),
      preset: z
        .enum(["increase_contrast", "medium_contrast", "strong_contrast", "linear_contrast", "lighter", "darker", "vintage", "cross_process", "color_negative", "negative"])
        .optional()
        .describe("Built-in curve shape (applied before custom points)"),
    })
    .optional()
    .describe("Tone curves (the graph): a master curve plus per-channel R/G/B curves"),
  wheels: z
    .object({ shadows: WheelSchema.optional(), midtones: WheelSchema.optional(), highlights: WheelSchema.optional() })
    .optional()
    .describe("Color wheels for grading: tint shadows, midtones and highlights separately (e.g. teal shadows + orange highlights)"),
  // Finish
  fade: slider("Matte/faded film look: lifts blacks and softens contrast", 0, 100),
  clarity: slider("Local contrast: + crisp and textured, − soft and dreamy"),
  sharpen: slider("Edge sharpening", 0, 100),
  vignette: slider("Edge darkening (+) or lightening (−)"),
  grain: slider("Film grain amount", 0, 100),
  autoCorrect: z.boolean().optional().describe("Automatic levels and white balance before other adjustments"),
});

export type ColorSettings = z.infer<typeof ColorSettingsSchema>;

const n = (v: number | undefined) => (v === undefined ? 0 : v / 100);
const fmt = (v: number) => round3(v).toString();

/** Merge partial settings into existing ones; nested groups merge per key, `null` removes a field. */
export function mergeColorSettings(base: ColorSettings, patch: Record<string, unknown>): ColorSettings {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if ((key === "hsl" || key === "curves" || key === "wheels") && typeof value === "object" && !Array.isArray(value)) {
      const merged: Record<string, unknown> = { ...((out[key] as object) ?? {}) };
      for (const [k, v] of Object.entries(value as object)) {
        if (v === null) delete merged[k];
        else if (key === "hsl" && typeof v === "object") merged[k] = { ...((merged[k] as object) ?? {}), ...v };
        else merged[k] = v;
      }
      if (Object.keys(merged).length) out[key] = merged;
      else delete out[key];
    } else out[key] = value;
  }
  return ColorSettingsSchema.parse(out);
}

/** Tone curve points from the light sliders (blacks, shadows, highlights, whites, brilliance). */
function toneCurve(s: ColorSettings): string | undefined {
  const blacks = n(s.blacks);
  const shadows = n(s.shadows) + n(s.brilliance) * 0.6;
  const highlights = n(s.highlights) - n(s.brilliance) * 0.5;
  const whites = n(s.whites);
  if (!blacks && !shadows && !highlights && !whites) return undefined;
  const pts: [number, number][] = [];
  pts.push(blacks >= 0 ? [0, 0.15 * blacks] : [-0.12 * blacks, 0]);
  pts.push([0.25, clamp(0.25 + 0.15 * shadows, 0.02, 0.6)]);
  pts.push([0.5, clamp(0.5 + 0.04 * (shadows + highlights), 0.3, 0.7)]);
  pts.push([0.75, clamp(0.75 + 0.15 * highlights, 0.4, 0.98)]);
  pts.push(whites >= 0 ? [1 - 0.12 * whites, 1] : [1, 1 + 0.15 * whites]);
  return pts.map(([x, y]) => `${fmt(x)}/${fmt(y)}`).join(" ");
}

const curveArg = (pts?: [number, number][]) =>
  pts ? `'${[...pts].sort((a, b) => a[0] - b[0]).map(([x, y]) => `${fmt(x)}/${fmt(y)}`).join(" ")}'` : undefined;

/** RGB offsets for a color wheel hue. */
function wheelRgb(hueDeg: number, amount: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const k = (amount / 100) * 0.35;
  return [k * Math.cos(h), k * Math.cos(h - (2 * Math.PI) / 3), k * Math.cos(h - (4 * Math.PI) / 3)];
}

/** Compile color settings to a comma-separated FFmpeg filter chain (empty string when neutral). */
export function colorFilter(s: ColorSettings): string {
  const f: string[] = [];

  if (s.autoCorrect) f.push("normalize=smoothing=24:independence=0.6:strength=0.8");
  // exposure works in float; clip back to 8-bit range so later filters never see values above white.
  if (s.exposure) f.push(`exposure=exposure=${fmt(s.exposure)}`, "format=gbrp");

  // White balance: temperature as blue<->yellow, tint as green<->magenta, mostly in midtones.
  const t = n(s.temperature);
  const tint = n(s.tint);
  if (t || tint) {
    const r = 0.18 * t + 0.08 * tint;
    const g = -0.16 * tint;
    const b = -0.2 * t + 0.08 * tint;
    f.push(`colorbalance=rs=${fmt(r * 0.6)}:gs=${fmt(g * 0.6)}:bs=${fmt(b * 0.6)}:rm=${fmt(r)}:gm=${fmt(g)}:bm=${fmt(b)}:rh=${fmt(r * 0.5)}:gh=${fmt(g * 0.5)}:bh=${fmt(b * 0.5)}`);
  }

  const tone = toneCurve(s);
  if (tone) f.push(`curves=master='${tone}'`);

  const brightness = n(s.brightness) * 0.25;
  const contrast = 1 + n(s.contrast) * (n(s.contrast) > 0 ? 0.6 : 0.5);
  const saturation = 1 + n(s.saturation) + n(s.brilliance) * 0.08;
  if (brightness || contrast !== 1 || saturation !== 1)
    f.push(`eq=brightness=${fmt(brightness)}:contrast=${fmt(contrast)}:saturation=${fmt(Math.max(0, saturation))}`);

  if (s.vibrance) f.push(`vibrance=intensity=${fmt(n(s.vibrance) * 1.2)}`);
  if (s.hue) f.push(`hue=h=${fmt(s.hue)}`);

  for (const range of HSL_RANGES) {
    const adj = s.hsl?.[range];
    if (!adj || (!adj.hue && !adj.saturation && !adj.luminance)) continue;
    f.push(
      `huesaturation=hue=${fmt(n(adj.hue) * 60)}:saturation=${fmt(clamp(n(adj.saturation), -1, 1))}:intensity=${fmt(clamp(n(adj.luminance) * 0.5, -1, 1))}:colors=${HSL_FLAGS[range]}:strength=2`,
    );
  }

  if (s.wheels) {
    const parts: string[] = [];
    const zones = [
      ["s", s.wheels.shadows],
      ["m", s.wheels.midtones],
      ["h", s.wheels.highlights],
    ] as const;
    for (const [z, w] of zones) {
      if (!w || !w.amount) continue;
      const [r, g, b] = wheelRgb(w.hue, w.amount);
      parts.push(`r${z}=${fmt(r)}:g${z}=${fmt(g)}:b${z}=${fmt(b)}`);
    }
    if (parts.length) f.push(`colorbalance=${parts.join(":")}`);
  }

  if (s.curves) {
    const c = s.curves;
    if (c.preset) f.push(`curves=preset=${c.preset}`);
    const channels = [
      ["master", curveArg(c.master)],
      ["red", curveArg(c.red)],
      ["green", curveArg(c.green)],
      ["blue", curveArg(c.blue)],
    ].filter(([, v]) => v);
    if (channels.length) f.push(`curves=${channels.map(([k, v]) => `${k}=${v}`).join(":")}`);
  }

  if (s.fade) {
    const k = n(s.fade);
    f.push(`curves=master='0/${fmt(0.22 * k)} 0.5/${fmt(0.5 + 0.04 * k)} 1/${fmt(1 - 0.08 * k)}'`, `eq=saturation=${fmt(1 - 0.25 * k)}`);
  }

  if (s.clarity) f.push(`unsharp=lx=13:ly=13:la=${fmt(clamp(n(s.clarity) * 1.2, -2, 5))}:cx=5:cy=5:ca=0`);
  if (s.sharpen) f.push(`unsharp=lx=5:ly=5:la=${fmt(n(s.sharpen) * 2)}:cx=5:cy=5:ca=0`);

  if (s.vignette) {
    const k = Math.abs(n(s.vignette));
    f.push(`vignette=angle=${fmt(0.25 + k * 0.6)}${s.vignette < 0 ? ":mode=backward" : ""}`);
  }
  if (s.grain) f.push(`noise=alls=${Math.round(n(s.grain) * 40)}:allf=t+u`);

  return f.join(",");
}

/** Human-readable list of active settings (for summaries and the app). */
export function describeColorSettings(s: ColorSettings): string {
  const parts: string[] = [];
  const keys = ["exposure", "brightness", "contrast", "highlights", "shadows", "whites", "blacks", "brilliance", "temperature", "tint", "hue", "saturation", "vibrance", "fade", "clarity", "sharpen", "vignette", "grain"] as const;
  for (const k of keys) {
    const v = s[k];
    if (typeof v === "number" && v !== 0) parts.push(`${k} ${v > 0 ? "+" : ""}${v}`);
  }
  if (s.autoCorrect) parts.push("auto correct");
  for (const r of HSL_RANGES) {
    const a = s.hsl?.[r];
    if (!a) continue;
    const bits = (["hue", "saturation", "luminance"] as const).filter((k) => a[k]).map((k) => `${k[0]}${a[k]! > 0 ? "+" : ""}${a[k]}`);
    if (bits.length) parts.push(`${r} ${bits.join(" ")}`);
  }
  if (s.curves) parts.push(`curves(${Object.keys(s.curves).join("/")})`);
  if (s.wheels) parts.push(`wheels(${Object.keys(s.wheels).join("/")})`);
  return parts.join(", ") || "neutral";
}
