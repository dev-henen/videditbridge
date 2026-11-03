import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeFrames, drawRegion, Inpainter, removalFrames, removalMasks, runFfmpegOrThrow, type Inpainting, type RemovalMasks, type RemovalTrack } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const hasOrt = await import("onnxruntime-node" as string).then(() => true, () => false);
const [W, H, FPS, SECONDS] = [640, 360, 30, 2];
const FRAMES = FPS * SECONDS;
const base = ["-y", "-hide_banner", "-loglevel", "error"];

/** A textured background in color, moved left by `dx` and up by `dy` (FFmpeg expressions), so a tracker finds corners anywhere. */
const texture = (dx: string, dy: string, c: number) => {
  const [x, y] = [`(X+${dx})`, `(Y+${dy})`];
  return `128+38*sin(${x}/${5 + c})*cos(${y}/${7 + c})+30*sin(${x}/${17 + 2 * c}+${y}/${11 + c})+22*cos((${x}+2*${y})/${3.1 + c})`;
};
/** A flat gray box between x0..x1, y0..y1 (FFmpeg expressions, inclusive) over the background. */
const scene = (dx: string, box?: [string, string, number, number], dy = "0") => {
  const inBox = box ? `between(X,${box[0]},${box[1]})*between(Y,${box[2]},${box[3]})` : "0";
  const ch = (c: number) => `'if(${inBox},90,${texture(dx, dy, c)})'`;
  return `nullsrc=s=${W}x${H}:r=${FPS}:d=${SECONDS},format=gbrp,geq=r=${ch(0)}:g=${ch(1)}:b=${ch(2)}`;
};

/** The box of the locked-off shot on frame n: 80 x 80, moving right 6 px a frame. */
const movingBox = (n: number) => ({ x0: 40 + 6 * n, x1: 120 + 6 * n, y0: 140, y1: 220 });

const boxMasks: RemovalMasks = async (frames, size) =>
  frames.map((n) => {
    const b = movingBox(n);
    return drawRegion({ shape: "rect", x0: b.x0 / W, y0: b.y0 / H, x1: (b.x1 + 1) / W, y1: (b.y1 + 1) / H }, size.w, size.h);
  });

/** Every fill frame of a removal, and its track. */
async function run(gen: AsyncGenerator<Uint8Array, RemovalTrack>): Promise<{ fills: Uint8Array[]; track: RemovalTrack }> {
  const fills: Uint8Array[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { fills, track: r.value };
    fills.push(Uint8Array.from(r.value));
  }
}

/**
 * Inside the fully filled area: the mean error against the clean plate (levels), and the frame to
 * frame change of that error (fraction of 255), the flicker a viewer sees.
 */
function measure(fills: Uint8Array[], clean: Uint8Array[], frames: number[]) {
  let [err, n, flick, m] = [0, 0, 0, 0];
  for (const f of frames) {
    const [a, t] = [fills[f]!, clean[f]!];
    const [pa, pt] = [fills[f - 1], clean[f - 1]];
    for (let q = 0; q < W * H; q++) {
      if (a[q * 4 + 3] !== 255) continue;
      for (let c = 0; c < 3; c++) {
        const e = a[q * 4 + c]! - t[q * 3 + c]!;
        err += Math.abs(e);
        n++;
        if (pa && pt && pa[q * 4 + 3] === 255) {
          flick += Math.abs(e - (pa[q * 4 + c]! - pt[q * 3 + c]!));
          m++;
        }
      }
    }
  }
  return { mean: err / Math.max(1, n), flicker: flick / Math.max(1, m) / 255 };
}

/** Stands in for the model: paints the hole one color, and counts its calls. */
class FlatInpainter implements Inpainting {
  calls = 0;
  async inpaint(rgb: Uint8Array, w: number, h: number, hole: Uint8Array): Promise<Uint8Array> {
    this.calls++;
    const out = Uint8Array.from(rgb);
    for (let q = 0; q < w * h; q++) if (hole[q]) out.set([200, 120, 60], q * 3);
    return out;
  }
}

describe.skipIf(!hasFfmpeg)("object removal", () => {
  const dir = path.join(OUT_DIR, "removal");
  const clips = {
    locked: path.join(dir, "locked.mkv"),
    lockedClean: path.join(dir, "locked-clean.mkv"),
    pan: path.join(dir, "pan.mkv"),
    panClean: path.join(dir, "pan-clean.mkv"),
    still: path.join(dir, "still-box.mkv"),
  };
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    const make = async (file: string, src: string) => {
      // Lossless, so a locked-off rebuild can be checked to the level.
      if (existsSync(file)) return;
      // Through a temporary file, so an interrupted run never leaves a short clip behind.
      const part = `${file}.part.mkv`;
      await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", src, "-c:v", "ffv1", "-pix_fmt", "gbrp", part]);
      await rename(part, file);
    };
    await make(clips.locked, scene("0", ["40+6*N", "120+6*N", 140, 220]));
    await make(clips.lockedClean, scene("0"));
    await make(clips.pan, scene("2.7*N", ["280", "360", 140, 220], "0.4*N"));
    await make(clips.panClean, scene("2.7*N", undefined, "0.4*N"));
    await make(clips.still, scene("0", ["280", "360", 140, 220]));
  }, 180_000);
  const clean = (file: string) => decodeFrames(file, { start: 0, end: SECONDS }, FPS, { w: W, h: H }, "rgb24", {});

  it("rebuilds a locked-off shot exactly from the frames the object moves away from, without flicker", { timeout: 120_000 }, async () => {
    const inpainter = new FlatInpainter();
    const { fills, track } = await run(removalFrames(clips.locked, { start: 0, end: SECONDS, fps: FPS, masks: boxMasks, grow: 0.008, feather: 0.006, inpainter }));
    expect(fills.length).toBe(FRAMES);
    expect(track.locked).toBe(true);
    expect(inpainter.calls).toBe(0);
    expect(Math.min(...track.real)).toBe(1);
    const r = measure(fills, await clean(clips.lockedClean), Array.from({ length: FRAMES }, (_, f) => f));
    console.log(`locked-off: mean error ${r.mean.toFixed(3)} levels, flicker ${(r.flicker * 100).toFixed(3)}%`);
    expect(r.mean).toBeLessThan(0.01);
    expect(r.flicker).toBe(0);
    // The fill covers the box and fades out just past it.
    const f = fills[30]!;
    const b = movingBox(30);
    expect(f[((b.y0 + 40) * W + b.x0 + 40) * 4 + 3]).toBe(255);
    expect(f[((b.y0 + 40) * W + b.x1 + 20) * 4 + 3]).toBe(0);
  });

  it("follows a moving camera, matching what the pan uncovers", { timeout: 120_000 }, async () => {
    const inpainter = new FlatInpainter();
    const region = { shape: "rect" as const, x0: 280 / W, y0: 140 / H, x1: 361 / W, y1: 221 / H };
    const t0 = Date.now();
    const { fills, track } = await run(removalFrames(clips.pan, { start: 0, end: SECONDS, fps: FPS, masks: removalMasks([region], [], FPS), grow: 0.008, feather: 0.006, inpainter }));
    const ms = (Date.now() - t0) / FRAMES;
    expect(track.locked).toBe(false);
    // 2.7 px a frame sideways and 0.4 down, over 59 frames.
    expect(track.moved).toBeGreaterThan(150);
    expect(track.moved).toBeLessThan(170);
    // The middle frames are rebuilt from real pixels only; the ends may need the model for what never showed.
    const middle = Array.from({ length: 30 }, (_, k) => 15 + k);
    expect(Math.min(...middle.map((f) => track.real[f]!))).toBe(1);
    const r = measure(fills, await clean(clips.panClean), middle);
    console.log(`pan: mean error ${r.mean.toFixed(2)} levels, flicker ${(r.flicker * 100).toFixed(3)}%, ${ms.toFixed(0)} ms a frame, model on ${track.inpainted.length} frames`);
    expect(r.mean).toBeLessThan(3);
    expect(r.flicker).toBeLessThan(0.04);
  });

  it("runs the model once for what no frame shows, and keeps its result still", { timeout: 120_000 }, async () => {
    const inpainter = new FlatInpainter();
    const region = { shape: "rect" as const, x0: 280 / W, y0: 140 / H, x1: 361 / W, y1: 221 / H };
    const { fills, track } = await run(removalFrames(clips.still, { start: 0, end: SECONDS, fps: FPS, masks: removalMasks([region], [], FPS), grow: 0.008, feather: 0.006, inpainter }));
    expect(track.locked).toBe(true);
    expect(inpainter.calls).toBe(1);
    expect(track.inpainted).toEqual([0]);
    expect(Math.min(...track.generated)).toBe(1);
    const q = (180 * W + 320) * 4;
    for (const f of [0, 29, 59]) expect(Array.from(fills[f]!.subarray(q, q + 4))).toEqual([200, 120, 60, 255]);
  });

  it.skipIf(!hasOrt)("fills what no frame shows with LaMa, continuing the texture around it", { timeout: 300_000 }, async () => {
    const [frame] = await decodeFrames(clips.still, { start: 0, end: 0.04 }, FPS, { w: W, h: H }, "rgb24", {});
    const [truth] = await decodeFrames(clips.lockedClean, { start: 0, end: 0.04 }, FPS, { w: W, h: H }, "rgb24", {});
    const hole = new Uint8Array(W * H);
    for (let y = 136; y <= 224; y++) for (let x = 276; x <= 364; x++) hole[y * W + x] = 1;
    const t0 = Date.now();
    const out = await new Inpainter().inpaint(frame!, W, H, hole);
    const ms = Date.now() - t0;
    let [err, flat, n] = [0, 0, 0];
    for (let q = 0; q < W * H; q++) {
      if (!hole[q]) continue;
      for (let c = 0; c < 3; c++) {
        err += Math.abs(out[q * 3 + c]! - truth![q * 3 + c]!);
        flat += Math.abs(90 - truth![q * 3 + c]!);
        n++;
      }
    }
    console.log(`LaMa: mean error ${(err / n).toFixed(1)} levels (the gray box: ${(flat / n).toFixed(1)}), ${ms} ms`);
    // Much nearer the hidden texture than the box was; no trace of the box's gray.
    expect(err / n).toBeLessThan((flat / n) * 0.6);
    const raw = path.join(dir, "lama-still.rgb");
    await writeFile(raw, out);
    await runFfmpegOrThrow([...base, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", raw, path.join(dir, "lama-still.png")]);
  });
});
