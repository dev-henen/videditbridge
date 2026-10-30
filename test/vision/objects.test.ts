import { describe, expect, it } from "vitest";
import { MaskSchema, addAsset, addClip, createProject, parseProject } from "../../engine/core/index.js";
import { buildMatte, effectObjects, effectToFilter, maskObjects } from "../../engine/library/effects/index.js";
import { compileProject } from "../../engine/tools/index.js";
import { frameToSource, maskBox, maskIou, sourceToFrame } from "../../engine/tools/vision/index.js";

const ctx = { width: 320, height: 180, fps: 30, duration: 2 };

describe("objects", () => {
  it("maps boxes from the edit's frame back to the source through each fit", () => {
    const src = { width: 1920, height: 1080 };
    const out = { width: 1080, height: 1920 };
    const box = { x0: 0.4, y0: 0.3, x1: 0.6, y1: 0.7 };
    for (const fit of ["cover", "contain", "stretch"] as const)
      for (const focus of [undefined, { x: 0.2, y: 0.5 }]) {
        const shown = sourceToFrame(box, src, out, fit, focus)!;
        const back = frameToSource(shown, src, out, fit, focus);
        for (const k of ["x0", "y0", "x1", "y1"] as const) expect(back[k], `${fit} ${k}`).toBeCloseTo(box[k], 2);
      }
  });

  it("measures masks", () => {
    const [w, h] = [10, 4];
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    for (let x = 2; x < 6; x++) a[w + x] = 255;
    for (let x = 4; x < 8; x++) b[w + x] = 200;
    expect(maskIou(a, b)).toBeCloseTo(2 / 6, 5);
    expect(maskBox(a, w, h)).toEqual({ x0: 2, y0: 1, x1: 6, y1: 2 });
    expect(maskBox(new Uint8Array(w * h), w, h)).toBeUndefined();
  });

  it("stores objects in the project and needs a prompt", () => {
    const p = parseProject({ objects: { phone: { assetId: "v", time: 1.5, box: { x0: 0.4, y0: 0.3, x1: 0.6, y1: 0.7 } } } });
    expect(p.objects.phone!.time).toBe(1.5);
    expect(() => parseProject({ objects: { x: { assetId: "v", time: 0 } } })).toThrow(/point, a box or a text/);
  });

  it("takes one stream per object a mask uses, and fails clearly without one", () => {
    const mask = MaskSchema.parse({ kind: "object", object: "phone", combine: [{ kind: "object", object: "phone", op: "add" }, { kind: "object", object: "cup", op: "subtract" }] });
    expect(maskObjects(mask)).toEqual(["phone", "cup"]);
    expect(effectObjects({ type: "maskView", params: { mask: { kind: "object", object: "car" } } })).toEqual(["car"]);
    expect(() => effectToFilter({ type: "blur", mask }, ctx)).toThrow(/object "phone"/);
    const asked: string[] = [];
    const matte = buildMatte({ ...ctx, objectMask: (id) => (asked.push(id), `obj_${id}`) }, mask);
    expect(asked.sort()).toEqual(["cup", "phone"]);
    expect(matte.lines.join(";")).toContain("[obj_phone]format=gray,split=2");
  });

  it("feeds object mask videos through the clip's timing and fit", () => {
    let p = createProject({ settings: { width: 320, height: 180 } });
    p = addAsset(p, { type: "video", id: "v", src: "shot.mp4", duration: 4, width: 640, height: 360, hasAudio: false });
    p = addClip(p, { id: "c", assetId: "v", duration: 2, effects: [{ type: "blur", mask: MaskSchema.parse({ kind: "object", object: "phone" }) }] });
    p = { ...p, objects: { phone: { assetId: "v", time: 1, box: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.4 } } } };
    const compiled = compileProject(p, { output: "x.mp4", objectMasks: { c: { phone: "phone-mask.mkv" } } });
    expect(compiled.args).toContain("phone-mask.mkv");
    expect(compiled.filterGraph).toContain("alphamerge");
    // Without the prepared mask the compile says why.
    expect(() => compileProject(p, { output: "x.mp4" })).toThrow(/object "phone"/);
  });
});
