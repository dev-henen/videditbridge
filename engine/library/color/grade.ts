/**
 * Grading in ACEScct, as colorists grade camera footage: for footage in a color space (camera log,
 * HDR), the color panel's primary controls act on scene light, between the camera transform and
 * the ACES output transform, so exposure moves real stops and white balance acts before the tone
 * curve. The engine runs this math as a shader (native/ave-render/src/shaders/grade.wgsl, which
 * follows this file exactly); the FFmpeg backend bakes it into a table (`gradeCube`).
 *
 * The other controls (curves, HSL, fade, vignette and the rest) stay on the finished Rec.709
 * picture, as for ordinary video.
 */

import type { ColorSettings } from "../effects/color.js";
import { ACESCCT, type Vec3 } from "./spaces.js";
import { CUBE_SIZE, acescctToRec709 } from "./transform.js";

/** The primary controls graded in ACEScct. */
export interface SceneGrade {
  /** Stops. */
  exposure?: number;
  /** -100..100: cooler to warmer, greener to more magenta. */
  temperature?: number;
  tint?: number;
  /** -100..100, around 18% gray. */
  contrast?: number;
  /** -100 (black and white)..100. */
  saturation?: number;
  /** Tints of the shadows, midtones and highlights: hue in degrees, amount 0..100. */
  wheels?: { shadows?: Wheel; midtones?: Wheel; highlights?: Wheel };
}
type Wheel = { hue: number; amount: number };

export const SCENE_SETTINGS = ["exposure", "temperature", "tint", "contrast", "saturation", "wheels"] as const;

/** A color panel's settings split into what grades in ACEScct and what stays on the Rec.709 picture. */
export function splitSceneGrade(settings: ColorSettings): { scene?: SceneGrade; rest: ColorSettings } {
  const scene: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...settings };
  for (const k of SCENE_SETTINGS) {
    if (settings[k] !== undefined) {
      scene[k] = settings[k];
      delete rest[k];
    }
  }
  const active = Object.values(scene).some((v) => (typeof v === "number" ? v !== 0 : v !== undefined));
  return { ...(active ? { scene: scene as SceneGrade } : {}), rest: rest as ColorSettings };
}

/** ACEScct of 18% gray: contrast pivots here. */
export const PIVOT = ACESCCT.fromLinear(0.18);
/** Luminance weights of ACEScg (AP1). */
export const AP1_Y: Vec3 = [0.2722287168, 0.6740817658, 0.0536895174];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** The direction a wheel pushes (hue 0 red, 120 green, 240 blue), in ACEScct units at full amount. */
function wheelOffset(w: Wheel | undefined): Vec3 {
  if (!w || !w.amount) return [0, 0, 0];
  const h = (w.hue * Math.PI) / 180;
  const k = (w.amount / 100) * 0.05;
  return [k * Math.cos(h), k * Math.cos(h - (2 * Math.PI) / 3), k * Math.cos(h - (4 * Math.PI) / 3)];
}

/** A grade's numbers, worked out once: what the shader (and `gradeAcescct`) apply per pixel. */
export interface GradeConstants {
  /** Linear gains per channel: white balance (keeping luminance) times exposure. */
  gains: Vec3;
  /** Contrast factor around `PIVOT`, in ACEScct. */
  contrast: number;
  /** Saturation factor around luminance (0 is black and white). */
  saturation: number;
  /** ACEScct offsets of the shadows, midtones and highlights wheels. */
  shadows: Vec3;
  midtones: Vec3;
  highlights: Vec3;
}

export function gradeConstants(g: SceneGrade): GradeConstants {
  const [t, k] = [(g.temperature ?? 0) / 100, (g.tint ?? 0) / 100];
  const balance: Vec3 = [2 ** (0.25 * t), 2 ** (-0.2 * k), 2 ** (-0.25 * t)];
  const y = dot(AP1_Y, balance);
  const exposure = 2 ** (g.exposure ?? 0);
  return {
    gains: balance.map((v) => (v * exposure) / y) as Vec3,
    contrast: 2 ** (((g.contrast ?? 0) / 100) * 0.6),
    saturation: 1 + (g.saturation ?? 0) / 100,
    shadows: wheelOffset(g.wheels?.shadows),
    midtones: wheelOffset(g.wheels?.midtones),
    highlights: wheelOffset(g.wheels?.highlights),
  };
}

/** Grade ACEScct values: white balance and exposure on linear light, contrast in ACEScct, saturation, then the wheels. */
export function gradeAcescct(cct: Vec3, g: SceneGrade): Vec3 {
  const c = gradeConstants(g);
  // White balance and exposure: gains on linear AP1.
  let lin = cct.map((v, i) => ACESCCT.toLinear(v) * c.gains[i]!) as Vec3;
  // Contrast around 18% gray, in ACEScct.
  lin = lin.map((v) => ACESCCT.toLinear(PIVOT + (ACESCCT.fromLinear(v) - PIVOT) * c.contrast)) as Vec3;
  // Saturation around luminance.
  const lum = dot(AP1_Y, lin);
  lin = lin.map((v) => lum + (v - lum) * c.saturation) as Vec3;
  // Wheels: offsets in ACEScct, each weighted by its zone of the luminance.
  const out = lin.map((v) => ACESCCT.fromLinear(v)) as Vec3;
  const zone = ACESCCT.fromLinear(Math.max(dot(AP1_Y, lin), 0));
  const shadows = 1 - smoothstep(0.15, PIVOT, zone);
  const highlights = smoothstep(PIVOT, 0.65, zone);
  const midtones = Math.max(0, 1 - shadows - highlights);
  return out.map((v, i) => v + shadows * c.shadows[i]! + midtones * c.midtones[i]! + highlights * c.highlights[i]!) as Vec3;
}

/** Input range of ACEScct tables: 0 to past ACEScct's largest value (1.468). */
export const ACESCCT_DOMAIN: [number, number] = [0, 1.5];

/** A .cube table over ACEScct values (`ACESCCT_DOMAIN`). */
export function acescctCube(title: string, f: (cct: Vec3) => Vec3, size = CUBE_SIZE): string {
  const [lo, hi] = ACESCCT_DOMAIN;
  const at = (i: number) => lo + ((hi - lo) * i) / (size - 1);
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, `DOMAIN_MIN ${lo} ${lo} ${lo}`, `DOMAIN_MAX ${hi} ${hi} ${hi}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) lines.push(f([at(r), at(g), at(b)]).map((v) => v.toFixed(6)).join(" "));
  return `${lines.join("\n")}\n`;
}

/** The grade as a table, ACEScct to ACEScct (the FFmpeg backend's form of the shader). */
export function gradeCube(g: SceneGrade): string {
  return acescctCube("ACEScct grade", (c) => gradeAcescct(c, g));
}

/** The output half as a table: ACEScct to the Rec.709 picture. */
export function outputCube(): string {
  return acescctCube("ACEScct to Rec.709 (ACES)", acescctToRec709);
}
