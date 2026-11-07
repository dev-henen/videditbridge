/**
 * The ACES 1.x output transform for Rec.709 displays: the Reference Rendering Transform (RRT) and
 * the Rec.709 100-nit dim-surround Output Device Transform (ODT), ported from the Academy's
 * reference CTL (aces-dev: RRT.ctl, ODT.Academy.Rec709_100nits_dim.ctl, ACESlib.*). It turns
 * scene-linear ACES into a Rec.709 picture with a filmic tone curve: a soft roll-off into the
 * highlights instead of a hard clip, and lifted, gentle shadows.
 */

import { GAMUTS, adapt, apply, gamutMatrix, invert, multiply, rgbToXyz, type Mat3, type Vec3 } from "./spaces.js";

const HALF_MIN = 6.103515625e-5;
const HALF_MAX = 65504;

const AP0_TO_AP1 = gamutMatrix(GAMUTS.ap0, GAMUTS.ap1);
const AP1_TO_AP0 = gamutMatrix(GAMUTS.ap1, GAMUTS.ap0);
const AP1_TO_XYZ = rgbToXyz(GAMUTS.ap1);
const AP1_RGB_TO_Y: Vec3 = AP1_TO_XYZ[1];

/** A saturation matrix keeping luminance (ACESlib.Utilities_Color calc_sat_adjust_matrix). */
function saturationMatrix(sat: number, rgbToY: Vec3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (1 - sat) * rgbToY[j]! + (i === j ? sat : 0))) as Mat3;
}

const RRT_SAT = saturationMatrix(0.96, AP1_RGB_TO_Y);
const ODT_SAT = saturationMatrix(0.93, AP1_RGB_TO_Y);

interface SplineParams {
  coefsLow: number[];
  coefsHigh: number[];
  minPoint: [number, number];
  midPoint: [number, number];
  maxPoint: [number, number];
  slopeLow: number;
  slopeHigh: number;
}

const M_SPLINE: Mat3 = [
  [0.5, -1, 0.5],
  [-1, 1, 0.5],
  [0.5, 0, 0],
];

/** A segmented quadratic B-spline in log10-log10 (ACESlib.Tonescales segmented_spline_c5/c9_fwd). */
function spline(x: number, c: SplineParams, knotsLow: number, knotsHigh: number): number {
  const logx = Math.log10(Math.max(x, HALF_MIN));
  const [lmin, lmid, lmax] = [Math.log10(c.minPoint[0]), Math.log10(c.midPoint[0]), Math.log10(c.maxPoint[0])];
  const piece = (coefs: number[], from: number, to: number, knots: number) => {
    const coord = ((knots - 1) * (logx - from)) / (to - from);
    const j = Math.floor(coord);
    const t = coord - j;
    const cf = [coefs[j]!, coefs[j + 1]!, coefs[j + 2]!];
    const m = [0, 1, 2].map((k) => cf[0]! * M_SPLINE[0][k]! + cf[1]! * M_SPLINE[1][k]! + cf[2]! * M_SPLINE[2][k]!);
    return t * t * m[0]! + t * m[1]! + m[2]!;
  };
  let logy: number;
  if (logx <= lmin) logy = logx * c.slopeLow + (Math.log10(c.minPoint[1]) - c.slopeLow * lmin);
  else if (logx < lmid) logy = piece(c.coefsLow, lmin, lmid, knotsLow);
  else if (logx < lmax) logy = piece(c.coefsHigh, lmid, lmax, knotsHigh);
  else logy = logx * c.slopeHigh + (Math.log10(c.maxPoint[1]) - c.slopeHigh * lmax);
  return 10 ** logy;
}

const RRT_PARAMS: SplineParams = {
  coefsLow: [-4.0, -4.0, -3.1573765773, -0.4852499958, 1.8477324706, 1.8477324706],
  coefsHigh: [-0.7185482425, 2.0810307172, 3.6681241237, 4.0, 4.0, 4.0],
  minPoint: [0.18 * 2 ** -15, 0.0001],
  midPoint: [0.18, 4.8],
  maxPoint: [0.18 * 2 ** 18, 10000],
  slopeLow: 0,
  slopeHigh: 0,
};
const c5 = (x: number) => spline(x, RRT_PARAMS, 4, 4);

const ODT_48_NITS: SplineParams = {
  coefsLow: [-1.69897, -1.69897, -1.4779, -1.2291, -0.8648, -0.448, 0.00518, 0.4511080334, 0.9113744414, 0.9113744414],
  coefsHigh: [0.5154386965, 0.8470437783, 1.1358, 1.3802, 1.5197, 1.5985, 1.6467, 1.6746091357, 1.687873339, 1.687873339],
  minPoint: [c5(0.18 * 2 ** -6.5), 0.02],
  midPoint: [c5(0.18), 4.8],
  maxPoint: [c5(0.18 * 2 ** 6.5), 48],
  slopeLow: 0,
  slopeHigh: 0.04,
};
const c9 = (x: number) => spline(x, ODT_48_NITS, 8, 8);

const rgbToSaturation = ([r, g, b]: Vec3) => (Math.max(r, g, b, 1e-10) - Math.max(Math.min(r, g, b), 1e-10)) / Math.max(Math.max(r, g, b), 1e-2);

function rgbToYc([r, g, b]: Vec3): number {
  const chroma = Math.sqrt(Math.max(0, b * (b - g) + g * (g - r) + r * (r - b)));
  return (b + g + r + 1.75 * chroma) / 3;
}

function rgbToHue([r, g, b]: Vec3): number {
  if (r === g && g === b) return 0;
  const hue = (180 / Math.PI) * Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
  return hue < 0 ? hue + 360 : hue;
}

function sigmoidShaper(x: number): number {
  const t = Math.max(1 - Math.abs(x / 2), 0);
  return (1 + Math.sign(x) * (1 - t * t)) / 2;
}

function glowFwd(yc: number, gain: number, mid: number): number {
  if (yc <= (2 / 3) * mid) return gain;
  if (yc >= 2 * mid) return 0;
  return gain * (mid / yc - 0.5);
}

const CUBIC_BASIS = [
  [-1 / 6, 3 / 6, -3 / 6, 1 / 6],
  [3 / 6, -6 / 6, 3 / 6, 0],
  [-3 / 6, 0, 3 / 6, 0],
  [1 / 6, 4 / 6, 1 / 6, 0],
];

function cubicBasisShaper(x: number, width: number): number {
  const knots = [-width / 2, -width / 4, 0, width / 4, width / 2];
  if (!(x > knots[0]! && x < knots[4]!)) return 0;
  const coord = ((x - knots[0]!) * 4) / width;
  const j = Math.floor(coord);
  const t = coord - j;
  const monomials = [t * t * t, t * t, t, 1];
  const column = 3 - j;
  return 1.5 * monomials.reduce((sum, m, i) => sum + m * CUBIC_BASIS[i]![column]!, 0);
}

function centerHue(hue: number, center: number): number {
  let h = hue - center;
  if (h < -180) h += 360;
  else if (h > 180) h -= 360;
  return h;
}

/** The RRT: scene-linear ACES2065-1 (AP0) to OCES (AP0). */
export function rrt(input: Vec3): Vec3 {
  let aces: Vec3 = [...input];
  // Glow module: lifts dark, saturated colors a little.
  const saturation = rgbToSaturation(aces);
  const s = sigmoidShaper((saturation - 0.4) / 0.2);
  const glow = 1 + glowFwd(rgbToYc(aces), 0.05 * s, 0.08);
  aces = aces.map((v) => v * glow) as Vec3;
  // Red modifier: keeps saturated reds from going orange and too bright.
  const hueWeight = cubicBasisShaper(centerHue(rgbToHue(aces), 0), 135);
  aces[0] = aces[0] + hueWeight * saturation * (0.03 - aces[0]) * (1 - 0.82);
  // To the rendering space (AP1), global desaturation, then the tone scale per channel.
  aces = aces.map((v) => Math.min(Math.max(v, 0), Infinity)) as Vec3;
  let rgb = apply(AP0_TO_AP1, aces).map((v) => Math.min(Math.max(v, 0), HALF_MAX)) as Vec3;
  rgb = apply(RRT_SAT, rgb);
  rgb = rgb.map(c5) as Vec3;
  return apply(AP1_TO_AP0, rgb);
}

const D60_TO_D65 = adapt(GAMUTS.ap1.white, GAMUTS.rec709.white);
const XYZ_TO_REC709 = invert(rgbToXyz(GAMUTS.rec709));
const CINEMA_WHITE = 48;
const CINEMA_BLACK = 10 ** Math.log10(0.02);
const DIM_SURROUND_GAMMA = 0.9811;

function darkToDimSurround(linear: Vec3): Vec3 {
  const [X, Y, Z] = apply(AP1_TO_XYZ, linear);
  const sum = Math.max(X + Y + Z, 1e-10);
  const [x, y] = [X / sum, Y / sum];
  const Ydim = Math.max(Y, 0) ** DIM_SURROUND_GAMMA;
  const yy = Math.max(y, 1e-10);
  return apply(invert(AP1_TO_XYZ), [(x * Ydim) / yy, Ydim, ((1 - x - y) * Ydim) / yy]);
}

/** The Rec.709 100-nit dim-surround ODT: OCES (AP0) to Rec.709 code values (BT.1886, gamma 2.4), 0..1. */
export function odtRec709(oces: Vec3): Vec3 {
  const toned = apply(AP0_TO_AP1, oces).map(c9);
  let linear = toned.map((y) => (y - CINEMA_BLACK) / (CINEMA_WHITE - CINEMA_BLACK)) as Vec3;
  linear = darkToDimSurround(linear);
  linear = apply(ODT_SAT, linear);
  const display = apply(multiply(XYZ_TO_REC709, D60_TO_D65), apply(AP1_TO_XYZ, linear));
  return display.map((v) => Math.min(Math.max(v, 0), 1) ** (1 / 2.4)) as Vec3;
}

/** Scene-linear ACES2065-1 to a Rec.709 picture (0..1 code values): RRT then ODT. */
export function acesToRec709(aces: Vec3): Vec3 {
  return odtRec709(rrt(aces));
}
