import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, createProject, setTransition } from "../../engine/core/index.js";
import { contactSheetFrames, enginePath, render, renderContactSheet, renderFrame, renderFrameShared, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { deltaE2000, rgbToLab } from "../../engine/library/effects/color-match.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

// Engine previews: the engine draws text and captions itself (libass in a decoder that stays
// open), and writes frames for the app into shared memory. Small and short, so it runs quickly.
const hasFfmpeg = await ffmpegAvailable();
const [W, H, FPS] = [320, 180, 15];

async function frames(file: string): Promise<Buffer[]> {
  const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
  const size = W * H * 3;
  return Array.from({ length: Math.floor(stdoutBuffer!.length / size) }, (_, i) => stdoutBuffer!.subarray(i * size, (i + 1) * size));
}

/** Mean ΔE 2000 between two frames, and the same over the text's band only (the bottom third). */
function deltaE(a: Buffer, b: Buffer, fromRow = 0): number {
  let sum = 0;
  let n = 0;
  for (let i = fromRow * W * 3; i < a.length; i += 3) {
    const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
    sum += deltaE2000(lab(a), lab(b));
    n++;
  }
  return sum / n;
}

describe.skipIf(!hasFfmpeg || !enginePath())("engine previews", () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  });

  it("frames match the engine's export (text burned in by the encoder) and FFmpeg's", async () => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "talk", type: "video", src: fx.talk, width: 1280, height: 720, duration: 4, hasAudio: true });
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 1 });
    p = addLayer(p, { type: "text", text: "Layer text", start: 0.2, duration: 0.8, position: { x: 0.5, y: 0.8 }, animationIn: { type: "fade", duration: 0.3 } });
    const dir = path.join(OUT_DIR, "engine");
    const exported = path.join(dir, "text-export.mp4");
    await render({ ...p, export: { ...p.export, crf: 0, preset: "ultrafast" } }, { output: exported, backend: "engine", hardware: false });
    const all = await frames(exported);
    // Before the text, while it fades in, with it, a jump back and a neighbor.
    for (const time of [0.1, 0.3, 0.8, 0.4, 0.4667]) {
      const [ff, gpu] = [path.join(dir, `text-${time}-ffmpeg.png`), path.join(dir, `text-${time}-engine.png`)];
      const started = performance.now();
      await renderFrame(p, time, { output: gpu, backend: "engine" });
      const took = performance.now() - started;
      await renderFrame(p, time, { output: ff, backend: "ffmpeg" });
      const [a, b] = [(await frames(ff))[0]!, (await frames(gpu))[0]!];
      const n = Math.ceil(time * FPS - 1e-6);
      const band = Math.floor(H * 0.65);
      if (process.env.PARITY_LOG) console.log(`text frame ${time} s: ${took.toFixed(0)} ms, against export ${deltaE(all[n]!, b, band).toFixed(3)} (text band), against FFmpeg ${deltaE(a, b, band).toFixed(3)}`);
      // Measured over the text's band, where a difference would show.
      expect(deltaE(all[n]!, b, band), `frame at ${time} s against the engine's export`).toBeLessThan(0.3);
      expect(deltaE(a, b, band), `frame at ${time} s against FFmpeg's`).toBeLessThan(1);
    }
  }, 60_000);

  it("writes frames for the app into shared memory, the same picture as the frame files", async () => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "talk", type: "video", src: fx.talk, width: 1280, height: 720, duration: 4, hasAudio: true });
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 1 });
    p = addLayer(p, { type: "text", text: "Shared", start: 0, duration: 1, position: { x: 0.5, y: 0.8 } });
    const dir = path.join(OUT_DIR, "engine");
    const shared = path.join(dir, "shared-frame.bin");
    let sequence = 0;
    for (const time of [0.6, 0.6667, 0.2]) {
      const started = performance.now();
      const f = await renderFrameShared(p, time, { shared });
      const took = performance.now() - started;
      expect([f.width, f.height]).toEqual([W, H]);
      expect(f.sequence).toBeGreaterThan(sequence);
      expect(f.sequence % 2).toBe(0);
      sequence = f.sequence;
      // The header, then BGRA pixels: compare with the frame file the engine writes at that time.
      const bytes = await readFile(shared);
      expect(bytes.subarray(0, 4).toString()).toBe("AVEF");
      expect([bytes.readUInt32LE(16), bytes.readUInt32LE(20)]).toEqual([W, H]);
      const rgb = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]] = [bytes[32 + i * 4 + 2]!, bytes[32 + i * 4 + 1]!, bytes[32 + i * 4]!];
      const png = path.join(dir, `shared-${time}.png`);
      await renderFrame(p, time, { output: png, backend: "engine" });
      const d = deltaE((await frames(png))[0]!, rgb);
      if (process.env.PARITY_LOG) console.log(`shared frame ${time} s: ${took.toFixed(0)} ms, against the frame file ${d.toFixed(3)}`);
      // The app's copy turns 4:2:0 into RGB more simply than ffmpeg does for the picture file.
      expect(d, `frame at ${time} s against the frame file`).toBeLessThan(0.5);
    }
  }, 60_000);

  it("contact sheets: the frames FFmpeg picks, drawn by the engine", async () => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "talk", type: "video", src: fx.talk, width: 1280, height: 720, duration: 4, hasAudio: true });
    p = addAsset(p, { id: "pic", type: "image", src: fx.image, width: 640, height: 480 });
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 1.2 });
    p = addClip(p, { id: "b", assetId: "pic", duration: 1 });
    p = setTransition(p, "b", { type: "fade", duration: 0.2 });
    p = addLayer(p, { type: "text", text: "Sheet", start: 0.5, duration: 1, position: { x: 0.5, y: 0.8 } });
    const dir = path.join(OUT_DIR, "engine");
    const sheet = { columns: 3, rows: 2, thumbWidth: 100 };
    const [ff, gpu] = [path.join(dir, "sheet-ffmpeg.png"), path.join(dir, "sheet-engine.png")];
    await renderContactSheet(p, { output: ff, backend: "ffmpeg", ...sheet });
    const started = performance.now();
    await renderContactSheet(p, { output: gpu, backend: "engine", ...sheet });
    const took = performance.now() - started;
    const rgb = async (file: string) =>
      (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true })).stdoutBuffer!;
    const [a, b] = [await rgb(ff), await rgb(gpu)];
    expect(b.length).toBe(a.length);
    const d = deltaE(a, b);
    if (process.env.PARITY_LOG) console.log(`contact sheet: ${took.toFixed(0)} ms on the engine, against FFmpeg's ${d.toFixed(3)}`);
    // FFmpeg's own sheet sits about a pixel off its own frames (measured: 2.5 on the fractal still
    // against its single frame there, where the engine's sheet is within 0.5 of both renderers'
    // frames), so the sheets are compared loosely; the frame choice is checked exactly below.
    expect(d).toBeLessThan(2);
  }, 60_000);

  it("contact sheets pick the frames FFmpeg's select picks", async () => {
    // FFmpeg's own select (as compile.ts writes it) over frames on AV_TIME_BASE, as the backend's are.
    for (const [duration, fps, count] of [[2, 15, 6], [7.3, 30, 12], [1, 24, 4], [12.5, 25, 9]] as const) {
      const [first, step] = [Math.round((duration / count / 2) * 1000) / 1000, Math.round((duration / count) * 1000) / 1000];
      const { stderr } = await runFfmpegOrThrow([
        "-hide_banner", "-nostdin", "-f", "lavfi", "-i", `color=c=black:s=16x16:r=${fps}:d=${duration}`,
        "-vf", `settb=AVTB,select='isnan(prev_selected_t)*gte(t,${first})+gte(t-prev_selected_t,${step})',showinfo`,
        "-f", "null", "-",
      ]);
      const picked = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * fps)).slice(0, count);
      expect(contactSheetFrames(duration, fps, count), `${duration} s at ${fps} fps, ${count} pictures`).toEqual(picked);
    }
  }, 30_000);
});
