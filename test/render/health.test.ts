import { describe, expect, it } from "vitest";
import { addAsset, addClip, createProject } from "../../engine/core/index.js";
import { parseStretches, stillSpans } from "../../engine/tools/render/health.js";

describe("render health", () => {
  it("pairs freezedetect starts and ends, closes an open one at the end, drops short ones", () => {
    const stderr = [
      "[freezedetect @ 0] lavfi.freezedetect.freeze_start: 2.1",
      "[freezedetect @ 0] lavfi.freezedetect.freeze_duration: 0.5",
      "[freezedetect @ 0] lavfi.freezedetect.freeze_end: 2.6",
      "[freezedetect @ 0] lavfi.freezedetect.freeze_start: 11.03",
    ].join("\n");
    expect(parseStretches(stderr, "freeze", 49.65)).toEqual([{ start: 11.03, end: 49.65 }]);
  });

  it("reads blackdetect lines", () => {
    const stderr = "[blackdetect @ 0] black_start:0 black_end:2.5 black_duration:2.5";
    expect(parseStretches(stderr, "black", 10)).toEqual([{ start: 0, end: 2.5 }]);
  });

  it("knows where the edit itself is still: images and very slow footage, shifted into a range", () => {
    let p = createProject({ settings: { width: 320, height: 180, fps: 30 } });
    p = addAsset(p, { id: "v", type: "video", src: "v.mp4", width: 320, height: 180, duration: 10, hasAudio: false });
    p = addAsset(p, { id: "still", type: "image", src: "still.png", width: 320, height: 180 });
    p = addClip(p, { id: "a", assetId: "v", duration: 3 });
    p = addClip(p, { id: "b", assetId: "still", duration: 2 });
    p = addClip(p, { id: "c", assetId: "v", in: 3, duration: 1, speed: 0.25 });
    expect(stillSpans(p)).toEqual([
      { start: 3, end: 5 },
      { start: 5, end: 9 },
    ]);
    expect(stillSpans(p, 3)[0]).toEqual({ start: 0, end: 2 });
  });
});
