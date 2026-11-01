import {
  SKIN_LINE,
  deltaE2000,
  rgbToLab,
  rgbToOklab,
  transferOklab,
  transferRgb,
  vectorscopeHue,
  type ColorMatch,
  type ColorTransfer,
  type Vec3,
} from "../../library/effects/color-match.js";
import { MATCH_PERCENTILES, detectPictureArea, matchingCurves, type ChannelLevels } from "./color-analysis.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";

// Shot matching for match_color and grade_scene (design: docs/design/cinematic-grade-and-vfx.md, 4.3).
// Three candidates are fitted from color distributions: a transfer in Oklab (lightness by quantiles,
// the a/b plane by the linear Monge-Kantorovich map between the two color spreads), Reinhard-style
// mean and spread per Oklab channel, and per-channel RGB curves. Each is fitted on some frames of the
// shot and scored on a held-out frame, and the one closest to the reference wins.

export type MatchMethod = ColorMatch["method"];

/** The picture of a frame (letterbox bars cut off) as gamma-encoded RGB colors in 0..1, and its size. */
export interface FramePixels {
  width: number;
  height: number;
  colors: Vec3[];
}

/** Read an image's picture area (or, with crop false, the whole image) at `width` pixels wide. */
export async function readPixels(imagePath: string, width: number, opts: FfmpegOptions & { crop?: boolean } = {}): Promise<FramePixels> {
  const crop = opts.crop === false ? undefined : await detectPictureArea(imagePath, opts);
  const res = await runFfmpegOrThrow(
    ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-vf", `${crop ? `${crop},` : ""}scale=${width}:-2:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"],
    { ...opts, binaryStdout: true },
  );
  const px = res.stdoutBuffer ?? Buffer.alloc(0);
  const n = Math.floor(px.length / 3);
  const colors: Vec3[] = new Array(n);
  for (let k = 0; k < n; k++) colors[k] = [px[3 * k]! / 255, px[3 * k + 1]! / 255, px[3 * k + 2]! / 255];
  return { width, height: Math.round(n / width), colors };
}

/** The colors inside a box (frame fractions) of a frame. */
export function pixelsIn(frame: FramePixels, box: { x0: number; y0: number; x1: number; y1: number }): Vec3[] {
  const out: Vec3[] = [];
  const [x0, x1] = [Math.max(0, Math.floor(box.x0 * frame.width)), Math.min(frame.width, Math.ceil(box.x1 * frame.width))];
  const [y0, y1] = [Math.max(0, Math.floor(box.y0 * frame.height)), Math.min(frame.height, Math.ceil(box.y1 * frame.height))];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(frame.colors[y * frame.width + x]!);
  return out;
}

/** Every k-th color, so at most `max` remain (the fits only need the distribution). */
const thin = (colors: Vec3[], max: number): Vec3[] => (colors.length <= max ? colors : colors.filter((_, k) => k % Math.ceil(colors.length / max) === 0));

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
const sortedOf = (values: number[]) => Float64Array.from(values).sort() as unknown as number[];
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

// --- 2x2 symmetric matrices as [a, b, c] = [[a, b], [b, c]] -------------------------------------
type Sym = [number, number, number];
type Mat = [number, number, number, number];

function covariance(points: Vec3[]): Sym {
  const [ma, mb] = [mean(points.map((p) => p[1])), mean(points.map((p) => p[2]))];
  let [aa, ab, bb] = [0, 0, 0];
  for (const [, a, b] of points) {
    aa += (a - ma) ** 2;
    ab += (a - ma) * (b - mb);
    bb += (b - mb) ** 2;
  }
  const k = Math.max(1, points.length);
  // A floor keeps nearly gray shots from blowing the map up.
  return [aa / k + 1e-5, ab / k, bb / k + 1e-5];
}
const symSqrt = ([a, b, c]: Sym): Sym => {
  const s = Math.sqrt(Math.max(0, a * c - b * b));
  const t = Math.sqrt(a + c + 2 * s);
  return [(a + s) / t, b / t, (c + s) / t];
};
const symInv = ([a, b, c]: Sym): Sym => {
  const d = a * c - b * b;
  return [c / d, -b / d, a / d];
};
const mul = (p: Mat, q: Mat): Mat => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];
const full = ([a, b, c]: Sym): Mat => [a, b, b, c];

/** A symmetric map with its scale factors held to [lo, hi] (plausible saturation changes). */
function clampScale([a, b, c]: Sym, lo: number, hi: number): Sym {
  const m = (a + c) / 2;
  const r = Math.hypot((a - c) / 2, b);
  const phi = 0.5 * Math.atan2(2 * b, a - c);
  const [l1, l2] = [Math.min(hi, Math.max(lo, m + r)), Math.min(hi, Math.max(lo, m - r))];
  const [co, si] = [Math.cos(phi), Math.sin(phi)];
  return [l1 * co * co + l2 * si * si, (l1 - l2) * si * co, l1 * si * si + l2 * co * co];
}

/** Lightness curve points mapping the shot's Oklab L quantiles onto the reference's. */
function lightnessCurve(src: number[], ref: number[]): [number, number][] {
  const [s, r] = [sortedOf(src), sortedOf(ref)];
  const points: [number, number][] = [];
  for (const q of [0.005, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.995]) {
    const [x, y] = [quantile(s, q), quantile(r, q)];
    const last = points[points.length - 1];
    if (x <= 0.002 || x >= 0.998 || (last && x - last[0] < 0.01)) continue;
    // Slopes between a quarter and four keep the curve smooth and increasing.
    points.push([x, last ? Math.min(last[1] + 4 * (x - last[0]), Math.max(last[1] + 0.25 * (x - last[0]), y)) : y]);
  }
  if (!points.length) return [[0, 0], [1, 1]];
  const [first, last] = [points[0]!, points[points.length - 1]!];
  return [[0, Math.min(first[1], Math.max(0, first[1] - first[0]))], ...points, [1, Math.max(last[1], Math.min(1, last[1] + 1 - last[0]))]];
}

/** The 90th percentile of hue turns a transfer gives to the shot's colorful pixels, in degrees. */
function hueShift(t: ColorTransfer, lab: Vec3[]): number {
  const turns: number[] = [];
  for (const p of lab) {
    if (Math.hypot(p[1], p[2]) < 0.04) continue;
    const q = transferOklab(t, p);
    turns.push(Math.abs(wrap180(((Math.atan2(q[2], q[1]) - Math.atan2(p[2], p[1])) * 180) / Math.PI)));
  }
  return turns.length ? quantile(sortedOf(turns), 0.9) : 0;
}

/** Move a transfer part of the way from no change (strength 0) to itself (1). Exact: the map is affine. */
export function scaleTransfer(t: ColorTransfer, s: number, chroma = s): ColorTransfer {
  const blend = (x: number, y: number, k: number) => x + k * (y - x);
  return {
    lightness: t.lightness.map(([x, y]) => [x, blend(x, y, s)] as [number, number]),
    matrix: [blend(1, t.matrix[0], chroma), blend(0, t.matrix[1], chroma), blend(0, t.matrix[2], chroma), blend(1, t.matrix[3], chroma)],
    from: t.from,
    to: [blend(t.from[0], t.to[0], chroma), blend(t.from[1], t.to[1], chroma)],
    ...(t.skin ? { skin: t.skin } : {}),
  };
}

/** Hold hue turns of the shot's colorful pixels to `maxHue` degrees by easing off the chroma part. */
function limitHue(t: ColorTransfer, lab: Vec3[], maxHue: number): { transfer: ColorTransfer; limited: boolean } {
  if (hueShift(t, lab) <= maxHue) return { transfer: t, limited: false };
  let [lo, hi] = [0, 1];
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) / 2;
    if (hueShift(scaleTransfer(t, 1, mid), lab) <= maxHue) lo = mid;
    else hi = mid;
  }
  return { transfer: scaleTransfer(t, 1, lo), limited: true };
}

/** The Oklab distribution transfer: lightness quantiles and the Monge-Kantorovich map of the a/b spread. */
export function fitTransfer(shot: Vec3[], reference: Vec3[], maxHue = 15): { transfer: ColorTransfer; limited: boolean } {
  const [src, ref] = [thin(shot, 20000).map(rgbToOklab), thin(reference, 20000).map(rgbToOklab)];
  const [Ss, Sr] = [covariance(src), covariance(ref)];
  const root = symSqrt(Ss);
  const inner = mul(mul(full(root), full(Sr)), full(root));
  const middle = symSqrt([inner[0], (inner[1] + inner[2]) / 2, inner[3]]);
  const inv = full(symInv(root));
  const m = mul(mul(inv, full(middle)), inv);
  const map = clampScale([m[0], (m[1] + m[2]) / 2, m[3]], 0.4, 2.5);
  const t: ColorTransfer = {
    lightness: lightnessCurve(src.map((p) => p[0]), ref.map((p) => p[0])),
    matrix: full(map),
    from: [mean(src.map((p) => p[1])), mean(src.map((p) => p[2]))],
    to: [mean(ref.map((p) => p[1])), mean(ref.map((p) => p[2]))],
  };
  return limitHue(t, src, maxHue);
}

/** Reinhard-style transfer: each Oklab channel's mean and spread moved onto the reference's. */
export function fitReinhard(shot: Vec3[], reference: Vec3[], maxHue = 15): { transfer: ColorTransfer; limited: boolean } {
  const [src, ref] = [thin(shot, 20000).map(rgbToOklab), thin(reference, 20000).map(rgbToOklab)];
  const stats = (pts: Vec3[], c: 0 | 1 | 2) => {
    const m = mean(pts.map((p) => p[c]));
    return [m, Math.sqrt(mean(pts.map((p) => (p[c] - m) ** 2))) + 1e-4] as const;
  };
  const [[ms0, ss0], [mr0, sr0]] = [stats(src, 0), stats(ref, 0)];
  const scale = (s: number, r: number) => Math.min(2.5, Math.max(0.4, r / s));
  const k = scale(ss0, sr0);
  const [[ms1, ss1], [mr1, sr1], [ms2, ss2], [mr2, sr2]] = [stats(src, 1), stats(ref, 1), stats(src, 2), stats(ref, 2)];
  const t: ColorTransfer = {
    lightness: [
      [0, mr0 - k * ms0],
      [1, mr0 + k * (1 - ms0)],
    ],
    matrix: [scale(ss1, sr1), 0, 0, scale(ss2, sr2)],
    from: [ms1, ms2],
    to: [mr1, mr2],
  };
  return limitHue(t, src, maxHue);
}

/** Per-channel percentile levels of colors, as channelLevels measures an image. */
export function levelsOf(colors: Vec3[]): ChannelLevels {
  const at = (c: 0 | 1 | 2) => {
    const s = sortedOf(colors.map((p) => p[c]));
    return MATCH_PERCENTILES.map((q) => Math.round(quantile(s, q) * 1000) / 1000);
  };
  return { r: at(0), g: at(1), b: at(2) };
}

type Curves = ReturnType<typeof matchingCurves>;

/** A color through per-channel curves, linear between points (FFmpeg draws a smooth spline: close, for scoring). */
function curvesRgb(c: Curves, [r, g, b]: Vec3): Vec3 {
  const at = (points: [number, number][], x: number) => {
    for (let k = 1; k < points.length; k++) {
      const [[x0, y0], [x1, y1]] = [points[k - 1]!, points[k]!];
      if (x <= x1) return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
    }
    return points[points.length - 1]![1];
  };
  return [at(c.red, r), at(c.green, g), at(c.blue, b)];
}

/**
 * How far apart two pictures' colors are: CIELAB quantiles (5% to 95%) of each, compared with
 * ΔE 2000 and averaged. Needs no matching pixels, so it compares different shots.
 */
export function distributionDeltaE(a: Vec3[], b: Vec3[]): number {
  const quantiles = (colors: Vec3[]) => {
    const lab = thin(colors, 20000).map(rgbToLab);
    const sorted = ([0, 1, 2] as const).map((c) => sortedOf(lab.map((p) => p[c])));
    return [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95].map((q) => sorted.map((s) => quantile(s, q)) as Vec3);
  };
  const [qa, qb] = [quantiles(a), quantiles(b)];
  return mean(qa.map((p, k) => deltaE2000(p, qb[k]!)));
}

const meanColor = (colors: Vec3[]): Vec3 => [mean(colors.map((p) => p[0])), mean(colors.map((p) => p[1])), mean(colors.map((p) => p[2]))];

/** Vectorscope hue of the average skin color after a color change. */
const skinHue = (skin: Vec3[], change: (c: Vec3) => Vec3) => vectorscopeHue(meanColor(skin.map(change)));

/**
 * Keep skin on the skin line: when the transfer leaves the average skin color more than `tolerance`
 * degrees off it on the vectorscope, add a hue turn around the skin's hue that brings it back inside.
 */
export function protectSkin(t: ColorTransfer, skin: Vec3[], tolerance = 5): { transfer: ColorTransfer; before: number; after: number } {
  const before = skinHue(skin, (c) => transferRgb(t, c));
  const off = wrap180(before - SKIN_LINE);
  if (Math.abs(off) <= tolerance) return { transfer: t, before, after: before };
  // Aim a degree inside the tolerance, so 8-bit rounding does not tip it back out.
  const target = SKIN_LINE + Math.sign(off) * (tolerance - 1);
  const mapped = rgbToOklab(meanColor(skin.map((c) => transferRgb(t, c))));
  const hue = (Math.atan2(mapped[2], mapped[1]) * 180) / Math.PI;
  let best = { transfer: t, after: before, miss: Math.abs(off) };
  for (let rotate = -45; rotate <= 45; rotate += 0.5) {
    const candidate: ColorTransfer = { ...t, skin: { hue, width: 25, rotate } };
    const after = skinHue(skin, (c) => transferRgb(candidate, c));
    const miss = Math.abs(wrap180(after - target));
    if (miss < best.miss) best = { transfer: candidate, after, miss };
  }
  return { transfer: best.transfer, before, after: best.after };
}

export interface ShotSample {
  /** Frames of the shot, in time order; with three or more, the middle one is held out for scoring. */
  frames: Vec3[][];
  /** Skin colors from faces in the shot, when any were found. */
  skin?: Vec3[];
}

export interface MatchOptions {
  /** 0 = no change, 1 = full match. */
  strength?: number;
  /** "auto" scores every method on the held-out frame and keeps the best. */
  method?: MatchMethod | "auto";
  /** Largest hue turn of colorful pixels, degrees (default 15). */
  maxHueShift?: number;
}

export interface ShotMatch {
  params: ColorMatch;
  method: MatchMethod;
  /** Distribution ΔE 2000 of the held-out frame to the reference, unchanged and after each method. */
  scores: { unchanged: number } & Partial<Record<MatchMethod, number>>;
  /** Skin hue on the vectorscope before and after (when faces were found). */
  skin?: { before: number; after: number };
  /** The hue limit eased off the chroma change. */
  hueLimited: boolean;
}

type Fitted = { method: MatchMethod; apply: (c: Vec3) => Vec3; transfer?: ColorTransfer; curves?: Curves; limited: boolean };

function fit(method: MatchMethod, shot: Vec3[], reference: Vec3[], o: Required<MatchOptions>): Fitted {
  if (method === "curves") {
    const curves = matchingCurves(levelsOf(shot), levelsOf(reference), o.strength);
    return { method, curves, apply: (c) => curvesRgb(curves, c), limited: false };
  }
  const fitted = (method === "transfer" ? fitTransfer : fitReinhard)(shot, reference, o.maxHueShift);
  const transfer = scaleTransfer(fitted.transfer, o.strength);
  return { method, transfer, apply: (c) => transferRgb(transfer, c), limited: fitted.limited };
}

/** Fit the color match that makes a shot look like the reference colors (from a hero shot or a still). */
export function matchShot(shot: ShotSample, reference: Vec3[], options: MatchOptions = {}): ShotMatch {
  const o: Required<MatchOptions> = { strength: options.strength ?? 1, method: options.method ?? "auto", maxHueShift: options.maxHueShift ?? 15 };
  const frames = shot.frames.filter((f) => f.length);
  if (!frames.length || !reference.length) throw new Error("No pixels to match");
  const held = frames.length >= 3 ? frames[Math.floor(frames.length / 2)]! : frames.flat();
  const training = frames.length >= 3 ? frames.filter((f) => f !== held).flat() : held;
  const unchanged = distributionDeltaE(held, reference);
  const scores: ShotMatch["scores"] = { unchanged };
  const methods: MatchMethod[] = o.method === "auto" ? ["transfer", "reinhard", "curves"] : [o.method];
  let best: { method: MatchMethod; score: number } | undefined;
  for (const method of methods) {
    const f = fit(method, training, reference, o);
    const score = distributionDeltaE(held.map(f.apply), reference);
    scores[method] = Math.round(score * 100) / 100;
    // Curves cannot be held to the skin line, so they only win when they leave skin on it.
    const skinOff = method === "curves" && shot.skin?.length && Math.abs(wrap180(skinHue(shot.skin, f.apply) - SKIN_LINE)) > 5;
    if (!skinOff && (!best || score < best.score)) best = { method, score };
  }
  best ??= { method: "transfer", score: Infinity };
  scores.unchanged = Math.round(unchanged * 100) / 100;
  // Final fit on every frame of the shot.
  const final = fit(best.method, frames.flat(), reference, o);
  if (final.method === "curves") return { params: { method: "curves", curves: final.curves }, method: "curves", scores, hueLimited: false };
  let transfer = final.transfer!;
  let skin: ShotMatch["skin"];
  if (shot.skin?.length) {
    const kept = protectSkin(transfer, shot.skin);
    transfer = kept.transfer;
    skin = { before: Math.round(kept.before * 10) / 10, after: Math.round(kept.after * 10) / 10 };
  }
  return { params: { method: final.method, transfer: roundTransfer(transfer) }, method: final.method, scores, ...(skin ? { skin } : {}), hueLimited: final.limited };
}

/** Six decimals: plenty for 8-bit output, and keeps the project file small. */
function roundTransfer(t: ColorTransfer): ColorTransfer {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    lightness: t.lightness.map(([x, y]) => [r(x), r(y)] as [number, number]),
    matrix: t.matrix.map(r) as ColorTransfer["matrix"],
    from: t.from.map(r) as [number, number],
    to: t.to.map(r) as [number, number],
    ...(t.skin ? { skin: { hue: r(t.skin.hue), width: t.skin.width, rotate: t.skin.rotate } } : {}),
  };
}
