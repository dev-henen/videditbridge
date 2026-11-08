import type { Easing, Mask, MaskPart } from "../../core/schema.js";
import { numberExpr } from "../../core/keyframes.js";
import { clamp, round3 } from "../../core/util.js";
import { grayFormat, labeler, yuvFormat, type EffectContext } from "./helpers.js";

/**
 * Masks limit an effect to part of the frame (see MaskSchema). Model masks (person, face, tracked
 * objects) come from the renderer as gray streams through EffectContext; key, luma and shape masks
 * are built in the graph. Everything here works on gray mattes: 255 = selected.
 */

type Selection = Omit<MaskPart, "op">;
type ModelKind = "person" | "face" | "sky" | "depth";

const parts = (mask: Mask): Selection[] => [mask, ...(mask.combine ?? [])];

/** Which renderer stream a part reads: "person", "face", "object:<id>", or none for in-graph masks. */
const modelKey = (m: Selection): string | undefined =>
  m.kind === "person" || m.kind === "face" || m.kind === "sky" || m.kind === "depth" ? m.kind : m.kind === "object" ? `object:${m.object ?? ""}` : undefined;

/** Whether a mask needs the clip's person cutout, face mask, sky or depth stream (at most one of each). */
export function maskNeeds(mask: Mask | undefined, kind: ModelKind): boolean {
  return !!mask && parts(mask).some((m) => m.kind === kind);
}

/** The tracked objects a mask uses (each needs one stream of that object's mask). */
export function maskObjects(mask: Mask | undefined): string[] {
  return mask ? [...new Set(parts(mask).filter((m) => m.kind === "object").map((m) => m.object ?? ""))] : [];
}

/** Whether the matte changes over time by itself (temporal smoothing). */
export function maskIsTemporal(mask: Mask | undefined): boolean {
  return !!mask && (mask.smooth > 1 || parts(mask).some((m) => !!shapeMotion(m)));
}

type Shape = NonNullable<Selection["shape"]>;
type Corners = { tl: { x: number; y: number }; tr: { x: number; y: number }; br: { x: number; y: number }; bl: { x: number; y: number } };

/** A shape's center: its own for ellipse and rect, the middle of its points' box for a polygon. */
export function shapeCenter(s: Shape): [number, number] {
  if (s.type !== "polygon") return [s.x ?? 0.5, s.y ?? 0.5];
  const xs = s.points!.map((p) => p[0]);
  const ys = s.points!.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/**
 * How a shape moves: where the frame's corners go over time (frame fractions), from `corners`
 * (pinned to a track) or from `keyframes` (center and scale: each frame corner moved and scaled about
 * the shape's center). Undefined for a fixed shape.
 */
export function shapeMotion(m: Selection): { time: number; value: Corners; easing: Easing }[] | undefined {
  const s = m.kind === "shape" ? m.shape : undefined;
  if (!s) return undefined;
  if (s.corners?.length) return s.corners;
  if (!s.keyframes?.length) return undefined;
  const [cx, cy] = shapeCenter(s);
  const at = (k: { x: number; y: number; scale: number }, fx: number, fy: number) => ({ x: k.x + (fx - cx) * k.scale, y: k.y + (fy - cy) * k.scale });
  return s.keyframes.map((k) => ({ time: k.time, easing: k.easing, value: { tl: at(k.value, 0, 0), tr: at(k.value, 1, 0), br: at(k.value, 1, 1), bl: at(k.value, 0, 1) } }));
}

/** Plain-language description of a mask, for summaries. */
export function describeMask(mask: Mask): string {
  const one = (m: Selection): string => {
    const bits: string[] = [];
    if (m.kind === "object") bits.push(`"${m.object ?? ""}"`);
    if (m.kind === "shape" && m.shape) {
      const s = m.shape;
      bits.push(s.type === "polygon" ? `polygon of ${s.points!.length} points` : `${s.type} at (${s.x}, ${s.y}) ${s.width}x${s.height}`);
      if (s.corners?.length) bits.push("pinned to a track");
      else if (s.keyframes?.length) bits.push(`moving (${s.keyframes.length} keyframes)`);
    }
    if (m.hue) bits.push(`hue ${m.hue[0]}-${m.hue[1]}`);
    if (m.saturation) bits.push(`sat ${m.saturation[0]}-${m.saturation[1]}`);
    if (m.luma) bits.push(`luma ${m.luma[0]}-${m.luma[1]}`);
    if (m.distance) bits.push(`distance ${m.distance[0]}-${m.distance[1]}`);
    return `${m.invert ? "not " : ""}${m.kind}${bits.length ? ` ${bits.join(" ")}` : ""}`;
  };
  return [one(mask), ...(mask.combine ?? []).map((c) => `${c.op} ${one(c)}`)].join(" ");
}

/** Smoothstep of `e` clipped to 0..1 (written out: the order operands are evaluated in is not fixed). */
const smoothstep = (e: string) => {
  const c = `clip(${e},0,1)`;
  return `${c}*${c}*(3-2*${c})`;
};

/** A range test as an FFmpeg expression of `v`: 1 inside [lo, hi], falling to 0 over `soft` outside it. */
function rangeExpr(v: string, lo: number, hi: number, soft: number): string {
  if (lo <= 0 && hi >= 1) return "1";
  if (soft <= 0) return `between(${v},${round3(lo)},${round3(hi)})`;
  const s = round3(soft);
  const below = lo > 0 ? smoothstep(`(${v}-${round3(lo)}+${s})/${s}`) : "1";
  const above = hi < 1 ? smoothstep(`(${round3(hi)}+${s}-${v})/${s}`) : "1";
  return `(${below})*(${above})`;
}

/**
 * The HSL qualifier as an expression of r, g, b (0..255) for geq: hue on the circle, HSV saturation
 * and Rec.709 luma, each with a soft falloff. Variables 0..5 hold the pixel's values; `;` runs the
 * steps in order.
 */
export function keyExpr(m: Selection): string {
  const soft = m.softness;
  const pre = [
    "st(0,r(X,Y)/255)",
    "st(1,g(X,Y)/255)",
    "st(2,b(X,Y)/255)",
    "st(3,max(max(ld(0),ld(1)),ld(2)))",
    "st(4,ld(3)-min(min(ld(0),ld(1)),ld(2)))",
  ];
  const terms: string[] = [];
  if (m.hue) {
    // Hue in degrees (hexcone), then its distance from the range's middle, around the circle.
    pre.push(
      "st(5,if(eq(ld(4),0),0,if(eq(ld(3),ld(0)),60*mod((ld(1)-ld(2))/ld(4)+6,6),if(eq(ld(3),ld(1)),60*((ld(2)-ld(0))/ld(4)+2),60*((ld(0)-ld(1))/ld(4)+4)))))",
    );
    const [h0, h1] = m.hue;
    const width = (((h1 - h0) % 360) + 360) % 360 || 360;
    if (width < 360) {
      const mid = round3((h0 + width / 2) % 360);
      const dist = `abs(mod(ld(5)-${mid}+540,360)-180)`;
      const half = round3(width / 2);
      const s = round3(soft * 45);
      terms.push(s > 0 ? smoothstep(`(${half}+${s}-${dist})/${s}`) : `lte(${dist},${half})`);
      // Hue means nothing without color: grays never pass a hue test.
      terms.push(`clip(ld(4)*20,0,1)`);
    }
  }
  if (m.saturation) terms.push(rangeExpr("if(ld(3),ld(4)/ld(3),0)", m.saturation[0], m.saturation[1], soft * 0.25));
  if (m.luma) terms.push(rangeExpr("(0.2126*ld(0)+0.7152*ld(1)+0.0722*ld(2))", m.luma[0], m.luma[1], soft * 0.25));
  const body = terms.filter((t) => t !== "1");
  return [...pre, `255*${body.length ? body.map((t) => `(${t})`).join("*") : "1"}`].join(";");
}

/** Inside test of a shape as a geq expression of X, Y, W, H (1 inside, 0 outside). */
function shapeExpr(m: Selection, W: number, H: number): string {
  const s = m.shape ?? { type: "ellipse" as const, x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
  if (s.type === "polygon") {
    // Even-odd rule at the pixel's center: count the edges a ray to the left crosses. Flat edges
    // never cross and are left out (their slope would divide by zero).
    const pts = s.points!.map(([x, y]) => [Math.round(x * W * 100) / 100, Math.round(y * H * 100) / 100] as const);
    const crossings = pts
      .map((a, i) => [a, pts[(i + 1) % pts.length]!] as const)
      .filter(([a, b]) => a[1] !== b[1])
      .map(([[x1, y1], [x2, y2]]) => `abs(gt(${y1},Y+0.5)-gt(${y2},Y+0.5))*lt(X+0.5,${round3((x2 - x1) / (y2 - y1))}*(Y+0.5-${y1})+${x1})`);
    return `mod(${crossings.join("+")},2)`;
  }
  const dx = `(X/W-${round3(s.x!)})/${round3(s.width! / 2)}`;
  const dy = `(Y/H-${round3(s.y!)})/${round3(s.height! / 2)}`;
  return s.type === "rect" ? `lte(max(abs(${dx}),abs(${dy})),1)` : `lte(hypot(${dx},${dy}),1)`;
}

export interface Matte {
  lines: string[];
  /** Label of the finished gray matte. */
  out: string;
  /** Labels the caller must feed with copies of the picture the matte is cut from (any pixel format). */
  picture: string[];
}

/** Build the gray matte of a mask, with its modifiers (combine, invert, grow, feather, smoothing). */
export function buildMatte(ctx: EffectContext, mask: Mask): Matte {
  const label = labeler(ctx);
  const lines: string[] = [];
  const picture: string[] = [];
  const { width: W, height: H, fps: F } = ctx;

  // Model masks come once per effect (and object) from the renderer; split when several parts use the same one.
  const model = new Map<string, string[]>();
  for (const key of new Set(parts(mask).map(modelKey).filter((k): k is string => !!k))) {
    const n = parts(mask).filter((m) => modelKey(m) === key).length;
    const id = key.startsWith("object:") ? key.slice(7) : undefined;
    const stream = id !== undefined ? ctx.objectMask?.(id) : key === "person" ? ctx.personMask?.() : key === "sky" ? ctx.skyMask?.() : key === "depth" ? ctx.depthMask?.() : ctx.faceMask?.();
    const what = id !== undefined ? `object "${id}"` : key;
    if (!stream) throw new Error(`${what} masks work on primary video clips${id !== undefined ? " of the object's video" : ""} only (not on media layers or whole-video effects); use a key or shape mask there, or put the effect on each clip`);
    const copies = Array.from({ length: n }, () => label("mmd"));
    lines.push(`[${stream}]format=${grayFormat(ctx)}${n > 1 ? `,split=${n}` : ""}${copies.map((c) => `[${c}]`).join("")}`);
    model.set(key, copies);
  }

  const select = (m: Selection): string => {
    const out = label("mms");
    let source: string;
    const key = modelKey(m);
    if (key === "depth") {
      // Distance (0 near .. 255 far) through the range test.
      const [lo, hi] = m.distance ?? [0, 1];
      source = `[${model.get(key)!.shift()}]lut=c0='255*${rangeExpr("val/255", lo, hi, m.softness * 0.25)}'`;
    } else if (key) {
      source = `[${model.get(key)!.shift()}]null`;
    } else if (m.kind === "shape") {
      // Drawn once; every consumer holds the last frame.
      source = `nullsrc=s=${W}x${H}:r=${F},trim=end_frame=1,format=${grayFormat(ctx)},geq=lum='${ctx.deep ? 65535 : 255}*${shapeExpr(m, W, H)}'`;
      const motion = shapeMotion(m);
      if (motion) {
        // Moving: the drawing repeated for every frame, and carried by perspective to where the
        // frame's corners are at each frame's time (its `on` counts frames from 1).
        const frames = Math.ceil(ctx.duration * F) + 2;
        const coord = (c: keyof Corners, axis: "x" | "y") => {
          const size = axis === "x" ? W : H;
          const keys = motion.map((k) => ({ ...k, value: k.value[c][axis] * size }));
          return keys.length > 1 ? numberExpr(keys, `((on-1)/${F})`) : String(round3(keys[0]!.value));
        };
        // perspective's corner order: top-left, top-right, bottom-left, bottom-right.
        const coords = (["tl", "tr", "bl", "br"] as const).flatMap((c, i) => [`x${i}='${coord(c, "x")}'`, `y${i}='${coord(c, "y")}'`]).join(":");
        source += `,loop=loop=-1:size=1,trim=end_frame=${frames},setpts=N/(${F}*TB),perspective=${coords}:sense=destination:interpolation=linear:eval=${motion.length > 1 ? "frame" : "init"}`;
      }
    } else {
      // A per-pixel function of color, so it is baked into a lookup table once and applied at full size.
      const [pic, clut] = [label("mmp"), label("mmc")];
      picture.push(pic);
      const e = keyExpr(m.kind === "luma" ? { ...m, hue: undefined, saturation: undefined } : m);
      lines.push(`haldclutsrc=level=8:rate=1,trim=end_frame=1,format=gbrp,geq=r='${e}':g='${e}':b='${e}',format=rgb24[${clut}]`);
      source = `[${pic}]format=${ctx.deep ? "gbrp12le" : "rgb24"}[${pic}k];[${pic}k][${clut}]haldclut=clut=first,extractplanes=r${mask.denoise ? ",median=radius=1" : ""}`;
    }
    lines.push(`${source}${m.invert ? ",negate" : ""}[${out}]`);
    return out;
  };

  let acc = select(mask);
  for (const part of mask.combine ?? []) {
    let other = select(part);
    if (part.op === "subtract") {
      const inv = label("mmi");
      lines.push(`[${other}]negate[${inv}]`);
      other = inv;
    }
    const out = label("mmx");
    lines.push(`[${acc}][${other}]blend=all_mode=${part.op === "add" ? "lighten" : "multiply"}[${out}]`);
    acc = out;
  }

  const finish: string[] = [];
  const passes = Math.min(24, Math.round(Math.abs(mask.grow) * H));
  if (passes) finish.push(...Array(passes).fill(mask.grow > 0 ? "dilation" : "erosion"));
  const sigma = round3(clamp(mask.feather, 0, 0.2) * H * 0.5);
  if (sigma >= 0.3) finish.push(`gblur=sigma=${sigma}`);
  if (mask.smooth > 1) finish.push(`tmix=frames=${mask.smooth}`);
  const out = label("mmo");
  lines.push(`[${acc}]${[`format=${grayFormat(ctx)}`, ...finish].join(",")}[${out}]`);
  return { lines, out, picture };
}

/**
 * Run `branch` on a copy of the stream and show it only where the mask selects. `base` optionally
 * changes the picture under it (render_mask draws on black). The matte is cut from the stream as it
 * enters, before the branch changes it. Returns a graph fragment reading and writing one stream.
 */
export function maskedEffect(ctx: EffectContext, mask: Mask, branch: string, opts: { base?: string } = {}): string {
  const label = labeler(ctx);
  const matte = buildMatte(ctx, mask);
  const [orig, copy, done, top] = [label("mko"), label("mkc"), label("mkb"), label("mkt")];
  const lines = [`format=${yuvFormat(ctx)},split=${2 + matte.picture.length}[${orig}][${copy}]${matte.picture.map((p) => `[${p}]`).join("")}`];
  let base = orig;
  let alpha: string | undefined;
  if (ctx.alpha) {
    // Composite the color only, then give the result the layer's own alpha back.
    const [color, a, oa] = [label("mkl"), label("mka"), label("mkx")];
    lines.push(`[${orig}]split=2[${color}][${a}]`, `[${a}]alphaextract[${oa}]`);
    lines.push(`[${color}]format=${yuvFormat({ deep: ctx.deep })}[${color}y]`);
    base = `${color}y`;
    alpha = oa;
  }
  if (opts.base) {
    const b = label("mkg");
    lines.push(`[${base}]${opts.base}[${b}]`);
    base = b;
  }
  lines.push(`[${copy}]${branch},format=${yuvFormat({ deep: ctx.deep })}[${done}]`, ...matte.lines, `[${done}][${matte.out}]alphamerge[${top}]`);
  const comp = `[${base}][${top}]overlay=format=auto:shortest=1,format=${yuvFormat({ deep: ctx.deep })}`;
  if (!alpha) return [...lines, comp].join(";");
  const c = label("mkr");
  return [...lines, `${comp}[${c}]`, `[${c}][${alpha}]alphamerge`].join(";");
}

/** The picture of a mask: white on black (`matte`) or a red tint over the picture (`overlay`). */
export function maskViewFilter(ctx: EffectContext, mask: Mask, style: "matte" | "overlay"): string {
  const fill = (c: string) => `drawbox=x=0:y=0:w=iw:h=ih:color=${c}:t=fill`;
  return style === "matte" ? maskedEffect(ctx, mask, fill("white"), { base: fill("black") }) : maskedEffect(ctx, mask, fill("0xFF2020@0.6"));
}
