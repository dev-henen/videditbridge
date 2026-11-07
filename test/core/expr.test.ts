import { describe, expect, it } from "vitest";
import { evalExpr } from "../../engine/core/expr.js";
import { numberAt, numberExpr } from "../../engine/core/keyframes.js";
import type { Keyframe } from "../../engine/core/schema.js";

describe("FFmpeg expressions", () => {
  it("follows the operators and their precedence", () => {
    expect(evalExpr("1+2*3")).toBe(7);
    expect(evalExpr("(1+2)*3")).toBe(9);
    expect(evalExpr("2^3^2")).toBe(512);
    expect(evalExpr("-2^2")).toBe(-4);
    expect(evalExpr("10/4-1")).toBe(1.5);
    expect(evalExpr("1e-3*2")).toBe(0.002);
    expect(evalExpr("PI")).toBe(Math.PI);
  });

  it("has FFmpeg's functions: mod with the divisor's sign, if, comparisons, clip", () => {
    expect(evalExpr("mod(-1,3)")).toBe(2);
    expect(evalExpr("mod(7.5,2)")).toBe(1.5);
    expect(evalExpr("if(gte(t,1),5,6)", { t: 1 })).toBe(5);
    expect(evalExpr("if(lt(t,1),5)", { t: 2 })).toBe(0);
    expect(evalExpr("clip(12,0,10)")).toBe(10);
    expect(evalExpr("between(t,0.2,0.5)", { t: 0.5 })).toBe(1);
    expect(evalExpr("hypot(3,4)")).toBe(5);
    expect(evalExpr("round(-2.5)")).toBe(-3);
  });

  it("keeps st and ld across a sequence, and evaluates only the branch taken", () => {
    expect(evalExpr("st(0,3);ld(0)*2")).toBe(6);
    expect(evalExpr("if(0,st(1,9),1);ld(1)")).toBe(0);
  });

  it("evaluates the keyframe expressions the renderer writes as the keyframes do", () => {
    const keys: Keyframe<number>[] = [
      { time: 0, value: 0, easing: "linear" },
      { time: 1, value: 90, easing: "ease-in-out" },
      { time: 2.5, value: 30, easing: "ease-out" },
    ];
    const expr = numberExpr(keys, "t");
    for (const t of [0, 0.3, 1, 1.7, 2.5, 3]) expect(evalExpr(expr, { t })).toBeCloseTo(numberAt(keys, t), 2);
  });

  it("names what it does not know", () => {
    expect(() => evalExpr("foo(1)")).toThrow(/Unknown function foo/);
    expect(() => evalExpr("x+1")).toThrow(/Unknown variable x/);
  });
});
