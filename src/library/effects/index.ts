import { z } from "zod";
import type { Effect } from "../../core/schema.js";
import { clamp, round3, toFfmpegColor } from "../../core/util.js";

export interface EffectContext {
  width: number;
  height: number;
  fps: number;
  /** Duration of the clip/layer the effect is applied to (seconds, after speed). */
  duration: number;
}

export type EffectCategory = "color" | "grade" | "blur" | "stylize" | "motion" | "distort" | "time";

export interface EffectDefinition<P extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: P;
  /** Returns a comma-separated FFmpeg filter chain. */
  toFilter(params: z.output<P>, ctx: EffectContext): string;
}

const num = (def: number, min: number, max: number, desc: string) =>
  z.number().min(min).max(max).default(def).describe(desc);

function define<P extends z.ZodType>(def: EffectDefinition<P>): EffectDefinition {
  return def as unknown as EffectDefinition;
}

/** zoompan always produces the project size; upscaling first avoids sub-pixel jitter. */
function zoompan(ctx: EffectContext, zoomExpr: string, xExpr = "iw/2-(iw/zoom/2)", yExpr = "ih/2-(ih/zoom/2)") {
  const w2 = ctx.width * 2;
  const h2 = ctx.height * 2;
  return `scale=${w2}:${h2},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${ctx.width}x${ctx.height}:fps=${ctx.fps}`;
}

const GRADES: Record<string, { name: string; description: string; filter: string }> = {
  cinematic: {
    name: "Cinematic",
    description: "Teal shadows, warm highlights, slightly crushed contrast",
    filter: "colorbalance=rs=-0.08:gs=-0.02:bs=0.1:rh=0.08:gh=0.02:bh=-0.08,eq=contrast=1.1:saturation=0.9",
  },
  tealOrange: {
    name: "Teal & Orange",
    description: "Strong blockbuster teal/orange split toning",
    filter: "colorbalance=rs=-0.15:bs=0.15:rm=0.05:rh=0.15:bh=-0.15,eq=saturation=1.15",
  },
  warm: { name: "Warm", description: "Golden, cozy tone", filter: "colortemperature=temperature=4500,eq=saturation=1.05" },
  cool: { name: "Cool", description: "Clean, blue-ish modern tone", filter: "colortemperature=temperature=8000" },
  vintage: {
    name: "Vintage",
    description: "Faded film look with lifted blacks and warm tint",
    filter: "curves=preset=vintage,eq=saturation=0.85",
  },
  noir: { name: "Noir", description: "High-contrast black & white", filter: "hue=s=0,eq=contrast=1.35:brightness=-0.03" },
  vibrant: { name: "Vibrant", description: "Punchy saturated social-media look", filter: "eq=saturation=1.35:contrast=1.08" },
  faded: {
    name: "Faded",
    description: "Matte, low-contrast pastel look",
    filter: "curves=all='0/0.08 1/0.92',eq=saturation=0.8",
  },
  moody: {
    name: "Moody",
    description: "Dark, desaturated and slightly green-teal",
    filter: "eq=brightness=-0.05:contrast=1.15:saturation=0.7,colorbalance=gs=0.03:bs=0.05",
  },
  bright: { name: "Bright & Airy", description: "Lifted exposure, soft contrast", filter: "eq=brightness=0.06:contrast=0.95:saturation=1.05" },
  sunset: {
    name: "Sunset",
    description: "Magenta-orange golden hour",
    filter: "colorbalance=rm=0.1:bm=0.05:rh=0.12:gh=0.02,colortemperature=temperature=5000",
  },
  matrix: { name: "Matrix", description: "Green-tinted digital look", filter: "colorbalance=rs=-0.1:gs=0.15:bs=-0.1:gm=0.1,eq=contrast=1.1" },
  crossProcess: { name: "Cross Process", description: "Experimental film cross-processing", filter: "curves=preset=cross_process" },
};

const gradeEffects = Object.entries(GRADES).map(([id, g]) =>
  define({
    id,
    name: g.name,
    category: "grade",
    description: `Color grade: ${g.description}.`,
    params: z.object({}),
    toFilter: () => g.filter,
  }),
);

export const EFFECTS: EffectDefinition[] = [
  // --- color ----------------------------------------------------------------
  define({
    id: "adjust",
    name: "Adjust",
    category: "color",
    description: "Basic color correction: brightness, contrast, saturation, gamma.",
    params: z.object({
      brightness: num(0, -1, 1, "-1..1, 0 = unchanged"),
      contrast: num(1, 0, 3, "1 = unchanged"),
      saturation: num(1, 0, 3, "1 = unchanged, 0 = grayscale"),
      gamma: num(1, 0.1, 3, "1 = unchanged"),
    }),
    toFilter: (p) => `eq=brightness=${p.brightness}:contrast=${p.contrast}:saturation=${p.saturation}:gamma=${p.gamma}`,
  }),
  define({
    id: "temperature",
    name: "Temperature",
    category: "color",
    description: "White balance. Lower kelvin = warmer, higher = cooler.",
    params: z.object({ kelvin: num(6500, 1000, 40000, "Color temperature in kelvin (6500 = neutral)") }),
    toFilter: (p) => `colortemperature=temperature=${p.kelvin}`,
  }),
  define({
    id: "grayscale",
    name: "Black & White",
    category: "color",
    description: "Remove all color.",
    params: z.object({}),
    toFilter: () => "hue=s=0",
  }),
  define({
    id: "sepia",
    name: "Sepia",
    category: "color",
    description: "Old-photo brown tone.",
    params: z.object({}),
    toFilter: () => "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
  }),
  define({
    id: "invert",
    name: "Invert",
    category: "color",
    description: "Negative image.",
    params: z.object({}),
    toFilter: () => "negate",
  }),
  define({
    id: "hueShift",
    name: "Hue Shift",
    category: "color",
    description: "Rotate all hues.",
    params: z.object({ degrees: num(90, -180, 180, "Hue rotation in degrees") }),
    toFilter: (p) => `hue=h=${p.degrees}`,
  }),
  define({
    id: "tint",
    name: "Tint",
    category: "color",
    description: "Wash the image with a color.",
    params: z.object({
      color: z.string().default("#FF8800").describe("Tint color #RRGGBB"),
      strength: num(0.3, 0, 1, "0..1"),
    }),
    toFilter: (p) => {
      const c = toFfmpegColor(p.color).slice(2);
      const r = parseInt(c.slice(0, 2), 16) / 255;
      const g = parseInt(c.slice(2, 4), 16) / 255;
      const b = parseInt(c.slice(4, 6), 16) / 255;
      return `colorize=hue=${Math.round(rgbToHue(r, g, b))}:saturation=${round3(p.strength)}:lightness=0.5:mix=${round3(p.strength)}`;
    },
  }),
  define({
    id: "lut",
    name: "LUT",
    category: "grade",
    description: "Apply a 3D LUT file (.cube/.3dl) for a custom grade.",
    params: z.object({ file: z.string().describe("Path to a .cube or .3dl LUT file") }),
    toFilter: (p) => `lut3d=file='${escapeFilterPath(p.file)}'`,
  }),
  ...gradeEffects,

  // --- blur & stylize -----------------------------------------------------------
  define({
    id: "blur",
    name: "Blur",
    category: "blur",
    description: "Gaussian blur.",
    params: z.object({ amount: num(10, 0, 100, "Blur radius") }),
    toFilter: (p) => `gblur=sigma=${p.amount}`,
  }),
  define({
    id: "sharpen",
    name: "Sharpen",
    category: "blur",
    description: "Increase detail.",
    params: z.object({ amount: num(1, 0, 3, "Sharpen strength") }),
    toFilter: (p) => `unsharp=5:5:${p.amount}:5:5:0`,
  }),
  define({
    id: "vignette",
    name: "Vignette",
    category: "stylize",
    description: "Darken the edges to focus attention on the center.",
    params: z.object({ strength: num(0.5, 0, 1, "0..1") }),
    toFilter: (p) => `vignette=angle=${round3(0.2 + p.strength * 0.8)}`,
  }),
  define({
    id: "grain",
    name: "Film Grain",
    category: "stylize",
    description: "Animated film grain noise.",
    params: z.object({ amount: num(12, 0, 60, "Noise strength") }),
    toFilter: (p) => `noise=alls=${p.amount}:allf=t+u`,
  }),
  define({
    id: "pixelate",
    name: "Pixelate",
    category: "stylize",
    description: "Blocky low-resolution mosaic (censoring, retro).",
    params: z.object({ blockSize: num(20, 2, 200, "Pixel block size") }),
    toFilter: (p, ctx) => {
      const w = Math.max(2, Math.round(ctx.width / p.blockSize));
      const h = Math.max(2, Math.round(ctx.height / p.blockSize));
      return `scale=${w}:${h},scale=${ctx.width}:${ctx.height}:flags=neighbor`;
    },
  }),
  define({
    id: "chromaticAberration",
    name: "Chromatic Aberration / RGB Split",
    category: "stylize",
    description: "Offset red and blue channels for a glitchy or lens-distortion look.",
    params: z.object({ amount: num(6, 0, 50, "Channel offset in pixels") }),
    toFilter: (p) => `rgbashift=rh=-${Math.round(p.amount)}:bh=${Math.round(p.amount)}`,
  }),
  define({
    id: "glitch",
    name: "Glitch",
    category: "stylize",
    description: "Digital glitch: jittering RGB split plus noise.",
    params: z.object({ amount: num(10, 1, 40, "Glitch intensity") }),
    toFilter: (p) => {
      const a = Math.round(p.amount);
      return `rgbashift=rh=${a}:bv=-${Math.round(a / 2)}:gh=-${Math.round(a / 2)},noise=alls=${Math.round(a * 1.5)}:allf=t`;
    },
  }),
  define({
    id: "letterbox",
    name: "Letterbox",
    category: "stylize",
    description: "Cinematic black bars top and bottom.",
    params: z.object({ ratio: num(2.39, 1, 4, "Target aspect ratio of the visible area, e.g. 2.39") }),
    toFilter: (p, ctx) => {
      const visible = Math.min(ctx.height, Math.round(ctx.width / p.ratio));
      const bar = Math.max(0, Math.floor((ctx.height - visible) / 2));
      return `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`;
    },
  }),
  define({
    id: "mirror",
    name: "Flip",
    category: "distort",
    description: "Flip horizontally or vertically.",
    params: z.object({ direction: z.enum(["horizontal", "vertical"]).default("horizontal") }),
    toFilter: (p) => (p.direction === "horizontal" ? "hflip" : "vflip"),
  }),

  // --- motion -------------------------------------------------------------------
  define({
    id: "kenBurns",
    name: "Ken Burns",
    category: "motion",
    description: "Slow zoom (in or out) with optional pan. Great for photos and static shots.",
    params: z.object({
      zoomFrom: num(1, 1, 3, "Start zoom (1 = no zoom)"),
      zoomTo: num(1.2, 1, 3, "End zoom"),
      pan: z.enum(["center", "left", "right", "up", "down"]).default("center"),
    }),
    toFilter: (p, ctx) => {
      const frames = Math.max(1, Math.round(ctx.duration * ctx.fps));
      const z0 = p.zoomFrom;
      const dz = p.zoomTo - p.zoomFrom;
      const zoomExpr = `${z0}+${round3(dz)}*on/${frames}`;
      const prog = `(on/${frames})`;
      const cx = "iw/2-(iw/zoom/2)";
      const cy = "ih/2-(ih/zoom/2)";
      const x = p.pan === "left" ? `(iw-iw/zoom)*(1-${prog})` : p.pan === "right" ? `(iw-iw/zoom)*${prog}` : cx;
      const y = p.pan === "up" ? `(ih-ih/zoom)*(1-${prog})` : p.pan === "down" ? `(ih-ih/zoom)*${prog}` : cy;
      return zoompan(ctx, zoomExpr, x, y);
    },
  }),
  define({
    id: "zoom",
    name: "Static Zoom / Crop In",
    category: "motion",
    description: "Punch into the frame by a fixed amount (reframe a shot).",
    params: z.object({
      scale: num(1.2, 1, 4, "Zoom factor"),
      x: num(0.5, 0, 1, "Focus point x (0..1)"),
      y: num(0.5, 0, 1, "Focus point y (0..1)"),
    }),
    toFilter: (p, ctx) => {
      const w = Math.round(ctx.width / p.scale / 2) * 2;
      const h = Math.round(ctx.height / p.scale / 2) * 2;
      return `crop=${w}:${h}:'clip(iw*${p.x}-${w}/2,0,iw-${w})':'clip(ih*${p.y}-${h}/2,0,ih-${h})',scale=${ctx.width}:${ctx.height}`;
    },
  }),
  define({
    id: "punchIn",
    name: "Punch-In Zooms",
    category: "motion",
    description:
      "Alternate between normal and zoomed framing every few seconds — the classic talking-head jump-zoom that keeps viewers engaged.",
    params: z.object({
      interval: num(3, 0.5, 30, "Seconds between zoom changes"),
      scale: num(1.15, 1.01, 2, "Zoom factor when punched in"),
    }),
    toFilter: (p, ctx) => zoompan(ctx, `if(mod(floor(it/${p.interval}),2),${p.scale},1)`),
  }),
  define({
    id: "shake",
    name: "Camera Shake",
    category: "motion",
    description: "Handheld/impact camera shake.",
    params: z.object({
      intensity: num(10, 1, 60, "Max offset in pixels"),
      speed: num(20, 1, 60, "Shake frequency"),
    }),
    toFilter: (p, ctx) => {
      const i = Math.round(p.intensity);
      return `scale=${ctx.width + i * 2}:${ctx.height + i * 2},crop=${ctx.width}:${ctx.height}:'${i}+${i}*sin(t*${p.speed})':'${i}+${i}*cos(t*${round3(p.speed * 1.3)})'`;
    },
  }),
  define({
    id: "pulse",
    name: "Beat Pulse",
    category: "motion",
    description: "Rhythmic zoom pulse, e.g. on a music beat.",
    params: z.object({
      bpm: num(120, 30, 240, "Beats per minute"),
      amount: num(0.06, 0.01, 0.5, "Zoom added on each beat"),
    }),
    toFilter: (p, ctx) => {
      const period = round3(60 / p.bpm);
      return zoompan(ctx, `1+${p.amount}*exp(-8*mod(it,${period})/${period})`);
    },
  }),

  // --- time -----------------------------------------------------------------------
  define({
    id: "fadeIn",
    name: "Fade In",
    category: "time",
    description: "Fade in from black at the start.",
    params: z.object({ duration: num(0.5, 0.05, 10, "Seconds") }),
    toFilter: (p) => `fade=t=in:st=0:d=${p.duration}`,
  }),
  define({
    id: "fadeOut",
    name: "Fade Out",
    category: "time",
    description: "Fade out to black at the end.",
    params: z.object({ duration: num(0.5, 0.05, 10, "Seconds") }),
    toFilter: (p, ctx) => `fade=t=out:st=${round3(Math.max(0, ctx.duration - p.duration))}:d=${p.duration}`,
  }),
  define({
    id: "flash",
    name: "Flash",
    category: "time",
    description: "Quick white flash at the start of the clip (impact moment).",
    params: z.object({ duration: num(0.25, 0.05, 2, "Seconds") }),
    toFilter: (p) => `fade=t=in:st=0:d=${p.duration}:color=white`,
  }),
];

const byId = new Map(EFFECTS.map((e) => [e.id, e]));

export function getEffect(id: string): EffectDefinition | undefined {
  return byId.get(id);
}

export function listEffects(category?: EffectCategory): EffectDefinition[] {
  return category ? EFFECTS.filter((e) => e.category === category) : EFFECTS;
}

export function registerEffect(def: EffectDefinition): void {
  if (byId.has(def.id)) throw new Error(`Effect "${def.id}" already registered`);
  EFFECTS.push(def);
  byId.set(def.id, def);
}

/** Validate params against the definition and fill defaults. */
export function resolveEffectParams(effect: Effect): Record<string, unknown> {
  const def = getEffect(effect.type);
  if (!def) throw new Error(`Unknown effect "${effect.type}"`);
  return def.params.parse(effect.params ?? {}) as Record<string, unknown>;
}

export function effectToFilter(effect: Effect, ctx: EffectContext): string {
  const def = getEffect(effect.type);
  if (!def) throw new Error(`Unknown effect "${effect.type}"`);
  return def.toFilter(def.params.parse(effect.params ?? {}), ctx);
}

export function effectsToFilter(effects: Effect[], ctx: EffectContext): string[] {
  return effects.map((e) => effectToFilter(e, ctx));
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return clamp(((h * 60) + 360) % 360, 0, 359);
}

/** Escape a filesystem path for use inside a single-quoted FFmpeg filter argument. */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}
