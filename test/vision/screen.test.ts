import { describe, expect, it } from "vitest";
import { gaussian, levelsFilter, matchScreen, sharpness } from "../../engine/tools/vision/index.js";

const [W, H] = [240, 160];
const QUAD: [number, number][] = [[80, 50], [160, 50], [160, 110], [80, 110]];

/** Seeded noise, 0..255 gray. */
function noise(seed: number): Float32Array {
  let s = seed;
  return Float32Array.from({ length: W * H }, () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 24));
}

/** Packed RGB from gray with a gain per channel. */
const rgb = (g: Float32Array, gain: [number, number, number]) => Buffer.from(Array.from({ length: W * H * 3 }, (_, k) => Math.min(255, Math.round(g[Math.floor(k / 3)]! * gain[k % 3]!))));

describe("matching a screen insert to its shot", () => {
  it("blurs a sharp insert to a soft scene, and takes the scene's white balance", () => {
    // A soft, warm scene; the insert inside the quad is sharp and neutral.
    const scene = gaussian(noise(3), W, H, 2);
    const plain = rgb(scene, [1.1, 1, 0.8]);
    const sharp = noise(9);
    const withInsert = Buffer.from(plain);
    for (let y = 50; y < 110; y++) for (let x = 80; x < 160; x++) for (let c = 0; c < 3; c++) withInsert[(y * W + x) * 3 + c] = sharp[y * W + x]!;
    const m = matchScreen(plain, withInsert, W, H, QUAD);
    expect(m.blur).toBeGreaterThanOrEqual(1.2);
    expect(m.blur).toBeLessThanOrEqual(3.2);
    // Warm: red whites kept, blue whites lowered, never brightened.
    expect(m.levels.max[0]).toBe(1);
    expect(m.levels.max[2]).toBeLessThan(m.levels.max[1]);
    expect(Math.min(...m.levels.max)).toBeGreaterThanOrEqual(0.85);
    for (const v of m.levels.min) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0.08);
    }
    expect(levelsFilter(m.levels)).toMatch(/^colorlevels=romin=[\d.]+:gomin=[\d.]+:bomin=[\d.]+:romax=1:gomax=[\d.]+:bomax=[\d.]+$/);
  });

  it("leaves an insert alone when the scene is as sharp, or flat", () => {
    const g = noise(5);
    const plain = rgb(g, [1, 1, 1]);
    expect(matchScreen(plain, plain, W, H, QUAD).blur).toBe(0);
    // A flat insert has no sharpness to match.
    const flat = Buffer.from(plain);
    for (let y = 50; y < 110; y++) for (let x = 80; x < 160; x++) for (let c = 0; c < 3; c++) flat[(y * W + x) * 3 + c] = 200;
    expect(matchScreen(rgb(gaussian(g, W, H, 2), [1, 1, 1]), flat, W, H, QUAD).blur).toBe(0);
    expect(sharpness(new Float32Array(W * H).fill(100), W, H, () => true)).toBeUndefined();
  });
});
