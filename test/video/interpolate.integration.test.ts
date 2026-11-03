import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { renderForAnalysis, runFfmpegOrThrow, type AnalysisFrame } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const hasOrt = await import("onnxruntime-node" as string).then(() => true, () => false);
const [W, H] = [640, 360];
const base = ["-y", "-hide_banner", "-loglevel", "error"];
/** A gray box (80 x 80) moving right `step` px a frame over a bright texture (never near the box's gray). */
const scene = (fps: number, step: number) => {
  const inBox = `between(X,40+${step}*N,119+${step}*N)*between(Y,140,219)`;
  const ch = (c: number) => `'if(${inBox},90,170+35*sin(X/${4 + c})*cos(Y/${6 + c}))'`;
  return `nullsrc=s=${W}x${H}:r=${fps}:d=1,format=gbrp,geq=r=${ch(0)}:g=${ch(1)}:b=${ch(2)}`;
};

/** The box's left edge and width in a frame: columns where most of its rows are the box's gray. */
function box(f: AnalysisFrame): { x: number; width: number } {
  const cols: number[] = [];
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 150; y < 210; y++) if (Math.abs(f.rgb[(y * W + x) * 3]! - 90) < 20) n++;
    if (n > 30) cols.push(x);
  }
  return { x: cols[0] ?? -1, width: cols.length };
}

describe.skipIf(!hasFfmpeg || !hasOrt)("smooth slow motion", () => {
  const dir = path.join(OUT_DIR, "interpolate");
  const clips = { fast: path.join(dir, "box-30.mkv"), low: path.join(dir, "box-15.mkv") };
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    for (const [file, src] of [
      [clips.fast, scene(30, 8)],
      [clips.low, scene(15, 16)],
    ] as const) {
      if (existsSync(file)) continue;
      const part = `${file}.part.mkv`;
      await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", src, "-c:v", "ffv1", "-pix_fmt", "gbrp", part]);
      await rename(part, file);
    }
  }, 180_000);

  const session = async (name: string, src: string) => {
    const s = new EditorSession(undefined, { outputDir: path.join(dir, name) });
    await executeTool(s, "new_project", { aspectRatio: "16:9" });
    await executeTool(s, "set_project_settings", { width: W, height: H, fps: 30 });
    await executeTool(s, "import_media", { src, id: "box" });
    await executeTool(s, "add_clip", { assetId: "box" });
    return { s, clipId: s.project.clips[0]!.id };
  };
  /** The box over 12 consecutive frames from `t`, as positions and widths. */
  const track = async (s: EditorSession, t: number) => {
    const times = Array.from({ length: 12 }, (_, k) => Math.round((t + k / 30) * 1000) / 1000 + 0.001);
    const frames = (await renderForAnalysis(s.project, { ...s.renderOptions, framesAt: times, probe: false })).frames;
    return frames.map(box);
  };
  const ok = (r: { isError?: boolean; text: string }) => expect(r.isError, r.text).toBeFalsy();

  it("makes every frame of a 4x slow motion, evenly spaced, with no doubled edges", { timeout: 600_000 }, async () => {
    const { s, clipId } = await session("slow", clips.fast);
    const set = await executeTool(s, "set_speed", { target: clipId, speed: 0.25 });
    ok(set);
    expect(set.text).toMatch(/Smooth motion on: 90 of its 121 frames/);
    const r = await executeTool(s, "interpolate", { clipIds: [clipId] });
    ok(r);
    // The last few in between come after the footage's final frame, which holds there.
    const [, made, held] = /121 frames from 30 fps footage, (\d+) made by the model(?:, (\d+) held)?/.exec(r.text) ?? [];
    expect(Number(made) + Number(held ?? 0)).toBe(90);
    expect(Number(held ?? 0)).toBeLessThanOrEqual(3);
    const boxes = await track(s, 1);
    const steps = boxes.slice(1).map((b, k) => b.x - boxes[k]!.x);
    console.log(`4x slow motion: box at ${boxes.map((b) => b.x).join(", ")}; widths ${Math.min(...boxes.map((b) => b.width))}-${Math.max(...boxes.map((b) => b.width))}`);
    // 2 px a frame on the timeline (8 px a source frame, a quarter of that), never repeated.
    for (const d of steps) expect(Math.abs(d - 2)).toBeLessThanOrEqual(1);
    // One box, not a blend of two: as wide as it is in the footage.
    for (const b of boxes) expect(Math.abs(b.width - 80)).toBeLessThanOrEqual(3);

    // Without it, frames repeat: three still frames, then a jump.
    ok(await executeTool(s, "interpolate", { clipIds: [clipId], off: true }));
    const plain = await track(s, 1);
    const still = plain.slice(1).filter((b, k) => b.x === plain[k]!.x).length;
    expect(still).toBeGreaterThanOrEqual(7);
  });

  it("converts 15 fps footage to a 30 fps edit with a new frame between each pair", { timeout: 600_000 }, async () => {
    const { s, clipId } = await session("rate", clips.low);
    const r = await executeTool(s, "interpolate", {});
    ok(r);
    // The last frame is past the footage's end, where both neighbors are its final frame.
    expect(r.text).toMatch(new RegExp(`${clipId}: 31 frames from 15 fps footage, 1[45] made by the model`));
    const boxes = await track(s, 0.2);
    const steps = boxes.slice(1).map((b, k) => b.x - boxes[k]!.x);
    console.log(`15 to 30 fps: steps ${steps.join(", ")}`);
    for (const d of steps) expect(Math.abs(d - 8)).toBeLessThanOrEqual(1);
  });
});
