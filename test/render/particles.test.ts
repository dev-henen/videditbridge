import { describe, expect, it } from "vitest";
import { parseProject, type Project } from "../../engine/core/index.js";
import { compileProject, footageSpeeds, particleSpec } from "../../engine/tools/index.js";
import { ParticleSettingsSchema } from "../../engine/library/particles/index.js";

/** Two clips (the second at half speed) and a full-frame particle layer over both. */
function project(layer: Record<string, unknown> = {}): Project {
  return parseProject({
    settings: { width: 320, height: 180, fps: 30 },
    assets: [
      { type: "video", id: "a", src: "a.mp4", duration: 4, width: 320, height: 180, hasAudio: false },
      { type: "video", id: "fx", src: "fx.mkv", duration: 4, width: 320, height: 180, hasAudio: false },
    ],
    clips: [
      { id: "c1", assetId: "a", duration: 2 },
      { id: "c2", assetId: "a", in: 2, duration: 1, speed: 0.5 },
    ],
    layers: [{ type: "media", id: "snow", assetId: "fx", start: 0, duration: 4, size: { width: 1, height: 1 }, fit: "stretch", ...layer }],
  });
}

describe("particle layers", () => {
  it("follow the speed of the footage under them", () => {
    const speeds = footageSpeeds(project(), 0, 120);
    expect(speeds[0]).toBe(1);
    expect(speeds[59]).toBe(1);
    expect(speeds[60]).toBe(0.5);
    expect(speeds[119]).toBe(0.5);
    const p = project();
    const s = ParticleSettingsSchema.parse({});
    expect(particleSpec(p, "snow", s, 1, 2, true).timeScale).toHaveLength(60);
    expect(particleSpec(p, "snow", s, 1, 2, false).timeScale).toBeUndefined();
  });

  it("show through a mask cut from the picture under them", () => {
    const { filterGraph } = compileProject(project({ mask: { kind: "key", hue: [190, 250] } }), { output: "out.mp4" });
    // The key is baked into a lookup table and multiplies the layer's alpha.
    expect(filterGraph).toMatch(/haldclutsrc/);
    expect(filterGraph).toMatch(/\[lbx\d+\]\[mmo\d+\]blend=all_mode=multiply/);
    // A normal layer with a mask is composited through its alpha, without a blend mode.
    expect(filterGraph).not.toMatch(/blend=all_mode=normal/);
  });

  it("take person and sky masks from the finished picture's mattes", () => {
    const sky = project({ mask: { kind: "sky" }, blend: "screen" });
    expect(() => compileProject(sky, { output: "out.mp4" })).toThrow(/sky matte of the finished picture/);
    const { args, filterGraph } = compileProject(sky, { output: "out.mp4", skyMatte: "sky.mkv" });
    expect(args).toContain("sky.mkv");
    expect(filterGraph).toMatch(/blend=all_mode=screen/);
    // A person mask and a layer behind the subject share one input of the person cutout.
    const both = parseProject({
      ...project({ mask: { kind: "person", invert: true } }),
      layers: [...project({ mask: { kind: "person", invert: true } }).layers, { type: "media", id: "smoke", assetId: "fx", start: 0, duration: 4, behindSubject: true }],
    });
    const c = compileProject(both, { output: "out.mp4", subjectMask: "subject.mkv" });
    expect(c.args.filter((a) => a === "subject.mkv")).toHaveLength(1);
    expect(c.filterGraph).toMatch(/split=2\[subm\d+\]\[subm\d+\]/);
  });

  it("refuse face and object masks", () => {
    expect(() => compileProject(project({ mask: { kind: "face" } }), { output: "out.mp4" })).toThrow(/face masks work on primary video clips/);
  });
});
