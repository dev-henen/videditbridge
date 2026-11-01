import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { deltaE2000, rgbToLab, type Vec3 } from "../../engine/library/effects/index.js";
import { renderFrame } from "../../engine/tools/index.js";
import { readPixels } from "../../engine/tools/render/color-transfer.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();

describe.skipIf(!hasFfmpeg)("grade_scene", () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  });

  it("matches a regraded shot back to its hero shot through the renderer", async () => {
    const dir = path.join(OUT_DIR, "grade-scene");
    const s = new EditorSession(undefined, { outputDir: dir });
    const call = async (name: string, input: unknown) => {
      const r = await executeTool(s, name, input);
      expect(r.isError, r.text).toBeFalsy();
      return r.text;
    };
    await call("new_project", { aspectRatio: "16:9" });
    await call("import_media", { src: fx.talk, id: "talk" });
    // The same footage twice: the second shot darkened, warmed and desaturated, as if from another camera.
    await call("add_clip", { assetId: "talk", in: 0, duration: 2 });
    await call("add_clip", { assetId: "talk", in: 0, duration: 2 });
    const [hero, shot] = s.project.clips.map((c) => c.id) as [string, string];
    await call("color_adjust", { target: shot, settings: { exposure: -0.5, temperature: 35, saturation: -30 } });

    const frame = async (name: string, time: number) => {
      const file = path.join(dir, `${name}.png`);
      await renderFrame(s.project, time, { output: file, scale: 0.5, ...s.renderOptions });
      return (await readPixels(file, 160)).colors;
    };
    // Pixel by pixel: the shot at 1 s against the hero at 1 s shows the same picture.
    const meanDeltaE = (a: Vec3[], b: Vec3[]) => a.reduce((n, c, k) => n + deltaE2000(rgbToLab(c), rgbToLab(b[k]!)), 0) / a.length;
    const target = await frame("hero", 1);
    const before = meanDeltaE(await frame("before", 3), target);

    const report = await call("grade_scene", { scenes: [{ reference: hero, clips: [shot] }], strength: 1 });
    expect(report).toMatch(new RegExp(`${shot} to ${hero}: (transfer|reinhard|curves), ΔE [\\d.]+ to [\\d.]+`));
    expect(s.project.clips[1]!.effects.at(-1)!.type).toBe("colorMatch");
    const after = meanDeltaE(await frame("after", 3), target);
    expect(before).toBeGreaterThan(6);
    // Same pixels as the hero again, within the design target of 2 (measured 21.6 to 1.4).
    expect(after).toBeLessThan(2);

    // Running it again replaces the match instead of stacking a second one.
    await call("match_color", { clipIds: [shot], referenceClipId: hero, strength: 1 });
    expect(s.project.clips[1]!.effects.filter((e) => e.type === "colorMatch")).toHaveLength(1);
  });
});
