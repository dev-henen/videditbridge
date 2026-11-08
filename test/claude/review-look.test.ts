import { describe, expect, it } from "vitest";
import { bandingScore, clippedShare, skinHue, toggleShare } from "../../engine/tools/review/index.js";
import { SKIN_LINE } from "../../engine/library/effects/color-match.js";

const [W, H] = [128, 64];
/** A picture from a gray value per pixel. */
const gray = (f: (x: number, y: number) => number) => Buffer.from(Array.from({ length: W * H * 3 }, (_, k) => Math.max(0, Math.min(255, Math.round(f(Math.floor(k / 3) % W, Math.floor(Math.floor(k / 3) / W)))))));

describe("review_edit look measurements", () => {
  it("counts clipped highlights and crushed shadows", () => {
    const c = clippedShare(gray((x) => (x < 16 ? 255 : x < 24 ? 0 : 128)));
    expect(c.highlights).toBeCloseTo(16 / W, 3);
    expect(c.shadows).toBeCloseTo(8 / W, 3);
  });

  it("sees bands in a stretched gradient, not in a fine one or in texture", () => {
    // 3-level steps every 8 px (an 8-bit gradient stretched by a grade), across and down; single
    // levels every 8 px (a plain 8-bit gradient, invisible); a step every 1 to 2 px.
    expect(bandingScore(gray((x) => 100 + 3 * Math.floor(x / 8)), W, H).score).toBeGreaterThan(0.9);
    expect(bandingScore(gray((_, y) => 100 + 3 * Math.floor(y / 8)), W, H).score).toBeGreaterThan(0.9);
    expect(bandingScore(gray((x) => 100 + Math.floor(x / 8)), W, H).score).toBeLessThan(0.1);
    expect(bandingScore(gray((x) => 100 + x * 0.6), W, H).score).toBeLessThan(0.1);
    // Noise and texture are not smooth areas.
    let s = 1;
    const noisy = bandingScore(gray(() => 100 + ((s = (s * 1103515245 + 12345) >>> 0) >>> 29)), W, H);
    expect(noisy.smooth).toBeLessThan(0.1);
  });

  it("reads skin hue inside faces against the skin line", () => {
    const face = [{ x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.9 }];
    const fill = (rgb: [number, number, number]) => Buffer.from(Array.from({ length: W * H * 3 }, (_, k) => rgb[k % 3]!));
    const natural = skinHue(fill([224, 172, 140]), W, H, face)!;
    expect(Math.abs(natural.hue - SKIN_LINE)).toBeLessThan(10);
    const green = skinHue(fill([180, 190, 140]), W, H, face)!;
    expect(Math.abs(green.hue - SKIN_LINE)).toBeGreaterThan(20);
    expect(skinHue(fill([224, 172, 140]), W, H, [])).toBeUndefined();
  });

  it("tells a flickering matte from a moving one", () => {
    const n = W * H;
    // A matte whose edge moves 2 px a frame: no pixel switches back.
    const moving = Array.from({ length: 10 }, (_, f) => Uint8Array.from({ length: n }, (_, q) => (q % W < 40 + 2 * f ? 255 : 0)));
    expect(toggleShare(moving)).toBe(0);
    // A matte whose edge band blinks every other frame.
    const blinking = Array.from({ length: 10 }, (_, f) => Uint8Array.from({ length: n }, (_, q) => (q % W < 40 || (q % W < 50 && f % 2 === 0) ? 255 : 0)));
    expect(toggleShare(blinking)).toBeGreaterThan(0.1);
  });
});
