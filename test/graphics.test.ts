import { describe, expect, it } from "vitest";
import { evalExpression, fillGraphic, isAnimatedGraphic } from "../src/tools/graphics/index.js";
import { checkCustomFilter } from "../src/library/effects/index.js";
import { customIsTimed } from "../src/library/effects/custom.js";

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
