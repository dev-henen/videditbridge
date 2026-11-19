import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lookAtMedia, parseMotion, probe, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const dir = path.join(OUT_DIR, "look");

describe("parseMotion", () => {
  it("averages each second's frame differences and moves them to source time", () => {
    const stderr = ["frame:0 pts:0 pts_time:0", "lavfi.signalstats.YAVG=2", "frame:1 pts:1 pts_time:0.6", "lavfi.signalstats.YAVG=4", "frame:2 pts:2 pts_time:1.2", "lavfi.signalstats.YAVG=10"].join("\n");
    expect(parseMotion(stderr, 10)).toEqual([
      { second: 10, value: 3 },
      { second: 11, value: 10 },
    ]);
  });
});

describe.skipIf(!hasFfmpeg)("lookAtMedia", () => {
  it("makes a grid of a part of the file and finds where the picture moves", async () => {
    await mkdir(dir, { recursive: true });
    // Two seconds of a still color, then two of the moving test pattern.
    const src = path.join(dir, "still-then-moving.mp4");
    await runFfmpegOrThrow([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=2",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src,
    ]);
    const r = await lookAtMedia(src, { output: path.join(dir, "grid.png"), duration: 4, frames: 8, columns: 4 });
    expect(r.times).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    const grid = await probe(r.output);
    expect(grid.isImage).toBe(true);
    expect(grid.width).toBeGreaterThan(grid.height!);
    const at = (s: number) => r.motion.find((m) => m.second === s)!.value;
    expect(at(0)).toBeLessThan(0.5);
    expect(at(3)).toBeGreaterThan(at(0) + 1);
    // A part of the file keeps source times.
    const part = await lookAtMedia(src, { output: path.join(dir, "part.png"), duration: 4, start: 2, end: 4, frames: 4 });
    expect(part.times[0]).toBe(2);
    expect(part.motion[0]!.second).toBe(2);
  }, 60_000);
});
