import { describe, expect, it } from "vitest";
import { effectRemovals, getEffect, removalKey, removalSpec, RemoveObjectParams } from "../../engine/library/effects/index.js";

const ctx = { width: 640, height: 360, fps: 30, duration: 2 };

describe("object removal effect", () => {
  it("names the same removal the same way, however it was written", () => {
    const a = removalSpec(RemoveObjectParams.parse({ objects: ["cup", "car", "cup"], regions: [{ x0: 0.6, y0: 0.4, x1: 0.2, y1: 0.1 }] }));
    const b = removalSpec(RemoveObjectParams.parse({ objects: ["car", "cup"], regions: [{ shape: "rect", x0: 0.2, y0: 0.1, x1: 0.6, y1: 0.4 }] }));
    expect(removalKey(a)).toBe(removalKey(b));
    expect(a.objects).toEqual(["car", "cup"]);
    expect(a.regions[0]).toEqual({ shape: "rect", x0: 0.2, y0: 0.1, x1: 0.6, y1: 0.4 });
    expect(removalKey(removalSpec(RemoveObjectParams.parse({ objects: ["car"], grow: 0.02 })))).not.toBe(removalKey(a));
  });

  it("lays its prepared fill over the clip, and says where it cannot", () => {
    const def = getEffect("removeObject")!;
    const p = def.params.parse({ objects: ["car"] });
    const asked: string[] = [];
    let n = 0;
    const f = def.toFilter(p, { ...ctx, label: (x) => `${x}${n++}`, removal: (key) => (asked.push(key), "fill") });
    expect(asked).toEqual([removalKey(removalSpec(p as never))]);
    expect(f).toMatch(/\[fill\]format=yuva420p\[rmf\d+\]/);
    expect(f).toMatch(/overlay=format=auto/);
    expect(() => def.toFilter(p, ctx)).toThrow(/primary video and photo clips/);
    // Nothing to remove: the picture passes through.
    expect(def.toFilter(def.params.parse({}), ctx)).toBe("null");
  });

  it("tells the renderer which removals a clip needs", () => {
    expect(effectRemovals({ type: "removeObject", params: { regions: [{ x0: 0, y0: 0, x1: 0.1, y1: 0.1 }] } })).toHaveLength(1);
    expect(effectRemovals({ type: "blur", params: {} })).toEqual([]);
  });
});
