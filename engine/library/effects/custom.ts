import { z } from "zod";
import { define, yuvFormat, type EffectDefinition } from "./helpers.js";

/**
 * FFmpeg filters a custom effect may use: ones that only change the picture of the stream they get.
 * Filters that read or write files, take extra streams or change timing are left out.
 */
export const CUSTOM_FILTERS = new Set([
  // color and tone
  "eq", "hue", "curves", "colorbalance", "colorchannelmixer", "colorlevels", "colortemperature", "colorcontrast", "colorcorrect", "colorize",
  "vibrance", "selectivecolor", "huesaturation", "exposure", "lutrgb", "lutyuv", "lut", "negate", "monochrome", "grayworld", "normalize", "pseudocolor",
  // per-pixel math
  "geq",
  // blur, sharpen, detail
  "gblur", "boxblur", "avgblur", "dblur", "smartblur", "unsharp", "cas", "convolution", "edgedetect", "sobel", "prewitt", "roberts", "deband", "gradfun", "bilateral", "median",
  // stylize
  "vignette", "noise", "chromashift", "rgbashift", "pixelize", "elbg", "posterize", "kirsch", "colorhold", "chromakey", "colorkey", "hsvhold", "hsvkey",
  // geometry (the frame size is restored after the chain)
  "lenscorrection", "rotate", "hflip", "vflip", "transpose", "crop", "scale", "pad", "perspective", "shear", "swaprect", "v360", "fillborders",
  // over time
  "tmix", "lagfun", "tblend", "deflicker", "fade",
  // formats
  "format", "setsar", "null",
]);
/** Filters that mix frames over time (the effect then cannot be cached per clip). */
const TEMPORAL = new Set(["tmix", "lagfun", "tblend", "deflicker", "fade", "normalize"]);
/** Filters whose output size may differ from their input. */
const RESIZING = new Set(["rotate", "transpose", "crop", "scale", "pad", "v360"]);

/** Split a filter chain at its top-level commas (not inside quotes or after a backslash). */
export function splitChain(chain: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]!;
    if (c === "\\" && i + 1 < chain.length) {
      cur += c + chain[++i];
      continue;
    }
    if (c === "'") quoted = !quoted;
    if (c === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (quoted) throw new Error("Unbalanced quote in the filter chain");
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** Check a custom filter chain; returns its filters' names. Throws with the reason when it is not allowed. */
export function checkCustomFilter(chain: string): string[] {
  if (/[[\];]/.test(chain.replace(/'[^']*'/g, ""))) throw new Error("A custom effect is one chain of filters for one stream: no [labels] or ; between chains");
  const parts = splitChain(chain);
  if (!parts.length) throw new Error("The filter chain is empty");
  return parts.map((p) => {
    const name = p.split("=")[0]!.trim();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`"${p}" does not start with a filter name`);
    if (!CUSTOM_FILTERS.has(name)) throw new Error(`The filter "${name}" is not allowed in custom effects. Allowed: ${[...CUSTOM_FILTERS].join(", ")}`);
    return name;
  });
}

/** Whether a custom chain depends on time: filters that mix frames, or expressions using t, T, n or N. */
export function customIsTimed(chain: string): boolean {
  if (checkCustomFilter(chain).some((n) => TEMPORAL.has(n))) return true;
  return splitChain(chain).some((p) => /(^|[^A-Za-z_])(t|T|n|N|pts|time)([^A-Za-z_0-9]|$)/.test(p.slice(p.indexOf("=") + 1)));
}

export const customEffect: EffectDefinition = define({
  id: "custom",
  name: "Custom",
  category: "stylize",
  description:
    "Your own effect as an FFmpeg filter chain (comma-separated filters for one stream), for looks the catalog does not have: e.g. 'geq=r=...:g=...:b=...' per-pixel math with X, Y, W, H, T, " +
    "'rgbashift=rh=6:bh=-6,noise=alls=12:allf=t' for a glitch, 'lagfun=decay=0.95' for light trails, 'lenscorrection=k1=-0.3:k2=0.05' for a fisheye. " +
    `Allowed filters: ${[...CUSTOM_FILTERS].join(", ")}. The frame size is kept. Save a good one with create_effect to reuse it by name.`,
  params: z.object({
    filter: z.string().min(1).max(4000).default("null").describe("FFmpeg filter chain"),
    name: z.string().optional().describe("Name of the saved effect this came from (create_effect)"),
  }),
  perFrame: (p) => {
    try {
      return !customIsTimed(p.filter);
    } catch {
      return false;
    }
  },
  toFilter: (p, ctx) => {
    const names = checkCustomFilter(p.filter);
    // Geometry filters may change the size; later steps expect the stream's own size.
    const resize = names.some((n) => RESIZING.has(n)) ? `,scale=${ctx.width}:${ctx.height},setsar=1` : "";
    return `${p.filter}${resize},format=${yuvFormat(ctx)}`;
  },
});
