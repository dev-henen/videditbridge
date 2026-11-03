import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { decodeFrames, renderForAnalysis, runFfmpegOrThrow, type AnalysisFrame } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const hasOrt = await import("onnxruntime-node" as string).then(() => true, () => false);
const [W, H, FPS] = [640, 360, 30];
const base = ["-y", "-hide_banner", "-loglevel", "error"];
/** A sign (flat gray, 80 x 80) fixed in the frame while the camera pans over a textured scene. */
const SIGN = { x0: 280, x1: 360, y0: 140, y1: 220 };
const texture = (c: number) => {
  const [x, y] = ["(X+2.7*N)", "(Y+0.4*N)"];
  return `128+38*sin(${x}/${5 + c})*cos(${y}/${7 + c})+30*sin(${x}/${17 + 2 * c}+${y}/${11 + c})+22*cos((${x}+2*${y})/${3.1 + c})`;
};
const scene = (sign: boolean) => {
  const inSign = sign ? `between(X,${SIGN.x0},${SIGN.x1 - 1})*between(Y,${SIGN.y0},${SIGN.y1 - 1})` : "0";
  const ch = (c: number) => `'if(${inSign},90,${texture(c)})'`;
  return `nullsrc=s=${W}x${H}:r=${FPS}:d=2,format=gbrp,geq=r=${ch(0)}:g=${ch(1)}:b=${ch(2)}`;
};
/** The sign's box in frame fractions, a few pixels larger, as Claude would draw it. */
const BOX = { x0: (SIGN.x0 - 4) / W, y0: (SIGN.y0 - 4) / H, x1: (SIGN.x1 + 4) / W, y1: (SIGN.y1 + 4) / H };

describe.skipIf(!hasFfmpeg)("removing objects in renders", () => {
  const dir = path.join(OUT_DIR, "removal-render");
  const files = { pan: path.join(dir, "sign-pan.mkv"), clean: path.join(dir, "clean-pan.mkv"), photo: path.join(dir, "sign.png") };
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    const make = async (file: string, args: string[]) => {
      if (existsSync(file)) return;
      const part = `${file}.part${path.extname(file)}`;
      await runFfmpegOrThrow([...base, ...args, part]);
      await rename(part, file);
    };
    await make(files.pan, ["-f", "lavfi", "-i", scene(true), "-c:v", "ffv1", "-pix_fmt", "gbrp"]);
    await make(files.clean, ["-f", "lavfi", "-i", scene(false), "-c:v", "ffv1", "-pix_fmt", "gbrp"]);
    await make(files.photo, ["-i", files.pan, "-frames:v", "1"]);
  }, 180_000);

  const session = async (name: string, src: string) => {
    const s = new EditorSession(undefined, { outputDir: path.join(dir, name) });
    await executeTool(s, "new_project", { aspectRatio: "16:9" });
    await executeTool(s, "set_project_settings", { width: W, height: H, fps: FPS });
    await executeTool(s, "import_media", { src, id: "plate" });
    await executeTool(s, "add_clip", { assetId: "plate", ...(src.endsWith(".png") ? { duration: 2 } : {}) });
    return { s, clipId: s.project.clips[0]!.id };
  };
  const frames = async (s: EditorSession, times: number[]) => (await renderForAnalysis(s.project, { ...s.renderOptions, framesAt: times, probe: false })).frames;
  /** Mean of |a - b| over the sign's area and the margin around it (or the same area moved by dx), in levels. */
  const diff = (a: Uint8Array, b: Uint8Array | ((c: number) => number), dx = 0) => {
    let [sum, n] = [0, 0];
    for (let y = SIGN.y0 - 3; y < SIGN.y1 + 3; y++)
      for (let x = SIGN.x0 - 3; x < SIGN.x1 + 3; x++)
        for (let c = 0; c < 3; c++) {
          const q = (y * W + x + dx) * 3 + c;
          sum += Math.abs(a[q]! - (typeof b === "function" ? b(c) : b[q]!));
          n++;
        }
    return sum / n;
  };
  const ok = (r: { isError?: boolean; text: string }) => expect(r.isError, r.text).toBeFalsy();

  it("takes out a sign the camera pans past, rebuilt from what the pan shows", { timeout: 300_000 }, async () => {
    const { s, clipId } = await session("pan", files.pan);
    const r = await executeTool(s, "remove_object", { box: BOX, time: 1 });
    ok(r);
    expect(r.text).toMatch(/camera moves/);
    expect(r.text).toMatch(/100% rebuilt from real frames/);
    expect(r.images?.length).toBe(2);
    expect(s.project.clips[0]!.effects[0]!.type).toBe("removeObject");
    const [f] = (await frames(s, [1])) as AnalysisFrame[];
    const [truth] = await decodeFrames(files.clean, { start: 1, end: 1.04 }, FPS, { w: W, h: H }, "rgb24", {});
    const [orig] = await decodeFrames(files.pan, { start: 1, end: 1.04 }, FPS, { w: W, h: H }, "rgb24", {});
    const [after, before] = [diff(f!.rgb, truth!), diff(orig!, truth!)];
    console.log(`sign on a pan: ${before.toFixed(1)} levels from the clean plate before, ${after.toFixed(1)} after (through the render's encode)`);
    // What is left is the render's own compression.
    expect(after).toBeLessThan(4);
    expect(after).toBeLessThan(before / 8);

    // Taking it out brings the sign back.
    ok(await executeTool(s, "remove_object", { clipIds: [clipId], remove: true }));
    expect(s.project.clips[0]!.effects.some((e) => e.type === "removeObject")).toBe(false);
  });

  it.skipIf(!hasOrt)("paints over a sign on a photo with the model, the same through the clip", { timeout: 300_000 }, async () => {
    const { s } = await session("photo", files.photo);
    const r = await executeTool(s, "remove_object", { box: BOX, time: 0.5, shape: "rect" });
    ok(r);
    expect(r.text).toMatch(/a still/);
    expect(r.text).toMatch(/model on 1 frame/);
    const [a, b] = (await frames(s, [0.2, 1.6])) as AnalysisFrame[];
    // The flat gray is gone (texture around it continues in), and the fill holds still.
    const gray = diff(a!.rgb, () => 90);
    // Frame to frame, the fill changes no more than an untouched part of the picture does (the encoder's own noise).
    const [held, still] = [diff(a!.rgb, b!.rgb), diff(a!.rgb, b!.rgb, -240)];
    console.log(`photo: ${gray.toFixed(1)} levels from the sign's gray after; frames 1.4 s apart differ by ${held.toFixed(2)} there, ${still.toFixed(2)} elsewhere`);
    expect(gray).toBeGreaterThan(15);
    expect(held).toBeLessThan(still * 1.5 + 0.1);
  });
});
