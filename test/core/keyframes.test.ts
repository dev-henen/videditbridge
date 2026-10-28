import { describe, expect, it } from "vitest";
import { easeValue, isAnimated, layerStateAt, numberAt, numberExpr, parseProject, positionAt, simplifyKeys, smoothKeys, validateProject, type Keyframe } from "../../engine/core/index.js";
import { AssDocument, compileProject, textLayerBox } from "../../engine/tools/index.js";
import { addShapeLayer, addTextLayer } from "../../engine/tools/render/text.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";

const k = (time: number, value: number, easing: Keyframe<number>["easing"] = "linear"): Keyframe<number> => ({ time, value, easing });

/** Evaluate an FFmpeg expression with the few functions numberExpr uses. */
function evalExpr(expr: string, t: number): number {
  const fn = new Function("t", "lt", "clip", "pow", "iff", `return ${expr.replace(/\bif\(/g, "iff(")};`);
  return fn(t, (a: number, b: number) => (a < b ? 1 : 0), (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)), Math.pow, (c: number, a: number, b: number) => (c ? a : b));
}

describe("keyframe values", () => {
  it("eases between keyframes and holds outside them", () => {
    const keys = [k(1, 10), k(3, 30, "ease-in-out"), k(4, 0)];
    expect(numberAt(keys, 0)).toBe(10);
    expect(numberAt(keys, 2)).toBeCloseTo(20); // smoothstep is half way at the middle
    expect(numberAt(keys, 1.5)).toBeCloseTo(10 + 20 * easeValue(0.25, "ease-in-out"));
    expect(numberAt(keys, 3.5)).toBeCloseTo(15);
    expect(numberAt(keys, 9)).toBe(0);
    expect(positionAt([{ time: 0, value: { x: 0, y: 1 }, easing: "linear" }, { time: 2, value: { x: 1, y: 0 }, easing: "linear" }], 0.5)).toEqual({ x: 0.25, y: 0.75 });
  });

  it("builds FFmpeg expressions that give the same values", () => {
    const keys = [k(0.5, 1), k(2, 3, "ease-out"), k(3, -1, "ease-in"), k(4.5, 2, "ease-in-out")];
    const expr = numberExpr(keys, "t");
    for (const t of [0, 0.5, 1, 1.7, 2, 2.4, 3, 3.9, 4.5, 6]) expect(evalExpr(expr, t)).toBeCloseTo(numberAt(keys, t), 2);
    expect(numberExpr([k(1, 5)], "t")).toBe("5");
  });

  it("smooths and simplifies a tracked path", () => {
    const path = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((time, i) => ({ time, value: { x: 0.1 * i + (i % 2 ? 0.004 : -0.004), y: 0.5 }, easing: "linear" as const }));
    const smooth = smoothKeys(path, 1);
    expect(Math.abs(smooth[3]!.value.x - 0.3)).toBeLessThan(0.003);
    // A straight walk becomes two keyframes; a turn keeps its corner.
    expect(simplifyKeys(smooth, 0.01).map((x) => x.time)).toEqual([0, 3]);
    const turn = [...path.slice(0, 4), ...[3.5, 4].map((time) => ({ time, value: { x: 0.3, y: 0.5 + (time - 3) }, easing: "linear" as const }))];
    const corners = simplifyKeys(turn, 0.01).map((x) => x.time);
    expect(corners).toContain(1.5);
    expect([corners[0], corners.at(-1)]).toEqual([0, 4]);
  });

  it("knows a layer's state at a time", () => {
    const p = parseProject({
      layers: [{ type: "text", id: "t", text: "Hi", start: 2, duration: 4, position: { x: 0.5, y: 0.5 }, keyframes: { scale: [k(0, 1), k(2, 2)], opacity: [k(3, 1), k(4, 0)] } }],
    });
    const l = p.layers[0]!;
    expect(isAnimated(l)).toBe(true);
    expect(layerStateAt(l, 1)).toEqual({ position: { x: 0.5, y: 0.5 }, scale: 1.5, rotation: 0, opacity: 1 });
    expect(layerStateAt(l, 3.5).opacity).toBeCloseTo(0.5);
    // The review's text box grows with the scale keyframes.
    const small = textLayerBox(l as never, 1080, 1920, 0);
    const big = textLayerBox(l as never, 1080, 1920, 2);
    expect(big.x1 - big.x0).toBeCloseTo(2 * (small.x1 - small.x0), 3);
    const late = parseProject({ layers: [{ type: "text", id: "t", text: "Hi", start: 0, duration: 1, keyframes: { opacity: [k(0, 1), k(3, 0)] } }] });
    expect(validateProject(late).issues.map((i) => i.message)).toContain("Keyframes after the layer ends (1s): they never show");
  });
});

describe("rendering keyframes", () => {
  it("draws text and shapes frame by frame with position, scale, rotation and opacity", () => {
    const p = parseProject({
      layers: [
        {
          type: "text",
          id: "t",
          text: "Go",
          start: 1,
          duration: 1,
          style: { shadowColor: "#00000080" },
          animationIn: { type: "fade", duration: 0.2 },
          keyframes: { position: [{ time: 0, value: { x: 0, y: 0.5 } }, { time: 1, value: { x: 1, y: 0.5 }, easing: "linear" }], rotation: [k(0, 30)], opacity: [k(0, 0.5)] },
        },
        { type: "shape", id: "s", start: 0, duration: 0.5, size: { width: 0.1, height: 0.1 }, shadow: 4, keyframes: { scale: [k(0, 1), k(0.5, 2)] } },
      ],
    });
    const doc = new AssDocument(1000, 1000, 0);
    addTextLayer(doc, p.layers[0] as never, 10, 10);
    const text = doc.events.filter((e) => e.layer === 10);
    // A fade in, then one event per frame (10 fps over 0.8 s).
    expect(text.length).toBe(9);
    expect(text[0]!.text).toMatch(/\\fad/);
    const xs = text.slice(1).map((e) => Number(/\\pos\((\d+),/.exec(e.text)![1]));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBe(200);
    // Clockwise degrees become ASS's counterclockwise angle; opacity scales each color's alpha.
    expect(text[1]!.text).toMatch(/\\frz-30/);
    expect(text[1]!.text).toMatch(/\\1a&H80&\\3a&H80&\\4a&HBF&/);
    const doc2 = new AssDocument(1000, 1000, 0);
    addShapeLayer(doc2, p.layers[1] as never, 11, 10);
    const shapes = doc2.events.map((e) => e.text);
    // The shadow copy and the shape both scale; identical frames would have merged.
    const scales = shapes.map((x) => Number(/\\fscx(\d+)/.exec(x)?.[1] ?? 100));
    expect(scales).toEqual([100, 120, 140, 160, 180, 100, 120, 140, 160, 180]);
    expect(shapes.some((x) => /\\pos\(500,504\)/.test(x))).toBe(true);
  });

  it("moves, turns, scales and fades media overlays, and pans a clip's crop", () => {
    const p = parseProject({
      settings: { width: 720, height: 1280 },
      assets: [{ type: "video", id: "v", src: "v.mp4", duration: 10, width: 1920, height: 1080 }, { type: "image", id: "img", src: "i.png", width: 100, height: 100 }],
      clips: [{ id: "c", assetId: "v", duration: 4, keyframes: { focus: [{ time: 0, value: { x: 0, y: 0.5 } }, { time: 4, value: { x: 1, y: 0.5 } }] } }],
      layers: [
        {
          type: "media",
          id: "m",
          assetId: "img",
          start: 1,
          duration: 2,
          size: { width: 0.2 },
          keyframes: { position: [{ time: 0, value: { x: 0.2, y: 0.5 } }, { time: 2, value: { x: 0.8, y: 0.5 } }], rotation: [k(0, 0), k(2, 90)], scale: [k(0, 1), k(2, 2)], opacity: [k(0, 0), k(1, 1)] },
        },
      ],
    });
    const g = compileProject(p, { output: "o.mp4" }).filterGraph;
    expect(g).toMatch(/crop=720:1280:'\(iw-ow\)\*clip\(if\(lt\(t,0\)/);
    expect(g).toMatch(/overlay=x='main_w\*\(if\(lt\(\(t-1\),0\)/);
    const chain = g.split(";\n").find((l) => l.includes("rotate="))!;
    // Rotation first, the size-changing scale last.
    expect(chain.indexOf("rotate=")).toBeLessThan(chain.indexOf("geq="));
    expect(chain.indexOf("geq=")).toBeLessThan(chain.indexOf("scale=w="));
    expect(chain).toMatch(/eval=frame/);
  });
});

describe("animate_layer", () => {
  const session = () =>
    new EditorSession(parseProject({ layers: [{ type: "text", id: "t", text: "Hi", start: 2, duration: 3 }] }));

  it("takes timeline times, and relative ones on request", async () => {
    const s = session();
    const r = await executeTool(s, "animate_layer", { layerId: "t", position: [{ time: 4, x: 0.8, y: 0.2 }, { time: 2, x: 0.2, y: 0.2, easing: "linear" }], opacity: [{ time: 2.5, value: 0 }], relative: false });
    expect(r.isError, r.text).toBeFalsy();
    const kf = s.project.layers[0]!.keyframes!;
    expect(kf.position!.map((x) => x.time)).toEqual([0, 2]);
    expect(kf.position![0]!.easing).toBe("linear");
    expect(kf.position![1]!.easing).toBe("ease-in-out");
    expect((await executeTool(s, "animate_layer", { layerId: "t", scale: [{ time: 1, value: 2 }], relative: true })).isError).toBeFalsy();
    expect(s.project.layers[0]!.keyframes!.scale![0]!.time).toBe(1);
    expect(s.project.layers[0]!.keyframes!.position).toHaveLength(2); // untouched
    // Out of the layer's time, and removal.
    expect((await executeTool(s, "animate_layer", { layerId: "t", scale: [{ time: 9, value: 2 }] })).text).toMatch(/outside the layer/);
    await executeTool(s, "animate_layer", { layerId: "t", position: null, scale: null, opacity: null });
    expect(s.project.layers[0]!.keyframes).toBeUndefined();
  });
});
