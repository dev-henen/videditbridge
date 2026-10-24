import { describe, expect, it } from "vitest";
import {
  addAudio,
  addClip,
  addLayer,
  computeTimeline,
  createProject,
  cutTimelineRanges,
  moveClip,
  parseProject,
  projectJsonSchema,
  removeClip,
  setTransition,
  splitClip,
  summarizeProject,
  updateLayer,
  validateProject,
  type Project,
} from "../src/core/index.js";

function base(): Project {
  return parseProject({
    settings: { width: 1080, height: 1920, fps: 30 },
    assets: [
      { type: "video", id: "a", src: "a.mp4", duration: 10, hasAudio: true },
      { type: "video", id: "b", src: "b.mp4", duration: 6, hasAudio: false },
      { type: "image", id: "img", src: "x.png" },
      { type: "audio", id: "music", src: "m.mp3", duration: 30 },
    ],
    clips: [
      { id: "c1", assetId: "a", in: 1, duration: 4 },
      { id: "c2", assetId: "b", duration: 3, transition: { type: "fade", duration: 1 } },
      { id: "c3", assetId: "img", duration: 2, speed: 1 },
    ],
  });
}

describe("schema", () => {
  it("fills defaults", () => {
    const p = parseProject({});
    expect(p.settings).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(p.clips).toEqual([]);
    expect(p.export.videoCodec).toBe("libx264");
  });

  it("produces a JSON schema for AI consumption", () => {
    const schema = projectJsonSchema();
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("transition");
  });

  it("createProject applies aspect ratio", () => {
    expect(createProject({ aspectRatio: "16:9" }).settings).toMatchObject({ width: 1920, height: 1080 });
  });
});

describe("timeline", () => {
  it("overlaps clips by transition duration", () => {
    const t = computeTimeline(base());
    expect(t.clips.map((c) => [c.start, c.end])).toEqual([
      [0, 4],
      [3, 6],
      [6, 8],
    ]);
    expect(t.duration).toBe(8);
  });

  it("applies speed", () => {
    const p = parseProject({ ...base(), clips: [{ id: "c", assetId: "a", duration: 4, speed: 2 }] });
    expect(computeTimeline(p).duration).toBe(2);
  });

  it("uses rest of source when duration omitted", () => {
    const p = parseProject({ ...base(), clips: [{ id: "c", assetId: "a", in: 3 }] });
    expect(computeTimeline(p).duration).toBe(7);
  });

  it("clamps transitions to fit short clips", () => {
    const p = setTransition(base(), "c3", { type: "fade", duration: 4 });
    const tc = computeTimeline(p).clips[2]!;
    expect(tc.transitionDuration).toBeLessThan(2);
  });

  it("looping music fills the video", () => {
    const p = addAudio(base(), { assetId: "music", loop: true, duration: undefined });
    expect(computeTimeline(p).audio[0]!.duration).toBe(8);
  });
});

describe("operations", () => {
  it("are immutable", () => {
    const p = base();
    const before = JSON.stringify(p);
    addClip(p, { assetId: "a", duration: 1 });
    removeClip(p, "c1");
    expect(JSON.stringify(p)).toBe(before);
  });

  it("splits a clip at a timeline time", () => {
    const { project, newClipId } = splitClip(base(), "c1", 1.5);
    const [first, second] = project.clips;
    expect(first).toMatchObject({ id: "c1", in: 1, duration: 1.5 });
    expect(second).toMatchObject({ id: newClipId, in: 2.5, duration: 2.5 });
    expect(computeTimeline(project).duration).toBe(8);
  });

  it("removes the first clip's transition when reordered", () => {
    const p = moveClip(base(), "c2", 0);
    expect(p.clips[0]!.id).toBe("c2");
    expect(p.clips[0]!.transition).toBeUndefined();
  });

  it("cuts timeline ranges and shifts layers and audio", () => {
    let p = parseProject({ ...base(), clips: [{ id: "c1", assetId: "a", in: 0, duration: 10 }] });
    p = addLayer(p, { type: "text", id: "t", text: "hi", start: 6, duration: 2 });
    p = addLayer(p, { type: "text", id: "inside", text: "gone", start: 2.2, duration: 0.5 });
    p = addAudio(p, { id: "m", assetId: "music", start: 0, duration: 10 });
    const cut = cutTimelineRanges(p, [{ start: 2, end: 3 }]);
    expect(cut.clips.map((c) => [c.in, c.duration])).toEqual([
      [0, 2],
      [3, 7],
    ]);
    expect(computeTimeline(cut).duration).toBe(9);
    expect(cut.layers.find((l) => l.id === "t")).toMatchObject({ start: 5, duration: 2 });
    expect(cut.layers.find((l) => l.id === "inside")).toBeUndefined();
    expect(cut.audio[0]).toMatchObject({ start: 0, duration: 9 });
  });

  it("merges text style on updateLayer", () => {
    let p = addLayer(base(), { type: "text", id: "t", text: "x", start: 0, duration: 1, style: { fontSize: 50, color: "#FF0000" } });
    p = updateLayer(p, "t", { style: { fontSize: 80 } });
    const l = p.layers[0]!;
    expect(l.type === "text" && l.style).toMatchObject({ fontSize: 80, color: "#FF0000" });
  });

  it("rejects unknown references with helpful errors", () => {
    expect(() => removeClip(base(), "nope")).toThrow(/Clip ids: c1, c2, c3/);
    expect(() => addClip(base(), { assetId: "missing" })).toThrow(/Unknown asset/);
  });
});

describe("validation", () => {
  it("accepts a good project", () => {
    expect(validateProject(base()).ok).toBe(true);
  });

  it("reports schema, reference and catalog errors", () => {
    const r = validateProject({
      assets: [{ type: "video", id: "a", src: "a.mp4", duration: 5 }],
      clips: [
        { id: "c1", assetId: "a", in: 4, duration: 3, effects: [{ type: "sparkles" }] },
        { id: "c2", assetId: "zzz", transition: { type: "warp", duration: 0.5 } },
      ],
      captions: { style: "nope" },
    });
    const msgs = r.issues.map((i) => i.message).join("\n");
    expect(r.ok).toBe(false);
    expect(msgs).toMatch(/exceeds source length/);
    expect(msgs).toMatch(/Unknown effect "sparkles"/);
    expect(msgs).toMatch(/Unknown asset "zzz"/);
    expect(msgs).toMatch(/Unknown caption style/);
  });

  it("validates effect params", () => {
    const r = validateProject({ ...base(), effects: [{ type: "blur", params: { amount: 999 } }] });
    expect(r.issues.some((i) => i.path === "effects.0.params")).toBe(true);
  });

  it("flags duplicate ids and empty projects", () => {
    expect(validateProject({}).issues.some((i) => /empty/i.test(i.message))).toBe(true);
    const r = validateProject({ ...base(), layers: [{ type: "text", id: "c1", text: "x", start: 0, duration: 1 }] });
    expect(r.issues.some((i) => /Duplicate id "c1"/.test(i.message))).toBe(true);
  });
});

describe("summary", () => {
  it("describes clips with timeline times", () => {
    const s = summarizeProject(base());
    expect(s).toContain("1080x1920");
    expect(s).toContain("c2 00:03.0–00:06.0 b");
    expect(s).toContain("⟵fade(1s)");
  });
});
