import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, createProject, type Project } from "../../engine/core/index.js";
import { checkRender, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

// The read-back after a render: a picture that stops moving where the edit has footage is reported,
// a still the edit asks for is not.
const hasFfmpeg = await ffmpegAvailable();
const dir = path.join(OUT_DIR, "health");

describe.skipIf(!hasFfmpeg)("checkRender", () => {
  const files: Record<string, string> = {};
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    const make = async (name: string, args: string[]) => {
      const file = path.join(dir, `${name}.mp4`);
      await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", ...args, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
      files[name] = file;
    };
    // One second of moving pattern, then its last frame held for three (what a failed filter leaves).
    await make("frozen", ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=1", "-vf", "tpad=stop_mode=clone:stop_duration=3"]);
    await make("moving", ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=4"]);
  });

  const project = (clips: { asset: "video" | "image"; duration: number }[]): Project => {
    let p = createProject({ settings: { width: 160, height: 90, fps: 30 } });
    p = addAsset(p, { id: "v", type: "video", src: "v.mp4", width: 160, height: 90, duration: 10, hasAudio: false });
    p = addAsset(p, { id: "still", type: "image", src: "still.png", width: 160, height: 90 });
    for (const c of clips) p = addClip(p, { assetId: c.asset === "video" ? "v" : "still", duration: c.duration });
    return p;
  };

  it("reports a picture that stops moving over footage", async () => {
    const h = await checkRender(files.frozen!, project([{ asset: "video", duration: 4 }]));
    expect(h.frozen).toHaveLength(1);
    expect(h.frozen[0]!.start).toBeGreaterThan(0.8);
    expect(h.frozen[0]!.start).toBeLessThan(1.3);
    expect(h.warnings.join("\n")).toMatch(/does not move/);
  }, 60_000);

  it("says nothing when the still is the edit's own (an image clip)", async () => {
    const h = await checkRender(files.frozen!, project([{ asset: "video", duration: 1 }, { asset: "image", duration: 3 }]));
    expect(h.warnings).toEqual([]);
  }, 60_000);

  it("says nothing about moving footage, and reports a wrong length", async () => {
    expect((await checkRender(files.moving!, project([{ asset: "video", duration: 4 }]))).warnings).toEqual([]);
    const long = await checkRender(files.moving!, project([{ asset: "video", duration: 6 }]));
    expect(long.warnings.join("\n")).toMatch(/lasts 4s but the edit lasts 6s/);
  }, 60_000);
});
