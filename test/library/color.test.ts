import { describe, expect, it } from "vitest";
import { ColorSettingsSchema, colorFilter, describeColorSettings, effectToFilter, mergeColorSettings } from "../../engine/library/effects/index.js";
import { getEffectParams, parseProject, setEffectParams, summarizeProject } from "../../engine/core/index.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";

describe("colorFilter", () => {
  it("is empty when neutral", () => {
    expect(colorFilter({})).toBe("");
    expect(colorFilter({ contrast: 0, hsl: { blue: {} } })).toBe("");
  });

  it("maps each control to a filter", () => {
    const f = colorFilter({
      exposure: 0.5,
      contrast: 20,
      saturation: -30,
      vibrance: 25,
      highlights: -40,
      shadows: 30,
      temperature: 20,
      tint: -10,
      hue: 15,
      hsl: { orange: { saturation: 20 }, purple: { hue: -10 } },
      wheels: { shadows: { hue: 200, amount: 30 } },
      curves: { master: [[0, 0], [0.5, 0.6], [1, 1]], red: [[0, 0.05], [1, 1]], preset: "medium_contrast" },
      fade: 30,
      clarity: 25,
      sharpen: 40,
      vignette: -20,
      grain: 10,
      autoCorrect: true,
    });
    for (const part of ["normalize=", "exposure=exposure=0.5", "colorbalance=", "curves=master='", "eq=", "vibrance=intensity=0.3", "hue=h=15", "colors=r+y", "colors=b+m", "curves=preset=medium_contrast", "red='0/0.05 1/1'", "unsharp=lx=13", "unsharp=lx=5", "mode=backward", "noise=alls=4"])
      expect(f).toContain(part);
  });

  it("clips after exposure and never uses preserve-lightness color balance", () => {
    // Both caused broken colors when combined with other controls (found on real footage).
    const f = colorFilter({ exposure: 0.2, temperature: 30, wheels: { highlights: { hue: 35, amount: 50 } } });
    expect(f).toMatch(/^exposure=exposure=0.2,format=gbrp,/);
    expect(f).not.toContain("pl=1");
  });

  it("keeps clarity within unsharp's matrix limit", () => {
    expect(colorFilter({ clarity: 100 })).toContain("unsharp=lx=13:ly=13");
  });

  it("orders curve points by input", () => {
    expect(colorFilter({ curves: { master: [[1, 1], [0, 0], [0.5, 0.4]] } })).toContain("master='0/0 0.5/0.4 1/1'");
  });

  it("rejects out-of-range values", () => {
    expect(ColorSettingsSchema.safeParse({ contrast: 150 }).success).toBe(false);
    expect(ColorSettingsSchema.safeParse({ exposure: -4 }).success).toBe(false);
  });
});

describe("mergeColorSettings", () => {
  it("merges nested groups per key and clears with null", () => {
    let s = mergeColorSettings({}, { contrast: 10, hsl: { blue: { saturation: 20 } } });
    s = mergeColorSettings(s, { hsl: { blue: { hue: 5 }, red: { luminance: -10 } } });
    expect(s.hsl).toEqual({ blue: { saturation: 20, hue: 5 }, red: { luminance: -10 } });
    s = mergeColorSettings(s, { contrast: null, hsl: { red: null } });
    expect(s.contrast).toBeUndefined();
    expect(s.hsl).toEqual({ blue: { saturation: 20, hue: 5 } });
  });

  it("describes active settings", () => {
    expect(describeColorSettings({ contrast: 15, shadows: -5, hsl: { blue: { saturation: 20 } } })).toBe("contrast +15, shadows -5, blue s+20");
    expect(describeColorSettings({})).toBe("neutral");
  });
});

describe("single-control effects", () => {
  const ctx = { width: 1920, height: 1080, fps: 30, duration: 5 };
  it("compile through the same engine", () => {
    expect(effectToFilter({ type: "highlights", params: { value: -50 } }, ctx)).toContain("curves=master=");
    expect(effectToFilter({ type: "whiteBalance", params: { temperature: 30 } }, ctx)).toContain("colorbalance=");
    expect(effectToFilter({ type: "hsl", params: { aqua: { saturation: 40 } } }, ctx)).toContain("colors=c");
    expect(effectToFilter({ type: "contrast" }, ctx)).toBe("null");
  });
});

describe("color in projects", () => {
  const base = () =>
    parseProject({
      assets: [{ type: "video", id: "v", src: "v.mp4", duration: 10, hasAudio: false }],
      clips: [
        { id: "a", assetId: "v", duration: 4 },
        { id: "b", assetId: "v", in: 4, duration: 4 },
      ],
      effects: [{ type: "letterbox" }],
    });

  it("setEffectParams updates in place and can prepend", () => {
    let p = setEffectParams(base(), "global", "color", { contrast: 10 }, { prepend: true });
    expect(p.effects.map((e) => e.type)).toEqual(["color", "letterbox"]);
    p = setEffectParams(p, "global", "color", { contrast: 20 });
    expect(p.effects).toHaveLength(2);
    expect(getEffectParams(p, "global", "color")).toEqual({ contrast: 20 });
  });

  it("color tools merge, reset, apply to all clips and summarize", async () => {
    const s = new EditorSession(base());
    await executeTool(s, "color_adjust", { settings: { contrast: 15, hsl: { blue: { saturation: 20 } } } });
    await executeTool(s, "color_adjust", { settings: { shadows: 10 } });
    let read = await executeTool(s, "get_color", {});
    expect(read.data).toEqual({ contrast: 15, shadows: 10, hsl: { blue: { saturation: 20 } } });

    await executeTool(s, "color_adjust", { reset: ["hsl"], settings: {} });
    read = await executeTool(s, "get_color", {});
    expect(read.data).toEqual({ contrast: 15, shadows: 10 });

    const all = await executeTool(s, "color_adjust", { target: "all-clips", settings: { exposure: 0.2 } });
    expect(all.isError).toBeFalsy();
    expect(s.project.clips.every((c) => c.effects.some((e) => e.type === "color"))).toBe(true);
    expect(s.project.effects[0]!.type).toBe("color"); // correction before the letterbox
    expect(summarizeProject(s.project)).toContain("color(contrast +15, shadows +10)");

    const bad = await executeTool(s, "color_adjust", { settings: { saturation: 400 } });
    expect(bad.isError).toBe(true);
  });
});
