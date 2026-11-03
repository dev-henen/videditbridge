import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, createProject, setTransition, type Project } from "../../engine/core/index.js";
import { enginePath, engineUnsupported, render, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { deltaE2000, rgbToLab } from "../../engine/library/effects/color-match.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const W = 480;
const H = 270;
const FPS = 15;

/** Every frame of a video as packed RGB. */
async function frames(file: string): Promise<Buffer[]> {
  const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
  const size = W * H * 3;
  return Array.from({ length: Math.floor(stdoutBuffer!.length / size) }, (_, i) => stdoutBuffer!.subarray(i * size, (i + 1) * size));
}

/** Mean ΔE 2000 between two frames, on every 4th pixel. */
function meanDeltaE(a: Buffer, b: Buffer): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 12) {
    const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
    sum += deltaE2000(lab(a), lab(b));
    n++;
  }
  return sum / n;
}

/** Render on both backends, losslessly, and compare frame by frame. */
async function compare(name: string, p: Project): Promise<{ mean: number; worst: number; frames: number }> {
  expect(engineUnsupported(p)).toEqual([]);
  p.export = { ...p.export, crf: 0, preset: "ultrafast" };
  const dir = path.join(OUT_DIR, "engine");
  const [ff, gpu] = [path.join(dir, `${name}-ffmpeg.mp4`), path.join(dir, `${name}-engine.mp4`)];
  await render(p, { output: ff, backend: "ffmpeg", hardware: false });
  await render(p, { output: gpu, backend: "engine", hardware: false });
  const [a, b] = [await frames(ff), await frames(gpu)];
  expect(b.length).toBe(a.length);
  const scores = a.map((f, i) => meanDeltaE(f, b[i]!));
  return { mean: scores.reduce((x, y) => x + y, 0) / scores.length, worst: Math.max(...scores), frames: a.length };
}

describe.skipIf(!hasFfmpeg || !enginePath())("GPU render engine parity with the FFmpeg backend", () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  });

  const base = () => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "talk", type: "video", src: fx.talk, width: 1280, height: 720, duration: 4, hasAudio: true });
    p = addAsset(p, { id: "tall", type: "video", src: fx.silentVertical, width: 720, height: 1280, duration: 3, hasAudio: false });
    p = addAsset(p, { id: "pic", type: "image", src: fx.image, width: 640, height: 480 });
    p = addAsset(p, { id: "blue", type: "color", color: "#2050C0" });
    return p;
  };

  it("clips: cover, contain, speed, fades and transitions", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 2, fadeIn: 0.4 });
    p = addClip(p, { id: "b", assetId: "tall", duration: 1.5, fit: "contain", speed: 1.5 });
    p = addClip(p, { id: "c", assetId: "pic", duration: 1.2, focus: { x: 0.2, y: 0.8 } });
    p = addClip(p, { id: "d", assetId: "blue", duration: 0.8, fadeOut: 0.5 });
    p = setTransition(p, "b", { type: "fade", duration: 0.5 });
    p = setTransition(p, "c", { type: "fadeblack", duration: 0.4 });
    const r = await compare("clips", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  it("layers: opacity, fades, blend modes and text", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 3 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0.2, duration: 2, position: { x: 0.3, y: 0.4 }, size: { width: 0.4 }, opacity: 0.7, animationIn: { type: "fade", duration: 0.5 } });
    p = addLayer(p, { type: "media", assetId: "blue", start: 1, duration: 1.5, position: { x: 0.75, y: 0.5 }, size: { width: 0.4, height: 0.6 }, blend: "multiply" });
    p = addLayer(p, { type: "media", assetId: "tall", start: 0.5, duration: 2, position: { x: 0.6, y: 0.7 }, size: { width: 0.3, height: 0.4 }, fit: "contain", blend: "screen" });
    p = addLayer(p, { type: "text", text: "Engine", start: 0, duration: 3, position: { x: 0.5, y: 0.85 } });
    const r = await compare("layers", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  it("refuses what it cannot draw yet, and auto falls back to FFmpeg", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 1, effects: [{ type: "vignette" }] });
    expect(engineUnsupported(p)).toEqual(['clip "a": effects (vignette)']);
    await expect(render(p, { output: path.join(OUT_DIR, "engine", "refused.mp4"), backend: "engine" })).rejects.toThrow(/cannot render this: clip "a": effects \(vignette\)/);
    const out = await render(p, { output: path.join(OUT_DIR, "engine", "auto.mp4"), backend: "auto", preset: "ultrafast" });
    expect(out.args.some((a) => a === "-filter_complex_script")).toBe(true);
  }, 60_000);
});
