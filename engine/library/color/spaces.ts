/**
 * Color spaces of footage: each camera log curve and gamut from its maker's published formulas,
 * and the ACES spaces the engine grades in (docs/design/cinematic-grade-and-vfx.md, sections 4.1
 * and 3.4). Pure math: the engine and the FFmpeg fallback both build their transforms from here.
 *
 * Curves map a code value (0..1, the file's 10-bit code value / 1023: camera log is recorded as
 * the curve's code values, black at S-Log3's 95 for example) to scene linear light, where 0.18 is
 * an 18% gray card, and back. HLG and PQ come out scene-referred too: HLG's reference white (75%)
 * and PQ's HDR reference white (203 nits, ITU-R BT.2408) at 1.0.
 */

import type { ColorSpaceId } from "../../core/schema.js";

export type { ColorSpaceId };
export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];
type Chromaticity = [number, number];

/** A gamut: red, green and blue primaries and the white point, as CIE xy. */
export interface Gamut {
  id: string;
  red: Chromaticity;
  green: Chromaticity;
  blue: Chromaticity;
  white: Chromaticity;
}

export interface Curve {
  id: string;
  /** Code value (0..1) to scene linear. */
  toLinear(code: number): number;
  /** Scene linear to code value. */
  fromLinear(linear: number): number;
}

export interface ColorSpace {
  id: ColorSpaceId;
  label: string;
  /** For Claude: what footage is in this space and how it looks. */
  description: string;
  gamut: Gamut;
  /** Null for display-referred video (Rec.709, sRGB), which the pipeline takes as it is. */
  curve: Curve | null;
  /**
   * How the file stores R'G'B': the YCbCr matrix, and whether code values use the full range
   * (camera log: the curves are defined on the recorded 10-bit code values) or the narrow one
   * (HLG and PQ, ITU-R BT.2100).
   */
  matrix: "bt709" | "bt2020";
  range: "full" | "narrow";
  /** Where the formulas come from. */
  source: string;
}

const D65: Chromaticity = [0.3127, 0.329];
const ACES_WHITE: Chromaticity = [0.32168, 0.33767];

export const GAMUTS = {
  rec709: { id: "rec709", red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: D65 },
  rec2020: { id: "rec2020", red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046], white: D65 },
  /** ACES AP0 (ACES2065-1) and AP1 (ACEScg, ACEScct). */
  ap0: { id: "ap0", red: [0.7347, 0.2653], green: [0, 1], blue: [0.0001, -0.077], white: ACES_WHITE },
  ap1: { id: "ap1", red: [0.713, 0.293], green: [0.165, 0.83], blue: [0.128, 0.044], white: ACES_WHITE },
  sgamut3cine: { id: "sgamut3cine", red: [0.766, 0.275], green: [0.225, 0.8], blue: [0.089, -0.087], white: D65 },
  sgamut3: { id: "sgamut3", red: [0.73, 0.28], green: [0.14, 0.855], blue: [0.1, -0.05], white: D65 },
  vgamut: { id: "vgamut", red: [0.73, 0.28], green: [0.165, 0.84], blue: [0.1, -0.03], white: D65 },
  awg3: { id: "awg3", red: [0.684, 0.313], green: [0.221, 0.848], blue: [0.0861, -0.102], white: D65 },
  awg4: { id: "awg4", red: [0.7347, 0.2653], green: [0.1424, 0.8576], blue: [0.0991, -0.0308], white: D65 },
  bmdwg5: { id: "bmdwg5", red: [0.7177215, 0.3171181], green: [0.228041, 0.861569], blue: [0.1005841, -0.0820452], white: D65 },
} satisfies Record<string, Gamut>;

/** Sony S-Log3 (Sony, "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3"). */
const slog3: Curve = {
  id: "slog3",
  toLinear: (c) => (c * 1023 >= 171.2102946929 ? 10 ** ((c * 1023 - 420) / 261.5) * 0.19 - 0.01 : ((c * 1023 - 95) * 0.01125) / (171.2102946929 - 95)),
  fromLinear: (x) => (x >= 0.01125 ? (420 + Math.log10((x + 0.01) / 0.19) * 261.5) / 1023 : ((x * (171.2102946929 - 95)) / 0.01125 + 95) / 1023),
};

/** Panasonic V-Log (Panasonic, "V-Log/V-Gamut Reference manual"). */
const VLOG = { b: 0.00873, c: 0.241514, d: 0.598206 };
const vlog: Curve = {
  id: "vlog",
  toLinear: (c) => (c < 0.181 ? (c - 0.125) / 5.6 : 10 ** ((c - VLOG.d) / VLOG.c) - VLOG.b),
  fromLinear: (x) => (x < 0.01 ? 5.6 * x + 0.125 : VLOG.c * Math.log10(x + VLOG.b) + VLOG.d),
};

/** ARRI LogC3 at EI 800 (ARRI, "ALEXA Log C Curve, Usage in VFX"). */
const LOGC3 = { cut: 0.010591, a: 5.555556, b: 0.052272, c: 0.24719, d: 0.385537, e: 5.367655, f: 0.092809 };
const logc3: Curve = {
  id: "logc3",
  toLinear: (t) => (t > LOGC3.e * LOGC3.cut + LOGC3.f ? (10 ** ((t - LOGC3.d) / LOGC3.c) - LOGC3.b) / LOGC3.a : (t - LOGC3.f) / LOGC3.e),
  fromLinear: (x) => (x > LOGC3.cut ? LOGC3.c * Math.log10(LOGC3.a * x + LOGC3.b) + LOGC3.d : LOGC3.e * x + LOGC3.f),
};

/** ARRI LogC4 (ARRI, "ALEXA LogC4 Specification"). */
const LOGC4 = (() => {
  const a = (2 ** 18 - 16) / 117.45;
  const b = (1023 - 95) / 1023;
  const c = 95 / 1023;
  const s = (7 * Math.LN2 * 2 ** (7 - (14 * c) / b)) / (a * b);
  const t = (2 ** (14 * (-c / b) + 6) - 64) / a;
  return { a, b, c, s, t };
})();
const logc4: Curve = {
  id: "logc4",
  toLinear: (e) => (e >= 0 ? (2 ** ((14 * (e - LOGC4.c)) / LOGC4.b + 6) - 64) / LOGC4.a : e * LOGC4.s + LOGC4.t),
  fromLinear: (x) => (x >= LOGC4.t ? ((Math.log2(LOGC4.a * x + 64) - 6) / 14) * LOGC4.b + LOGC4.c : (x - LOGC4.t) / LOGC4.s),
};

/** Apple Log (Apple, "Apple Log Profile" white paper). */
const APPLE = { r0: -0.05641088, rt: 0.01, c: 47.28711236, beta: 0.00964052, gamma: 0.08550479, delta: 0.69336945 };
const appleLogCut = APPLE.c * (APPLE.rt - APPLE.r0) ** 2;
const applelog: Curve = {
  id: "applelog",
  toLinear: (p) => (p >= appleLogCut ? 2 ** ((p - APPLE.delta) / APPLE.gamma) - APPLE.beta : p > 0 ? Math.sqrt(p / APPLE.c) + APPLE.r0 : APPLE.r0),
  fromLinear: (x) => (x >= APPLE.rt ? APPLE.gamma * Math.log2(x + APPLE.beta) + APPLE.delta : x >= APPLE.r0 ? APPLE.c * (x - APPLE.r0) ** 2 : 0),
};

/** Blackmagic Film Generation 5 (Blackmagic Design, "Blackmagic Generation 5 Color Science"). */
const GEN5 = { a: 0.08692876065491224, b: 0.005494072432257808, c: 0.5300133392291939, d: 8.283605932402494, e: 0.09246575342465753, cut: 0.005 };
const bmdfilm5: Curve = {
  id: "bmdfilm5",
  toLinear: (y) => (y < GEN5.d * GEN5.cut + GEN5.e ? (y - GEN5.e) / GEN5.d : Math.exp((y - GEN5.c) / GEN5.a) - GEN5.b),
  fromLinear: (x) => (x < GEN5.cut ? GEN5.d * x + GEN5.e : GEN5.a * Math.log(x + GEN5.b) + GEN5.c),
};

/** HLG (ITU-R BT.2100), scene light with the reference white (75% signal) at 1.0. */
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
const hlgSignal = (e: number) => (e <= 1 / 12 ? Math.sqrt(3 * e) : HLG.a * Math.log(12 * e - HLG.b) + HLG.c);
const hlgScene = (s: number) => (s <= 0.5 ? (s * s) / 3 : (Math.exp((s - HLG.c) / HLG.a) + HLG.b) / 12);
const HLG_WHITE = hlgScene(0.75);
const hlg: Curve = {
  id: "hlg",
  toLinear: (s) => hlgScene(Math.max(0, s)) / HLG_WHITE,
  fromLinear: (x) => hlgSignal(Math.max(0, x) * HLG_WHITE),
};

/** PQ (SMPTE ST 2084), with the HDR reference white of 203 nits (ITU-R BT.2408) at 1.0. */
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
/** Nits from a PQ signal, and back. */
export const pqToNits = (e: number) => {
  const p = Math.max(0, e) ** (1 / PQ.m2);
  return 10000 * (Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p)) ** (1 / PQ.m1);
};
export const nitsToPq = (nits: number) => {
  const y = (Math.max(0, nits) / 10000) ** PQ.m1;
  return ((PQ.c1 + PQ.c2 * y) / (1 + PQ.c3 * y)) ** PQ.m2;
};
const pq: Curve = { id: "pq", toLinear: (e) => pqToNits(e) / 203, fromLinear: (x) => nitsToPq(x * 203) };

/** ACEScct, the log encoding of ACEScg the engine grades in (Academy, S-2016-001). */
export const ACESCCT: Curve = {
  id: "acescct",
  toLinear: (c) => (c <= 0.155251141552511 ? (c - 0.0729055341958355) / 10.5402377416545 : Math.min(65504, 2 ** (c * 17.52 - 9.72))),
  fromLinear: (x) => (x <= 0.0078125 ? 10.5402377416545 * x + 0.0729055341958355 : (Math.log2(x) + 9.72) / 17.52),
};

export const COLOR_SPACES: ColorSpace[] = [
  { id: "rec709", label: "Rec.709", description: "Ordinary video (phones, most cameras, screen recordings, the web). The default: the picture is used as it is.", gamut: GAMUTS.rec709, curve: null, matrix: "bt709", range: "narrow", source: "ITU-R BT.709" },
  { id: "srgb", label: "sRGB", description: "Pictures and graphics made for screens. Used as it is.", gamut: GAMUTS.rec709, curve: null, matrix: "bt709", range: "narrow", source: "IEC 61966-2-1" },
  { id: "slog3-sgamut3cine", label: "Sony S-Log3 / S-Gamut3.Cine", description: "Sony cameras (FX3, FX6, A7S III, Venice) shot in S-Log3 with S-Gamut3.Cine: flat, gray-looking footage, 18% gray near 41%.", gamut: GAMUTS.sgamut3cine, curve: slog3, matrix: "bt709", range: "full", source: "Sony, Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3" },
  { id: "slog3-sgamut3", label: "Sony S-Log3 / S-Gamut3", description: "Sony S-Log3 with the wider S-Gamut3.", gamut: GAMUTS.sgamut3, curve: slog3, matrix: "bt709", range: "full", source: "Sony, Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3" },
  { id: "vlog-vgamut", label: "Panasonic V-Log / V-Gamut", description: "Panasonic cameras (GH5S, GH6, S1H, S5) shot in V-Log: flat footage, 18% gray near 42%.", gamut: GAMUTS.vgamut, curve: vlog, matrix: "bt709", range: "full", source: "Panasonic, V-Log/V-Gamut Reference manual" },
  { id: "applelog", label: "Apple Log", description: "iPhone 15 Pro and later recording in Apple Log (ProRes Log): very flat footage, 18% gray near 49%, Rec.2020 primaries.", gamut: GAMUTS.rec2020, curve: applelog, matrix: "bt2020", range: "full", source: "Apple, Apple Log Profile white paper" },
  { id: "logc3-awg3", label: "ARRI LogC3 / ALEXA Wide Gamut 3", description: "ARRI ALEXA cameras before the ALEXA 35 (LogC3 at EI 800): 18% gray near 39%.", gamut: GAMUTS.awg3, curve: logc3, matrix: "bt709", range: "full", source: "ARRI, ALEXA Log C Curve, Usage in VFX (EI 800)" },
  { id: "logc4-awg4", label: "ARRI LogC4 / ALEXA Wide Gamut 4", description: "ARRI ALEXA 35 footage: 18% gray near 28%.", gamut: GAMUTS.awg4, curve: logc4, matrix: "bt709", range: "full", source: "ARRI, ALEXA LogC4 Specification" },
  { id: "bmdfilm-gen5", label: "Blackmagic Film Gen 5", description: "Blackmagic cameras (Pocket 4K/6K, URSA) in Film mode, Generation 5 color science: 18% gray near 38%.", gamut: GAMUTS.bmdwg5, curve: bmdfilm5, matrix: "bt709", range: "full", source: "Blackmagic Design, Blackmagic Generation 5 Color Science" },
  { id: "hlg-rec2020", label: "HLG (Rec.2020)", description: "HDR video in HLG, as phones and cameras record HDR (often tagged arib-std-b67).", gamut: GAMUTS.rec2020, curve: hlg, matrix: "bt2020", range: "narrow", source: "ITU-R BT.2100; reference white per ITU-R BT.2408" },
  { id: "pq-rec2020", label: "PQ / HDR10 (Rec.2020)", description: "HDR video in PQ (HDR10, Dolby Vision base layers; tagged smpte2084).", gamut: GAMUTS.rec2020, curve: pq, matrix: "bt2020", range: "narrow", source: "SMPTE ST 2084; reference white 203 nits per ITU-R BT.2408" },
];

export function colorSpace(id: string): ColorSpace | undefined {
  return COLOR_SPACES.find((s) => s.id === id);
}

// ---------------------------------------------------------------- matrices

export function multiply(a: Mat3, b: Mat3): Mat3 {
  return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j]! + row[1] * b[1][j]! + row[2] * b[2][j]!)) as Mat3;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;
}

export function invert(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const xyz = ([x, y]: Chromaticity): Vec3 => [x / y, 1, (1 - x - y) / y];

/** RGB in a gamut (linear) to CIE XYZ. */
export function rgbToXyz(g: Gamut): Mat3 {
  const [r, gr, b] = [xyz(g.red), xyz(g.green), xyz(g.blue)];
  const p: Mat3 = [
    [r[0], gr[0], b[0]],
    [r[1], gr[1], b[1]],
    [r[2], gr[2], b[2]],
  ];
  const s = apply(invert(p), xyz(g.white));
  return p.map((row) => [row[0] * s[0], row[1] * s[1], row[2] * s[2]]) as Mat3;
}

const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

/** Chromatic adaptation of XYZ from one white to another (Bradford). */
export function adapt(from: Chromaticity, to: Chromaticity): Mat3 {
  if (from[0] === to[0] && from[1] === to[1]) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [s, d] = [apply(BRADFORD, xyz(from)), apply(BRADFORD, xyz(to))];
  const scale: Mat3 = [
    [d[0] / s[0], 0, 0],
    [0, d[1] / s[1], 0],
    [0, 0, d[2] / s[2]],
  ];
  return multiply(invert(BRADFORD), multiply(scale, BRADFORD));
}

/** Linear RGB in gamut `from` to linear RGB in gamut `to`, white points adapted (Bradford). */
export function gamutMatrix(from: Gamut, to: Gamut): Mat3 {
  return multiply(invert(rgbToXyz(to)), multiply(adapt(from.white, to.white), rgbToXyz(from)));
}

/**
 * The color space a file's tags give, where they are enough: HDR is tagged (HLG `arib-std-b67`, PQ
 * `smpte2084`). Camera log is usually tagged Rec.709, so it is not found from tags.
 */
export function colorSpaceFromTags(transfer?: string): ColorSpaceId | undefined {
  if (transfer === "arib-std-b67") return "hlg-rec2020";
  if (transfer === "smpte2084") return "pq-rec2020";
  return undefined;
}
