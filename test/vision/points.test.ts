import { describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, createProject, simplifyKeysBy } from "../../engine/core/index.js";
import { compileProject, padCorners, rectToQuad } from "../../engine/tools/index.js";
import { cornersOf, fillQuad, framePointToSource, quadOf, sourcePointToFrame, specQuad, trackCornersAt, trackQuad, type PointTrack, type Quad } from "../../engine/tools/vision/index.js";
import { computeTimeline } from "../../engine/core/timeline.js";
import { applyMat, cameraMove, texturedFrame } from "../helpers/textured.js";

const maxError = (a: Quad, b: Quad) => Math.max(...a.map((p, c) => Math.hypot(p[0] - b[c]![0], p[1] - b[c]![1])));

describe("point and surface tracking", () => {
  it("fills a quad by pixel centers", () => {
    const m = fillQuad(
      [
        [2, 1],
        [6, 1],
        [6, 3],
        [2, 3],
      ],
      10,
      5,
    );
    expect(m.reduce((n, v) => n + v, 0)).toBe(8);
    expect(m[1 * 10 + 2]).toBe(1);
    expect(m[1 * 10 + 6]).toBe(0);
  });

  it("follows a surface forward and backward from the marked frame within half a pixel", async () => {
    const [w, h, n, key] = [320, 240, 13, 6];
    const truth = Array.from({ length: n }, (_, i) => cameraMove(i, 1.5));
    const frames = truth.map((m) => texturedFrame(w, h, m));
    const scene: Quad = [
      [90, 70],
      [230, 70],
      [230, 170],
      [90, 170],
    ];
    const at = (i: number) => scene.map(([x, y]) => applyMat(truth[i]!, x, y));
    const r = await trackQuad(frames, w, h, key, at(key), { motion: "perspective" });
    expect(r.quads).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(maxError(r.quads[i]!, at(i)), `frame ${i}`).toBeLessThan(0.5);
      expect(r.confidence[i], `frame ${i}`).toBeGreaterThan(0.5);
    }
  });

  it("follows a point as a moving square", async () => {
    const [w, h, n] = [320, 240, 8];
    const truth = Array.from({ length: n }, (_, i) => [1, 0, 2.5 * i, 0, 1, -1.5 * i, 0, 0, 1]);
    const frames = truth.map((m) => texturedFrame(w, h, m));
    const spec = { assetId: "a", time: 0, point: { x: 0.5, y: 0.5 }, radius: 0.1 };
    const quad = specQuad(spec, { width: w, height: h }).map(([x, y]): [number, number] => [x * w, y * h]);
    expect(quad[1]![0] - quad[0]![0]).toBeCloseTo(64, 6);
    const r = await trackQuad(frames, w, h, 0, quad, { motion: "translation" });
    for (let i = 0; i < n; i++) expect(maxError(r.quads[i]!, quad.map(([x, y]) => [x + 2.5 * i, y - 1.5 * i])), `frame ${i}`).toBeLessThan(0.3);
  });

  it("reads corners between frames and maps them into the edit's frame", () => {
    const c = (x: number) => cornersOf(quadOf({ tl: { x, y: 0.2 }, tr: { x: x + 0.2, y: 0.2 }, br: { x: x + 0.2, y: 0.4 }, bl: { x, y: 0.4 } }));
    const track: PointTrack = { fps: 10, start: 1, source: { width: 1920, height: 1080 }, motion: "perspective", corners: [c(0.1), c(0.2), c(0.3)], confidence: [1, 0.8, 0.6], redetected: [] };
    expect(trackCornersAt(track, 1.15)!.corners.tl.x).toBeCloseTo(0.25, 6);
    expect(trackCornersAt(track, 1.15)!.confidence).toBe(0.6);
    expect(trackCornersAt(track, 0.5)).toBeUndefined();
    // A 16:9 source in a 9:16 edit, cropped with a focus: there and back without rounding.
    let p = createProject({ settings: { width: 1080, height: 1920, fps: 30 } });
    p = addAsset(p, { type: "video", id: "v", src: "v.mp4", width: 1920, height: 1080, duration: 10 });
    p = addClip(p, { assetId: "v", focus: { x: 0.3, y: 0.5 } });
    const tc = computeTimeline(p).clips[0]!;
    const shown = sourcePointToFrame({ x: 0.31234, y: 0.6 }, track.source, p.settings, tc, 0);
    const back = framePointToSource(shown, track.source, p.settings, tc, 0);
    expect(back.x).toBeCloseTo(0.31234, 9);
    expect(back.y).toBeCloseTo(0.6, 9);
  });

  it("corner-pins a layer: the perspective takes the layer's corners to the keyframed ones", () => {
    const q: [number, number][] = [
      [100, 50],
      [500, 80],
      [480, 330],
      [120, 300],
    ];
    const m = rectToQuad(640, 360, q);
    [
      [0, 0],
      [640, 0],
      [640, 360],
      [0, 360],
    ].forEach(([x, y], c) => {
      const [u, v] = applyMat(m, x!, y!);
      expect(u).toBeCloseTo(q[c]![0], 6);
      expect(v).toBeCloseTo(q[c]![1], 6);
    });
    const corners = cornersOf(q, 640, 360);
    const outer = padCorners(corners, 640, 360, 4);
    // Padding goes outward, and stays on the lines of the surface's edges.
    expect(outer[0]![0]).toBeLessThan(100);
    expect(outer[0]![1]).toBeLessThan(50);
    let p = createProject({ settings: { width: 640, height: 360, fps: 30 } });
    p = addAsset(p, { type: "color", id: "bg", color: "#000000" });
    p = addAsset(p, { type: "color", id: "red", color: "#FF0000" });
    p = addClip(p, { assetId: "bg", duration: 2 });
    p = addLayer(p, {
      type: "media",
      assetId: "red",
      start: 0,
      duration: 2,
      keyframes: {
        corners: [
          { time: 0, value: corners, easing: "linear" },
          { time: 2, value: cornersOf(q.map(([x, y]) => [x + 20, y]), 640, 360), easing: "linear" },
        ],
      },
    });
    const graph = compileProject(p, { output: "out.mp4" }).filterGraph;
    expect(graph).toMatch(/perspective=x0='[^']*on\/30[^']*'.*sense=destination.*eval=frame/);
    expect(graph).toContain("scale=640:360,format=yuva420p,pad=648:368:4:4:color=black@0");
  });

  it("simplifies keyframes of any shape", () => {
    const keys = [0, 1, 2, 3, 4].map((t) => ({ time: t, value: [t, t < 2 ? 0 : t - 2], easing: "linear" as const }));
    expect(simplifyKeysBy(keys, (v) => v, 0.01).map((k) => k.time)).toEqual([0, 2, 4]);
  });
});
