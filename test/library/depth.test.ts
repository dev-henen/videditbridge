import { describe, expect, it } from "vitest";
import { MaskSchema } from "../../engine/core/index.js";
import { focusAt, getEffect, maskStreams, usesDepthMask } from "../../engine/library/effects/index.js";
import { buildMatte, describeMask } from "../../engine/library/effects/masks.js";

const ctx = { width: 640, height: 360, fps: 30, duration: 2, depthMask: () => "dep" };

describe("depth effects", () => {
  it("eases the focus between rack steps and holds it outside them", () => {
    const keys = [
      { time: 0.5, focus: 0.2 },
      { time: 1.5, focus: 0.8 },
    ];
    expect(focusAt(keys, 0)).toBe(0.2);
    expect(focusAt(keys, 1)).toBeCloseTo(0.5);
    expect(focusAt(keys, 0.75)).toBeLessThan(0.35);
    expect(focusAt(keys, 9)).toBe(0.8);
  });

  it("sends a rack focus to its blur filters over time, and nothing for a fixed focus", () => {
    const def = getEffect("depthOfField")!;
    let n = 0;
    const label = (p: string) => `${p}${n++}`;
    const racked = def.toFilter(def.params.parse({ focusPath: [{ time: 0, focus: 0.1 }, { time: 1, focus: 0.9 }] }), { ...ctx, label });
    const cmds = /sendcmd=c='([^']+)'/.exec(racked)?.[1];
    expect(cmds).toBeDefined();
    // Ten steps a second over the clip, each setting every band's two blurs, across and down: gblur
    // copies sigma to sigmaV only when it starts (found on real footage: a rack left the subject soft).
    expect(cmds!.split(";")).toHaveLength(21);
    expect(cmds!.split(";")[0]!.match(/ sigma /g)).toHaveLength(12);
    expect(cmds!.split(";")[0]!.match(/ sigmaV /g)).toHaveLength(12);
    // Every commanded filter exists in the graph under that name.
    for (const name of new Set([...cmds!.matchAll(/(gblur@\w+) sigma/g)].map((m) => m[1]!))) expect(racked).toContain(`${name}=sigma=`);
    expect(def.toFilter(def.params.parse({ focus: 0.3 }), { ...ctx, label })).not.toMatch(/sendcmd/);
    expect(() => def.toFilter(def.params.parse({}), { ...ctx, depthMask: undefined })).toThrow(/needs the clip's depth/);
  });

  it("selects a range of distance as a mask", () => {
    const mask = MaskSchema.parse({ kind: "depth", distance: [0.6, 1], softness: 0.2 });
    expect(describeMask(mask)).toBe("depth distance 0.6-1");
    const matte = buildMatte(ctx, mask);
    expect(matte.lines.join(";")).toMatch(/\[dep\]format=gray.*lut=c0='255\*/);
    expect(usesDepthMask({ type: "blur", params: {}, mask })).toBe(true);
    expect(maskStreams({ type: "depthOfField", params: {}, mask }, "depth")).toBe(2);
    expect(usesDepthMask({ type: "blur", params: {} })).toBe(false);
  });
});
