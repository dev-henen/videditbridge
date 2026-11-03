import { describe, expect, it } from "vitest";
import { drawRegion, fitSize, inpaintCrop } from "../../engine/tools/vision/removal.js";

describe("object removal helpers", () => {
  it("draws fixed regions as rectangles and ellipses", () => {
    const rect = drawRegion({ shape: "rect", x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 }, 8, 8);
    expect(rect.filter((v) => v === 255).length).toBe(16);
    const ellipse = drawRegion({ shape: "ellipse", x0: 0, y0: 0, x1: 1, y1: 1 }, 20, 20);
    expect(ellipse[0]).toBe(0);
    expect(ellipse[10 * 20 + 10]).toBe(255);
    const area = ellipse.filter((v) => v === 255).length / 400;
    expect(area).toBeGreaterThan(0.75);
    expect(area).toBeLessThan(0.82);
  });

  it("crops around the hole for the model, with room around it, inside the frame", () => {
    const [W, H] = [640, 360];
    const hole = new Uint8Array(W * H);
    for (let y = 150; y < 190; y++) for (let x = 600; x < 630; x++) hole[y * W + x] = 1;
    const c = inpaintCrop(hole, W, H)!;
    expect(c.cw).toBe(256);
    expect(c.x + c.cw).toBe(W);
    expect(c.y).toBeLessThanOrEqual(150);
    expect(c.y + c.ch).toBeGreaterThanOrEqual(190);
    expect(inpaintCrop(new Uint8Array(W * H), W, H)).toBeUndefined();
  });

  it("works at the source's size up to 1920 on the long side", () => {
    expect(fitSize(3840, 2160, 1920)).toEqual({ w: 1920, h: 1080 });
    expect(fitSize(1080, 1920, 1920)).toEqual({ w: 1080, h: 1920 });
    expect(fitSize(640, 360, 1920)).toEqual({ w: 640, h: 360 });
  });
});
