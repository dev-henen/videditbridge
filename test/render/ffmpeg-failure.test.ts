import { describe, expect, it } from "vitest";
import { ffmpegFailure } from "../../engine/tools/render/ffmpeg.js";

describe("ffmpegFailure", () => {
  it("names a Windows access violation with nothing printed as a crash inside a filter", () => {
    const m = ffmpegFailure(3221225477, "");
    expect(m).toMatch(/^ffmpeg crashed \(an access violation, exit code 3221225477\)/);
    expect(m).toMatch(/inside a filter/);
  });

  it("names a segmentation fault and keeps what ffmpeg printed", () => {
    expect(ffmpegFailure(139, "frame=  10\nsomething broke")).toBe("ffmpeg crashed (a segmentation fault, exit code 139):\nframe=  10\nsomething broke");
  });

  it("leaves ordinary failures as they were", () => {
    expect(ffmpegFailure(1, "No such file")).toBe("ffmpeg exited with code 1:\nNo such file");
  });
});
