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

interface Glow {
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
function glow(ctx: EffectContext, g: Glow): string {
  const label = labeler(ctx);
  const [orig, copy, light] = [label("glo"), label("glc"), label("gll")];
  const [rgb, out] = ctx.alpha ? ["gbrap16le", "yuva420p"] : ["gbrp16le", "yuv420p"];
  const t = round3(clamp(g.threshold, 0, 0.98));
  // A soft knee: the highlights' excess over the threshold, eased in.
  const keep = `colorlevels=rimin=${t}:gimin=${t}:bimin=${t},curves=all='0/0 0.3/0.12 1/1'`;
  const [r, gr, b] = g.tint.map(round3);
  // The light's own alpha is 0, so a layer keeps its transparency.
  const tint = `colorchannelmixer=rr=${r}:gg=${gr}:bb=${b}${ctx.alpha ? ":aa=0" : ""}`;
  const blur = ([sx, sy]: [number, number]) => `gblur=sigma=${round3(Math.max(0.5, sx))}:sigmaV=${round3(Math.max(0.5, sy))}`;
  const lines = [`format=${rgb},split=2[${orig}][${copy}]`];
  if (g.sigmas.length === 1) lines.push(`[${copy}]${keep},${blur(g.sigmas[0]!)},${tint}[${light}]`);
  else {
    const parts = g.sigmas.map(() => label("glb"));
    const blurred = g.sigmas.map(() => label("glg"));
    lines.push(`[${copy}]${keep},split=${parts.length}${parts.map((p) => `[${p}]`).join("")}`);
    g.sigmas.forEach((s, i) => lines.push(`[${parts[i]}]${blur(s)}[${blurred[i]}]`));
    // Average the radii pairwise, then tint.
    let acc = blurred[0]!;
    for (let i = 1; i < blurred.length; i++) {
      const next = label("gla");
      lines.push(`[${acc}][${blurred[i]}]blend=all_mode=average[${next}]`);
      acc = next;
    }
    lines.push(`[${acc}]${tint}[${light}]`);
  }
  lines.push(`[${orig}][${light}]blend=all_mode=addition:all_opacity=${round3(clamp(g.strength, 0, 2) / 2)},format=${out}`);
  return lines.join(";");
}

/** Grain cell sizes of the stocks, as a fraction of the frame height. */
const GRAIN_STOCKS = { fine: 0.0012, medium: 0.002, coarse: 0.0035 } as const;

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
      toFilter: (p, ctx) => {
        const sigma = ctx.height * 0.015 * p.size;
        return glow(ctx, { threshold: p.threshold, sigmas: [[sigma, sigma]], tint: [1, 0.35, 0.12], strength: p.strength });
      },
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
      toFilter: (p, ctx) => {
        const [tight, wide] = [ctx.height * 0.004 * p.size, ctx.height * 0.02 * p.size];
        return glow(ctx, { threshold: p.threshold, sigmas: [[tight, tight], [wide, wide]], tint: [1, 1, 1], strength: p.strength });
      },
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
      toFilter: (p, ctx) => glow(ctx, { threshold: p.threshold, sigmas: [[ctx.width * 0.06 * p.length, Math.max(1, ctx.height * 0.0015)]], tint: [0.35, 0.65, 1], strength: p.strength }),
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
        const cell = Math.max(1, ctx.height * GRAIN_STOCKS[p.stock]);
        const [gw, gh] = [Math.max(2, Math.round(ctx.width / cell / 2) * 2), Math.max(2, Math.round(ctx.height / cell / 2) * 2)];
        const strength = round3(clamp(p.amount, 0, 100) * 0.6);
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
        // A smooth wander from two sine waves per axis, with seeded speeds and phases.
        const wave = (i: number, scale: number) => {
          const [f1, f2] = [0.35 + seeded(p.seed, i) * 0.6, 1.1 + seeded(p.seed, i + 1) * 1.4];
          const [a, b] = [round3(seeded(p.seed, i + 2) * 6.283), round3(seeded(p.seed, i + 3) * 6.283)];
          // perspective has no time variable: the output frame number over the frame rate.
          const t = `(on/${ctx.fps})`;
          return `(${round3(scale * 0.65)}*sin(${round3(6.283 * f1)}*${t}+${a})+${round3(scale * 0.35)}*sin(${round3(6.283 * f2)}*${t}+${b}))`;
        };
        const dx = wave(0, ctx.width * 0.0012 * p.amount);
        const dy = wave(4, ctx.height * 0.0018 * p.amount);
        const angle = wave(8, 0.0005 * p.amount);
        // Where each output corner comes from: rotated about the center, then moved.
        const [cx, cy] = [ctx.width / 2, ctx.height / 2];
        const corner = (x: number, y: number) => {
          const [ox, oy] = [x - cx, y - cy];
          return [`${cx}+${ox}*cos(${angle})-${oy}*sin(${angle})+${dx}`, `${cy}+${ox}*sin(${angle})+${oy}*cos(${angle})+${dy}`];
        };
        const pts = [corner(0, 0), corner(ctx.width, 0), corner(0, ctx.height), corner(ctx.width, ctx.height)];
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
      toFilter: (p) => `lenscorrection=k1=${round3(p.amount * 0.2)}:k2=${round3(p.amount * 0.05)}:i=bilinear`,
    }),
  ];
}
