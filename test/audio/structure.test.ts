import { describe, expect, it } from "vitest";
import { barLevels, bestWindow, musicStructure, placeOnBeats } from "../../engine/tools/audio/structure.js";

// A song of 2 s bars: 4 quiet bars (with a silent first one), 8 middling, 8 loud from the drop at
// 24 s, 4 middling, 4 loud.
const levels = [-60, -30, -30, -30, ...Array(8).fill(-15), ...Array(8).fill(-10), ...Array(4).fill(-16), ...Array(4).fill(-10)] as number[];
const downbeats = levels.map((_, k) => k * 2);

describe("music structure", () => {
  it("finds the drop on the loud part, not the jump out of a quiet intro, and names the sections", () => {
    const s = musicStructure(levels, downbeats, 56);
    expect(s.barLength).toBe(2);
    expect(s.drop).toBe(24);
    expect(s.sections.map((x) => [x.kind, x.start, x.end])).toEqual([
      ["intro", 0, 8],
      ["build", 8, 24],
      ["drop", 24, 40],
      ["build", 40, 48],
      ["chorus", 48, 56],
    ]);
  });

  it("picks a window starting on a phrase with the drop inside after a build", () => {
    const s = musicStructure(levels, downbeats, 56);
    // 20 s = 10 bars: starting at 16 s puts the drop 8 s in; starting at 24 s would be louder but has no build.
    expect(bestWindow(s, 20)).toEqual({ start: 16, end: 36, bars: 10, level: expect.any(Number), drop: 24 });
  });

  it("measures each bar's level from the samples", () => {
    const rate = 100;
    const samples = new Float32Array(400);
    samples.fill(0.5, 200, 400);
    const [quiet, loud] = barLevels(samples, rate, [0, 2], 4);
    expect(quiet).toBeLessThan(-100);
    expect(loud).toBeCloseTo(20 * Math.log10(0.5), 1);
  });
});

describe("placeOnBeats", () => {
  it("cuts on the beats after the start, and keeps the grid going past the last beat", () => {
    const beats = [10, 10.5, 11, 11.5, 12, 12.5];
    expect(placeOnBeats(beats, 10, [4, 2, 4], 0.5)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it("starts from the start even off the beat, then follows the beats", () => {
    expect(placeOnBeats([1, 2, 3, 4], 0.7, [1, 2], 1)).toEqual([
      { start: 0, end: 0.3 },
      { start: 0.3, end: 2.3 },
    ]);
  });
});
