import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, createProject, setEffectParams, type Project } from "../../engine/core/index.js";
import { acesToRec709, acescctToRec709, codeToAces, colorSpace, gradeAcescct, toAcescct, type SceneGrade } from "../../engine/library/color/index.js";
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

  // Graded in ACEScct: the color panel's primaries act on scene light, between the camera half and
  // the output half; the vignette stays on the finished picture.
  const grade: SceneGrade = { exposure: 1, temperature: 30, contrast: 25, saturation: -20, wheels: { shadows: { hue: 190, amount: 40 } } };
  it.skipIf(!enginePath())("grading in ACEScct: both renderers follow the grade's math, and match", async () => {
    const graded = setEffectParams(project("slog3-sgamut3cine"), "a", "color", grade as Record<string, unknown>);
    const pictures: Buffer[] = [];
    // Where the grade puts the gray card: the pipeline's RGB of code 420 through the camera half, the grade and the output half.
    const pipelineGray = (420 / 1023 - 16 / 255) / (219 / 255);
    const expected = acescctToRec709(gradeAcescct(toAcescct(colorSpace("slog3-sgamut3cine")!, [pipelineGray, pipelineGray, pipelineGray]), grade));
    const expectedLuma = 0.2126 * expected[0] + 0.7152 * expected[1] + 0.0722 * expected[2];
    for (const backend of ["ffmpeg", "engine"] as const) {
      const out = path.join(dir, `graded-${backend}.mp4`);
      await render(graded, { output: out, backend, hardware: false });
      const f = await frame(out);
      pictures.push(f);
      const gray = luma(f, 80, 90);
      if (process.env.PARITY_LOG) console.log(`${backend} graded: gray card ${gray.toFixed(4)} (the grade's math: ${expectedLuma.toFixed(4)})`);
      expect(Math.abs(gray - expectedLuma)).toBeLessThan(0.02);
      // A stop brighter than ungraded (0.39), and warmer: red over blue.
      expect(gray).toBeGreaterThan(0.45);
      const i = (90 * W + 80) * 3;
      expect(f[i]!).toBeGreaterThan(f[i + 2]!);
    }
    let sum = 0;
    let n = 0;
    for (let i = 0; i < pictures[0]!.length; i += 12) {
      const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
      sum += deltaE2000(lab(pictures[0]!), lab(pictures[1]!));
      n++;
    }
    if (process.env.PARITY_LOG) console.log(`graded, FFmpeg against the engine: mean ΔE ${(sum / n).toFixed(3)}`);
    expect(sum / n).toBeLessThan(1);
    // The rest of the panel (here a vignette, which the engine does not draw yet) stays on the finished picture: the corners darken, the grade holds.
    const vignetted = path.join(dir, "graded-vignette.mp4");
    await render(setEffectParams(project("slog3-sgamut3cine"), "a", "color", { ...grade, vignette: 60 } as Record<string, unknown>), { output: vignetted, backend: "ffmpeg", hardware: false });
    const v = await frame(vignetted);
    expect(luma(v, 2, 2)).toBeLessThan(luma(pictures[0]!, 2, 2) - 0.05);
    expect(Math.abs(luma(v, 160, 90) - luma(pictures[0]!, 160, 90))).toBeLessThan(0.02);
  }, 60_000);

  // Section 1's precision check: a 10-bit ramp through a heavy grade, at 1080p, with no run of equal
  // output values longer than 4 px. 8 bits cannot pass it (256 levels over 1920 px are 7.5 px each,
  // dithered or not), so it is measured on a 10-bit export; the 8-bit one is dithered and reported.
  it.skipIf(!enginePath())("precision: a 10-bit ramp through a heavy grade has no run of equal values over 4 px (10-bit export)", async () => {
    const [RW, RH] = [1920, 1080];
    const ramp = path.join(dir, "slog3-ramp-1080.mkv");
    // A 10-bit ramp linear in code values across the camera's range (95 to 940: 2.3 px per code).
    await runFfmpegOrThrow([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${RW}x${RH}:r=${FPS}:d=0.2,format=yuv420p10le,geq=lum='95+845*X/${RW - 1}':cb=512:cr=512`,
      "-c:v", "ffv1", ramp,
    ]);
    let p = createProject({ settings: { width: RW, height: RH, fps: FPS } });
    p = addAsset(p, { id: "log", type: "video", src: ramp, width: RW, height: RH, duration: 0.2, hasAudio: false, colorSpace: "slog3-sgamut3cine" });
    p = addClip(p, { id: "a", assetId: "log", duration: 0.2 });
    p = setEffectParams(p, "a", "color", { exposure: 0.5, contrast: 60, saturation: 30 });
    const runs = async (bitDepth: 8 | 10) => {
      const out = path.join(dir, `precision-${bitDepth}.mp4`);
      await render({ ...p, export: { ...p.export, crf: 0, preset: "ultrafast", bitDepth } }, { output: out, backend: "engine", hardware: false });
      const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", bitDepth === 10 ? "gray10le" : "gray", "pipe:1"], { binaryStdout: true });
      const row = Array.from({ length: RW }, (_, x) => (bitDepth === 10 ? stdoutBuffer!.readUInt16LE((540 * RW + x) * 2) : stdoutBuffer![540 * RW + x]!));
      // Longest run of equal values where the picture is a gradient: where it changes by 4 levels or
      // more over 16 px (a tone curve's flat shoulder repeats values legitimately; lost precision
      // shows as long runs with steps between them, which this still sees).
      const step = bitDepth === 10 ? 4 : 1;
      const gradient = (x: number) => x >= 8 && x < RW - 8 && Math.abs(row[x + 8]! - row[x - 8]!) >= step * 4;
      let [longest, run] = [0, 1];
      for (let x = 1; x < RW; x++) {
        run = row[x] === row[x - 1] ? run + 1 : 1;
        if (gradient(x)) longest = Math.max(longest, run);
      }
      const levels = new Set(row).size;
      return { longest, levels };
    };
    const ten = await runs(10);
    const eight = await runs(8);
    if (process.env.PARITY_LOG) console.log(`precision at 1080p: 10-bit longest run ${ten.longest} px over ${ten.levels} levels; 8-bit dithered longest run ${eight.longest} px over ${eight.levels} levels`);
    expect(ten.levels).toBeGreaterThan(300);
    expect(ten.longest).toBeLessThanOrEqual(4);
  }, 120_000);
});
