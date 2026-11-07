/**
 * Footage in a color space (camera log, HDR) to the edit's Rec.709 picture: the maker's curve to
 * scene linear, its gamut to ACES, then the ACES output transform. Both renderers apply it as one
 * 65-point 3D table built here (`cubeFor`), so they use the same numbers.
 *
 * The table's input is the pipeline's RGB: both renderers turn YUV into RGB with the BT.601
 * limited-range matrix, so YUV comes back as it went in. The transform undoes that, then reads the
 * file's R'G'B' as its maker stores it (`ColorSpace.matrix` and `range`).
 */

import { acesToRec709 } from "./aces.js";
import { ACESCCT, GAMUTS, apply, gamutMatrix, type ColorSpace, type Mat3, type Vec3 } from "./spaces.js";

/**
 * Input range of the table: pipeline RGB goes past 1 where code values pass video white. It starts
 * at 0 because FFmpeg's lut3d reads a .cube's range as a scale only (1 / (max - min)), without
 * the offset; values below 0 (only the most saturated colors) clamp there.
 */
export const CUBE_DOMAIN: [number, number] = [0, 1.25];
export const CUBE_SIZE = 65;
/** Changes when the transforms change, so tables written before are made again. */
export const TRANSFORM_VERSION = 2;

const KR_KB = { bt709: [0.2126, 0.0722], bt2020: [0.2627, 0.0593] } as const;

/** Pipeline RGB (decoded with BT.601, limited range) back to the file's YCbCr, as 8-bit code / 255. */
function pipelineToYuv([r, g, b]: Vec3): Vec3 {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [(16 + 219 * y) / 255, (128 + (224 * (b - y)) / 1.772) / 255, (128 + (224 * (r - y)) / 1.402) / 255];
}

/** Pipeline RGB to the file's R'G'B' code values (0..1), as the space's maker reads them. */
export function pipelineToCode(space: Pick<ColorSpace, "matrix" | "range">, rgb: Vec3): Vec3 {
  const [Y, Cb, Cr] = pipelineToYuv(rgb);
  const [kr, kb] = KR_KB[space.matrix];
  const kg = 1 - kr - kb;
  // Full range: code values as recorded. Narrow: 16..235 (luma) and 16..240 (chroma) to 0..1.
  const [y, cb, cr] = space.range === "full" ? [Y, Cb - 128 / 255, Cr - 128 / 255] : [(Y - 16 / 255) / (219 / 255), (Cb - 128 / 255) / (224 / 255), (Cr - 128 / 255) / (224 / 255)];
  const red = y + 2 * (1 - kr) * cr;
  const blue = y + 2 * (1 - kb) * cb;
  return [red, (y - kr * red - kb * blue) / kg, blue];
}

/** R'G'B' code values in `space` to scene-linear ACES2065-1 (AP0). */
export function codeToAces(space: ColorSpace, code: Vec3): Vec3 {
  if (!space.curve) throw new Error(`${space.id} is used as it is`);
  return apply(toAp0(space), code.map((c) => space.curve!.toLinear(c)) as Vec3);
}

const matrices = new Map<string, Mat3>();
const toAp0 = (space: ColorSpace) => {
  let m = matrices.get(space.gamut.id);
  if (!m) matrices.set(space.gamut.id, (m = gamutMatrix(space.gamut, GAMUTS.ap0)));
  return m;
};

/** Pipeline RGB of footage in `space` to the Rec.709 picture (pipeline RGB, 0..1). */
export function toRec709(space: ColorSpace, rgb: Vec3): Vec3 {
  return acesToRec709(codeToAces(space, pipelineToCode(space, rgb)));
}

/**
 * The transform as a .cube 3D table (Adobe/Resolve format, red fastest): `CUBE_SIZE` points per
 * axis over `CUBE_DOMAIN`. FFmpeg's lut3d and the engine read the same file.
 */
export function cubeFor(space: ColorSpace, size = CUBE_SIZE): string {
  const [lo, hi] = CUBE_DOMAIN;
  const at = (i: number) => lo + ((hi - lo) * i) / (size - 1);
  const lines = [
    `TITLE "${space.label} to Rec.709 (ACES)"`,
    `LUT_3D_SIZE ${size}`,
    `DOMAIN_MIN ${lo} ${lo} ${lo}`,
    `DOMAIN_MAX ${hi} ${hi} ${hi}`,
  ];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) lines.push(toRec709(space, [at(r), at(g), at(b)]).map((v) => v.toFixed(6)).join(" "));
  return `${lines.join("\n")}\n`;
}

const AP0_TO_AP1 = gamutMatrix(GAMUTS.ap0, GAMUTS.ap1);
const AP1_TO_AP0 = gamutMatrix(GAMUTS.ap1, GAMUTS.ap0);

/** Pipeline RGB of footage in `space` to ACEScct (ACEScg, log encoded): the camera half, for grading in between. */
export function toAcescct(space: ColorSpace, rgb: Vec3): Vec3 {
  return apply(AP0_TO_AP1, codeToAces(space, pipelineToCode(space, rgb))).map((v) => ACESCCT.fromLinear(v)) as Vec3;
}

/** ACEScct to the Rec.709 picture: the output half, the same for every color space. */
export function acescctToRec709(cct: Vec3): Vec3 {
  return acesToRec709(apply(AP1_TO_AP0, cct.map((c) => ACESCCT.toLinear(c)) as Vec3));
}

/** `cubeFor` split in two around ACEScct, for footage graded there: camera to ACEScct (over `CUBE_DOMAIN`). */
export function inputCubeFor(space: ColorSpace, size = CUBE_SIZE): string {
  const [lo, hi] = CUBE_DOMAIN;
  const at = (i: number) => lo + ((hi - lo) * i) / (size - 1);
  const lines = [`TITLE "${space.label} to ACEScct"`, `LUT_3D_SIZE ${size}`, `DOMAIN_MIN ${lo} ${lo} ${lo}`, `DOMAIN_MAX ${hi} ${hi} ${hi}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) lines.push(toAcescct(space, [at(r), at(g), at(b)]).map((v) => v.toFixed(6)).join(" "));
  return `${lines.join("\n")}\n`;
}

/** The inverse of `pipelineToCode`: the file's R'G'B' code values (0..1) as the pipeline's RGB. */
export function codeToPipeline(space: Pick<ColorSpace, "matrix" | "range">, [red, green, blue]: Vec3): Vec3 {
  const [kr, kb] = KR_KB[space.matrix];
  const y = kr * red + (1 - kr - kb) * green + kb * blue;
  const [cb, cr] = [(blue - y) / (2 * (1 - kb)), (red - y) / (2 * (1 - kr))];
  const [Y, Cb, Cr] = space.range === "full" ? [y, cb + 128 / 255, cr + 128 / 255] : [16 / 255 + (y * 219) / 255, 128 / 255 + (cb * 224) / 255, 128 / 255 + (cr * 224) / 255];
  // BT.601 limited range to RGB, as both renderers decode.
  const [l, u, v] = [(Y - 16 / 255) / (219 / 255), (Cb - 128 / 255) / (224 / 255), (Cr - 128 / 255) / (224 / 255)];
  return [l + 1.402 * v, l - 0.344136 * u - 0.714136 * v, l + 1.772 * u];
}
