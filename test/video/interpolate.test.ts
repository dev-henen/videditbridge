import { describe, expect, it } from "vitest";
import { ClipSchema } from "../../engine/core/schema.js";
import { speedMap } from "../../engine/core/timeline.js";
import { clipFrameTimes, framePlan, needsFrames } from "../../engine/tools/video/interpolate.js";

const timed = (clip: Record<string, unknown>, sourceDuration: number) => {
  const c = ClipSchema.parse({ id: "c", assetId: "a", ...clip });
  const map = speedMap(c, sourceDuration);
  return { clip: c, sourceDuration, duration: map ? map.duration : sourceDuration / c.speed, speedMap: map };
};

describe("frame interpolation planning", () => {
  it("takes real frames where they are and asks for the rest at the right fraction", () => {
    expect(framePlan([0, 1 / 120, 2 / 120, 3 / 120, 4 / 120], 30)).toEqual([
      { frame: 0, t: 0 },
      { frame: 0, t: 0.25 },
      { frame: 0, t: 0.5 },
      { frame: 0, t: 0.75 },
      { frame: 1, t: 0 },
    ]);
    // Within a twentieth of a frame of a real one, the real one.
    expect(framePlan([0.999 / 30, 1.02 / 30], 30)).toEqual([{ frame: 1, t: 0 }, { frame: 1, t: 0 }]);
  });

  it("lists the source time of every frame a slowed clip shows", () => {
    const times = clipFrameTimes(timed({ in: 2, duration: 1, speed: 0.25 }, 1), 30);
    // 4 s on the timeline at 30 fps, and one more.
    expect(times).toHaveLength(121);
    expect(times[0]).toBe(2);
    expect(times[1]! - times[0]!).toBeCloseTo(1 / 120);
    const plan = framePlan(times, 30);
    expect(plan.filter((p) => p.t > 0)).toHaveLength(90);
    expect(needsFrames(plan)).toBe(true);
    // At full speed, every frame is in the footage.
    expect(needsFrames(framePlan(clipFrameTimes(timed({ duration: 1 }, 1), 30), 30))).toBe(false);
    // 24 fps footage in a 60 fps edit needs frames in between.
    expect(needsFrames(framePlan(clipFrameTimes(timed({ duration: 1 }, 1), 60), 24))).toBe(true);
  });

  it("keeps source order for a reversed clip, and follows a speed ramp", () => {
    const rev = clipFrameTimes(timed({ in: 1, duration: 1, speed: 0.5, reverse: true }, 1), 30);
    expect(rev[0]).toBeCloseTo(1);
    expect(rev[rev.length - 1]).toBeCloseTo(2);
    expect(rev.every((t, k) => k === 0 || t >= rev[k - 1]!)).toBe(true);
    const ramp = clipFrameTimes(timed({ duration: 2, keyframes: { speed: [{ time: 0, value: 1 }, { time: 1, value: 1, easing: "linear" }, { time: 1.01, value: 0.25, easing: "linear" }] } }, 2), 30);
    const steps = ramp.slice(1).map((t, k) => t - ramp[k]!);
    // A frame's worth of footage per frame first, a quarter of one later.
    expect(steps[5]).toBeCloseTo(1 / 30, 3);
    expect(steps[steps.length - 5]).toBeCloseTo(1 / 120, 3);
  });
});
