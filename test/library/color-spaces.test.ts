import { describe, expect, it } from "vitest";
import { ACESCCT, COLOR_SPACES, GAMUTS, apply, colorSpace, gamutMatrix, nitsToPq, pqToNits, rgbToXyz, type Mat3 } from "../../engine/library/color/spaces.js";

const close = (a: Mat3, b: Mat3, tolerance: number) => a.forEach((row, i) => row.forEach((v, j) => expect(v, `[${i}][${j}]`).toBeCloseTo(b[i]![j]!, -Math.log10(tolerance))));

describe("color spaces", () => {
  const logs = COLOR_SPACES.filter((s) => s.curve);

  // Section 4.1: each curve round-trips a synthetic ramp within 0.5% of full range.
  it.each(logs.map((s) => [s.id, s] as const))("%s round-trips a ramp within 0.5%", (_, s) => {
    for (let code = 0.02; code <= 0.98; code += 0.005) {
      expect(Math.abs(s.curve!.fromLinear(s.curve!.toLinear(code)) - code), `code ${code.toFixed(3)}`).toBeLessThan(0.005);
    }
    for (let stop = -8; stop <= 6; stop += 0.25) {
      const linear = 0.18 * 2 ** stop;
      const back = s.curve!.toLinear(s.curve!.fromLinear(linear));
      expect(Math.abs(back - linear) / linear, `${stop} stops`).toBeLessThan(0.005);
    }
  });

  it("curves rise steadily (no flat spots or folds)", () => {
    for (const s of logs) {
      let previous = -Infinity;
      for (let code = 0; code <= 1; code += 1 / 1023) {
        const linear = s.curve!.toLinear(code);
        expect(linear, `${s.id} at ${code.toFixed(4)}`).toBeGreaterThan(previous);
        previous = linear;
      }
    }
  });

  // Where each maker's documents put an 18% gray card (or the standard's reference point).
  it.each([
    ["slog3-sgamut3cine", 420 / 1023, 1e-9],
    ["vlog-vgamut", 0.4233, 5e-4],
    ["logc3-awg3", 0.391, 5e-4],
    ["logc4-awg4", 0.2784, 5e-4],
    ["bmdfilm-gen5", 0.3835, 5e-4],
    // Canon: 18% gray at 34.3%.
    ["clog3-cinemagamut", 0.3434, 5e-4],
  ] as const)("%s puts 18%% gray where its maker does", (id, code, tolerance) => {
    expect(Math.abs(colorSpace(id)!.curve!.fromLinear(0.18) - code)).toBeLessThan(tolerance);
  });

  it("HLG and PQ: reference white at 1.0, the standards' signal levels", () => {
    const hlg = colorSpace("hlg-rec2020")!.curve!;
    expect(hlg.fromLinear(1)).toBeCloseTo(0.75, 6);
    expect(pqToNits(nitsToPq(100))).toBeCloseTo(100, 6);
    expect(nitsToPq(100)).toBeCloseTo(0.5081, 4);
    expect(nitsToPq(10000)).toBeCloseTo(1, 6);
    expect(colorSpace("pq-rec2020")!.curve!.toLinear(nitsToPq(203))).toBeCloseTo(1, 6);
  });

  it("ACEScct: the Academy's constants and 18% gray", () => {
    expect(ACESCCT.fromLinear(0.18)).toBeCloseTo(0.4135884, 6);
    expect(ACESCCT.toLinear(ACESCCT.fromLinear(0.001))).toBeCloseTo(0.001, 9);
    expect(ACESCCT.fromLinear(0.0078125)).toBeCloseTo(0.155251141552511, 9);
  });

  it("matrices match the published ones", () => {
    // SMPTE ST 2065-1: AP0 to XYZ.
    close(rgbToXyz(GAMUTS.ap0), [[0.9525523959, 0, 0.0000936786], [0.3439664498, 0.7281660966, -0.0721325464], [0, 0, 1.0088251844]], 1e-6);
    // Rec.709 to XYZ (sRGB's matrix, published from the white point as XYZ, not xy: 1e-4 apart).
    close(rgbToXyz(GAMUTS.rec709), [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]], 1e-3);
    // ACES: AP1 to AP0 (same white, no adaptation).
    close(gamutMatrix(GAMUTS.ap1, GAMUTS.ap0), [[0.6954522414, 0.1406786965, 0.1638690622], [0.0447945634, 0.8596711185, 0.0955343182], [-0.0055258826, 0.0040252103, 1.0015006723]], 1e-6);
    // Rec.709 to ACEScg, D65 adapted to the ACES white with Bradford.
    close(gamutMatrix(GAMUTS.rec709, GAMUTS.ap1), [[0.6131, 0.3395, 0.0474], [0.0702, 0.9164, 0.0134], [0.0206, 0.1096, 0.8698]], 1e-3);
  });

  it("white stays white through every gamut to ACEScg", () => {
    for (const s of COLOR_SPACES) {
      const w = apply(gamutMatrix(s.gamut, GAMUTS.ap1), [1, 1, 1]);
      for (const v of w) expect(v, s.id).toBeCloseTo(1, 4);
    }
  });
});
