import { describe, expect, it } from "vitest";
import { PEOPLE_SURE, confidentPeople, personBox, summarizeBoxes } from "../../engine/tools/vision/people.js";

const N = 100;
/** A mask with rectangles of person pixels (x0, y0, x1, y1 in pixels, inclusive). */
const mask = (...rects: [number, number, number, number][]) => {
  const m = new Float32Array(N * N);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * N + x] = 0.9;
  return m;
};

describe("personBox", () => {
  it("boxes the main person and leaves out a smaller one apart from them", () => {
    expect(personBox(mask([40, 20, 55, 90], [80, 60, 85, 75]), N)).toEqual({ x0: 0.4, y0: 0.2, x1: 0.56, y1: 0.91, sure: 0.9 });
  });

  it("prefers a whole person in the middle to a bigger one cut off by the side of the frame", () => {
    expect(personBox(mask([0, 10, 20, 95], [45, 40, 58, 90]), N)!.x0).toBe(0.45);
  });

  it("passes over a region far wider than tall in the picture (a car), given the source's shape", () => {
    // 40 x 12 pixels of a square mask is 3.3 times wider than tall in a square picture.
    expect(personBox(mask([10, 50, 49, 61], [60, 30, 69, 70]), N, 0.5, 0.003, 2, 1)!.x0).toBe(0.6);
  });

  it("finds nobody in an empty or nearly empty mask", () => {
    expect(personBox(new Float32Array(N * N), N)).toBeUndefined();
    expect(personBox(mask([10, 10, 11, 11]), N)).toBeUndefined();
  });

  it("summarizes boxes as their extent and median", () => {
    const s = summarizeBoxes([
      { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.8 },
      { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.8 },
      { x0: 0.6, y0: 0.1, x1: 0.8, y1: 0.9 },
    ]);
    expect(s.extent).toEqual({ x0: 0.1, y0: 0.1, x1: 0.8, y1: 0.9 });
    expect(s.box).toEqual({ x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.8 });
  });
});

describe("confidentPeople", () => {
  const box = (x0: number, sure: number) => ({ x0, y0: 0.1, x1: x0 + 0.2, y1: 0.9, sure });
  it("reports people the model is sure of in most frames", () => {
    const r = confidentPeople([{ time: 0, box: box(0.4, 0.98) }, { time: 1, box: box(0.42, 0.97) }, { time: 2 }]);
    expect(r.confidence).toBeCloseTo(0.975, 2);
    expect(r.box?.x0).toBeCloseTo(0.41, 5);
  });

  it("reports nobody when the model is unsure (a car, a building) or finds them in too few frames", () => {
    expect(confidentPeople([{ time: 0, box: box(0.4, 0.88) }, { time: 1, box: box(0.4, 0.9) }]).box).toBeUndefined();
    expect(confidentPeople([{ time: 0, box: box(0.4, 0.99) }, { time: 1 }, { time: 2 }]).box).toBeUndefined();
    expect(PEOPLE_SURE).toBe(0.95);
  });

  it("takes a lower bar when asked (game and cartoon characters)", () => {
    expect(confidentPeople([{ time: 0, box: box(0.4, 0.78) }], 0.65).box).toBeDefined();
  });
});
