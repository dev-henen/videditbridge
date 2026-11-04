import type { Effect } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { getEffect, haldClutChain, type EffectContext } from "../../library/effects/index.js";

/**
 * Effects as GPU render engine operations (see plan.ts). Each one follows its FFmpeg filter in the
 * backend: color effects are baked into a lookup table from their own filters, and the others are
 * computed here from the same parameters (crop rectangles per frame, bar heights, offsets), so the
 * engine draws the same picture. Keep in step with native/ave-render/src/plan.rs.
 */

export type PlanOp =
  /** A per-pixel color chain, baked by running `args` (ffmpeg writing a 512x512 rgb24 Hald table to stdout). */
  | { op: "lut"; args: string[] }
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
  /** FFmpeg's gblur (its recursive filter, not a true Gaussian). */
  | { op: "blur"; sigma: number }
  /** FFmpeg's eq on the YUV planes as they are (values past video black and white included), with its own integer math. */
  | { op: "eq"; brightness: number; contrast: number; saturation: number; gamma: number; gammaWeight: number };

/** Filters that change each pixel from its own value alone, so a chain of them can be baked into a table. */
const PIXEL_FILTERS = new Set(["eq", "colorbalance", "colortemperature", "curves", "hue", "colorchannelmixer", "negate", "colorize", "vibrance", "huesaturation", "exposure", "format", "lut3d", "null"]);

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

const filterName = (f: string) => f.split("=")[0]!.trim();

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
function effectSteps(e: Effect, ctx: EffectContext, frames: number): Step[] | string {
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
  // Color effects: their own chain, unbaked, if every filter in it works pixel by pixel.
  const filters = splitChain(def.toFilter(p, { ...ctx, noBake: true }));
  if (!filters || !filters.every((f) => PIXEL_FILTERS.has(filterName(f)))) return `effect ${e.type}`;
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
export function effectsOps(effects: Effect[], ctx: EffectContext, frames: number): { ops: PlanOp[]; unsupported: string[] } {
  const ops: PlanOp[] = [];
  const unsupported: string[] = [];
  let colors: string[] = [];
  const flush = () => {
    if (colors.length) ops.push({ op: "lut", args: lutArgs(colors) });
    colors = [];
  };
  for (const e of effects) {
    const r = effectSteps(e, ctx, frames);
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
