import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MaskSchema, createProject, addAsset, addClip, addLayer, type Project } from "../../engine/core/index.js";
import { renderForAnalysis, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const W = 320;
const H = 180;

/** RGB of the pixel at (x, y) of a frame. */
const px = (f: { rgb: Buffer }, x: number, y: number) => [0, 1, 2].map((c) => f.rgb[(y * W + x) * 3 + c]!);
const frameOf = async (p: Project) => (await renderForAnalysis(p, { framesAt: [0.5], probe: false })).frames[0]!;

describe.skipIf(!hasFfmpeg)("blend modes and masks", () => {
  // Left half sky blue, right half red, so a hue key has a known answer.
  const halves = path.join(OUT_DIR, "fixtures", "halves.png");
  beforeAll(async () => {
    if (!existsSync(halves))
      await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=0x3070D0:s=${W / 2}x${H}`, "-f", "lavfi", "-i", `color=0xD03020:s=${W / 2}x${H}`, "-filter_complex", "hstack", "-frames:v", "1", halves]);
  });

  const base = (asset: { type: "image"; src: string } | { type: "color"; color: string }) => {
    let p = createProject({ settings: { width: W, height: H, fps: 10 } });
    p = addAsset(p, { id: "bg", ...asset, ...(asset.type === "image" ? { width: W, height: H } : {}) });
    return addClip(p, { assetId: "bg", duration: 1 });
  };

  it("screen and add of a black layer leave the picture as it was", async () => {
    const plain = base({ type: "image", src: halves });
    const before = await frameOf(plain);
    for (const blend of ["screen", "add", "addlight", "screenlight"] as const) {
      let p = addAsset(plain, { type: "color", id: "black", color: "#000000" });
      p = addLayer(p, { type: "media", assetId: "black", start: 0, duration: 1, size: { width: 0.5, height: 0.5 }, blend });
      const after = await frameOf(p);
      let worst = 0;
      for (let k = 0; k < before.rgb.length; k++) worst = Math.max(worst, Math.abs(before.rgb[k]! - after.rgb[k]!));
      // Pixel exact: the round trip through RGB uses nearest-neighbor chroma both ways.
      expect(worst, blend).toBe(0);
    }
  });

  it("multiplies inside the layer only, by the formula", async () => {
    let p = base({ type: "color", color: "#808080" });
    p = addAsset(p, { type: "color", id: "tint", color: "#FF8040" });
    p = addLayer(p, { type: "media", assetId: "tint", start: 0, duration: 1, position: { x: 0.25, y: 0.5 }, size: { width: 0.5, height: 1 }, blend: "multiply" });
    const f = await frameOf(p);
    const inside = px(f, 80, 90);
    [128, 64, 32].forEach((v, c) => expect(Math.abs(inside[c]! - v)).toBeLessThanOrEqual(3));
    px(f, 240, 90).forEach((v) => expect(Math.abs(v - 128)).toBeLessThanOrEqual(1));
  });

  it("adds and screens in linear light, keeping midtones", async () => {
    for (const [blend, plain] of [["addlight", "add"], ["screenlight", "screen"]] as const) {
      let p = base({ type: "color", color: "#808080" });
      p = addAsset(p, { type: "color", id: "glow", color: "#404040" });
      const at = (b: string) => addLayer(p, { type: "media", assetId: "glow", start: 0, duration: 1, size: { width: 1, height: 1 }, blend: b as never });
      const [light, flat] = [px(await frameOf(at(blend)), 160, 90)[0]!, px(await frameOf(at(plain)), 160, 90)[0]!];
      // Linear light: (128/255)^2.4 and (64/255)^2.4 added (or screened) and back through 1/2.4.
      const [a, b] = [(128 / 255) ** 2.4, (64 / 255) ** 2.4];
      const expected = 255 * (blend === "addlight" ? Math.min(1, a + b) : 1 - (1 - a) * (1 - b)) ** (1 / 2.4);
      expect(Math.abs(light - expected), blend).toBeLessThanOrEqual(3);
      // Plain add and screen lift the midtone far more.
      expect(flat - light, blend).toBeGreaterThan(20);
    }
  });

  it("polygon shapes, shapes moving by keyframes, and shapes pinned by corners", async () => {
    const matteAt = async (shape: object, times: number[]) => {
      const p = base({ type: "color", color: "#808080" });
      p.clips[0]!.effects = [{ type: "maskView", params: { mask: { kind: "shape", feather: 0, shape } } }];
      return (await renderForAnalysis(p, { framesAt: times, probe: false })).frames;
    };
    const white = (f: { rgb: Buffer }, x: number, y: number) => px(f, x, y)[0]! > 200;
    // A triangle pointing down: in at its top middle, out at the bottom corners.
    const [tri] = await matteAt({ type: "polygon", points: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]] }, [0.5]);
    expect(white(tri!, 160, 30)).toBe(true);
    expect(white(tri!, 160, 150)).toBe(true);
    expect(white(tri!, 20, 160)).toBe(false);
    expect(white(tri!, 300, 160)).toBe(false);
    // A small square moving from the left quarter to the right quarter over the clip (linear).
    const keyframes = [{ time: 0, value: { x: 0.25, y: 0.5 } }, { time: 0.8, value: { x: 0.75, y: 0.5 }, easing: "linear" }];
    const [start, end] = await matteAt({ type: "rect", x: 0.25, y: 0.5, width: 0.1, height: 0.2, keyframes }, [0, 0.8]);
    expect(white(start!, 80, 90)).toBe(true);
    expect(white(start!, 240, 90)).toBe(false);
    expect(white(end!, 240, 90)).toBe(true);
    expect(white(end!, 80, 90)).toBe(false);
    // Pinned: the frame's corners shifted right by half the frame at 0.8 s (the clip's last frame repeats the one before).
    const shift = (dx: number) => ({ tl: { x: dx, y: 0 }, tr: { x: 1 + dx, y: 0 }, br: { x: 1 + dx, y: 1 }, bl: { x: dx, y: 1 } });
    const corners = [{ time: 0, value: shift(0) }, { time: 0.8, value: shift(0.5), easing: "linear" }];
    const [, pinned] = await matteAt({ type: "ellipse", x: 0.25, y: 0.5, width: 0.1, height: 0.2, corners }, [0, 0.8]);
    expect(white(pinned!, 240, 90)).toBe(true);
    expect(white(pinned!, 80, 90)).toBe(false);
  });

  it("a hue key selects the blue half and nothing else", async () => {
    const p = base({ type: "image", src: halves });
    p.clips[0]!.effects = [{ type: "maskView", params: { mask: { kind: "key", hue: [190, 240], saturation: [0.2, 1], feather: 0 } } }];
    const f = await frameOf(p);
    expect(px(f, 40, 90)[0]).toBeGreaterThan(245);
    expect(px(f, 280, 90)[0]).toBeLessThan(10);
  });

  it("grades inside a feathered mask without a hard edge", async () => {
    const plain = base({ type: "image", src: halves });
    const p = structuredClone(plain);
    p.clips[0]!.effects = [{ type: "color", params: { exposure: 1.5 }, label: "sky", mask: MaskSchema.parse({ kind: "shape", shape: { type: "rect", x: 0.15, y: 0.5, width: 0.3, height: 2 }, feather: 0.05 }) }];
    const [a, b] = [await frameOf(plain), await frameOf(p)];
    // Brighter well inside, unchanged well outside.
    expect(px(b, 20, 90)[2]! - px(a, 20, 90)[2]!).toBeGreaterThan(20);
    expect(px(b, 300, 90)).toEqual(px(a, 300, 90));
    // Across the mask edge (x = 96, inside the blue half) the change ramps from 90% to 10% over many
    // pixels: feather 0.05 of 180 px is a Gaussian of sigma 4.5, about 11 px from 90% to 10%.
    const lift = (x: number) => px(b, x, 90)[1]! - px(a, x, 90)[1]!;
    const full = lift(20);
    let ramp = 0;
    for (let x = 40; x < 150; x++) if (lift(x) < full * 0.9 && lift(x) > full * 0.1) ramp++;
    expect(ramp).toBeGreaterThanOrEqual(8);
  });

  it("grade_region and render_mask work through the tools", async () => {
    const session = new EditorSession(undefined, { outputDir: path.join(OUT_DIR, "masks-session") });
    await executeTool(session, "new_project", { aspectRatio: "16:9" });
    await executeTool(session, "import_media", { src: halves, id: "halves" });
    await executeTool(session, "add_clip", { assetId: "halves", duration: 1 });
    const clipId = session.project.clips[0]!.id;
    await executeTool(session, "color_adjust", { target: clipId, settings: { contrast: 10 } });
    const graded = await executeTool(session, "grade_region", {
      target: clipId,
      label: "deeper sky",
      mask: { kind: "key", hue: [190, 240], combine: [{ kind: "shape", op: "intersect", shape: { type: "rect", x: 0.5, y: 0.25, width: 1, height: 0.5 } }] },
      color: { saturation: 20 },
    });
    expect(graded.isError, graded.text).toBeFalsy();
    const effects = session.project.clips[0]!.effects;
    expect(effects.map((e) => e.label ?? e.type)).toEqual(["color", "deeper sky"]);
    // color_adjust still edits the whole-frame grade, not the secondary.
    await executeTool(session, "color_adjust", { target: clipId, settings: { contrast: 20 } });
    expect(session.project.clips[0]!.effects[0]!.params).toEqual({ contrast: 20 });
    expect(session.project.clips[0]!.effects[1]!.params).toEqual({ saturation: 20 });

    const view = await executeTool(session, "render_mask", { target: clipId, label: "deeper sky" });
    expect(view.isError, view.text).toBeFalsy();
    expect(existsSync(view.images![0]!.path)).toBe(true);
    const frame = await executeTool(session, "render_frame", { time: 0.5 });
    expect(frame.isError, frame.text).toBeFalsy();

    const bad = await executeTool(session, "grade_region", { target: "global", label: "faces", mask: { kind: "face" }, color: { exposure: 0.2 } });
    expect(bad.isError).toBe(true);
    await executeTool(session, "grade_region", { target: clipId, label: "deeper sky", remove: true });
    expect(session.project.clips[0]!.effects).toHaveLength(1);
  });
});
