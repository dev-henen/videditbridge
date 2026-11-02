import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { depthFile, renderForAnalysis, runFfmpegOrThrow, type AnalysisFrame } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const [W, H, FPS] = [640, 360, 30];
const base = ["-y", "-hide_banner", "-loglevel", "error"];
/** A red textured box (near) in front of a blue textured wall (far). */
const BOX = { x0: 220, x1: 420, y0: 90, y1: 270 };
const inBox = `between(X,${BOX.x0},${BOX.x1 - 1})*between(Y,${BOX.y0},${BOX.y1 - 1})`;
const PLATE = `nullsrc=s=${W}x${H}:r=${FPS}:d=2,geq=r='if(${inBox},200+40*sin(X/2)*sin(Y/2),40+25*sin(X/3))':g='if(${inBox},40,60+30*sin(Y/3))':b='if(${inBox},40,200+40*sin(X/2+Y/3))'`;
/** Its exact depth: the box at 0.15, the wall at 0.85. */
const DEPTH = `nullsrc=s=${W}x${H}:r=${FPS}:d=2,format=gray16le,geq=lum='if(${inBox},0.15,0.85)*65535'`;

describe.skipIf(!hasFfmpeg)("depth effects", () => {
  const dir = path.join(OUT_DIR, "depth-effects");
  const clip = path.join(dir, "box.mp4");
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    if (!existsSync(clip)) await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", PLATE, "-c:v", "libx264", "-crf", "6", "-pix_fmt", "yuv420p", clip]);
  });

  const session = async (name: string) => {
    const s = new EditorSession(undefined, { outputDir: path.join(dir, name) });
    await executeTool(s, "new_project", { aspectRatio: "16:9" });
    await executeTool(s, "set_project_settings", { width: W, height: H, fps: FPS });
    await executeTool(s, "import_media", { src: clip, id: "box" });
    await executeTool(s, "add_clip", { assetId: "box" });
    // The exact depth, where the renderer looks for it, so no model is needed here.
    const asset = s.project.assets[0]! as { src: string };
    const src = path.resolve(s.renderOptions.baseDir ?? process.cwd(), asset.src);
    const d = await depthFile(path.join(s.renderOptions.cacheDir!, "masks"), src, { start: 0, end: 2 }, FPS);
    await mkdir(path.dirname(d.file), { recursive: true });
    if (!d.exists) await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", DEPTH, "-c:v", "ffv1", "-pix_fmt", "gray16le", d.file]);
    const track = { fps: FPS, start: 0, width: W, height: H, keyframes: [0], near: Array(2 * FPS).fill(0.15), far: Array(2 * FPS).fill(0.85) };
    await writeFile(d.track, JSON.stringify(track));
    return { s, clipId: s.project.clips[0]!.id };
  };
  const frames = async (s: EditorSession, times: number[]) => (await renderForAnalysis(s.project, { ...s.renderOptions, framesAt: times, probe: false })).frames;
  const px = (f: AnalysisFrame, x: number, y: number) => [0, 1, 2].map((c) => f.rgb[(y * W + x) * 3 + c]!);
  /** Spread of the red channel (texture) in a 16 px square. */
  const texture = (f: AnalysisFrame, x0: number, y0: number, c = 0) => {
    let [lo, hi] = [255, 0];
    for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 16; x++) [lo, hi] = [Math.min(lo, px(f, x, y)[c]!), Math.max(hi, px(f, x, y)[c]!)];
    return hi - lo;
  };
  const ok = (r: { isError?: boolean; text: string }) => expect(r.isError, r.text).toBeFalsy();

  it("keeps the subject sharp and blurs the rest, with no halo around the subject", { timeout: 180_000 }, async () => {
    const { s, clipId } = await session("focus");
    const [clean] = await frames(s, [1]);
    const read = await executeTool(s, "estimate_depth", { clipId, time: 1, points: [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1 }] });
    ok(read);
    expect((read.data as { distances: number[] }).distances).toEqual([0.15, 0.85]);
    ok(await executeTool(s, "set_focus", { clipId, point: { x: 0.5, y: 0.5 }, blur: 40 }));
    const [f] = await frames(s, [1]);
    expect(texture(f!, 300, 170), "box texture").toBeGreaterThan(0.9 * texture(clean!, 300, 170));
    expect(texture(f!, 60, 40, 2), "wall texture").toBeLessThan(0.4 * texture(clean!, 60, 40, 2));
    // Beside the sharp box, beyond 2 px, the wall keeps its own colors: no red from the box, no dark ring.
    let worst = 0;
    for (let y = 110; y < 250; y += 7)
      for (const x of [BOX.x0 - 12, BOX.x0 - 6, BOX.x0 - 3, BOX.x1 + 2, BOX.x1 + 5, BOX.x1 + 11]) {
        const [r, , b] = px(f!, x, y);
        expect(b, `wall blue at (${x}, ${y})`).toBeGreaterThan(150);
        worst = Math.max(worst, r! - 70);
      }
    console.error(`red over the wall's own beside the box: ${Math.max(0, worst)}`);
    expect(worst, "red from the box on the wall").toBeLessThanOrEqual(0);
  });

  it("racks focus smoothly from the subject to the background", { timeout: 180_000 }, async () => {
    const { s, clipId } = await session("rack");
    ok(await executeTool(s, "set_focus", { clipId, rack: [{ time: 0.2, point: { x: 0.5, y: 0.5 } }, { time: 1.8, point: { x: 0.1, y: 0.1 } }], blur: 40 }));
    const times = Array.from({ length: 19 }, (_, k) => round(0.1 + k * 0.1));
    const f = await frames(s, times);
    const box = f.map((x) => texture(x, 300, 170));
    const wall = f.map((x) => texture(x, 60, 40, 2));
    console.error(`box texture ${box.join(" ")}\nwall texture ${wall.join(" ")}`);
    // The box only goes soft and the wall only comes sharp, a little at a time: no jumps between bands.
    for (let k = 1; k < f.length; k++) {
      expect(box[k]!, `box at ${times[k]}s`).toBeLessThanOrEqual(box[k - 1]! + 3);
      expect(wall[k]!, `wall at ${times[k]}s`).toBeGreaterThanOrEqual(wall[k - 1]! - 3);
      expect(Math.abs(box[k]! - box[k - 1]!), `box step at ${times[k]}s`).toBeLessThan(0.35 * box[0]!);
    }
    expect(box[box.length - 1]!).toBeLessThan(0.3 * box[0]!);
    expect(wall[wall.length - 1]!).toBeGreaterThan(2 * wall[0]!);
  });

  it("grades only the far part, and fogs by distance", { timeout: 180_000 }, async () => {
    const { s, clipId } = await session("mask-fog");
    const [clean] = await frames(s, [1]);
    ok(await executeTool(s, "grade_region", { target: clipId, label: "far", mask: { kind: "depth", distance: [0.5, 1], feather: 0 }, color: { exposure: -1 } }));
    const [graded] = await frames(s, [1]);
    const lum = (f: AnalysisFrame, x: number, y: number) => {
      const [r, g, b] = px(f, x, y);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    expect(lum(graded!, 60, 40)).toBeLessThan(lum(clean!, 60, 40) - 15);
    expect(Math.abs(lum(graded!, 320, 180) - lum(clean!, 320, 180))).toBeLessThan(2);
    ok(await executeTool(s, "grade_region", { target: clipId, label: "far", remove: true }));
    ok(await executeTool(s, "add_effect", { target: clipId, type: "depthFog", params: { color: "#FFFFFF", density: 0.8, start: 0.3 } }));
    const [fog] = await frames(s, [1]);
    expect(lum(fog!, 60, 40)).toBeGreaterThan(lum(clean!, 60, 40) + 60);
    expect(Math.abs(lum(fog!, 320, 180) - lum(clean!, 320, 180))).toBeLessThan(3);
  });

  it("moves near things more than far ones in a 2.5D move", { timeout: 180_000 }, async () => {
    const { s, clipId } = await session("parallax");
    ok(await executeTool(s, "add_effect", { target: clipId, type: "parallax", params: { x: 0.06, zoom: 0 } }));
    const [a, b] = await frames(s, [0, 1.95]);
    /** The box's left edge on the middle row: the first red column. */
    const edge = (f: AnalysisFrame) => {
      for (let x = 0; x < W; x++) if (px(f, x, 180)[0]! > 140 && px(f, x, 180)[2]! < 100) return x;
      return -1;
    };
    const moved = edge(a!) - edge(b!);
    console.error(`the box moved ${moved} px left`);
    // Near layers move up to x times the frame width (38 px here); the box is at 0.15.
    expect(moved).toBeGreaterThan(20);
    // The wall moves less: the shift that lines its texture up with itself.
    const shiftOf = (y: number) => {
      let best = { shift: 0, diff: Infinity };
      for (let sh = -12; sh <= 12; sh++) {
        let d = 0;
        for (let x = 30; x < 130; x++) d += Math.abs(px(a!, x, y)[2]! - px(b!, x - sh, y)[2]!);
        if (d < best.diff) best = { shift: sh, diff: d };
      }
      return best.shift;
    };
    console.error(`the wall moved ${shiftOf(40)} px`);
    // At distance 0.85 the wall moves about a fifth as far as the nearest layer (7 px).
    expect(Math.abs(shiftOf(40))).toBeLessThanOrEqual(10);
    expect(moved).toBeGreaterThan(3 * Math.abs(shiftOf(40)));
  });
});

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
