import { z } from "zod";
import { clamp, round3 } from "../../core/util.js";
import type { Easing } from "../../core/schema.js";
import { easeExpr } from "../../core/keyframes.js";

export interface EffectContext {
  width: number;
  height: number;
  fps: number;
  /** Duration of the clip/layer the effect is applied to (seconds, after speed). */
  duration: number;
  /** The stream has an alpha channel (media layers). */
  alpha?: boolean;
  /** Unique filter-graph label generator, for effects that branch the stream. */
  label?: (prefix: string) => string;
  /**
   * The person cutout of this clip, when the renderer prepared one: each call returns a new label of
   * a gray stream (255 = person) with the same size and timing as the clip. Undefined otherwise.
   */
  personMask?: () => string | undefined;
}

export type EffectCategory = "light" | "color" | "grade" | "retouch" | "blur" | "stylize" | "motion" | "shake" | "distort" | "time";

export interface EffectDefinition<P extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: P;
  /**
   * True when each output frame depends only on the same input frame: no time, motion, or
   * smoothing across frames. Such a global effect gives the same picture whether it runs on each
   * clip or on the joined video, so the render cache can bake it into cached clips.
   */
  perFrame?: boolean | ((params: z.output<P>) => boolean);
  /** The effect wants the clip's person cutout (EffectContext.personMask); the renderer then prepares one. */
  usesPersonMask?: (params: z.output<P>) => boolean;
  /** Returns a comma-separated FFmpeg filter chain. */
  toFilter(params: z.output<P>, ctx: EffectContext): string;
}

export const num = (def: number, min: number, max: number, desc: string) =>
  z.number().min(min).max(max).default(def).describe(desc);

export function define<P extends z.ZodType>(def: EffectDefinition<P>): EffectDefinition {
  return def as unknown as EffectDefinition;
}

/** zoompan always produces the project size; upscaling first avoids sub-pixel jitter. */
export function zoompan(ctx: EffectContext, zoomExpr: string, xExpr = "iw/2-(iw/zoom/2)", yExpr = "ih/2-(ih/zoom/2)") {
  const w2 = ctx.width * 2;
  const h2 = ctx.height * 2;
  return `scale=${w2}:${h2},zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${ctx.width}x${ctx.height}:fps=${ctx.fps}`;
}

export const SubjectRegionSchema = z.object({
  x: z.number().min(0).max(1).describe("Center x (0 = left edge, 1 = right edge)"),
  y: z.number().min(0).max(1).describe("Center y (0 = top, 1 = bottom)"),
  width: z.number().positive().max(2).describe("Ellipse width as a fraction of frame width"),
  height: z.number().positive().max(2).describe("Ellipse height as a fraction of frame height"),
});
export type SubjectRegion = z.infer<typeof SubjectRegionSchema>;

let fallbackLabel = 0;

/** Labels for a branching effect: from the compiler when available, else a module counter. */
export function labeler(ctx: EffectContext): (prefix: string) => string {
  return ctx.label ?? ((p: string) => `${p}${fallbackLabel++}`);
}

/**
 * Run `branch` on a copy of the stream and blend it back through a static mask: either
 * a feathered ellipse (inside or outside it) or, without a region, the whole frame.
 * The mask is drawn once with geq; maskedmerge holds its last frame for the whole clip.
 * Returns a graph fragment that still reads and writes one unlabeled stream.
 */
export function maskedBlend(
  ctx: EffectContext,
  branch: string,
  opts: { region?: SubjectRegion; inside: boolean; feather?: number; strength: number },
): string {
  const label = labeler(ctx);
  const [orig, copy, done, mask] = [label("fxo"), label("fxc"), label("fxb"), label("fxm")];
  const fmt = ctx.alpha ? "yuva420p" : "yuv420p";
  const s = round3(clamp(opts.strength, 0, 1) * 255);
  let e = String(s);
  if (opts.region) {
    const r = opts.region;
    const f = round3(clamp(opts.feather ?? 0.3, 0.02, 1));
    // Normalized distance from the ellipse center: 1 on its edge. X/SW maps chroma samples to luma pixels.
    const d = `hypot((X/SW/W-${round3(r.x)})/${round3(r.width / 2)},(Y/SH/H-${round3(r.y)})/${round3(r.height / 2)})`;
    const outside = `clip((${d}-1+${f})/${round3(2 * f)},0,1)`;
    e = `${s}*${opts.inside ? `(1-${outside})` : outside}`;
  }
  const planes = `lum='${e}':cb='${e}':cr='${e}'${ctx.alpha ? `:a='${e}'` : ""}`;
  return [
    `format=${fmt},split=2[${orig}][${copy}]`,
    `[${copy}]${branch}[${done}]`,
    `nullsrc=s=${ctx.width}x${ctx.height}:r=${ctx.fps},trim=end_frame=1,format=${fmt},geq=${planes}[${mask}]`,
    `[${orig}][${done}][${mask}]maskedmerge`,
  ].join(";");
}

/**
 * Keep the person sharp and run `background` on everything else, following the person's outline
 * frame by frame through the cutout stream `mask`. `feather` (0..1) softens the edge, and
 * `shrink` pulls the edge inward first, so a soft edge does not show the old scene around the person.
 */
export function personBlend(ctx: EffectContext, mask: string, background: string, feather: number, shrink = false): string {
  const label = labeler(ctx);
  const [orig, copy, bg, soft, person] = [label("fpo"), label("fpc"), label("fpb"), label("fpm"), label("fpp")];
  const sigma = round3(Math.max(0.5, clamp(feather, 0, 1) * Math.min(ctx.width, ctx.height) * 0.02));
  return [
    `format=yuv420p,split=2[${orig}][${copy}]`,
    `[${copy}]${background}[${bg}]`,
    `[${mask}]format=gray,${shrink ? `${Array(Math.max(1, Math.round(Math.min(ctx.width, ctx.height) / 360))).fill("erosion").join(",")},` : ""}gblur=sigma=${sigma}[${soft}]`,
    `[${orig}][${soft}]alphamerge[${person}]`,
    `[${bg}][${person}]overlay=format=auto:shortest=1,format=yuv420p`,
  ].join(";");
}

/**
 * Blend `branch` (run on a copy) back over the stream as it plays, by an amount that changes
 * over time: `amountAt` is an expression of T (seconds from the clip start) giving 0..1.
 * The mask is a tiny time-varying frame scaled up, so it costs almost nothing.
 */
export function timedBlend(ctx: EffectContext, branch: string, amountAt: string): string {
  const label = labeler(ctx);
  const [orig, copy, done, mask] = [label("fto"), label("ftc"), label("ftb"), label("ftm")];
  const fmt = ctx.alpha ? "yuva420p" : "yuv420p";
  const e = `255*clip(${amountAt},0,1)`;
  const planes = `lum='${e}':cb='${e}':cr='${e}'${ctx.alpha ? `:a='${e}'` : ""}`;
  return [
    `format=${fmt},split=2[${orig}][${copy}]`,
    `[${copy}]${branch}[${done}]`,
    `nullsrc=s=16x16:r=${ctx.fps}:d=${round3(ctx.duration + 1)},format=${fmt},geq=${planes},scale=${ctx.width}:${ctx.height}:flags=neighbor[${mask}]`,
    // The mask outlasts the clip; maskedmerge has no shortest option, so cut back to the clip length.
    `[${orig}][${done}][${mask}]maskedmerge,trim=duration=${round3(ctx.duration)}`,
  ].join(";");
}

/**
 * An effect that changes over time: each state's filter runs on its own copy of the stream, and
 * the copies are blended one into the next as `times` pass (with `easings`), through tiny
 * time-varying masks scaled up, so the blend costs almost nothing beyond the copies themselves.
 */
export function rampFilter(ctx: EffectContext, chains: string[], times: number[], easings: Easing[]): string {
  const label = labeler(ctx);
  const fmt = ctx.alpha ? "yuva420p" : "yuv420p";
  const ins = chains.map(() => label("frs"));
  const outs = chains.map(() => label("frr"));
  const parts = [`format=${fmt},split=${chains.length}${ins.map((l) => `[${l}]`).join("")}`];
  chains.forEach((c, i) => parts.push(`[${ins[i]}]${c},format=${fmt}[${outs[i]}]`));
  let acc = outs[0]!;
  for (let i = 1; i < chains.length; i++) {
    const span = Math.max(0.001, times[i]! - times[i - 1]!);
    const e = `255*${easeExpr(`clip((T-${round3(times[i - 1]!)})/${round3(span)},0,1)`, easings[i]!)}`;
    const [mask, next] = [label("frm"), label("fra")];
    parts.push(
      `nullsrc=s=16x16:r=${ctx.fps}:d=${round3(ctx.duration + 1)},format=${fmt},geq=lum='${e}':cb='${e}':cr='${e}'${ctx.alpha ? `:a='${e}'` : ""},scale=${ctx.width}:${ctx.height}:flags=neighbor[${mask}]`,
    );
    // The masks outlast the stream and maskedmerge has no shortest option, so cut back each time.
    parts.push(`[${acc}][${outs[i]}][${mask}]maskedmerge,trim=duration=${round3(ctx.duration)}${i < chains.length - 1 ? `[${next}]` : ""}`);
    acc = next;
  }
  return parts.join(";");
}

/**
 * Size of the low-resolution canvas light layers are drawn on: 1/8 of the frame, with the short
 * side capped at 120 px. Soft light looks the same scaled up, and geq cost grows with pixels.
 */
export function lightCanvas(ctx: EffectContext): { w: number; h: number } {
  const k = Math.min(1 / 8, 120 / Math.min(ctx.width, ctx.height));
  return { w: Math.max(16, Math.round((ctx.width * k) / 2) * 2), h: Math.max(16, Math.round((ctx.height * k) / 2) * 2) };
}

/** A graph fragment producing a gray light canvas (lightCanvas size) as the labeled stream `out`. */
export interface LightSource {
  lines: string[];
  out: string;
}

/** Light canvas drawn per pixel with geq: X, Y in canvas pixels, W, H its size, T in seconds. */
export function geqLight(ctx: EffectContext, lumaExpr: string): LightSource {
  const out = labeler(ctx)("flg");
  const { w, h } = lightCanvas(ctx);
  return { lines: [`nullsrc=s=${w}x${h}:r=${ctx.fps}:d=${round3(ctx.duration + 1)},format=gray,geq=lum='${lumaExpr}'[${out}]`], out };
}

/**
 * Lay generated light over the stream: the gray canvas from `source` becomes the alpha of a
 * solid layer in `color`, overlaid on the picture, so light glows in its color where bright.
 * Staying in YUV avoids converting every full-size frame to RGB and back for a screen blend.
 * Used for floating lights and light leaks.
 */
export function lightLayer(ctx: EffectContext, source: LightSource, color: string, opacity: number): string {
  const label = labeler(ctx);
  const [base, alpha, solid, light] = [label("flb"), label("fla"), label("fls"), label("fll")];
  const d = round3(ctx.duration + 1);
  return [
    `format=${ctx.alpha ? "yuva420p" : "yuv420p"}[${base}]`,
    ...source.lines,
    `[${source.out}]scale=${ctx.width}:${ctx.height}:flags=bicubic,lut=c0='val*${round3(clamp(opacity, 0, 1))}'[${alpha}]`,
    `color=c=0x${color.replace(/^#/, "").slice(0, 6)}:s=${ctx.width}x${ctx.height}:r=${ctx.fps}:d=${d},format=yuva420p[${solid}]`,
    `[${solid}][${alpha}]alphamerge[${light}]`,
    `[${base}][${light}]overlay=shortest=1`,
  ].join(";");
}

/**
 * Sum of hit envelopes at the given times: each rises over `attack` seconds, then decays
 * exponentially at `decay` per second. `t` is the time variable of the filter ("t" or "it").
 */
export function hitEnvelope(t: string, times: number[], attack: number, decay: number): string {
  if (!times.length) return "0";
  const a = round3(Math.max(0.001, attack));
  return times
    .map((ti) => {
      const s = round3(ti);
      return `if(gte(${t},${s}),if(lt(${t},${s}+${a}),(${t}-${s})/${a},exp(-(${t}-${s}-${a})*${round3(decay)})),0)`;
    })
    .join("+");
}

/** 1 inside any [time, time + length) window, else 0; or 1 always when no times are given. */
export function windows(t: string, times: number[] | undefined, length: number): string {
  if (!times?.length) return "1";
  return `min(1,${times.map((ti) => `between(${t},${round3(ti)},${round3(ti + length)})`).join("+")})`;
}

/** Easing of a 0..1 progress expression. */
export function ease(p: string, easing: "linear" | "ease-in" | "ease-out" | "ease-in-out"): string {
  switch (easing) {
    case "linear":
      return p;
    case "ease-in":
      return `pow(${p},2)`;
    case "ease-out":
      return `(1-pow(1-${p},2))`;
    case "ease-in-out":
      return `(pow(${p},2)*(3-2*${p}))`;
  }
}

/** Times inside the clip, relative to its start (seconds). */
export const TimesSchema = z
  .array(z.number().min(0))
  .max(64)
  .describe("Moments, in seconds from the start of the clip or layer it is on (add_moment_effect and beat_sync fill these from timeline times)");
