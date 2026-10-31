import { describe, expect, it } from "vitest";
import { parseProject } from "../../engine/core/index.js";
import { compileProject } from "../../engine/tools/index.js";
import { evalExpression, fillGraphic, isAnimatedGraphic } from "../../engine/tools/graphics/index.js";
import { checkCustomFilter } from "../../engine/library/effects/index.js";
import { customIsTimed } from "../../engine/library/effects/custom.js";

describe("graphic expressions", () => {
  it("evaluates math, easing and conditions with the frame's variables", () => {
    const v = { t: 1, p: 0.5, d: 2, n: 30, w: 400, h: 200 };
    expect(evalExpression("2 + 3 * 4 ** 2 / 8", v)).toBe(8);
    expect(evalExpression("-w/2 + clamp(t*300, 0, 250)", v)).toBe(50);
    expect(evalExpression("easeOut(p)", v)).toBeCloseTo(0.875);
    expect(evalExpression("t >= 1 ? 10 : 20", v)).toBe(10);
    expect(evalExpression("round(360*seg(t,0.5,1.5))", v)).toBe(180);
  });

  it("refuses anything outside the grammar", () => {
    expect(() => evalExpression("process.exit()", {})).toThrow(/Unknown name|Unexpected/);
    expect(() => evalExpression("constructor(1)", {})).toThrow(/Unknown function/);
    expect(() => evalExpression("1 +", {})).toThrow();
  });

  it("fills placeholders and tells still from animated SVG", () => {
    expect(fillGraphic('<rect width="{{ 100*p }}"/>', { p: 0.25 })).toBe('<rect width="25"/>');
    expect(isAnimatedGraphic("<svg><rect/></svg>")).toBe(false);
    expect(isAnimatedGraphic('<rect x="{{t}}"/>')).toBe(true);
  });
});

describe("custom effects", () => {
  it("allows picture filters and refuses files, graphs and unknown filters", () => {
    expect(checkCustomFilter("rgbashift=rh=4,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'")).toEqual(["rgbashift", "geq"]);
    expect(() => checkCustomFilter("movie=secret.mp4")).toThrow(/not allowed/);
    expect(() => checkCustomFilter("split[a][b];[a][b]overlay")).toThrow(/one chain/);
    expect(() => checkCustomFilter("drawtext=textfile=/etc/passwd")).toThrow(/not allowed/);
  });

  it("knows which chains depend on time", () => {
    expect(customIsTimed("eq=contrast=1.2")).toBe(false);
    expect(customIsTimed("lagfun=decay=0.9")).toBe(true);
    expect(customIsTimed("hue=h=360*t")).toBe(true);
  });
});

describe("3D layers", () => {
  it("leaves room for a drop shadow when turning a narrow layer in space", () => {
    const p = parseProject({
      settings: { width: 1920, height: 1080, fps: 25 },
      assets: [{ type: "image", id: "chair", src: "chair.png", width: 300, height: 600 }],
      clips: [],
      layers: [{ type: "media", id: "m", assetId: "chair", start: 0, duration: 2, size: { width: 0.075 }, shadow: 20, rotateY: 30 }],
    });
    const graph = compileProject(p, { output: "x.mp4" }).filterGraph;
    const [, shadowW] = graph.match(/\]pad=(\d+):\d+:\d+:\d+:color=black@0,split/)!.map(Number);
    const [, turnW] = graph.match(/\]pad=(\d+):\d+:\(ow-iw\)\/2/)!.map(Number);
    expect(turnW).toBeGreaterThanOrEqual(shadowW!);
  });
});

describe("layers behind the subject", () => {
  const project = (behindSubject: boolean) =>
    parseProject({
      settings: { width: 320, height: 180, fps: 25 },
      assets: [
        { type: "video", id: "v", src: "v.mp4", duration: 4, hasAudio: false, width: 320, height: 180 },
        { type: "image", id: "smoke", src: "smoke.png", width: 320, height: 180 },
      ],
      clips: [{ id: "a", assetId: "v", in: 0, duration: 4 }],
      layers: [{ type: "media", id: "m", assetId: "smoke", start: 1, duration: 2, behindSubject }],
    });

  it("puts the picture from before the layer back where the people are", () => {
    const graph = compileProject(project(true), { output: "x.mp4", subjectMask: "subject.mkv" }).filterGraph;
    const [, keep] = graph.match(/split=2\[lsb\d+\]\[(lsk\d+)\]/)!;
    expect(graph).toContain(`[${keep}][${graph.match(/\[(subj\d+)\];/)![1]}]alphamerge`);
    expect(graph).toMatch(/\[lsc\d+\]overlay=format=auto:shortest=1:enable='between\(t,1,3\)'/);
  });

  it("draws on top without a cutout, and ignores the cutout for other layers", () => {
    expect(compileProject(project(true), { output: "x.mp4" }).filterGraph).not.toMatch(/alphamerge/);
    expect(compileProject(project(false), { output: "x.mp4", subjectMask: "subject.mkv" }).filterGraph).not.toMatch(/subj|alphamerge/);
  });
});
