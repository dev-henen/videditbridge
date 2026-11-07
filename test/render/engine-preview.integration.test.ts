import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, createProject } from "../../engine/core/index.js";
import { enginePath, render, renderFrame, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { deltaE2000, rgbToLab } from "../../engine/library/effects/color-match.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

// Engine previews draw text and captions as a layer (libass on a transparent picture, in a
// decoder that stays open) instead of an ffmpeg run per frame. Small and short, so it runs quickly.
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

describe.skipIf(!hasFfmpeg || !enginePath())("engine previews: text as a layer", () => {
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
});
