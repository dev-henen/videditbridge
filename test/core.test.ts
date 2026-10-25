import { describe, expect, it } from "vitest";
import {
  addAudio,
  addAudioEffect,
  addClip,
  addLayer,
  removeAudioEffect,
  placeMomentEffect,
  setAudioEffectParams,
  snapCutsToTimes,
  setSpeed,
  setVolume,
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

  it("changes speed of clips and audio clips, keeping the source range", () => {
    let p = setSpeed(base(), "c1", 2);
    expect(computeTimeline(p).clips[0]!.duration).toBe(2);
    p = addAudio(p, { id: "m1", assetId: "music", duration: 10 });
    p = setSpeed(p, "m1", 2);
    expect(p.audio[0]!.duration).toBe(5);
    p = addAudio(p, { id: "m2", assetId: "music" });
    p = setSpeed(p, "m2", 1.5);
    expect(computeTimeline(p).audio[1]!.duration).toBe(20);
    expect(() => setSpeed(p, "c1", 8)).toThrow(/between/);
    expect(() => setSpeed(p, "nope", 2)).toThrow(/clip id or audio clip id/);
  });

  it("sets volume on clips, audio, media layers and the master mix", () => {
    let p = addAudio(base(), { id: "m1", assetId: "music" });
    p = addLayer(p, { type: "media", id: "pip", assetId: "a", start: 0, duration: 2 });
    p = setVolume(p, "c1", 0.5, { muted: true });
    p = setVolume(p, "m1", 2);
    p = setVolume(p, "pip", 0.3);
    p = setVolume(p, "master", 0.5);
    expect(p.clips[0]).toMatchObject({ volume: 0.5, muted: true });
    expect(p.audio[0]!.volume).toBe(2);
    expect(p.layers[0]!.type === "media" && p.layers[0]!.volume).toBe(0.3);
    expect(p.audioEffects).toEqual([{ type: "gain", params: { db: -6.021 } }]);
    expect(setVolume(base(), "master", 1)).toEqual(base());
  });

  it("places moment effects on the clips playing at timeline times", () => {
    // c1 0-4, c2 3-6 (1s fade overlap), c3 6-8.
    let r = placeMomentEffect(base(), "zoomPunch", [1, 3.5, 7], { amount: 0.2 });
    expect(r.placed).toEqual([
      { clipId: "c1", times: [1] },
      { clipId: "c2", times: [0.5] },
      { clipId: "c3", times: [1] },
    ]);
    // More moments merge with the ones already there.
    r = placeMomentEffect(r.project, "zoomPunch", [2]);
    const fx = r.project.clips[0]!.effects.find((e) => e.type === "zoomPunch")!;
    expect(fx.params).toMatchObject({ times: [1, 2], amount: 0.2 });
    expect(placeMomentEffect(base(), "smoothZoom", [5]).project.clips[1]!.effects[0]!.params).toMatchObject({ start: 2 });
    expect(() => placeMomentEffect(base(), "blur", [1])).toThrow(/no times or start/);
    expect(() => placeMomentEffect(base(), "zoomPunch", [50])).toThrow(/None of the times/);
  });

  it("snaps cuts to the nearest given times without running past the source", () => {
    const { project, moved } = snapCutsToTimes(base(), [3.6, 6.4, 7.5]);
    // c1 (4s, ends at 4) snaps to 3.6; c2 then ends at 3.6 - 1 + 3 = 5.6 and snaps to 6.4 (b.mp4 has room: 6s source).
    expect(moved.map((m) => m.to)).toEqual([3.6, 6.4]);
    expect(project.clips[0]!.duration).toBe(3.6);
    expect(computeTimeline(project).clips[1]!.end).toBe(6.4);
    // A clip cannot grow past its source: c1 uses a.mp4 from 1s, so at most 9s.
    expect(snapCutsToTimes(base(), [12]).moved).toEqual([]);
  });

  it("adds and removes audio effects on every audio target", () => {
    let p = addAudio(base(), { id: "m1", assetId: "music" });
    for (const target of ["c1", "m1", "master"]) p = addAudioEffect(p, target, { type: "denoise" });
    expect(p.clips[0]!.audioEffects).toHaveLength(1);
    expect(p.audio[0]!.audioEffects).toHaveLength(1);
    expect(p.audioEffects).toHaveLength(1);
    p = setAudioEffectParams(p, "c1", "dehum", { frequency: 60 }, { prepend: true });
    expect(p.clips[0]!.audioEffects.map((e) => e.type)).toEqual(["dehum", "denoise"]);
    p = removeAudioEffect(p, "c1", "denoise");
    expect(p.clips[0]!.audioEffects.map((e) => e.type)).toEqual(["dehum"]);
    expect(() => removeAudioEffect(p, "c1", "reverb")).toThrow(/has no/);
    expect(() => addAudioEffect(p, "nope", { type: "denoise" })).toThrow(/must be a clip id/);
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
        { id: "c1", assetId: "a", in: 4, duration: 3, effects: [{ type: "sparkles" }], audioEffects: [{ type: "autotune" }, { type: "denoise", params: { amount: 500 } }] },
        { id: "c2", assetId: "zzz", transition: { type: "warp", duration: 0.5 } },
      ],
      captions: { style: "nope" },
    });
    const msgs = r.issues.map((i) => i.message).join("\n");
    expect(r.ok).toBe(false);
    expect(msgs).toMatch(/exceeds source length/);
    expect(msgs).toMatch(/Unknown effect "sparkles"/);
    expect(msgs).toMatch(/Unknown audio effect "autotune"/);
    expect(r.issues.some((i) => i.path === "clips.0.audioEffects.1.params")).toBe(true);
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
    expect(s).toContain("c2 00:03.0-00:06.0 b");
    expect(s).toContain("transition fade 1s");
  });
});
