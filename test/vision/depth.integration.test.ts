import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DepthEstimator, depthInputSize, runFfmpegOrThrow, writeDepth } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const [W, H, FPS] = [640, 360, 30];
const base = ["-y", "-hide_banner", "-loglevel", "error"];
/** The camera pans right 3 px a frame over a blue wall (far) with a red box (near) on it. */
const SCENE = `nullsrc=s=${W}x${H}:r=${FPS}:d=2,geq=r='if(between(X+3*N,250,400)*between(Y,100,260),210+30*sin((X+3*N)/3),40+25*sin((X+3*N)/5)*sin(Y/7))':g='60+20*sin(Y/4)':b='if(between(X+3*N,250,400)*between(Y,100,260),50,190+30*sin((X+3*N)/4+Y/9))'`;

/**
 * Stands in for the model: the true disparity (the red box near; the wall far, a little nearer
 * toward the bottom), read from the picture, on a new random scale and offset every call, as a
 * monocular model's output drifts.
 */
class DriftingEstimator {
  calls = 0;
  async expect(): Promise<void> {}
  async disparity(rgb: Uint8Array, size: { w: number; h: number }): Promise<Float32Array> {
    this.calls++;
    const [s, t] = [0.5 + ((this.calls * 0.618) % 1) * 3, ((this.calls * 0.377) % 1) * 10 - 5];
    return Float32Array.from({ length: size.w * size.h }, (_, i) => (rgb[i * 3]! > 150 ? 3 : 1 + 0.5 * (Math.floor(i / size.w) / size.h)) * s + t);
  }
}

describe.skipIf(!hasFfmpeg)("depth over time", () => {
  const dir = path.join(OUT_DIR, "depth");
  const clip = path.join(dir, "pan.mp4");
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    if (!existsSync(clip)) await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", SCENE, "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", clip]);
  });

  it("puts every keyframe on one scale, follows the pan, and does not flicker", { timeout: 120_000 }, async () => {
    const estimator = new DriftingEstimator();
    const out = { file: path.join(dir, "pan-depth.mkv"), track: path.join(dir, "pan-depth.json") };
    const track = await writeDepth(clip, out, { start: 0, end: 2, fps: FPS, estimator: estimator as unknown as DepthEstimator });
    expect(estimator.calls).toBe(track.keyframes.length);
    expect(track.keyframes.length).toBeGreaterThanOrEqual(4);
    const raw = path.join(dir, "pan-depth.d16");
    await runFfmpegOrThrow([...base, "-i", out.file, "-f", "rawvideo", "-pix_fmt", "gray16le", raw]);
    const d = await readFile(raw);
    const { width: w, height: h } = track;
    const area = w * h;
    const n = d.length / 2 / area;
    expect(n).toBe(60);
    const at = (f: number, x: number, y: number) => d.readUInt16LE((f * area + Math.round(y * h) * w + Math.round(x * w)) * 2) / 65535;
    // The box (near) and the wall (far), where they are in the first, middle and last frame.
    let flicker = 0;
    let count = 0;
    for (const f of [0, 29, 59]) {
      const box = (250 + 75 - 3 * f) / W;
      expect(at(f, box, 0.5), `box at frame ${f}`).toBeLessThan(at(f, 0.05, 0.1) - 0.3);
    }
    // Frame to frame, on the wall far from the box (it moves with the camera, so follow it).
    for (let f = 1; f < n; f++)
      for (let x = 0.02; x < 0.25; x += 0.02)
        for (let y = 0.05; y < 0.95; y += 0.1) {
          flicker += Math.abs(at(f, x, y) - at(f - 1, x + 3 / W, y));
          count++;
        }
    console.error(`depth flicker on the wall: ${((100 * flicker) / count).toFixed(2)}% a frame`);
    expect(flicker / count).toBeLessThan(0.03);
  });

  it("finds the near ground nearer than the far ground with the real model", { timeout: 300_000 }, async () => {
    // A tiled floor in perspective under a pale sky: the bottom is near, the horizon far.
    const floor = path.join(dir, "floor.png");
    if (!existsSync(floor))
      await runFfmpegOrThrow([
        ...base, "-f", "lavfi", "-i",
        `nullsrc=s=${W}x${H},geq=lum='if(lt(Y,120),200,if(mod(floor((X-320)*60/(Y-110))+floor(2400/(Y-110)),2),190,50))':cb=128:cr=128`,
        "-frames:v", "1", floor,
      ]);
    const size = depthInputSize(W, H);
    const res = await runFfmpegOrThrow([...base, "-i", floor, "-vf", `scale=${size.w}:${size.h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { binaryStdout: true });
    const disp = await new DepthEstimator().disparity(res.stdoutBuffer!, size);
    const row = (y: number) => {
      const r = Math.round(y * size.h);
      let s = 0;
      for (let x = 0; x < size.w; x++) s += disp[r * size.w + x]!;
      return s / size.w;
    };
    // Disparity is larger for nearer things.
    expect(row(0.95)).toBeGreaterThan(row(0.45));
    expect(row(0.45)).toBeGreaterThan(row(0.36));
  });
});
