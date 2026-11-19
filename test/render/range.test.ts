import { describe, expect, it } from "vitest";
import { addAsset, addAudio, addClip, computeTimeline, createProject, type Project } from "../../engine/core/index.js";
import { RANGE_STAND_IN, forRange } from "../../engine/tools/render/range.js";

const project = (): Project => {
  let p = createProject({ settings: { width: 320, height: 180, fps: 30 } });
  p = addAsset(p, { id: "v", type: "video", src: "v.mp4", width: 320, height: 180, duration: 60, hasAudio: true });
  p = addAsset(p, { id: "song", type: "audio", src: "song.mp3", duration: 60 });
  // Five 2 s clips, the third at half speed (4 s) and the fourth coming in with a 0.5 s crossfade.
  p = addClip(p, { id: "a", assetId: "v", in: 0, duration: 2, effects: [{ type: "glitch" }] as never });
  p = addClip(p, { id: "b", assetId: "v", in: 2, duration: 2 });
  p = addClip(p, { id: "c", assetId: "v", in: 4, duration: 2, speed: 0.5 });
  p = addClip(p, { id: "d", assetId: "v", in: 6, duration: 2, transition: { type: "fade", duration: 0.5 } });
  p = addClip(p, { id: "e", assetId: "v", in: 8, duration: 2 });
  p = addClip(p, { id: "f", assetId: "v", in: 10, duration: 2 });
  p = addAudio(p, { assetId: "song", role: "music", start: 0, duration: 3 });
  p = addAudio(p, { assetId: "song", role: "music", start: 7, duration: 2 });
  return p;
};

describe("forRange", () => {
  it("keeps every clip it keeps at the same time, standing in black for clips before the range", () => {
    const p = project();
    const r = forRange(p, { start: 8.2, end: 9 });
    const [full, cut] = [computeTimeline(p), computeTimeline(r)];
    // a and b are before c (the clip just ahead of d, where the range starts): stand-ins.
    expect(r.clips.map((c) => [c.id, c.assetId])).toEqual([
      ["a", RANGE_STAND_IN],
      ["b", RANGE_STAND_IN],
      ["c", "v"],
      ["d", "v"],
      ["e", "v"],
    ]);
    expect(r.clips[0]!.effects).toEqual([]);
    for (const c of cut.clips) {
      const same = full.clips.find((f) => f.clip.id === c.clip.id)!;
      expect([c.start, c.end]).toEqual([same.start, same.end]);
    }
    // The first music clip ends at 3 s, before the range.
    expect(r.audio).toHaveLength(1);
  });

  it("changes nothing for a range at the start beyond dropping what comes after", () => {
    const r = forRange(project(), { start: 0, end: 1 });
    expect(r.clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.assets.some((a) => a.id === RANGE_STAND_IN)).toBe(false);
  });
});
