import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, positionAt, type Corners } from "../../engine/core/index.js";
import { renderForAnalysis, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { quadOf, quadToQuad } from "../../engine/tools/vision/index.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";
import { applyMat, cameraMove, invertMat, texturedFrame } from "../helpers/textured.js";

const hasFfmpeg = await ffmpegAvailable();

// A textured scene under a camera that turns, zooms, slides and tilts: every frame's motion is known.
const [W, H, FPS, FRAMES] = [640, 360, 30, 60];
const truth = (f: number) => cameraMove(f - 30, 0.8);
// A surface in scene coordinates, marked at 1 s (frame 30, where the camera move is the identity).
const SURFACE: [number, number][] = [
  [220, 110],
  [420, 120],
  [410, 250],
  [230, 240],
];
const surfaceAt = (f: number) => SURFACE.map(([x, y]) => applyMat(truth(f), x, y));
const frac = (q: [number, number][]): Corners => {
  const [tl, tr, br, bl] = q.map(([x, y]) => ({ x: x / W, y: y / H }));
  return { tl: tl!, tr: tr!, br: br!, bl: bl! };
};

describe.skipIf(!hasFfmpeg)("tracking points and surfaces", () => {
  const clip = path.join(OUT_DIR, "fixtures", "camera-move.mp4");
  beforeAll(async () => {
    if (existsSync(clip)) return;
    await mkdir(path.dirname(clip), { recursive: true });
    const raw = `${clip}.gray`;
    const all = new Uint8Array(W * H * FRAMES);
    for (let f = 0; f < FRAMES; f++) all.set(texturedFrame(W, H, truth(f)), f * W * H);
    await writeFile(raw, all);
    try {
      await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(FPS), "-i", raw, "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", clip]);
    } finally {
      await rm(raw, { force: true });
    }
  });

  const session = async (name: string) => {
    const s = new EditorSession(undefined, { outputDir: path.join(OUT_DIR, name) });
    await executeTool(s, "new_project", { aspectRatio: "16:9" });
    await executeTool(s, "set_project_settings", { width: W, height: H, fps: FPS });
    await executeTool(s, "import_media", { src: clip, id: "shot" });
    await executeTool(s, "add_clip", { assetId: "shot" });
    return s;
  };

  it("puts a picture on a tracked surface: corners within a pixel, forward and backward from the marked frame", async () => {
    const s = await session("points-screen");
    const tracked = await executeTool(s, "track_points", { time: 1, corners: frac(surfaceAt(30)), label: "screen" });
    expect(tracked.isError, tracked.text).toBeFalsy();
    expect(s.project.tracks.screen?.corners).toBeDefined();
    expect(existsSync(tracked.images![0]!.path)).toBe(true);
    s.commit(addAsset(s.project, { type: "color", id: "red", color: "#E02020" }), "test");
    const put = await executeTool(s, "replace_screen", { trackId: "screen", assetId: "red" });
    expect(put.isError, put.text).toBeFalsy();
    const layer = s.project.layers.find((l) => l.type === "media" && l.keyframes?.corners?.length)!;
    expect(layer.start).toBe(0);
    // Matched to the shot (levels; a flat red insert needs no blur), and a glare pinned with it.
    expect(put.text).toMatch(/matched to the shot/);
    expect(layer.type === "media" && layer.effects.some((e) => e.type === "custom" && /colorlevels/.test(String((e.params as { filter?: string }).filter)))).toBe(true);
    const glare = s.project.layers.find((l) => l.type === "media" && l.blend === "screen");
    expect(glare?.keyframes?.corners).toEqual(layer.keyframes!.corners);
    const keys = layer.keyframes!.corners!;
    // The stored keyframes, read at every frame, against the exact corners.
    let worst = 0;
    for (let f = 0; f < FRAMES - 1; f++) {
      const pick = (c: keyof Corners) => positionAt(keys.map((k) => ({ ...k, value: k.value[c] })), f / FPS);
      (["tl", "tr", "br", "bl"] as const).forEach((c, k) => {
        const [p, q] = [pick(c), surfaceAt(f)[k]!];
        worst = Math.max(worst, Math.hypot(p.x * W - q[0], p.y * H - q[1]));
      });
    }
    console.error(`replace_screen: worst corner error ${worst.toFixed(3)} px over ${FRAMES - 1} frames, ${keys.length} keyframes`);
    expect(worst, "worst corner error, px").toBeLessThan(1);
    // The render: red inside the surface where it has moved to, the scene just outside it.
    for (const f of [5, 55]) {
      const frame = (await renderForAnalysis(s.project, { framesAt: [f / FPS], probe: false })).frames[0]!;
      const px = ([x, y]: [number, number]) => [0, 1, 2].map((c) => frame.rgb[(Math.round(y) * W + Math.round(x)) * 3 + c]!);
      const q = surfaceAt(f);
      const mid: [number, number] = [q.reduce((n, v) => n + v[0], 0) / 4, q.reduce((n, v) => n + v[1], 0) / 4];
      const [r, g] = px(mid);
      expect(r, `frame ${f} center`).toBeGreaterThan(180);
      expect(g, `frame ${f} center`).toBeLessThan(80);
      // 4 px inside and outside the top-left corner, along the diagonal.
      const d = Math.hypot(q[0]![0] - mid[0], q[0]![1] - mid[1]);
      const along = (k: number): [number, number] => [q[0]![0] + ((q[0]![0] - mid[0]) * k) / d, q[0]![1] + ((q[0]![1] - mid[1]) * k) / d];
      expect(px(along(-4))[0]! - px(along(-4))[1]!, `frame ${f} inside the corner`).toBeGreaterThan(100);
      expect(Math.abs(px(along(4))[0]! - px(along(4))[1]!), `frame ${f} outside the corner`).toBeLessThan(30);
    }
  });

  it("pins a layer to a tracked point, keeping its offset", async () => {
    const s = await session("points-pin");
    const [cx, cy] = applyMat(truth(30), 320, 180);
    const tracked = await executeTool(s, "track_points", { time: 1, point: { x: cx / W, y: cy / H }, radius: 0.12, label: "spot" });
    expect(tracked.isError, tracked.text).toBeFalsy();
    await executeTool(s, "add_shape", { start: 0, duration: 1.9, position: { x: 320 / W, y: 120 / H }, size: { width: 0.05, height: 0.05 }, color: "#FFFFFF" });
    const id = s.project.layers[0]!.id;
    const pinned = await executeTool(s, "pin_layer", { layerId: id, trackId: "spot" });
    expect(pinned.isError, pinned.text).toBeFalsy();
    const keys = s.project.layers[0]!.keyframes!;
    expect(keys.position!.length).toBeGreaterThan(1);
    expect(keys.rotation?.length).toBeGreaterThan(0);
    // The scene point under the shape on its first frame, carried by the true motion.
    const under = applyMat(invertMat(truth(0)), 320, 120);
    let worst = 0;
    for (let f = 0; f < 57; f++) {
      const want = applyMat(truth(f), ...under);
      const got = positionAt(keys.position!, f / FPS);
      worst = Math.max(worst, Math.hypot(got.x * W - want[0], got.y * H - want[1]));
    }
    console.error(`pin_layer: worst position error ${worst.toFixed(3)} px, ${keys.position!.length} position keyframes`);
    // A similarity track of a camera move with a little perspective: most of the error is the model.
    expect(worst, "pinned position error, px").toBeLessThan(2.5);
    // The layer records its track, and review_edit finds the track sure the whole time (no drift).
    expect(s.project.layers[0]!.track).toBe("spot");
    const review = await executeTool(s, "review_edit", { checks: ["vfx"] });
    expect(review.isError, review.text).toBeFalsy();
    expect((review.data as { issues: unknown[]; notes: string[] }).issues, review.text).toEqual([]);
  });

  it("pins a shape mask to a tracked surface, in perspective", async () => {
    const s = await session("points-pin-mask");
    const tracked = await executeTool(s, "track_points", { time: 1, corners: frac(surfaceAt(30)), label: "wall" });
    expect(tracked.isError, tracked.text).toBeFalsy();
    // A polygon over the surface as it is on the clip's first frame.
    const points = surfaceAt(0).map(([x, y]) => [x / W, y / H]);
    const graded = await executeTool(s, "grade_region", { target: s.project.clips[0]!.id, label: "wall", mask: { kind: "shape", shape: { type: "polygon", points } }, color: { exposure: 1 } });
    expect(graded.isError, graded.text).toBeFalsy();
    const pinned = await executeTool(s, "pin_mask", { target: s.project.clips[0]!.id, label: "wall", trackId: "wall" });
    expect(pinned.isError, pinned.text).toBeFalsy();
    const shape = s.project.clips[0]!.effects.find((e) => e.label === "wall")!.mask!.shape!;
    expect(shape.corners!.length).toBeGreaterThan(1);
    // A point of the shape on the first frame, carried by the stored frame corners, against the truth.
    const start = applyMat(invertMat(truth(0)), ...surfaceAt(0)[0]!);
    let worst = 0;
    for (let f = 0; f < FRAMES - 1; f++) {
      const c = Object.fromEntries((["tl", "tr", "br", "bl"] as const).map((k) => [k, positionAt(shape.corners!.map((key) => ({ ...key, value: key.value[k] })), f / FPS)])) as Corners;
      const m = quadToQuad([[0, 0], [W, 0], [W, H], [0, H]], quadOf(c, W, H));
      const [x, y] = surfaceAt(0)[0]!;
      const z = m[6]! * x + m[7]! * y + m[8]!;
      const want = applyMat(truth(f), ...start);
      worst = Math.max(worst, Math.hypot((m[0]! * x + m[1]! * y + m[2]!) / z - want[0], (m[3]! * x + m[4]! * y + m[5]!) / z - want[1]));
    }
    console.error(`pin_mask: worst corner error ${worst.toFixed(3)} px, ${shape.corners!.length} corner keyframes`);
    expect(worst, "pinned shape corner error, px").toBeLessThan(1);
    // Rendered: brighter in the middle of the surface where it has moved to than in the plain clip.
    const f = 50;
    const q = surfaceAt(f);
    const [mx, my] = [Math.round(q.reduce((n, v) => n + v[0], 0) / 4), Math.round(q.reduce((n, v) => n + v[1], 0) / 4)];
    const plain = structuredClone(s.project);
    plain.clips[0]!.effects = [];
    const lum = async (p: typeof plain) => (await renderForAnalysis(p, { framesAt: [f / FPS], probe: false })).frames[0]!.rgb[(my * W + mx) * 3]!;
    expect((await lum(s.project)) - (await lum(plain))).toBeGreaterThan(20);
  });
});
