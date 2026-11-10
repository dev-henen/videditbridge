import type { Effect } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { chromaticAberrationRadial, getEffect, haldClutChain, type EffectContext } from "../../library/effects/index.js";
import { GLOWS, gateWeave, glowKeep, glowOpacity, glowSigmas, grainSpec, lensDistortion } from "../../library/effects/film.js";
import { bokehOrbs, glowEffect, lightLeakSpeeds, lightRays } from "../../library/effects/motion.js";
import { lightCanvas } from "../../library/effects/helpers.js";
import { evalExpr } from "../../core/expr.js";
import { parseColor } from "../../core/util.js";
import type { GradeConstants } from "../../library/color/index.js";

/**
 * Effects as GPU render engine operations (see plan.ts). Each one follows its FFmpeg filter in the
 * backend: color effects are baked into a lookup table from their own filters, and the others are
 * computed here from the same parameters (crop rectangles per frame, bar heights, offsets), so the
 * engine draws the same picture. Keep in step with native/ave-render/src/plan.rs.
 */

export type PlanOp =
  /** A per-pixel color chain, baked by running `args` (ffmpeg writing a 512x512 rgb24 Hald table to stdout). */
  | { op: "lut"; args: string[] }
  /** A color space transform: a .cube table (engine/library/color/transform.ts), with its own input range. */
  | { op: "cube"; file: string }
  /** The color panel's primaries in ACEScct, between the two halves of a color space's transform (engine/library/color/grade.ts). */
  | ({ op: "grade" } & GradeConstants)
  /**
   * Show a rectangle of the picture (x, y, width, height in pixels) at full size, per frame of the
   * piece (the last one holds): `linear` samples between pixels (the perspective filter the motion
   * effects use), `bicubic` crops whole pixels and scales (crop and scale).
   */
  | { op: "crop"; rects: [number, number, number, number][]; filter: "linear" | "bicubic" }
  /** FFmpeg's vignette at `angle` (radians); backward brightens the edges instead. */
  | { op: "vignette"; angle: number; backward?: boolean }
  /** Black bars of `height` pixels at the top and bottom (letterbox). */
  | { op: "bars"; height: number }
  /** A media layer's rounded corners (compile.ts): alpha cleared outside a rounded rectangle of `radius` pixels. */
  | { op: "corners"; radius: number }
  /** FFmpeg's fade toward `color` (RGB 0..1): in from it, or out to it, `start` and `duration` in seconds of the piece. */
  | { op: "fade"; color: [number, number, number]; out: boolean; start: number; duration: number }
  /** Move the red, green and blue channels by whole pixels, [across, down] each (rgbashift). */
  | { op: "shift"; red: [number, number]; green: [number, number]; blue: [number, number] }
  /**
   * FFmpeg's noise, new on each frame: uniform over `strength` levels, or gaussian with deviation
   * strength / sqrt(3), on every YUV plane, or on R, G and B when the frames are RGB there (after
   * rgbashift). Random, so it matches FFmpeg in strength, not pixels.
   */
  | { op: "noise"; strength: number; uniform: boolean; rgb?: boolean }
  /** FFmpeg's gblur (its recursive filter, not a true Gaussian): on the YUV planes, or on RGB (`rgb`); `sigmaV` down columns. */
  | { op: "blur"; sigma: number; sigmaV?: number; rgb?: boolean }
  /**
   * filmGrain: gaussian luma noise on mid-gray at `size` (one pixel a grain cell), new each frame,
   * scaled up bicubic and put on with blend's softlight on luma. Random like FFmpeg's noise, so it
   * matches in strength, not pixels; the same seed gives the same grain.
   */
  | { op: "grain"; size: [number, number]; strength: number; seed: number }
  /**
   * FFmpeg's perspective with sense=source: each output pixel (x, y) reads the source at
   * ((a x + b y + c) / (g x + h y + 1), (d x + e y + f) / (g x + h y + 1)), in 1/256 pixel steps,
   * with its cubic (11-bit weights) or linear sampling. `maps` holds [a, b, c, d, e, f, g, h] per
   * frame of the piece (the last holds).
   */
  | { op: "warp"; maps: [number, number, number, number, number, number, number, number][]; cubic: boolean }
  /** FFmpeg's lenscorrection (bilinear) about the center: radius scaled by 1 + k1 r^2 + k2 r^4, black outside; with `rgb`, each RGB plane on its own with its k1 (k2 0). */
  | { op: "lens"; k1: number; k2: number; rgb?: [number, number, number] }
  /**
   * lightRays: at `size`, the highlight curve (a table), six passes each averaging the picture with
   * a copy scaled to [width, height] and cropped at [x, y], per-channel levels (a table), scaled up,
   * then screen over the picture (8-bit RGB there).
   */
  | { op: "rays"; size: [number, number]; curve: string[]; zooms: [number, number, number, number][]; levels: string[] }
  /**
   * lightLeak and bokehLights: a small gray canvas (light.wgsl) scaled up bicubic, times `opacity`,
   * as the alpha of `color` over the picture. `leak`: its speeds; `orbs`: per frame, each orb's
   * left, top, size and alpha factor.
   */
  | { op: "light"; canvas: [number, number]; color: [number, number, number]; opacity: number; leak?: [number, number, number, number, number]; orbs?: [number, number, number, number][][] }
  /**
   * A camera move (scale, then rotate, then crop): the picture scaled bicubic to `size`, then per
   * frame of the piece (the last holds) [x, y, angle]: turned by angle radians about its center as
   * FFmpeg's rotate turns it (bilinear, black outside; 0 for no turn), and the frame-size window at
   * x, y shown.
   */
  | { op: "move"; size: [number, number]; frames: [number, number, number][]; rotate: boolean }
  /** hflip or vflip. */
  | { op: "flip"; horizontal: boolean }
  /** drawgrid: lines `thickness` thick every `cell` [across, down] pixels, blended toward black at `alpha` (the color's alpha byte / 255: av_parse_color truncates). */
  | { op: "grid"; cell: [number, number]; thickness: number; alpha: number }
  /** dilation: the 3 x 3 maximum on each plane. */
  | { op: "dilate"; rgb?: boolean }
  /** convolution: a square kernel times rdiv plus bias, on each plane (8-bit). */
  | { op: "conv"; kernel: number[]; rdiv: number; bias: number; rgb?: boolean }
  /**
   * FFmpeg's unsharp on the 8-bit luma plane (chroma and alpha kept): `size` [across, down], odd;
   * its blur is a cascade of two-tap sums (a binomial kernel, edges repeated); `amount` in 1/65536
   * steps, as the filter holds it.
   */
  | { op: "unsharp"; size: [number, number]; amount: number }
  /** Each branch from the same picture, then FFmpeg's mix of them with equal weights (8-bit planes, rounded to nearest). */
  | { op: "mix"; branches: PlanOp[][] }
  /**
   * `ops` on the picture scaled to `size` (`down` with bicubic, area or neighbor), then scaled
   * back (`up`). On YUV frames (not `rgb`) FFmpeg scales 4:2:0 chroma planes on their own: chroma
   * then goes through `ops` at half the size (rounded up) and back to half the frame's.
   */
  | { op: "at"; size: [number, number]; down: ScaleKind; up: ScaleKind; ops: PlanOp[]; rgb?: boolean }
  /** Red, green and blue multiplied (colorchannelmixer's diagonal). */
  | { op: "tint"; gains: [number, number, number] }
  /** `ops` on a copy of the picture, then blended back over it with FFmpeg's blend (the picture is its top). */
  | { op: "branch"; ops: PlanOp[]; blend: PlanBlend }
  /** Each branch from the same picture, the results averaged pairwise in order (a chain of blend=average). */
  | { op: "average"; branches: PlanOp[][] }
  /** FFmpeg's eq on the YUV planes as they are (values past video black and white included), with its own integer math. */
  | { op: "eq"; brightness: number; contrast: number; saturation: number; gamma: number; gammaWeight: number };

export type ScaleKind = "bicubic" | "area" | "neighbor";

/** FFmpeg's blend: a mode at an opacity, on RGB, or on the luma plane alone with its 8-bit math. */
export interface PlanBlend {
  mode: "addition" | "average" | "screen" | "softlight" | "multiply";
  opacity: number;
  luma?: boolean;
}

/** Filters that change each pixel from its own value alone, so a chain of them can be baked into a table. */
/** Filters that work pixel by pixel (a color table can stand for them). */
export const PIXEL_FILTERS = new Set(["eq", "lutrgb", "lutyuv", "colorbalance", "colortemperature", "curves", "hue", "colorchannelmixer", "negate", "colorize", "vibrance", "huesaturation", "exposure", "format", "lut3d", "null"]);

/** Split a filter chain at its top-level commas (not inside quotes or brackets). Undefined for a graph with labels or branches. */
export function splitChain(chain: string): string[] | undefined {
  if (/[[\];]/.test(chain.replace(/'[^']*'/g, ""))) return undefined;
  const out: string[] = [];
  let quoted = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && c === ",") {
      out.push(chain.slice(start, i));
      start = i + 1;
    }
  }
  out.push(chain.slice(start));
  return out.map((f) => f.trim()).filter(Boolean);
}

export const filterName = (f: string) => f.split("=")[0]!.trim();

/** The ffmpeg arguments that bake a chain of per-pixel filters into a Hald table on stdout. */
export function lutArgs(filters: string[]): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", haldClutChain(filters), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
}

const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** FFmpeg's crop position: rounded to nearest, ties to even (lrint), then kept on the 4:2:0 chroma grid. */
export function cropPosition(v: number): number {
  const r = Math.round(v);
  const nearest = Math.abs(v - Math.trunc(v)) === 0.5 ? 2 * Math.round(v / 2) : r;
  return nearest & ~1;
}
/** Rounded to nearest, ties to even (lrint). */
const roundEven = (v: number) => (Math.abs(v - Math.trunc(v)) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v));

/** FFmpeg's mod: the remainder with the sign of the divisor. */
const fmod = (a: number, b: number) => a - b * Math.floor(a / b);

/**
 * The rectangles the zoompan helper (helpers.ts) shows: `zoom` per frame, the top-left corner from
 * `x` and `y` (given the zoom), clipped inside the picture. The perspective filter it runs through
 * counts frames from 1 (its `on` is 1 on the first frame), so frame j is evaluated at j + 1.
 */
function zoomRects(ctx: EffectContext, frames: number, zoom: (on: number) => number, x?: (on: number, z: number) => number, y?: (on: number, z: number) => number): [number, number, number, number][] {
  const { width: W, height: H } = ctx;
  return Array.from({ length: Math.max(1, frames) }, (_, j) => {
    const on = j + 1;
    const z = clip(zoom(on), 1, 10);
    const [w, h] = [W / z, H / z];
    const rx = clip(x ? x(on, z) : W / 2 - W / z / 2, 0, W - w);
    const ry = clip(y ? y(on, z) : H / 2 - H / z / 2, 0, H - h);
    return [rx, ry, w, h];
  });
}

/** An operation, or a color chain still to be baked (neighboring chains are merged first). */
type Step = PlanOp | { op: "color"; filters: string[] };

/**
 * An effect as engine operations, or why the engine cannot draw it yet. `frames` is how many frames
 * the piece it is on shows (a clip, or the whole primary track for whole-video effects).
 */
function effectSteps(e: Effect, ctx: EffectContext, frames: number, time: FrameTime = clipTime(ctx.fps)): Step[] | string {
  if (e.mask) return `${e.type} with a mask`;
  if (e.keyframes?.length) return `${e.type} with keyframes`;
  const def = getEffect(e.type);
  if (!def) return `unknown effect ${e.type}`;
  const p = def.params.parse(e.params ?? {}) as Record<string, number | string | undefined>;
  const { width: W, height: H, fps: F } = ctx;
  switch (e.type) {
    case "blur":
      return (p.amount as number) > 0 ? [{ op: "blur", sigma: p.amount as number }] : [];
    case "vignette":
      return [{ op: "vignette", angle: round3(0.2 + (p.strength as number) * 0.8) }];
    case "letterbox": {
      const visible = Math.min(H, Math.round(W / (p.ratio as number)));
      return [{ op: "bars", height: Math.max(0, Math.floor((H - visible) / 2)) }];
    }
    case "chromaticAberration": {
      // Radial: lenscorrection on each RGB plane (8-bit), k1 per channel.
      if (p.radial) return [{ op: "lens", k1: 0, k2: 0, rgb: chromaticAberrationRadial(p.amount as number) }];
      const a = Math.round(p.amount as number);
      return [{ op: "shift", red: [-a, 0], green: [0, 0], blue: [a, 0] }];
    }
    case "grain":
      return (p.amount as number) > 0 ? [{ op: "noise", strength: p.amount as number, uniform: true }] : [];
    case "glitch": {
      const a = Math.round(p.amount as number);
      return [
        { op: "shift", red: [a, 0], green: [-Math.round(a / 2), 0], blue: [0, -Math.round(a / 2)] },
        // rgbashift leaves the frames in RGB, so the noise lands on R, G and B.
        { op: "noise", strength: Math.round(a * 1.5), uniform: false, rgb: true },
      ];
    }
    case "halation":
    case "bloom":
    case "anamorphicFlare": {
      // Highlights kept and eased in, blurred (radii averaged), tinted, then added on (gbrp16le there).
      const g = GLOWS[e.type](p as Record<string, number>, ctx);
      const blur = ([sx, sy]: [number, number]): PlanOp => ({ op: "blur", sigma: sx, sigmaV: sy, rgb: true });
      const sigmas = glowSigmas(g);
      const light: PlanOp[] = [
        { op: "lut", args: lutArgs(glowKeep(g.threshold)) },
        sigmas.length === 1 ? blur(sigmas[0]!) : { op: "average", branches: sigmas.map((s) => [blur(s)]) },
        { op: "tint", gains: g.tint.map(round3) as [number, number, number] },
      ];
      return [{ op: "branch", ops: light, blend: { mode: "addition", opacity: glowOpacity(g) } }];
    }
    case "filmGrain": {
      const g = grainSpec(p as { amount: number; stock: "fine" | "medium" | "coarse" }, ctx);
      return g.strength > 0 ? [{ op: "grain", size: g.size, strength: g.strength, seed: p.seed as number }] : [];
    }
    case "gateWeave": {
      // perspective counts frames from 1: frame j of the piece is `on` j + 1.
      const g = gateWeave(p as { amount: number; seed: number }, ctx);
      const maps = Array.from({ length: Math.max(1, frames) }, (_, j) => {
        const t = (j + 1) / F;
        const [dx, dy, angle] = g.waves.map((v) => v.at(t));
        const ref = g.corners.map(([ox, oy]): [number, number] => [g.cx + ox * Math.cos(angle!) - oy * Math.sin(angle!) + dx!, g.cy + ox * Math.sin(angle!) + oy * Math.cos(angle!) + dy!]);
        return perspectiveMap(ref, W, H);
      });
      return [{ op: "warp", maps, cubic: true }];
    }
    case "lensDistortion": {
      const { k1, k2 } = lensDistortion(p as { amount: number });
      return k1 || k2 ? [{ op: "lens", k1, k2 }] : [];
    }
    case "lightRays": {
      const r = lightRays(p as Parameters<typeof lightRays>[0], ctx);
      // crop rounds its offsets to nearest (ties to even); on RGB there is no chroma grid to keep.
      const zooms = r.zooms.map((z): [number, number, number, number] => [z.width, z.height, roundEven(z.x), roundEven(z.y)]);
      return [{ op: "rays", size: r.size, curve: lutArgs([r.curve]), zooms, levels: lutArgs([r.levels]) }];
    }
    case "lightLeak":
    case "bokehLights": {
      const c = parseColor(p.color as string);
      const canvas = lightCanvas(ctx);
      const base = { op: "light" as const, canvas: [canvas.w, canvas.h] as [number, number], color: [c.r / 255, c.g / 255, c.b / 255] as [number, number, number], opacity: round3(clip(p.opacity as number, 0, 1)) };
      if (e.type === "lightLeak") return [{ ...base, leak: lightLeakSpeeds(p as { speed: number }) }];
      // overlay's position, per frame: the expression's value truncated, then kept even (a 4:2:0 canvas).
      const orbs = bokehOrbs(p as { count: number; size: number; speed: number }, ctx);
      const place = (v: number) => Math.trunc(v) & ~1;
      const fmodPos = (a: number, b: number) => a - b * Math.floor(a / b);
      const perFrame = Array.from({ length: Math.max(1, frames) }, (_, j) => {
        const t = j / F;
        return orbs.map((o, i): [number, number, number, number] => [place(o.x0 + o.sway * Math.sin(t * o.swaySpeed + i)), place(fmodPos(o.y0 - t * o.v, o.span) - o.size), o.size, o.alpha]);
      });
      return [{ ...base, orbs: perFrame }];
    }
    case "zoomBlur": {
      // zoomBlur's graph (motion.ts): copies scaled up a little more each, cropped back about the
      // point (crop rounds to nearest, ties to even, then keeps the 4:2:0 grid), and mixed.
      const n = 5;
      const place = (v: number, room: number) => Math.min(room, Math.max(0, roundEven(v))) & ~1;
      const branches = Array.from({ length: n }, (_, i): PlanOp[] => {
        const s = 1 + ((p.amount as number) / 100) * 0.18 * (i / (n - 1));
        const [w, h] = [Math.round((W * s) / 2) * 2, Math.round((H * s) / 2) * 2];
        // scale to the frame's own size passes the frame through.
        if (w === W && h === H) return [];
        const [x, y] = [place(round3((w - W) * (p.x as number)), w - W), place(round3((h - H) * (p.y as number)), h - H)];
        return [{ op: "move", size: [w, h], frames: [[x, y, 0]], rotate: false }];
      });
      return [{ op: "mix", branches }];
    }
    case "glow": {
      const g = glowEffect(p as { strength: number; threshold: number; radius: number }, ctx);
      return [{ op: "branch", ops: [{ op: "lut", args: lutArgs([g.curve]) }, { op: "blur", sigma: g.sigma, rgb: true }], blend: { mode: "screen", opacity: g.opacity } }];
    }
    case "flash":
      return [{ op: "fade", color: [1, 1, 1], out: false, start: 0, duration: p.duration as number }];
    case "fadeIn":
      return [{ op: "fade", color: [0, 0, 0], out: false, start: 0, duration: p.duration as number }];
    case "fadeOut":
      return [{ op: "fade", color: [0, 0, 0], out: true, start: round3(Math.max(0, ctx.duration - (p.duration as number))), duration: p.duration as number }];
    case "zoom": {
      const s = p.scale as number;
      const [w, h] = [Math.round(W / s / 2) * 2, Math.round(H / s / 2) * 2];
      const x = cropPosition(clip(W * (p.x as number) - w / 2, 0, W - w));
      const y = cropPosition(clip(H * (p.y as number) - h / 2, 0, H - h));
      return [{ op: "crop", rects: [[x, y, w, h]], filter: "bicubic" }];
    }
    case "kenBurns": {
      const n = Math.max(1, Math.round(ctx.duration * F));
      const [z0, dz] = [p.zoomFrom as number, round3((p.zoomTo as number) - (p.zoomFrom as number))];
      const pan = p.pan as string;
      const prog = (on: number) => on / n;
      const x = pan === "left" ? (on: number, z: number) => (W - W / z) * (1 - prog(on)) : pan === "right" ? (on: number, z: number) => (W - W / z) * prog(on) : undefined;
      const y = pan === "up" ? (on: number, z: number) => (H - H / z) * (1 - prog(on)) : pan === "down" ? (on: number, z: number) => (H - H / z) * prog(on) : undefined;
      return [{ op: "crop", rects: zoomRects(ctx, frames, (on) => z0 + (dz * on) / n, x, y), filter: "linear" }];
    }
    case "punchIn": {
      const [interval, scale] = [p.interval as number, p.scale as number];
      return [{ op: "crop", rects: zoomRects(ctx, frames, (on) => (fmod(Math.floor(on / F / interval), 2) ? scale : 1)), filter: "linear" }];
    }
    case "pulse": {
      const period = round3(60 / (p.bpm as number));
      return [{ op: "crop", rects: zoomRects(ctx, frames, (on) => 1 + (p.amount as number) * Math.exp((-8 * fmod(on / F, period)) / period)), filter: "linear" }];
    }
  }
  // An effect that reads what only the backend prepares (a mask view's person, sky or depth matte)
  // cannot build its chain here: it is the backend's to draw, as a piece.
  let chain: string;
  try {
    chain = def.toFilter(p, { ...ctx, noBake: true });
  } catch {
    return `effect ${e.type}`;
  }
  const filters = splitChain(chain);
  // Camera moves: scale, rotate, crop; and moves through perspective.
  const move = filters && (cameraMove(filters, ctx, frames, time) ?? perspectiveWarp(filters, ctx, frames));
  if (move) return [move];
  // Color effects: their own chain, unbaked, if every filter in it works pixel by pixel; other
  // plain chains filter by filter.
  if (!filters) return `effect ${e.type}`;
  if (!filters.every((f) => PIXEL_FILTERS.has(filterName(f)))) return chainOps(filters, ctx, frames, time)?.steps ?? `effect ${e.type}`;
  if (!filters.some((f) => !["null", "format"].includes(filterName(f)))) return [];
  // The FFmpeg backend bakes some chains into one RGB table (bakeColor), and runs the rest as they
  // are: eq then works on the YUV frames without clipping them to RGB, so it runs that way here
  // too, with tables only for the RGB filters around it.
  if (/haldclut/.test(def.toFilter(p, ctx))) return [{ op: "color", filters }];
  const steps: Step[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.some((f) => !["null", "format"].includes(filterName(f)))) steps.push({ op: "color", filters: run });
    run = [];
  };
  for (const f of filters) {
    const eq = filterName(f) === "eq" ? eqOp(f) : undefined;
    if (eq) {
      flush();
      steps.push(eq);
    } else run.push(f);
  }
  flush();
  return steps;
}

/**
 * perspective's map for sense=source (calc_persp_luts in vf_perspective.c): the four source points
 * (top-left, top-right, bottom-left, bottom-right) of a `w` x `h` frame, as [a, b, c, d, e, f, g, h]
 * of the projective map from output to source, divided through by its constant term.
 */
export function perspectiveMap(ref: [number, number][], w: number, h: number): [number, number, number, number, number, number, number, number] {
  const [r0, r1, r2, r3] = ref as [[number, number], [number, number], [number, number], [number, number]];
  const x6 = ((r0[0] - r1[0] - r2[0] + r3[0]) * (r2[1] - r3[1]) - (r0[1] - r1[1] - r2[1] + r3[1]) * (r2[0] - r3[0])) * h;
  const x7 = ((r0[1] - r1[1] - r2[1] + r3[1]) * (r1[0] - r3[0]) - (r0[0] - r1[0] - r2[0] + r3[0]) * (r1[1] - r3[1])) * w;
  const q = (r1[0] - r3[0]) * (r2[1] - r3[1]) - (r2[0] - r3[0]) * (r1[1] - r3[1]);
  const x0 = q * (r1[0] - r0[0]) * h + x6 * r1[0];
  const x1 = q * (r2[0] - r0[0]) * w + x7 * r2[0];
  const x2 = q * r0[0] * w * h;
  const x3 = q * (r1[1] - r0[1]) * h + x6 * r1[1];
  const x4 = q * (r2[1] - r0[1]) * w + x7 * r2[1];
  const x5 = q * r0[1] * w * h;
  const x8 = q * w * h;
  return [x0 / x8, x1 / x8, x2 / x8, x3 / x8, x4 / x8, x5 / x8, x6 / x8, x7 / x8];
}

/** A filter's options: positional and named (`name=a:b:k='v'`), quotes taken off. */
export function filterOptions(filter: string): { positional: string[]; named: Record<string, string> } {
  const eq = filter.indexOf("=");
  const body = eq < 0 ? "" : filter.slice(eq + 1);
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const c of body) {
    if (c === "'") quoted = !quoted;
    else if (c === ":" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (body) parts.push(cur);
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const part of parts) {
    const m = /^([a-z0-9_]+)=([\s\S]*)$/i.exec(part);
    if (m) named[m[1]!] = m[2]!;
    else positional.push(part);
  }
  return { positional, named };
}

/**
 * The frame time effect expressions see on frame j of a piece: a clip's frames are on its 1/fps
 * timebase (t is j times 1/fps in doubles); whole-video effects run on the joined picture, which is
 * on AV_TIME_BASE (microseconds).
 */
export type FrameTime = (j: number) => number;
export const clipTime = (fps: number): FrameTime => (j) => j * (1 / fps);
export const joinedTime = (fps: number): FrameTime => (j) => Math.round((j * 1e6) / fps) * 1e-6;

/**
 * A chain of scale, an optional rotate and crop (the camera moves of motion.ts) as a move: crop's
 * and rotate's expressions evaluated per frame as FFmpeg evaluates them. crop rounds its position
 * to nearest (ties to even), keeps the window inside the picture, then on the 4:2:0 chroma grid.
 */
function cameraMove(filters: string[], ctx: EffectContext, frames: number, time: FrameTime): PlanOp | undefined {
  const names = filters.map(filterName);
  const rotated = names.length === 3 && names[1] === "rotate";
  if (names[0] !== "scale" || names.at(-1) !== "crop" || !(names.length === 2 || rotated)) return undefined;
  const scale = filterOptions(filters[0]!);
  const [sw, sh] = [Number(scale.positional[0] ?? scale.named.w), Number(scale.positional[1] ?? scale.named.h)];
  if (!Number.isInteger(sw) || !Number.isInteger(sh) || Object.keys(scale.named).length) return undefined;
  const crop = filterOptions(filters.at(-1)!);
  const [ow, oh] = [Number(crop.positional[0] ?? crop.named.w), Number(crop.positional[1] ?? crop.named.h)];
  if (ow !== ctx.width || oh !== ctx.height) return undefined;
  const xExpr = crop.positional[2] ?? crop.named.x ?? "(in_w-out_w)/2";
  const yExpr = crop.positional[3] ?? crop.named.y ?? "(in_h-out_h)/2";
  const rot = rotated ? filterOptions(filters[1]!) : undefined;
  if (rot && (rot.named.c ?? "black") !== "black") return undefined;
  const angleExpr = rot ? (rot.positional[0] ?? rot.named.a ?? rot.named.angle ?? "0") : "0";
  const out = Array.from({ length: Math.max(1, frames) }, (_, j): [number, number, number] => {
    const t = time(j);
    const vars = { t, n: j, in_w: sw, iw: sw, in_h: sh, ih: sh, out_w: ow, ow, out_h: oh, oh, a: 1, sar: 1, dar: sw / sh, hsub: 2, vsub: 2 };
    const place = (v: number, room: number) => Math.min(room, Math.max(0, roundEven(v))) & ~1;
    return [place(evalExpr(xExpr, vars), sw - ow), place(evalExpr(yExpr, vars), sh - oh), rot ? evalExpr(angleExpr, vars) : 0];
  });
  return { op: "move", size: [sw, sh], frames: out, rotate: !!rot };
}

/**
 * A perspective filter with sense=source (the zoompan-style moves of helpers.ts, and others) as a
 * warp: its corner expressions evaluated per frame with W, H, and in and on counting from 1, as the
 * filter counts them, and the projective map made from the corners as calc_persp_luts makes it.
 */
function perspectiveWarp(filters: string[], ctx: EffectContext, frames: number): PlanOp | undefined {
  if (filters.length !== 1 || filterName(filters[0]!) !== "perspective") return undefined;
  const o = filterOptions(filters[0]!).named;
  if ((o.sense ?? "source") !== "source" && o.sense !== "0") return undefined;
  const corner = (k: string, fallback: string) => o[k] ?? fallback;
  const { width: W, height: H } = ctx;
  const exprs = [
    [corner("x0", "0"), corner("y0", "0")],
    [corner("x1", "W"), corner("y1", "0")],
    [corner("x2", "0"), corner("y2", "H")],
    [corner("x3", "W"), corner("y3", "H")],
  ];
  const once = (o.eval ?? "init") === "init";
  const maps = Array.from({ length: once ? 1 : Math.max(1, frames) }, (_, j) => {
    const vars = { W, H, in: j + 1, on: j + 1 };
    return perspectiveMap(exprs.map(([x, y]): [number, number] => [evalExpr(x!, vars), evalExpr(y!, vars)]), W, H);
  });
  return { op: "warp", maps, cubic: (o.interpolation ?? "linear") === "cubic" };
}

/** Color filters that take RGB frames only. */
export const RGB_PIXEL_FILTERS = new Set(["lutrgb", "colorbalance", "colortemperature", "curves", "colorchannelmixer", "lut3d", "haldclut", "exposure", "vibrance", "huesaturation"]);
/** Filters that only take RGB frames: from them on FFmpeg keeps the frames in RGB until a filter needs YUV. */
const RGB_ONLY = new Set(["rgbashift", ...RGB_PIXEL_FILTERS]);
/** Filters that only take YUV frames. */
const YUV_ONLY = new Set(["eq", "lutyuv", "drawgrid", "unsharp"]);

/**
 * A plain chain of filters the engine draws, as operations, filter by filter, following the frame
 * format FFmpeg negotiates (RGB after rgbashift until a YUV-only filter). Undefined when a filter
 * is not one of them. Per-pixel color filters are baked into tables as elsewhere.
 */
function chainOps(filters: string[], ctx: EffectContext, frames: number, time: FrameTime, startRgb = false): { steps: Step[]; rgb: boolean } | undefined {
  const steps: Step[] = [];
  let rgb = startRgb;
  let i = 0;
  const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
  while (i < filters.length) {
    const f = filters[i]!;
    const name = filterName(f);
    const o = filterOptions(f);
    if (RGB_ONLY.has(name)) rgb = true;
    // A YUV-only filter after RGB ones: FFmpeg converts back there. The engine's pictures stay RGB,
    // and its YUV operations convert each pixel as they read it, so the frames are YUV from here.
    if (YUV_ONLY.has(name)) rgb = false;
    if (name === "format") {
      rgb = /rgb|gbr/.test(o.positional[0] ?? o.named.pix_fmts ?? "");
      i++;
      continue;
    }
    if (PIXEL_FILTERS.has(name) && name !== "eq") {
      steps.push({ op: "color", filters: [f] });
      i++;
      continue;
    }
    switch (name) {
      case "null":
        break;
      case "eq": {
        const op = eqOp(f);
        if (!op) return undefined;
        steps.push(op);
        break;
      }
      case "rgbashift": {
        const v = (k: string) => Math.round(num(o.named[k], 0));
        steps.push({ op: "shift", red: [v("rh"), v("rv")], green: [v("gh"), v("gv")], blue: [v("bh"), v("bv")] });
        break;
      }
      case "gblur": {
        const sigma = num(o.named.sigma ?? o.positional[0], 0.5);
        const sigmaV = o.named.sigmaV !== undefined ? Number(o.named.sigmaV) : undefined;
        if ((o.named.steps ?? "1") !== "1" || o.named.planes !== undefined) return undefined;
        steps.push({ op: "blur", sigma, ...(sigmaV !== undefined && sigmaV >= 0 ? { sigmaV } : {}), ...(rgb ? { rgb: true } : {}) });
        break;
      }
      case "noise": {
        const strength = num(o.named.alls ?? o.named.all_strength, 0);
        const flags = o.named.allf ?? o.named.all_flags ?? "";
        if (Object.keys(o.named).some((k) => /^c\d/.test(k))) return undefined;
        if (strength > 0) steps.push({ op: "noise", strength, uniform: /u/.test(flags), ...(rgb ? { rgb: true } : {}) });
        break;
      }
      case "drawgrid": {
        const cell = (k: string, full: number) => {
          const v = o.named[k] ?? "0";
          return v === "iw" || v === "ih" || v === "0" ? full : Number(v);
        };
        const color = o.named.c ?? o.named.color ?? "black";
        const m = /^black@([\d.]+)$/.exec(color);
        if (!m || (o.named.x ?? "0") !== "0" || (o.named.y ?? "0") !== "0") return undefined;
        steps.push({ op: "grid", cell: [cell("w", ctx.width), cell("h", ctx.height)], thickness: Math.round(num(o.named.t ?? o.named.thickness, 1)), alpha: Math.trunc(255 * Number(m[1])) / 255 });
        break;
      }
      case "hflip":
      case "vflip":
        steps.push({ op: "flip", horizontal: name === "hflip" });
        break;
      case "dilation":
        if (o.positional.length || Object.keys(o.named).length) return undefined;
        steps.push({ op: "dilate", ...(rgb ? { rgb: true } : {}) });
        break;
      case "convolution": {
        const k = (o.named["0m"] ?? "").trim().split(/\s+/).map(Number);
        const n = Math.round(Math.sqrt(k.length));
        const same = ["1m", "2m", "3m"].every((c) => (o.named[c] ?? o.named["0m"]) === o.named["0m"]) && ["1rdiv", "2rdiv", "3rdiv"].every((c) => (o.named[c] ?? o.named["0rdiv"]) === o.named["0rdiv"]);
        if (n * n !== k.length || !(n % 2) || n > 7 || !same || (o.named["0bias"] ?? "0") !== "0") return undefined;
        steps.push({ op: "conv", kernel: k, rdiv: num(o.named["0rdiv"], 1 / k.reduce((a, b) => a + b, 0)), bias: 0, ...(rgb ? { rgb: true } : {}) });
        break;
      }
      case "unsharp": {
        // Positional: luma x, y, amount, chroma x, y, amount, alpha x, y, amount.
        const keys = [["lx", "luma_msize_x"], ["ly", "luma_msize_y"], ["la", "luma_amount"], ["cx", "chroma_msize_x"], ["cy", "chroma_msize_y"], ["ca", "chroma_amount"], ["ax", "alpha_msize_x"], ["ay", "alpha_msize_y"], ["aa", "alpha_amount"]] as const;
        const defaults = [5, 5, 1, 5, 5, 0, 5, 5, 0];
        const [lx, ly, la, , , ca, , , aa] = keys.map(([short, long], k) => num(o.named[short] ?? o.named[long] ?? o.positional[k], defaults[k]!)) as number[];
        // Chroma and alpha sharpening work on planes the engine does not keep apart.
        const odd = (v: number) => Number.isInteger(v) && v % 2 === 1 && v >= 3 && v <= 23;
        // FFmpeg refuses more than 25 scale bits; past 24 its 32-bit sums can wrap.
        if (ca !== 0 || aa !== 0 || !odd(lx!) || !odd(ly!) || (Math.floor(lx! / 2) + Math.floor(ly! / 2)) * 2 > 24) return undefined;
        // The filter keeps its float amount times 65536 in an int (truncated).
        const amount = Math.trunc(Math.fround(la!) * 65536);
        if (amount) steps.push({ op: "unsharp", size: [lx!, ly!], amount });
        break;
      }
      case "scale": {
        // A scale down and the matching scale back up: the filters between run at the small size.
        const [sw, sh] = [Number(o.positional[0] ?? o.named.w), Number(o.positional[1] ?? o.named.h)];
        const back = filters.findIndex((g, k) => k > i && filterName(g) === "scale" && Number(filterOptions(g).positional[0]) === ctx.width && Number(filterOptions(g).positional[1]) === ctx.height);
        const flags = (g: string): ScaleKind | undefined => {
          const fl = filterOptions(g).named.flags ?? "bicubic";
          return fl === "bicubic" || fl === "area" || fl === "neighbor" ? fl : undefined;
        };
        if (!Number.isInteger(sw) || !Number.isInteger(sh) || back < 0) return undefined;
        const [down, up] = [flags(f), flags(filters[back]!)];
        if (!down || !up) return undefined;
        // scale converts too: when the filters after it take RGB only, it gives them RGB at once.
        const between = filters.slice(i + 1, back).map(filterName);
        const firstNeed = between.find((n) => RGB_ONLY.has(n) || YUV_ONLY.has(n));
        const inRgb = firstNeed ? RGB_ONLY.has(firstNeed) : rgb;
        const inner = chainOps(filters.slice(i + 1, back), { ...ctx, width: sw, height: sh }, frames, time, inRgb);
        if (!inner) return undefined;
        steps.push({ op: "at", size: [sw, sh], down, up, ops: bake(inner.steps), ...(inRgb ? { rgb: true } : {}) });
        rgb = inner.rgb;
        i = back + 1;
        continue;
      }
      default:
        return undefined;
    }
    i++;
  }
  return { steps, rgb };
}

/** Steps with neighboring color chains baked into one table each. */
function bake(steps: Step[]): PlanOp[] {
  const ops: PlanOp[] = [];
  let colors: string[] = [];
  const flush = () => {
    if (colors.length) ops.push({ op: "lut", args: lutArgs(colors) });
    colors = [];
  };
  for (const s of steps) {
    if (s.op === "color") colors.push(...s.filters);
    else {
      flush();
      ops.push(s);
    }
  }
  flush();
  return ops;
}

/** An eq filter with named options as an operation (undefined for other forms, which then bake). */
function eqOp(filter: string): PlanOp | undefined {
  const opts = filter.slice(filter.indexOf("=") + 1).split(":");
  const values: Record<string, number> = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, gamma_weight: 1 };
  for (const o of opts) {
    const [k, v] = o.split("=");
    if (!k || v === undefined || !(k in values) || !Number.isFinite(Number(v))) return undefined;
    values[k] = Number(v);
  }
  return { op: "eq", brightness: values.brightness!, contrast: values.contrast!, saturation: values.saturation!, gamma: values.gamma!, gammaWeight: values.gamma_weight! };
}

/** A list of effects as operations, with neighboring color tables merged into one bake; or what cannot be drawn. */
export function effectsOps(effects: Effect[], ctx: EffectContext, frames: number, time: FrameTime = clipTime(ctx.fps)): { ops: PlanOp[]; unsupported: string[] } {
  const ops: PlanOp[] = [];
  const unsupported: string[] = [];
  let colors: string[] = [];
  const flush = () => {
    if (colors.length) ops.push({ op: "lut", args: lutArgs(colors) });
    colors = [];
  };
  for (const e of effects) {
    const r = effectSteps(e, ctx, frames, time);
    if (typeof r === "string") {
      unsupported.push(r);
      continue;
    }
    for (const op of r) {
      if (op.op === "color") colors.push(...op.filters);
      else {
        flush();
        ops.push(op);
      }
    }
  }
  flush();
  return { ops, unsupported };
}
