import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, createProject, type Project } from "../../engine/core/index.js";
import { acesToRec709, codeToAces, colorSpace } from "../../engine/library/color/index.js";
import { deltaE2000, rgbToLab } from "../../engine/library/effects/color-match.js";
import { enginePath, render, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

// Camera log through both renderers: synthetic 10-bit S-Log3 footage (an 18% gray card and a ramp
// of stops), small and one second long, so it runs quickly.
const hasFfmpeg = await ffmpegAvailable();
const [W, H, FPS] = [320, 180, 15];
const dir = path.join(OUT_DIR, "color-space");
const footage = path.join(dir, "slog3.mkv");

/** S-Log3 code value (10-bit) of `stops` above 18% gray, as a geq expression of X. */
const SLOG3_RAMP = "420+log((0.18*pow(2,-6+12*(X-160)/159)+0.01)/0.19)/log(10)*261.5";

async function frame(file: string): Promise<Buffer> {
  const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
  return stdoutBuffer!;
}

const luma = (f: Buffer, x: number, y: number) => {
  const i = (y * W + x) * 3;
  return (0.2126 * f[i]! + 0.7152 * f[i + 1]! + 0.0722 * f[i + 2]!) / 255;
};

describe.skipIf(!hasFfmpeg)("footage in a color space", () => {
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    // Left: the gray card (code 420, neutral chroma). Right: the ramp, 6 stops under to 6 over.
    await runFfmpegOrThrow([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=1,format=yuv420p10le,geq=lum='if(lt(X,160),420,${SLOG3_RAMP})':cb=512:cr=512`,
      "-c:v", "ffv1", footage,
    ]);
  });

  const project = (space?: "slog3-sgamut3cine"): Project => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "log", type: "video", src: footage, width: W, height: H, duration: 1, hasAudio: false, ...(space ? { colorSpace: space } : {}) });
    p = addClip(p, { id: "a", assetId: "log", duration: 1 });
    p.export = { ...p.export, crf: 0, preset: "ultrafast" };
    return p;
  };

  // Where the transform puts the gray card: S-Log3 code 420 through S-Gamut3.Cine to ACES, then the
  // ACES output transform (about 0.39, since the gamut keeps neutrals neutral).
  const expectedGray = acesToRec709(codeToAces(colorSpace("slog3-sgamut3cine")!, [420 / 1023, 420 / 1023, 420 / 1023]))[1];

  for (const backend of ["ffmpeg", "engine"] as const) {
    it.skipIf(backend === "engine" && !enginePath())(`${backend}: the gray card lands at 18% gray, and the ramp rolls off without clipping`, async () => {
      const out = path.join(dir, `slog3-${backend}.mp4`);
      await render(project("slog3-sgamut3cine"), { output: out, backend, hardware: false });
      const f = await frame(out);
      const gray = luma(f, 80, 90);
      if (process.env.PARITY_LOG) console.log(`${backend}: gray card ${gray.toFixed(4)} (expected ${expectedGray.toFixed(4)})`);
      // Section 4.1: within 2% of full range.
      expect(Math.abs(gray - expectedGray)).toBeLessThan(0.02);
      // The ramp (12 stops) rises all the way, and reaches white only at its top.
      const ramp = Array.from({ length: 150 }, (_, i) => luma(f, 165 + i, 90));
      for (let i = 4; i < ramp.length; i += 4) expect(ramp[i]!, `ramp at ${i}`).toBeGreaterThanOrEqual(ramp[i - 4]! - 0.004);
      const clipped = ramp.findIndex((v) => v > 0.995);
      expect(clipped === -1 || clipped > 120, `white from ${clipped} of 150`).toBe(true);
      expect(ramp[0]!).toBeLessThan(0.08);
    }, 60_000);
  }

  it.skipIf(!enginePath())("both renderers give the same picture, and footage left as Rec.709 stays flat", async () => {
    const [ff, gpu, flat] = [path.join(dir, "slog3-ffmpeg.mp4"), path.join(dir, "slog3-engine.mp4"), path.join(dir, "slog3-flat.mp4")];
    await render(project(), { output: flat, backend: "ffmpeg", hardware: false });
    const [a, b, c] = [await frame(ff), await frame(gpu), await frame(flat)];
    const meanDeltaE = (x: Buffer, y: Buffer) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < x.length; i += 12) {
        const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
        sum += deltaE2000(lab(x), lab(y));
        n++;
      }
      return sum / n;
    };
    const [same, changed] = [meanDeltaE(a, b), meanDeltaE(a, c)];
    if (process.env.PARITY_LOG) console.log(`FFmpeg against the engine: mean ΔE ${same.toFixed(3)}; converted against unconverted ${changed.toFixed(2)}`);
    expect(same).toBeLessThan(1);
    // The conversion changes the picture clearly (unconverted, the ramp shows its log code values).
    expect(changed).toBeGreaterThan(3);
  }, 60_000);
});
