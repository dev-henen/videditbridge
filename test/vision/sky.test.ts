import { describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, createProject } from "../../engine/core/index.js";
import { effectMedia, relightGains, usesSkyMask } from "../../engine/library/effects/index.js";
import { compileProject } from "../../engine/tools/index.js";
import { SKY_INPUT, compose, doubleTransforms, halve, horizonBand, probabilityToMatte, skyColors } from "../../engine/tools/vision/sky.js";

describe("sky", () => {
  it("finds the band of scenery just under the sky", () => {
    // 4 x 6: sky in the top two rows, except column 3, where it reaches down four.
    const [w, h] = [4, 6];
    const m = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) for (let y = 0; y < (x === 3 ? 4 : 2); y++) m[y * w + x] = 255;
    const band = horizonBand(m, w, h, 2);
    const col = (x: number) => Array.from({ length: h }, (_, y) => band[y * w + x]);
    expect(col(0)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(col(3)).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it("turns probabilities into a clean matte", () => {
    expect(Array.from(probabilityToMatte(Float32Array.from([0, 0.35, 0.5, 0.65, 1])))).toEqual([0, 0, 128, 255, 255]);
  });

  it("measures the old sky's color and its band above the scenery", () => {
    const n = SKY_INPUT;
    const rgb = new Uint8Array(n * n * 3);
    const p = new Float32Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const sky = y < n / 2;
        p[y * n + x] = sky ? 1 : 0;
        // Blue high up, paler in the 16 rows (5%) just above the scenery, green below.
        const c = sky ? (y >= n / 2 - 16 ? [180, 200, 230] : [60, 110, 200]) : [40, 120, 40];
        rgb.set(c, (y * n + x) * 3);
      }
    const c = skyColors(rgb, p);
    expect(c.share).toBe(0.5);
    expect(c.horizon).toBe("#B4C8E6");
    expect(parseInt(c.sky!.slice(5, 7), 16)).toBeGreaterThan(200);
  });

  it("tracks on half-size frames and scales the transforms back", () => {
    const img = Uint8Array.from({ length: 4 * 4 }, (_, i) => i * 10);
    expect(Array.from(halve(img, 4, 4))).toEqual([25, 45, 105, 125]);
    // A shift of (3, 2) half-size pixels is (6, 4) at full size; scale and turn are unchanged.
    const m = Float64Array.from([1.1, -0.1, 3, 0.1, 1.1, 2, 0, 0, 1]);
    expect(Array.from(doubleTransforms(m))).toEqual([1.1, -0.1, 6, 0.1, 1.1, 4, 0, 0, 1]);
    expect(compose([1, 0, 5, 0, 1, 0, 0, 0, 1], [2, 0, 0, 0, 2, 1, 0, 0, 1])).toEqual([2, 0, 5, 0, 2, 1, 0, 0, 1]);
  });

  it("relights toward a color without changing brightness", () => {
    const [r, g, b] = relightGains("#FF8040", 0.2);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(relightGains("#808080", 0.5)).toEqual([1, 1, 1]);
  });

  it("asks the renderer for the sky and the new sky's picture, and only works on clips", () => {
    const fx = { type: "skyReplace", params: { asset: "clouds" } };
    expect(usesSkyMask(fx)).toBe(true);
    expect(effectMedia(fx)).toEqual(["clouds"]);
    expect(usesSkyMask({ type: "blur", params: {}, mask: { kind: "sky", feather: 0.01, grow: 0, smooth: 0, denoise: false, invert: false, softness: 0.2 } })).toBe(true);
    let p = createProject({ settings: { width: 320, height: 180, fps: 30 } });
    p = addAsset(p, { type: "color", id: "bg", color: "#000000" });
    p = addAsset(p, { type: "image", id: "clouds", src: "clouds.png", width: 320, height: 180 });
    p = addClip(p, { assetId: "bg", duration: 1 });
    p = addLayer(p, { type: "media", assetId: "clouds", start: 0, duration: 1, effects: [fx] });
    expect(() => compileProject(p, { output: "out.mp4" })).toThrow(/primary video clips/);
  });
});
