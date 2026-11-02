import { z } from "zod";
import { round3, toFfmpegColor } from "../../core/util.js";
import { define, labeler, num, type EffectContext, type EffectDefinition } from "./helpers.js";

/**
 * Effects that read the clip's depth (EffectContext.depthMask: 0 = the nearest things in the clip,
 * 255 = the farthest; see estimate_depth): depth of field, fog by distance, and a 2.5D camera move.
 * Section 7.1 of docs/design/cinematic-grade-and-vfx.md.
 */

/** Soft depth bands depth of field and parallax cut the picture into. */
const BANDS = 6;
/** Half the width of the soft edge between two bands, in distance. */
const BAND_SOFT = 0.03;

const scaleOf = (ctx: EffectContext) => Math.min(ctx.width, ctx.height) / 1080;

/** "Farther than b" as a lut expression of the depth value (val, 0..255): 0 nearer, 1 farther, soft over `soft` either side. */
const farther = (b: number, soft = BAND_SOFT) => {
  if (b <= 0) return "1";
  if (b >= 1) return "0";
  const u = `clip((val/255-${round3(b - soft)})/${round3(2 * soft)},0,1)`;
  return `(${u}*${u}*(3-2*${u}))`;
};

/** The depth stream, or a clear error where there is none. */
function depthStream(ctx: EffectContext, what: string): string {
  const d = ctx.depthMask?.();
  if (!d) throw new Error(`${what} works on primary video and photo clips only (it needs the clip's depth); use estimate_depth to check it`);
  return d;
}

export const FocusKeySchema = z.object({
  time: z.number().min(0).describe("Seconds from the clip's start"),
  focus: z.number().min(0).max(1).describe("Distance in focus then (0 near .. 1 far)"),
});

export const DepthOfFieldParams = z.object({
  focus: num(0.2, 0, 1, "Distance in focus, 0 = the nearest things in the clip, 1 = the farthest (estimate_depth tells the distance of a point or object)"),
  focusPath: z.array(FocusKeySchema).max(200).optional().describe("Rack focus: the distance in focus over time, eased between points; replaces focus while set"),
  range: num(0.1, 0, 0.6, "How deep the sharp zone around the focus is (0 = a thin plane, like a wide-open lens)"),
  blur: num(25, 0, 100, "Blur of the most out-of-focus parts, in pixels at 1080p"),
});

/** Blur (gblur sigma) of a band centered at `c` for a focus distance. */
function bandSigma(p: z.output<typeof DepthOfFieldParams>, ctx: EffectContext, c: number, focus: number): number {
  const off = Math.max(0, Math.abs(c - focus) - p.range / 2);
  return round3(Math.max(0.01, p.blur * 0.5 * scaleOf(ctx) * Math.min(1, off / 0.45)));
}

/** The focus distance at a time, eased between keys (smoothstep), held before the first and after the last. */
export function focusAt(keys: { time: number; focus: number }[], t: number): number {
  if (t <= keys[0]!.time) return keys[0]!.focus;
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1]!, keys[i]!];
    if (t <= b.time) {
      const u = (t - a.time) / (b.time - a.time || 1);
      return a.focus + (b.focus - a.focus) * u * u * (3 - 2 * u);
    }
  }
  return keys[keys.length - 1]!.focus;
}

/**
 * Depth of field from the depth bands. Each band's color is a normalized blur of that band alone
 * (premultiplied by its matte, blurred, divided by the blurred matte), so a sharp subject never
 * smears into the blurred background behind it, and the background fills in behind the subject's
 * edge. Bands go on far to near, each covering its own blurred matte (so blurred foreground spills
 * over what is behind it, as through a real lens) and, sharply, itself and everything nearer (so no
 * gap opens where a blurred band ends; nearer bands then cover that). Neighboring bands still add up
 * to exactly the picture where they meet. A rack
 * focus changes each band's blur over time with commands to its blur filters.
 */
function depthOfFieldFilter(p: z.output<typeof DepthOfFieldParams>, ctx: EffectContext): string {
  const label = labeler(ctx);
  const depth = depthStream(ctx, "Depth of field");
  const keys = p.focusPath?.length ? [...p.focusPath].sort((a, b) => a.time - b.time) : undefined;
  const focus0 = keys ? focusAt(keys, 0) : p.focus;
  const pics = Array.from({ length: BANDS }, () => label("dpc"));
  const lines = [`format=gbrp,split=${BANDS}${pics.map((x) => `[${x}]`).join("")}`];
  const owns = Array.from({ length: BANDS }, () => label("dpm"));
  const covers = Array.from({ length: BANDS }, () => label("dpa"));
  const centers = Array.from({ length: BANDS }, (_, k) => (k + 0.5) / BANDS);
  // Each blur filter has a name unique to this effect, so a rack focus's commands reach it.
  const id = label("dof");
  const blurName = (x: string, b: number) => `gblur@${id}${x}${b}`;
  // The commands of a rack focus: every band's blur, ten times a second.
  let send = "";
  if (keys) {
    const end = Math.max(ctx.duration, keys[keys.length - 1]!.time);
    const steps: string[] = [];
    for (let k = 0; k * 0.1 <= end + 1e-6; k++) {
      const t = round3(k * 0.1);
      const f = focusAt(keys, t);
      steps.push(`${t} ${centers.map((c, b) => ["c", "m"].map((x) => `${blurName(x, b)} sigma ${bandSigma(p, ctx, c, f)}`).join(",")).join(",")}`);
    }
    send = steps.join(";");
  }
  lines.push(`[${depth}]${send ? `sendcmd=c='${send}',` : ""}format=gray,split=${2 * BANDS}${[...owns, ...covers].map((x) => `[${x}s]`).join("")}`);
  let acc: string | undefined;
  for (let b = BANDS - 1; b >= 0; b--) {
    const [lo, hi] = [b / BANDS, (b + 1) / BANDS];
    const sigma = bandSigma(p, ctx, centers[b]!, focus0);
    // Own band: farther than its near edge and not farther than its far edge.
    const own = `255*clip(${farther(lo)}-${farther(hi)},0,1)`;
    const cover = b === BANDS - 1 ? "255" : `255*(1-${farther(hi)})`;
    const [m, mb, pm, n, a, layer] = [owns[b]!, label("dpb"), label("dpp"), label("dpn"), covers[b]!, label("dpl")];
    const [mbu, alpha] = [label("dpu"), label("dpv")];
    // The blurs run in 16 bits: dividing by a small blurred weight in 8 bits gives wrong colors.
    lines.push(`[${m}s]lut=c0='${own}',format=gray16le,split=2[${m}][${m}x]`);
    lines.push(`[${pics[b]}]format=gbrp16le[${pics[b]}w];[${pics[b]}w][${m}]premultiply=inplace=0,${blurName("c", b)}=sigma=${sigma}[${pm}]`);
    lines.push(`[${m}x]${blurName("m", b)}=sigma=${sigma},split=2[${mb}][${mbu}w];[${mbu}w]format=gray[${mbu}]`);
    lines.push(`[${pm}][${mb}]unpremultiply=inplace=0,format=gbrp[${n}]`);
    lines.push(`[${a}s]lut=c0='${cover}'[${a}]`);
    lines.push(`[${mbu}][${a}]blend=all_mode=lighten[${alpha}]`);
    lines.push(`[${n}][${alpha}]alphamerge[${layer}]`);
    if (!acc) {
      acc = layer;
      continue;
    }
    const next = label("dpo");
    lines.push(`[${acc}][${layer}]overlay=format=gbrp[${next}]`);
    acc = next;
  }
  lines.push(`[${acc}]format=${ctx.alpha ? "yuva420p" : "yuv420p"}`);
  return lines.join(";");
}

export const DepthFogParams = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#C9D2DC").describe("Fog color #RRGGBB (pale blue-gray by default; warmer for dust or a sunset)"),
  density: num(0.6, 0, 1, "How much fog the farthest things are under (1 = hidden)"),
  start: num(0.25, 0, 0.95, "Distance where the fog begins (0 near .. 1 far)"),
  falloff: num(3, 0.5, 10, "How fast the fog thickens with distance past start (higher is a denser wall of fog)"),
});

/** Fog by distance: the fog color laid over the picture, thickening exponentially past `start`. */
function depthFogFilter(p: z.output<typeof DepthFogParams>, ctx: EffectContext): string {
  const label = labeler(ctx);
  const depth = depthStream(ctx, "Depth fog");
  const [base, alpha, solid, fog] = [label("dfb"), label("dfa"), label("dfs"), label("dff")];
  const u = `max(0,(val/255-${round3(p.start)})/${round3(1 - p.start)})`;
  const k = round3(p.falloff);
  const amount = `255*${round3(p.density)}*(1-exp(-${k}*${u}))/${round3(1 - Math.exp(-p.falloff))}`;
  const fmt = ctx.alpha ? "yuva420p" : "yuv420p";
  return [
    `format=${fmt}[${base}]`,
    `[${depth}]format=gray,lut=c0='clip(${amount},0,255)'[${alpha}]`,
    `color=c=${toFfmpegColor(p.color)}:s=${ctx.width}x${ctx.height}:r=${ctx.fps}:d=${round3(ctx.duration + 1)},format=yuva420p[${solid}]`,
    `[${solid}][${alpha}]alphamerge[${fog}]`,
    `[${base}][${fog}]overlay=shortest=1:format=auto,format=${fmt}`,
  ].join(";");
}

export const ParallaxParams = z.object({
  x: num(0.04, -0.3, 0.3, "How far the camera moves sideways over the clip, as a fraction of frame width (+ right): near things shift the most"),
  y: num(0, -0.3, 0.3, "How far it moves up or down (+ down)"),
  zoom: num(0.08, -0.5, 0.5, "How far it pushes in (+) or pulls out (-) over the clip: near things grow the most"),
  layers: z.number().int().min(3).max(12).default(8).describe("Depth layers the picture is cut into (more is smoother, and slower)"),
});

/**
 * A 2.5D camera move: the picture is cut into depth layers, each filled in behind the nearer ones
 * (a wide normalized blur of what is farther), and the layers move apart over the clip, near ones
 * more, as if the camera moved through the scene. The whole frame is enlarged a little so moving
 * layers never show the edge.
 */
function parallaxFilter(p: z.output<typeof ParallaxParams>, ctx: EffectContext): string {
  const label = labeler(ctx);
  const depth = depthStream(ctx, "Parallax");
  const L = p.layers;
  const { width: W, height: H } = ctx;
  const d = Math.max(0.04, ctx.duration);
  const prog = `(clip(on/${ctx.fps}/${round3(d)},0,1))`;
  const ease = `(${prog}*${prog}*(3-2*${prog}))`;
  // Enough margin for the farthest any layer goes.
  const margin = 1 + 2 * Math.max(Math.abs(p.x), Math.abs(p.y)) + Math.max(0, -p.zoom) * 1.2;
  const pics = Array.from({ length: 2 * L }, () => label("plc"));
  const ds = Array.from({ length: 2 * L }, () => label("pld"));
  const lines = [`format=gbrp,split=${2 * L}${pics.map((x) => `[${x}]`).join("")}`, `[${depth}]format=gray,split=${2 * L}${ds.map((x) => `[${x}]`).join("")}`];
  const fillSigma = round3(40 * scaleOf(ctx));
  // Neighboring layers move a few pixels apart; crossing over half a layer turns that into a slight
  // softening on smooth depth (a receding floor) instead of a double line.
  const soft = 0.5 / L;
  let acc: string | undefined;
  for (let b = L - 1; b >= 0; b--) {
    const [lo, hi] = [b / L, (b + 1) / L];
    // Nearness of the layer's middle: near layers move most.
    const near = 1 - (b + 0.5) / L;
    const [behind, sharp, fillW, own, layer, moved] = [label("plb"), label("pls"), label("plw"), label("plo"), label("pll"), label("plm")];
    // The layer and everything behind it, with the holes nearer things leave filled from around them.
    const backW = label("plk");
    lines.push(`[${ds[2 * b]}]lut=c0='255*${farther(lo, soft)}',split=2[${fillW}][${behind}k]`);
    // The fill weight never reaches 0, so far from the layer the fill is a plain blur of the picture,
    // and it runs in 16 bits, as for depth of field: it divides by small blurred weights.
    lines.push(`[${behind}k]lut=c0='max(1,val)',format=gray16le,split=2[${behind}][${backW}]`);
    const [pm, wb] = [label("plp"), label("plq")];
    lines.push(`[${pics[2 * b]}]format=gbrp16le[${pics[2 * b]}w];[${pics[2 * b]}w][${behind}]premultiply=inplace=0,gblur=sigma=${fillSigma}[${pm}]`);
    lines.push(`[${backW}]gblur=sigma=${fillSigma}[${wb}]`);
    const fill = label("plx");
    lines.push(`[${pm}][${wb}]unpremultiply=inplace=0,format=gbrp[${fill}]`);
    lines.push(`[${fill}][${pics[2 * b + 1]}][${fillW}]maskedmerge[${sharp}]`);
    // The layer shows itself (the farthest shows everything, so nothing is ever uncovered).
    const alpha = b === L - 1 ? "255" : `255*clip(${farther(lo, soft)}-${farther(hi, soft)},0,1)`;
    lines.push(`[${ds[2 * b + 1]}]lut=c0='${alpha}'[${own}]`);
    lines.push(`[${sharp}][${own}]alphamerge,format=gbrap[${layer}]`);
    // Move: scale about the center by s, shift by (dx, dy), as corners for perspective (it samples between pixels).
    const s = `(${round3(margin)}*(1+${round3(p.zoom * near)}*${ease}))`;
    const dx = `(${round3(-p.x * near * W)}*${ease})`;
    const dy = `(${round3(-p.y * near * H)}*${ease})`;
    const cx = (sx: number) => `(${W / 2}+${sx}*${W / 2}/${s}-${dx})`;
    const cy = (sy: number) => `(${H / 2}+${sy}*${H / 2}/${s}-${dy})`;
    const corners = [
      [cx(-1), cy(-1)],
      [cx(1), cy(-1)],
      [cx(-1), cy(1)],
      [cx(1), cy(1)],
    ]
      .flatMap(([x, y], i) => [`x${i}='${x}'`, `y${i}='${y}'`])
      .join(":");
    lines.push(`[${layer}]perspective=${corners}:interpolation=linear:eval=frame[${moved}]`);
    if (!acc) {
      acc = moved;
      continue;
    }
    const next = label("plo");
    lines.push(`[${acc}][${moved}]overlay=format=gbrp[${next}]`);
    acc = next;
  }
  lines.push(`[${acc}]format=${ctx.alpha ? "yuva420p" : "yuv420p"}`);
  return lines.join(";");
}

export function depthEffects(): EffectDefinition[] {
  return [
    define({
      id: "depthView",
      name: "Depth View",
      category: "retouch",
      perFrame: true,
      description: "Shows the clip's depth in place of the picture, near white and far black, to check it. estimate_depth uses it; it does not belong in a finished edit.",
      params: z.object({}),
      usesDepthMask: () => true,
      toFilter: (_, ctx) => `nullsink;[${depthStream(ctx, "Depth view")}]format=gray,negate,format=${ctx.alpha ? "yuva420p" : "yuv420p"}`,
    }),
    define({
      id: "depthOfField",
      name: "Depth of Field",
      category: "blur",
      description:
        "A real lens's depth of field from the clip's depth: things at the focus distance stay sharp and everything nearer or farther blurs more the farther it is from it, with clean edges around the sharp subject. " +
        "Set focus to the subject's distance (estimate_depth gives it for a point or a tracked object), range for how deep the sharp zone is, and blur for the strength. focusPath racks focus over time, from one subject to another. Primary video and photo clips only.",
      params: DepthOfFieldParams,
      usesDepthMask: () => true,
      toFilter: (p, ctx) => depthOfFieldFilter(p, ctx),
    }),
    define({
      id: "depthFog",
      name: "Depth Fog",
      category: "light",
      perFrame: true,
      description:
        "Fog, haze or mist that thickens with distance, from the clip's depth: far hills fade into the haze while near things stay clear. Atmosphere for landscapes, mornings, horror and dusty or smoky scenes. " +
        "For drifting fog banks in front of everything, add_particles fog instead. Primary video and photo clips only.",
      params: DepthFogParams,
      usesDepthMask: () => true,
      toFilter: (p, ctx) => depthFogFilter(p, ctx),
    }),
    define({
      id: "parallax",
      name: "2.5D Parallax",
      category: "motion",
      description:
        "Brings a photo (or a still shot) to life with a camera move through it: the picture is cut into depth layers that move apart, near ones more, so the scene looks three-dimensional. The gaps nearer layers leave are filled from around them. " +
        "Keep moves small (x up to 0.06, zoom up to 0.15) for a clean result; check the edges of near subjects at the end of the move with render_frame. Primary photo and video clips only.",
      params: ParallaxParams,
      usesDepthMask: () => true,
      toFilter: (p, ctx) => parallaxFilter(p, ctx),
    }),
  ];
}

