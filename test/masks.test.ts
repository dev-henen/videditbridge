import { describe, expect, it } from "vitest";
import { MaskSchema, addAsset, addClip, addLayer, createProject, getEffectParams, setEffectParams, setMaskedEffect } from "../src/core/index.js";
import { buildMatte, effectToFilter, isPerFrame, keyExpr, maskStreams } from "../src/library/effects/index.js";
import { compileProject } from "../src/tools/index.js";

const ctx = { width: 320, height: 180, fps: 30, duration: 2 };

/** Evaluate a key expression the way geq would, for one RGB color (0..255). */
function keyAt(expr: string, [r, g, b]: number[]): number {
  const vars: number[] = Array(10).fill(0);
  const js = expr
    .replace(/r\(X,Y\)/g, String(r))
    .replace(/g\(X,Y\)/g, String(g))
    .replace(/b\(X,Y\)/g, String(b))
    .replace(/st\((\d),/g, "st($1,")
    .replace(/;/g, ",");
  const fn = new Function("st", "ld", "max", "min", "clip", "abs", "mod", "eq", "between", "lte", "if_", `return (${js.replace(/\bif\(/g, "if_(")});`);
  return fn(
    (i: number, v: number) => (vars[i] = v),
    (i: number) => vars[i],
    Math.max,
    Math.min,
    (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
    Math.abs,
    (a: number, b: number) => a - b * Math.floor(a / b),
    (a: number, b: number) => (a === b ? 1 : 0),
    (v: number, lo: number, hi: number) => (v >= lo && v <= hi ? 1 : 0),
    (a: number, b: number) => (a <= b ? 1 : 0),
    (c: number, a: number, b: number) => (c ? a : b),
  );
}

describe("masks", () => {
  it("keys hue ranges around the circle, and never grays", () => {
    const reds = keyExpr(MaskSchema.parse({ kind: "key", hue: [340, 20], softness: 0 }));
    expect(keyAt(reds, [220, 30, 40])).toBe(255);
    expect(keyAt(reds, [220, 30, 120])).toBe(0); // hue about 335, just outside
    expect(keyAt(reds, [30, 60, 220])).toBe(0);
    expect(keyAt(reds, [128, 128, 128])).toBe(0);
    const highlights = keyExpr(MaskSchema.parse({ kind: "luma", luma: [0.7, 1], softness: 0.2 }));
    expect(keyAt(highlights, [250, 250, 250])).toBe(255);
    expect(keyAt(highlights, [20, 20, 20])).toBe(0);
    const mid = keyAt(highlights, [168, 168, 168]);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
  });

  it("takes one model stream per mask, and fails clearly without one", () => {
    const face = { type: "color", params: { exposure: 0.2 }, mask: MaskSchema.parse({ kind: "face", combine: [{ kind: "face", op: "intersect" }] }) };
    expect(maskStreams(face, "face")).toBe(1);
    expect(maskStreams(face, "person")).toBe(0);
    // beauty with followFace takes its own copy per ramp state, plus one for the mask.
    expect(maskStreams({ ...face, type: "beauty", params: { followFace: true }, keyframes: [{ time: 0, params: { smooth: 10 }, easing: "linear" }, { time: 1, params: { smooth: 80 }, easing: "linear" }] }, "face")).toBeGreaterThan(2);
    expect(() => effectToFilter(face, ctx)).toThrow(/primary video clips/);
    let n = 0;
    const matte = buildMatte({ ...ctx, faceMask: () => `face${n++}` }, face.mask);
    expect(n).toBe(1);
    expect(matte.lines[0]).toContain("split=2");
  });

  it("combines, grows, feathers and smooths the matte", () => {
    const m = MaskSchema.parse({ kind: "key", hue: [190, 240], grow: 0.02, feather: 0.02, smooth: 3, denoise: true, combine: [{ kind: "shape", op: "subtract", shape: { type: "rect", x: 0.5, y: 0.8, width: 1, height: 0.4 } }] });
    const f = effectToFilter({ type: "blur", mask: m }, ctx);
    for (const part of ["haldclut=clut=first", "median=radius=1", "negate", "blend=all_mode=multiply", "dilation", "gblur=sigma=1.8", "tmix=frames=3", "alphamerge"]) expect(f).toContain(part);
    expect(isPerFrame({ type: "blur", mask: m })).toBe(false);
    expect(isPerFrame({ type: "blur", mask: { ...m, smooth: 0 } })).toBe(true);
  });

  it("keeps secondaries apart from the whole-frame grade, in grading order", () => {
    let p = createProject({ settings: { width: 320, height: 180 } });
    p = addAsset(p, { type: "color", id: "c", color: "#336699" });
    p = addClip(p, { id: "a", assetId: "c", duration: 1, effects: [{ type: "vignette" }] });
    p = setEffectParams(p, "a", "color", { contrast: 10 }, { prepend: true });
    p = setMaskedEffect(p, "a", "sky", { type: "color", params: { saturation: 20 }, mask: MaskSchema.parse({ kind: "luma", luma: [0.6, 1] }) });
    p = setMaskedEffect(p, "a", "shadows", { type: "color", params: { temperature: -10 }, mask: MaskSchema.parse({ kind: "luma", luma: [0, 0.3] }) });
    expect(p.clips[0]!.effects.map((e) => e.label ?? e.type)).toEqual(["color", "sky", "shadows", "vignette"]);
    expect(getEffectParams(p, "a", "color")).toEqual({ contrast: 10 });
    p = setMaskedEffect(p, "a", "sky", null);
    expect(p.clips[0]!.effects.map((e) => e.label ?? e.type)).toEqual(["color", "shadows", "vignette"]);
  });

  it("compiles blend modes through RGB and the layer's alpha", () => {
    let p = createProject({ settings: { width: 320, height: 180 } });
    p = addAsset(p, { type: "color", id: "c", color: "#336699" });
    p = addClip(p, { assetId: "c", duration: 2 });
    p = addLayer(p, { type: "media", assetId: "c", start: 0.5, duration: 1, size: { width: 0.5 }, blend: "colordodge" });
    const graph = compileProject(p, { output: "x.mp4" }).filterGraph;
    expect(graph).toContain("blend=all_mode=dodge:enable='between(t,0.5,1.5)'");
    expect(graph).toContain("alphaextract");
    p = addLayer(p, { type: "media", assetId: "c", start: 0, duration: 1, size: { width: 0.5 } });
    expect(compileProject(p, { output: "x.mp4" }).filterGraph.match(/blend=all_mode/g)).toHaveLength(1);
  });
});
