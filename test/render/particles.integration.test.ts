import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { PARTICLE_PRESETS } from "../../engine/library/particles/index.js";
import { finishedMatteFiles, renderForAnalysis, runFfmpegOrThrow, type AnalysisFrame } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const [W, H] = [640, 360];
const HORIZON = 200;
const base = ["-y", "-hide_banner", "-loglevel", "error"];

/** Plates: a night street, a bright overcast day, a sky over dark ground, two colors side by side, and a dark room with a lamp. */
const PLATES: Record<string, string> = {
  dark: `geq=r='18+10*sin(X/9)*sin(Y/11)':g='22+10*sin(X/7+Y/13)':b='38+12*sin(X/5)'`,
  bright: `geq=r='200+20*sin(X/9)*sin(Y/11)':g='205+15*sin(X/7+Y/13)':b='210+10*sin(X/5)'`,
  sky: `geq=r='if(lt(Y,${HORIZON}),120,40+20*sin(X/3))':g='if(lt(Y,${HORIZON}),160,60+20*sin(Y/4))':b='if(lt(Y,${HORIZON}),220,35)'`,
  halves: `geq=r='if(lt(X,${W / 2}),40,230)':g='if(lt(X,${W / 2}),90,120)':b='if(lt(X,${W / 2}),210,40)'`,
  lamp: `geq=lum='if(lt(hypot(X-448,Y-72),18),250,24)':cb=128:cr=128`,
  // The sun behind dark branches: a bright disc crossed by slanted bars.
  window: `geq=lum='if(lt(hypot(X-448,Y-72),60)*gt(abs(sin((X+0.6*Y)/9)),0.45),245,22)':cb=128:cr=128`,
};

describe.skipIf(!hasFfmpeg)("particles and light", () => {
  const dir = path.join(OUT_DIR, "particles");
  const plate = (name: string) => path.join(dir, `${name}.mp4`);
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    for (const [name, geq] of Object.entries(PLATES))
      if (!existsSync(plate(name)))
        await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=30:d=2,${geq}`, "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", plate(name)]);
  });

  const session = async (name: string, plateName: string) => {
    const s = new EditorSession(undefined, { outputDir: path.join(dir, name) });
    await executeTool(s, "new_project", { aspectRatio: "16:9" });
    await executeTool(s, "set_project_settings", { width: W, height: H, fps: 30 });
    await executeTool(s, "import_media", { src: plate(plateName), id: "plate" });
    await executeTool(s, "add_clip", { assetId: "plate" });
    return s;
  };
  const frame = async (s: EditorSession, time = 1): Promise<AnalysisFrame> => (await renderForAnalysis(s.project, { ...s.renderOptions, framesAt: [time], probe: false })).frames[0]!;
  const lum = (f: AnalysisFrame, x: number, y: number) => {
    const i = (Math.round(y) * W + Math.round(x)) * 3;
    return 0.2126 * f.rgb[i]! + 0.7152 * f.rgb[i + 1]! + 0.0722 * f.rgb[i + 2]!;
  };
  /** Mean absolute difference per pixel (all channels) of two frames, over the rows and columns given. */
  const diff = (a: AnalysisFrame, b: AnalysisFrame, rows = [0, H], cols = [0, W]) => {
    let sum = 0;
    for (let y = rows[0]!; y < rows[1]!; y++) for (let x = cols[0]!; x < cols[1]!; x++) for (let c = 0; c < 3; c++) sum += Math.abs(a.rgb[(y * W + x) * 3 + c]! - b.rgb[(y * W + x) * 3 + c]!);
    return sum / ((rows[1]! - rows[0]!) * (cols[1]! - cols[0]!) * 3);
  };
  const ok = (r: { isError?: boolean; text: string }) => expect(r.isError, r.text).toBeFalsy();
  /** Keep a frame as a PNG in the output folder, for looking at. */
  const save = async (f: AnalysisFrame, name: string) => {
    const raw = path.join(dir, `${name}.rgb`);
    await writeFile(raw, f.rgb);
    await runFfmpegOrThrow([...base, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", raw, "-frames:v", "1", path.join(dir, `${name}.png`)]);
  };

  it("draws every preset on a dark and a bright plate", { timeout: 600_000 }, async () => {
    for (const plateName of ["dark", "bright"]) {
      const sheet: string[] = [];
      for (const [k, preset] of PARTICLE_PRESETS.map((p, k) => [k, p.id] as const)) {
        const s = await session(`${plateName}-${preset}`, plateName);
        const clean = await frame(s);
        ok(await executeTool(s, "add_particles", { preset: preset, start: 0, duration: 2 }));
        const f = await frame(s);
        const d = diff(f, clean);
        console.error(`${preset} on ${plateName}: mean change ${d.toFixed(2)}`);
        // Light added on a dark plate always shows; on a bright plate only what covers it (snow, confetti,
        // smoke, fog) does, as with light in a real bright scene. Snow and fog are pale, so they show least there.
        const blend = PARTICLE_PRESETS.find((p) => p.id === preset)!.blend;
        if (plateName === "dark") expect(d, `${preset} on dark`).toBeGreaterThan(0.3);
        else if (blend === "normal" && preset !== "snow" && preset !== "fog") expect(d, `${preset} on bright`).toBeGreaterThan(0.4);
        const name = `sheet-${plateName}-${String(k).padStart(2, "0")}`;
        await save(f, name);
        sheet.push(name);
      }
      // One picture of them all, five a row, for looking at.
      await runFfmpegOrThrow([...base, "-i", path.join(dir, `sheet-${plateName}-%02d.png`), "-vf", `scale=320:180,tile=5x${Math.ceil(sheet.length / 5)}`, "-frames:v", "1", path.join(dir, `sheet-${plateName}.png`)]);
    }
  });

  it("renders the same picture from the same seed, and another from another seed", { timeout: 120_000 }, async () => {
    const make = async (name: string, seed: number) => {
      const s = await session(name, "dark");
      ok(await executeTool(s, "add_particles", { preset: "snow", start: 0, duration: 1.5, seed }));
      return frame(s, 0.8);
    };
    const [a, b, c] = [await make("seed-a", 3), await make("seed-b", 3), await make("seed-c", 4)];
    expect(a.rgb.equals(b.rgb)).toBe(true);
    expect(a.rgb.equals(c.rgb)).toBe(false);
  });

  it("redraws particles with only the settings it is given changed", { timeout: 120_000 }, async () => {
    const s = await session("update", "dark");
    ok(await executeTool(s, "add_particles", { preset: "rain", start: 0, duration: 1, density: 2, wind: 0.3, seed: 9 }));
    const layer = s.project.layers[0]!;
    ok(await executeTool(s, "update_particles", { layerId: layer.id, size: 1.5, duration: 1.5 }));
    const updated = s.project.layers[0]!;
    const asset = s.project.assets.find((a) => updated.type === "media" && a.id === updated.assetId);
    expect(asset?.type === "video" && asset.particles).toMatchObject({ preset: "rain", settings: { density: 2, wind: 0.3, seed: 9, size: 1.5 } });
    expect(updated.duration).toBe(1.5);
    // The old drawing is gone with its layer's old asset.
    expect(s.project.assets.some((a) => layer.type === "media" && a.id === layer.assetId)).toBe(false);
    const bad = await executeTool(s, "add_particles", { preset: "snow", start: 0, duration: 1, mask: { kind: "face" } });
    expect(bad.isError).toBe(true);
  });

  it("keeps particles out of what the mask leaves out, with a clean edge", { timeout: 180_000 }, async () => {
    const s = await session("holdout-key", "halves");
    const clean = await frame(s);
    // Fog only on the blue half: a key on blue, with the default feather.
    ok(await executeTool(s, "add_particles", { preset: "fog", start: 0, duration: 2, density: 2, mask: { kind: "key", hue: [200, 250], saturation: [0.3, 1], softness: 0.05 } }));
    const f = await frame(s);
    const edge = W / 2;
    // The orange half, away from the feathered edge, is untouched to the code value.
    expect(diff(f, clean, [0, H], [edge + 12, W]), "fog on the orange half").toBe(0);
    expect(diff(f, clean, [0, H], [0, edge - 12]), "fog on the blue half").toBeGreaterThan(3);
    // Across the edge the fog fades out smoothly: averaged over rows, its strength never rises toward the held-out side.
    const profile = Array.from({ length: 24 }, (_, k) => diff(f, clean, [0, H], [edge - 12 + k, edge - 11 + k]));
    console.error(`fog across the edge: ${profile.map((v) => v.toFixed(1)).join(" ")}`);
    for (let k = 1; k < profile.length; k++) expect(profile[k]!, `column ${edge - 12 + k}`).toBeLessThanOrEqual(profile[k - 1]! + 0.6);
  });

  it("puts snow in the sky only, from the finished picture's sky matte", { timeout: 180_000 }, async () => {
    const s = await session("holdout-sky", "sky");
    const clean = await frame(s);
    ok(await executeTool(s, "add_particles", { preset: "snow", start: 0, duration: 2, density: 3, mask: { kind: "sky", feather: 0.005 } }));
    // The exact sky of the plate, where the renderer looks for it, so no model is needed here.
    const { skyMatte } = finishedMatteFiles(s.project, s.renderOptions.cacheDir);
    await mkdir(path.dirname(skyMatte), { recursive: true });
    await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=30:d=2,format=gray,geq=lum='255*lt(Y,${HORIZON})'`, "-c:v", "ffv1", skyMatte]);
    const f = await frame(s);
    expect(diff(f, clean, [HORIZON + 6, H]), "snow on the ground").toBe(0);
    expect(diff(f, clean, [0, HORIZON - 6]), "snow in the sky").toBeGreaterThan(1);
  });

  it("casts shafts of light from a light behind branches, fading with distance", { timeout: 120_000 }, async () => {
    const s = await session("rays", "window");
    const clean = await frame(s);
    ok(await executeTool(s, "add_light", { kind: "rays", source: { x: 0.7, y: 0.2 } }));
    const f = await frame(s);
    await save(f, "rays");
    // Brightening around arcs below and left of the sun (center 448, 72, radius 60), outside it.
    const arc = (r: number) =>
      Array.from({ length: 121 }, (_, k) => {
        const a = ((100 + k) * Math.PI) / 180;
        const [x, y] = [448 + r * Math.cos(a), 72 + r * Math.sin(a)];
        return x >= 0 && y < H ? lum(f, x, y) - lum(clean, x, y) : NaN;
      }).filter((v) => !Number.isNaN(v));
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const rings = [90, 140, 200, 280].map((r) => mean(arc(r)));
    console.error(`rays brighten by ${rings.map((v) => v.toFixed(1)).join(", ")} on average at 90, 140, 200 and 280 px`);
    expect(rings[0]!).toBeGreaterThan(6);
    for (let k = 1; k < rings.length; k++) expect(rings[k]!, `ring ${k}`).toBeLessThan(rings[k - 1]!);
    // The branches break the light into shafts: bright and dark rays alternate around the arc.
    const around = arc(120);
    console.error(`at 120 px the rays range from ${Math.min(...around).toFixed(1)} to ${Math.max(...around).toFixed(1)}`);
    expect(Math.max(...around) - Math.min(...around)).toBeGreaterThan(8);
    // No light in the far corner, beyond the rays' reach.
    expect(lum(f, 10, 350) - lum(clean, 10, 350)).toBeLessThan(2);
  });

  it("sizes a flare by the light it comes from, and refuses one on a dark spot", { timeout: 300_000 }, async () => {
    const s = await session("flare", "lamp");
    const clean = await frame(s);
    ok(await executeTool(s, "add_light", { kind: "flare", source: { x: 0.7, y: 0.2 }, start: 0, duration: 2 }));
    const f = await frame(s);
    await save(f, "flare");
    // A ghost sits on the line from the lamp through the center: at 1.15 of the way, (179, 249).
    const [gx, gy] = [448 + (320 - 448) * 1.15, 72 + (180 - 72) * 1.15];
    expect(lum(f, gx, gy) - lum(clean, gx, gy), "ghost").toBeGreaterThan(3);
    expect(lum(f, 448, 72 + 40) - lum(clean, 448, 72 + 40), "glow around the lamp").toBeGreaterThan(10);
    const dark = await session("flare-dark", "lamp");
    const r = await executeTool(dark, "add_light", { kind: "flare", source: { x: 0.15, y: 0.8 }, start: 0, duration: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not bright at the source/);
  });
});
