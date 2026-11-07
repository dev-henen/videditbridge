/**
 * Film look effects (docs/design/cinematic-grade-and-vfx.md, section 4.4): light that spills from
 * highlights (halation, bloom, anamorphic flare), grain that behaves like film's, gate weave, a
 * print-film-like tone and color response, and lens distortion. Sizes are fractions of the frame,
 * so previews and 4K renders look alike. Names describe a character; no film stock is claimed.
 */

import { z } from "zod";
import { round3 } from "../../core/util.js";
import { bakeColor, define, labeler, num, type EffectContext, type EffectDefinition } from "./helpers.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Glow {
  /** Brightness (0..1) where the light starts to spill, with a soft knee above it. */
  threshold: number;
  /** Blur radii (gblur sigma) across and down, in pixels; several radii are averaged. */
  sigmas: [number, number][];
  /** Color of the spilled light, per channel. */
  tint: [number, number, number];
  strength: number;
}

/**
 * Highlights above `threshold` (scaled so brighter ones spill more), blurred, tinted and added back,
 * on 16-bit RGB. Nothing below the threshold changes the picture: a frame without highlights comes
 * out as it went in.
 */
/** The highlights a glow keeps: their excess over the threshold, eased in with a soft knee (per-pixel filters). */
export function glowKeep(threshold: number): string[] {
  const t = round3(clamp(threshold, 0, 0.98));
  return [`colorlevels=rimin=${t}:gimin=${t}:bimin=${t}`, "curves=all='0/0 0.3/0.12 1/1'"];
}

/** A glow's blur radii as gblur takes them (sigma, sigmaV). */
export const glowSigmas = (g: Glow): [number, number][] => g.sigmas.map(([sx, sy]) => [round3(Math.max(0.5, sx)), round3(Math.max(0.5, sy))]);

/** How much of the light goes on: blend addition's opacity. */
export const glowOpacity = (g: Glow) => round3(clamp(g.strength, 0, 2) / 2);

/** The glows of halation, bloom and anamorphicFlare from their parameters, for the FFmpeg graph and the engine plan alike. */
export const GLOWS: Record<"halation" | "bloom" | "anamorphicFlare", (p: Record<string, number>, ctx: Pick<EffectContext, "width" | "height">) => Glow> = {
  halation: (p, ctx) => {
    const sigma = ctx.height * 0.015 * p.size!;
    return { threshold: p.threshold!, sigmas: [[sigma, sigma]], tint: [1, 0.35, 0.12], strength: p.strength! };
  },
  bloom: (p, ctx) => {
    const [tight, wide] = [ctx.height * 0.004 * p.size!, ctx.height * 0.02 * p.size!];
    return { threshold: p.threshold!, sigmas: [[tight, tight], [wide, wide]], tint: [1, 1, 1], strength: p.strength! };
  },
  anamorphicFlare: (p, ctx) => ({ threshold: p.threshold!, sigmas: [[ctx.width * 0.06 * p.length!, Math.max(1, ctx.height * 0.0015)]], tint: [0.35, 0.65, 1], strength: p.strength! }),
};

function glow(ctx: EffectContext, g: Glow): string {
  const label = labeler(ctx);
  const [orig, copy, light] = [label("glo"), label("glc"), label("gll")];
  const [rgb, out] = ctx.alpha ? ["gbrap16le", "yuva420p"] : ["gbrp16le", "yuv420p"];
  const keep = glowKeep(g.threshold).join(",");
  const [r, gr, b] = g.tint.map(round3);
  // The light's own alpha is 0, so a layer keeps its transparency.
  const tint = `colorchannelmixer=rr=${r}:gg=${gr}:bb=${b}${ctx.alpha ? ":aa=0" : ""}`;
  const sigmas = glowSigmas(g);
  const blur = ([sx, sy]: [number, number]) => `gblur=sigma=${sx}:sigmaV=${sy}`;
  const lines = [`format=${rgb},split=2[${orig}][${copy}]`];
  if (sigmas.length === 1) lines.push(`[${copy}]${keep},${blur(sigmas[0]!)},${tint}[${light}]`);
  else {
    const parts = sigmas.map(() => label("glb"));
    const blurred = sigmas.map(() => label("glg"));
    lines.push(`[${copy}]${keep},split=${parts.length}${parts.map((p) => `[${p}]`).join("")}`);
    sigmas.forEach((s, i) => lines.push(`[${parts[i]}]${blur(s)}[${blurred[i]}]`));
    // Average the radii pairwise, then tint.
    let acc = blurred[0]!;
    for (let i = 1; i < blurred.length; i++) {
      const next = label("gla");
      lines.push(`[${acc}][${blurred[i]}]blend=all_mode=average[${next}]`);
      acc = next;
    }
    lines.push(`[${acc}]${tint}[${light}]`);
  }
  lines.push(`[${orig}][${light}]blend=all_mode=addition:all_opacity=${glowOpacity(g)},format=${out}`);
  return lines.join(";");
}

/** Grain cell sizes of the stocks, as a fraction of the frame height. */
const GRAIN_STOCKS = { fine: 0.0012, medium: 0.002, coarse: 0.0035 } as const;

/** filmGrain's numbers: the grain picture's size (one pixel a cell) and the noise strength. */
export function grainSpec(p: { amount: number; stock: keyof typeof GRAIN_STOCKS }, ctx: Pick<EffectContext, "width" | "height">): { size: [number, number]; strength: number } {
  const cell = Math.max(1, ctx.height * GRAIN_STOCKS[p.stock]);
  return {
    size: [Math.max(2, Math.round(ctx.width / cell / 2) * 2), Math.max(2, Math.round(ctx.height / cell / 2) * 2)],
    strength: round3(clamp(p.amount, 0, 100) * 0.6),
  };
}

/** lensDistortion's lenscorrection coefficients. */
export const lensDistortion = (p: { amount: number }) => ({ k1: round3(p.amount * 0.2), k2: round3(p.amount * 0.05) });

/** A smooth wander: two sine waves with seeded speeds and phases, as an expression of a time and as its value. */
interface Wave {
  expr: (t: string) => string;
  at: (t: number) => number;
}

/**
 * gateWeave's motion: the x and y drift and the angle (waves), and the frame's corners from its
 * center. The FFmpeg graph writes the waves as perspective expressions of `on`, and the engine
 * evaluates the same numbers (in doubles, as FFmpeg's expressions are).
 */
export function gateWeave(p: { amount: number; seed: number }, ctx: Pick<EffectContext, "width" | "height">): { waves: [Wave, Wave, Wave]; cx: number; cy: number; corners: [number, number][] } {
  const wave = (i: number, scale: number): Wave => {
    const [f1, f2] = [0.35 + seeded(p.seed, i) * 0.6, 1.1 + seeded(p.seed, i + 1) * 1.4];
    const [a, b] = [round3(seeded(p.seed, i + 2) * 6.283), round3(seeded(p.seed, i + 3) * 6.283)];
    const [s1, w1, s2, w2] = [round3(scale * 0.65), round3(6.283 * f1), round3(scale * 0.35), round3(6.283 * f2)];
    return { expr: (t) => `(${s1}*sin(${w1}*${t}+${a})+${s2}*sin(${w2}*${t}+${b}))`, at: (t) => s1 * Math.sin(w1 * t + a) + s2 * Math.sin(w2 * t + b) };
  };
  const [cx, cy] = [ctx.width / 2, ctx.height / 2];
  return {
    waves: [wave(0, ctx.width * 0.0012 * p.amount), wave(4, ctx.height * 0.0018 * p.amount), wave(8, 0.0005 * p.amount)],
    cx,
    cy,
    // perspective's order: top-left, top-right, bottom-left, bottom-right.
    corners: [[0 - cx, 0 - cy], [ctx.width - cx, 0 - cy], [0 - cx, ctx.height - cy], [ctx.width - cx, ctx.height - cy]],
  };
}

/** A seeded number in 0..1 from an integer (the same in every render). */
const seeded = (seed: number, i: number) => {
  const x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export function filmEffects(): EffectDefinition[] {
  return [
    define({
      id: "halation",
      name: "Halation",
      category: "light",
      perFrame: true,
      description:
        "Film halation: a warm red-orange glow that spills around bright highlights (lamps, windows, sun on skin, specular edges), as light scatters back through film. " +
        "Only highlights above the threshold glow, more for brighter ones; the rest of the picture is untouched. Subtle (0.3-0.6) reads as filmic; strong reads as dreamy.",
      params: z.object({
        strength: num(0.5, 0, 2, "How much light spills (0..2)"),
        threshold: num(0.75, 0.3, 0.98, "Brightness where highlights start to glow (0..1)"),
        size: num(1, 0.2, 4, "Spread, relative to the usual 1.5% of the frame height"),
      }),
      toFilter: (p, ctx) => glow(ctx, GLOWS.halation(p, ctx)),
    }),
    define({
      id: "bloom",
      name: "Bloom",
      category: "light",
      perFrame: true,
      description:
        "A soft neutral glow around highlights, as through diffusion filters or old lenses: a tight halo and a wider one together. " +
        "Only highlights above the threshold glow. Use for a dreamy, romantic or nostalgic feel; keep it low (0.2-0.4) for a gentle lift.",
      params: z.object({
        strength: num(0.35, 0, 2, "How much light spills (0..2)"),
        threshold: num(0.7, 0.3, 0.98, "Brightness where highlights start to glow (0..1)"),
        size: num(1, 0.2, 4, "Spread, relative to the usual size"),
      }),
      toFilter: (p, ctx) => glow(ctx, GLOWS.bloom(p, ctx)),
    }),
    define({
      id: "anamorphicFlare",
      name: "Anamorphic Flare",
      category: "light",
      perFrame: true,
      description:
        "Horizontal blue-cyan streaks through bright points of light (headlights, street lamps, the sun), as anamorphic lenses draw them. " +
        "Only highlights above the threshold streak. Works best on night scenes and practical lights; on a bright daylight shot it washes the frame.",
      params: z.object({
        strength: num(0.6, 0, 2, "Brightness of the streaks (0..2)"),
        threshold: num(0.85, 0.3, 0.98, "Brightness where lights start to streak (0..1)"),
        length: num(1, 0.2, 3, "Length of the streaks, relative to the usual"),
      }),
      toFilter: (p, ctx) => glow(ctx, GLOWS.anamorphicFlare(p, ctx)),
    }),
    define({
      id: "filmGrain",
      name: "Film Grain (stock)",
      category: "stylize",
      perFrame: true,
      description:
        "Grain that behaves like film's: strongest in the midtones, fading in deep shadows and bright highlights, new every frame, with a grain size relative to the frame (so previews and 4K match). " +
        'Stocks: "fine" (slow, clean daylight stock), "medium" (an all-round stock), "coarse" (fast tungsten stock, pushed look). The same seed gives the same grain in every render. Prefer it over grain for a filmic look.',
      params: z.object({
        amount: num(30, 0, 100, "Strength (0..100)"),
        stock: z.enum(["fine", "medium", "coarse"]).default("medium").describe("Grain size and character"),
        seed: z.number().int().min(0).max(100000).default(1).describe("Pattern seed; renders with the same seed match"),
      }),
      toFilter: (p, ctx) => {
        const label = labeler(ctx);
        const [orig, noise, grain] = [label("fgo"), label("fgn"), label("fgg")];
        const fmt = ctx.alpha ? "yuva420p" : "yuv420p";
        const { size: [gw, gh], strength } = grainSpec(p, ctx);
        // Gray noise around mid-gray at the grain's own size, scaled up smoothly, then soft-light on
        // luma only: soft light moves midtones most and leaves black and white nearly alone.
        return [
          `format=${fmt},split=2[${orig}][${noise}]`,
          `[${noise}]scale=${gw}:${gh},lutyuv=y=128:u=128:v=128,noise=c0s=${strength}:c0f=t:all_seed=${p.seed},scale=${ctx.width}:${ctx.height}:flags=bicubic,format=${fmt}[${grain}]`,
          `[${orig}][${grain}]blend=c0_mode=softlight:c1_mode=normal:c2_mode=normal${ctx.alpha ? ":c3_mode=normal" : ""}`,
        ].join(";");
      },
    }),
    define({
      id: "gateWeave",
      name: "Gate Weave",
      category: "motion",
      perFrame: true,
      description:
        "The slight, slow wander of a film frame in the projector gate: sub-pixel drift and a tiny rotation, smooth and random-looking. " +
        "Adds the feel of projected film to digital footage; keep it barely noticeable (amount 0.5-1). The same seed repeats in every render.",
      params: z.object({
        amount: num(1, 0, 3, "How far the frame wanders (1 = a projector's typical weave)"),
        seed: z.number().int().min(0).max(100000).default(1).describe("Motion seed"),
      }),
      toFilter: (p, ctx) => {
        const w = gateWeave(p, ctx);
        const [dx, dy, angle] = w.waves.map((v) => v.expr(`(on/${ctx.fps})`));
        // Where each output corner comes from: rotated about the center, then moved.
        const pts = w.corners.map(([ox, oy]) => [`${w.cx}+${ox}*cos(${angle})-${oy}*sin(${angle})+${dx}`, `${w.cy}+${ox}*sin(${angle})+${oy}*cos(${angle})+${dy}`]);
        const args = pts.flatMap(([x, y], i) => [`x${i}='${x}'`, `y${i}='${y}'`]).join(":");
        return `perspective=${args}:interpolation=cubic:sense=source:eval=frame`;
      },
    }),
    define({
      id: "printFilm",
      name: "Print Film Look",
      category: "color",
      perFrame: true,
      description:
        "A print-film-like response: an S-curve with a soft toe and a gently rolled shoulder, mild crosstalk between the colors, warm highlights and cool shadows. " +
        "The classic projected-film feel; works on most footage as a base for other looks. warmth tilts the split between warm highlights and cool shadows.",
      params: z.object({
        strength: num(1, 0, 1, "How much of the look (0..1)"),
        warmth: num(0.5, 0, 1, "Warm highlights and cool shadows (0..1)"),
      }),
      toFilter: (p, ctx) => {
        const s = clamp(p.strength, 0, 1);
        const lift = (v: number, to: number) => round3(v + (to - v) * s);
        // S-curve: soft toe (blacks a little lifted), rolled shoulder.
        const curve = `curves=all='0/${lift(0, 0.03)} 0.25/${lift(0.25, 0.2)} 0.5/0.5 0.75/${lift(0.75, 0.8)} 1/${lift(1, 0.96)}'`;
        const x = round3(0.06 * s);
        const crosstalk = `colorchannelmixer=rr=${round3(1 - 2 * x)}:rg=${x}:rb=${x}:gr=${x}:gg=${round3(1 - 2 * x)}:gb=${x}:br=${x}:bg=${x}:bb=${round3(1 - 2 * x)}`;
        const w = round3(0.12 * s * p.warmth);
        const split = `colorbalance=rs=${-w}:bs=${w}:rh=${w}:bh=${-w}`;
        return bakeColor(ctx, [curve, crosstalk, split]);
      },
    }),
    define({
      id: "lensDistortion",
      name: "Lens Distortion",
      category: "distort",
      perFrame: true,
      description:
        "Barrel (+, a wide-angle or fisheye bulge) or pincushion (-, a telephoto pinch) distortion around the frame's center. Small amounts (0.1-0.3) give a vintage or action-camera lens feel; large ones are a stylized effect. Barrel leaves the corners dark.",
      params: z.object({ amount: num(0.2, -1, 1, "+ barrel, - pincushion") }),
      toFilter: (p) => {
        const { k1, k2 } = lensDistortion(p);
        return `lenscorrection=k1=${k1}:k2=${k2}:i=bilinear`;
      },
    }),
  ];
}
