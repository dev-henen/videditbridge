import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, createProject, type Project } from "../../engine/core/index.js";
import { render, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

// Film look effects (section 4.4), small and short: 320x180, one second.
const hasFfmpeg = await ffmpegAvailable();
const [W, H, FPS] = [320, 180, 15];
const dir = path.join(OUT_DIR, "film");

async function frames(file: string): Promise<Buffer[]> {
  const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
  const size = W * H * 3;
  return Array.from({ length: Math.floor(stdoutBuffer!.length / size) }, (_, i) => stdoutBuffer!.subarray(i * size, (i + 1) * size));
}

const px = (f: Buffer, x: number, y: number) => [f[(y * W + x) * 3]!, f[(y * W + x) * 3 + 1]!, f[(y * W + x) * 3 + 2]!];

/** Share of the frame clipped to white in every channel. */
const clippedShare = (g: Buffer) => {
  let n = 0;
  for (let i = 0; i < g.length; i += 3) if (g[i]! >= 254 && g[i + 1]! >= 254 && g[i + 2]! >= 254) n++;
  return n / (W * H);
};

describe.skipIf(!hasFfmpeg)("film look effects", () => {
  let fx: Fixtures;
  const sources: Record<string, string> = {};
  beforeAll(async () => {
    fx = await makeFixtures();
    await mkdir(dir, { recursive: true });
    // A dark frame (nothing near the highlights), a bright square on dark, and a gray ramp.
    const make = async (name: string, graph: string) => {
      const file = path.join(dir, `${name}.mkv`);
      await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", graph, "-c:v", "ffv1", file]);
      sources[name] = file;
    };
    await make("dark", `color=c=0x303840:s=${W}x${H}:r=${FPS}:d=1,format=yuv420p`);
    await make("spot", `color=c=0x101010:s=${W}x${H}:r=${FPS}:d=1,drawbox=x=150:y=80:w=20:h=20:color=white:t=fill,format=yuv420p`);
    await make("ramp", `color=c=black:s=${W}x${H}:r=${FPS}:d=1,format=yuv420p,geq=lum='16+219*X/${W - 1}':cb=128:cr=128`);
  });

  const project = (src: string, effects: { type: string; params?: Record<string, unknown> }[]): Project => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "v", type: "video", src, width: W, height: H, duration: 1, hasAudio: false });
    p = addClip(p, { id: "a", assetId: "v", duration: 1, effects: effects as never });
    p.export = { ...p.export, crf: 0, preset: "ultrafast" };
    return p;
  };
  const renderFrames = async (name: string, p: Project) => {
    const out = path.join(dir, `${name}.mp4`);
    await render(p, { output: out, backend: "ffmpeg", hardware: false });
    return frames(out);
  };

  it("halation: nothing below the threshold changes; highlights spill warm light", async () => {
    const [plain] = await renderFrames("dark-plain", project(sources.dark!, []));
    const [glowing] = await renderFrames("dark-halation", project(sources.dark!, [{ type: "halation", params: { strength: 1.5 } }]));
    let worst = 0;
    for (let i = 0; i < plain!.length; i++) worst = Math.max(worst, Math.abs(plain![i]! - glowing![i]!));
    // The 16-bit round trip may move a level; no light is added.
    expect(worst).toBeLessThanOrEqual(2);
    const [spot] = await renderFrames("spot-halation", project(sources.spot!, [{ type: "halation", params: { strength: 1.5 } }]));
    const [bare] = await renderFrames("spot-plain", project(sources.spot!, []));
    // Just below the square the glow adds more red than blue; the far corner stays as it was.
    const [after, before] = [px(spot!, 160, 102), px(bare!, 160, 102)];
    expect(after[0]! - before[0]!).toBeGreaterThan(after[2]! - before[2]! + 6);
    expect(Math.abs(px(spot!, 5, 5)[0]! - px(bare!, 5, 5)[0]!)).toBeLessThanOrEqual(2);
  }, 60_000);

  it("film grain: the same seed repeats, frames differ, midtones get the most", async () => {
    const grain = [{ type: "filmGrain", params: { amount: 60, stock: "medium", seed: 7 } }];
    const a = await renderFrames("grain-a", project(sources.ramp!, grain));
    const b = await renderFrames("grain-b", project(sources.ramp!, grain));
    expect(a[3]!.equals(b[3]!)).toBe(true);
    expect(a[3]!.equals(a[4]!)).toBe(false);
    const [plain] = await renderFrames("grain-plain", project(sources.ramp!, []));
    // Deviation from the plain ramp in a dark band and in the midtones.
    const deviation = (x0: number, x1: number) => {
      let sum = 0;
      let n = 0;
      for (let y = 20; y < H - 20; y += 2) for (let x = x0; x < x1; x++) sum += Math.abs(a[3]![(y * W + x) * 3 + 1]! - plain![(y * W + x) * 3 + 1]!), n++;
      return sum / n;
    };
    const [dark, mid] = [deviation(4, 24), deviation(150, 170)];
    expect(mid).toBeGreaterThan(dark * 1.5);
  }, 60_000);

  it.each(["halation", "bloom", "anamorphicFlare", "filmGrain", "gateWeave", "printFilm", "lensDistortion"])(
    "%s renders and stays legal at default strength",
    async (type) => {
      const f = await renderFrames(`talk-${type}`, project(fx.talk, [{ type }]));
      expect(f.length).toBe(FPS);
      // At most 0.5% more of the frame clipped than the plain picture (the test pattern's saturated
      // bars clip already, and effects that move pixels move them).
      const [plain] = await renderFrames("talk-plain", project(fx.talk, []));
      expect(clippedShare(f[5]!) - clippedShare(plain!)).toBeLessThan(0.005);
    },
    60_000,
  );
});
