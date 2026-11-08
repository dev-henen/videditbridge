import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, createProject, MaskSchema, setTransition, type Project } from "../../engine/core/index.js";
import { deltaE2000, rgbToLab } from "../../engine/library/effects/color-match.js";
import { render, runFfmpeg, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const [W, H, FPS] = [320, 180, 15];

/** Every frame of a video as packed RGB. */
async function frames(file: string): Promise<Buffer[]> {
  const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
  const size = W * H * 3;
  return Array.from({ length: Math.floor(stdoutBuffer!.length / size) }, (_, i) => stdoutBuffer!.subarray(i * size, (i + 1) * size));
}

/** Mean ΔE 2000 between two frames, on every 4th pixel. */
function meanDeltaE(a: Buffer, b: Buffer): number {
  let [sum, n] = [0, 0];
  for (let i = 0; i < a.length; i += 12) {
    const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
    sum += deltaE2000(lab(a), lab(b));
    n++;
  }
  return sum / n;
}

// Deep renders (10-bit and ProRes exports on the FFmpeg backend): the whole picture path at 10 bits
// with 16-bit mattes and RGB, so it must give the same picture as the 8-bit path, only finer.
describe.skipIf(!hasFfmpeg)("deep renders on the FFmpeg backend", () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  });

  it("a busy edit renders deep, the same picture as the 8-bit path, through the clip cache too", async () => {
    let p: Project = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "talk", type: "video", src: fx.talk, width: 1280, height: 720, duration: 4, hasAudio: true });
    p = addAsset(p, { id: "pic", type: "image", src: fx.image, width: 640, height: 480 });
    p = addAsset(p, { id: "warm", type: "color", color: "#E08030" });
    const mask = MaskSchema.parse({ kind: "shape", feather: 0.05, shape: { type: "polygon", points: [[0.1, 0.1], [0.6, 0.15], [0.4, 0.9]] } });
    p = addClip(p, {
      id: "a",
      assetId: "talk",
      in: 0.5,
      duration: 1,
      effects: [
        { type: "color", params: { exposure: 0.4, contrast: 30, saturation: 20 } },
        { type: "color", label: "region", mask, params: { temperature: 40 } },
        { type: "glow", params: { threshold: 40 } },
        { type: "vignette", params: { strength: 0.5 } },
      ],
    });
    p = addClip(p, { id: "b", assetId: "pic", duration: 1, effects: [{ type: "halation", params: { strength: 1, threshold: 0.6 } }, { type: "chromaticAberration", params: { amount: 8, radial: true } }] });
    p = setTransition(p, "b", { type: "fade", duration: 0.3 });
    p = addLayer(p, { type: "media", assetId: "warm", start: 0.2, duration: 1.4, position: { x: 0.7, y: 0.4 }, size: { width: 0.3, height: 0.4 }, blend: "addlight", opacity: 0.8 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0.4, duration: 1.2, position: { x: 0.3, y: 0.6 }, size: { width: 0.3 }, blend: "softlight", mask: MaskSchema.parse({ kind: "luma", luma: [0.4, 1] }) });
    const dir = path.join(OUT_DIR, "deep");
    const out = (name: string) => path.join(dir, `${name}.mp4`);
    const lossless = (bitDepth: 8 | 10): Project => ({ ...p, export: { ...p.export, crf: 0, preset: "ultrafast", bitDepth } });
    await render(lossless(8), { output: out("eight"), backend: "ffmpeg", hardware: false });
    await render(lossless(10), { output: out("ten"), backend: "ffmpeg", hardware: false });
    // The 10-bit graph is used: the file is 10-bit, and its filter script carries 10-bit stages.
    const { stderr } = await runFfmpeg(["-hide_banner", "-i", out("ten")]);
    expect(stderr).toMatch(/yuv420p10le/);
    const [a, b] = [await frames(out("eight")), await frames(out("ten"))];
    expect(b.length).toBe(a.length);
    const scores = a.map((f, i) => meanDeltaE(f, b[i]!));
    const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
    if (process.env.PARITY_LOG) console.log(`deep against 8-bit: mean ΔE ${mean.toFixed(3)}, worst ${Math.max(...scores).toFixed(3)}`);
    // The same sources encoded at 8 and at 10 bits already differ by 0.6 (the video) to 1.2 (the
    // test photo's saturated edges) ΔE 2000; the deep graph adds little to that.
    expect(mean).toBeLessThan(1.5);
    expect(Math.max(...scores)).toBeLessThan(2.5);
    // Through the clip cache: cached deep clips (x264 High 10) give the same picture.
    const cacheDir = path.join(dir, "cache");
    await render(lossless(10), { output: out("cached-1"), backend: "ffmpeg", hardware: false, cacheDir });
    await render(lossless(10), { output: out("cached-2"), backend: "ffmpeg", hardware: false, cacheDir });
    const c = await frames(out("cached-2"));
    const cached = c.map((f, i) => meanDeltaE(f, b[i]!));
    expect(cached.reduce((x, y) => x + y, 0) / cached.length).toBeLessThan(0.5);
  }, 240_000);
});
