import { describe, expect, it } from "vitest";
import { ACESCCT, AP1_Y, COLOR_SPACES, acescctToRec709, codeToPipeline, gradeAcescct, pipelineToCode, splitSceneGrade, toAcescct, toRec709, type Vec3 } from "../../engine/library/color/index.js";

const cct = (lin: number): Vec3 => [ACESCCT.fromLinear(lin), ACESCCT.fromLinear(lin), ACESCCT.fromLinear(lin)];
const linear = (c: Vec3): Vec3 => c.map((v) => ACESCCT.toLinear(v)) as Vec3;
const luminance = (lin: Vec3) => AP1_Y[0] * lin[0] + AP1_Y[1] * lin[1] + AP1_Y[2] * lin[2];

describe("grading in ACEScct", () => {
  it("a neutral grade changes nothing", () => {
    for (const c of [cct(0.01), cct(0.18), cct(2), [0.3, 0.45, 0.5] as Vec3]) {
      gradeAcescct(c, {}).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 9));
    }
  });

  it("exposure moves real stops, and contrast pivots on 18% gray", () => {
    expect(linear(gradeAcescct(cct(0.18), { exposure: 1 }))[1]).toBeCloseTo(0.36, 6);
    expect(linear(gradeAcescct(cct(0.18), { contrast: 60 }))[1]).toBeCloseTo(0.18, 6);
    // More contrast pushes a stop under gray further down.
    expect(linear(gradeAcescct(cct(0.09), { contrast: 60 }))[1]).toBeLessThan(0.09);
  });

  it("white balance warms or cools without changing luminance", () => {
    const warm = linear(gradeAcescct(cct(0.18), { temperature: 60 }));
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(luminance(warm)).toBeCloseTo(0.18, 6);
    const magenta = linear(gradeAcescct(cct(0.18), { tint: 50 }));
    expect(magenta[1]).toBeLessThan(magenta[0]);
  });

  it("saturation -100 is black and white; wheels tint their zone", () => {
    const gray = linear(gradeAcescct([0.5, 0.3, 0.35], { saturation: -100 }));
    expect(gray[0]).toBeCloseTo(gray[1], 9);
    expect(gray[1]).toBeCloseTo(gray[2], 9);
    // Teal shadows leave a bright gray alone and tint a dark one.
    const teal = { wheels: { shadows: { hue: 190, amount: 80 } } };
    const bright = gradeAcescct(cct(2), teal);
    expect(bright[2] - bright[0]).toBeCloseTo(0, 6);
    const dark = gradeAcescct(cct(0.01), teal);
    expect(dark[2]).toBeGreaterThan(dark[0]);
  });

  it("the camera half and the output half make the whole transform", () => {
    for (const space of COLOR_SPACES.filter((s) => s.curve)) {
      for (const rgb of [[0.4, 0.4, 0.4], [0.2, 0.5, 0.7], [0.9, 0.6, 0.3]] as Vec3[]) {
        const whole = toRec709(space, rgb);
        acescctToRec709(toAcescct(space, rgb)).forEach((v, i) => expect(v, space.id).toBeCloseTo(whole[i]!, 6));
      }
    }
  });

  it("reading code values back as pipeline RGB undoes pipelineToCode", () => {
    for (const space of COLOR_SPACES.filter((s) => s.curve)) {
      for (const code of [[0.41, 0.41, 0.41], [0.2, 0.5, 0.7], [0.6, 0.35, 0.3]] as Vec3[]) {
        // Within the rounding of the BT.601 decode constants (0.344136, 0.714136).
        pipelineToCode(space, codeToPipeline(space, code)).forEach((v, i) => expect(v, space.id).toBeCloseTo(code[i]!, 6));
      }
    }
  });

  it("splits the color panel: primaries to ACEScct, the rest on the picture", () => {
    const { scene, rest } = splitSceneGrade({ exposure: 0.5, contrast: 20, curves: { preset: "lighter" }, vignette: 30 });
    expect(scene).toEqual({ exposure: 0.5, contrast: 20 });
    expect(rest).toEqual({ curves: { preset: "lighter" }, vignette: 30 });
    expect(splitSceneGrade({ exposure: 0, fade: 10 }).scene).toBeUndefined();
  });
});
