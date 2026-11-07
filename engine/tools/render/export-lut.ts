/**
 * Export a clip's grade as a .cube 3D table (docs/design/cinematic-grade-and-vfx.md, section 4.5),
 * for DaVinci Resolve, Premiere or a camera monitor: the color space's transform (camera to ACES and
 * out to Rec.709), the grade in ACEScct, and every effect that works pixel by pixel (the rest of the
 * color panel, a look's grade and print-film curve, LUT files). Spatial effects (secondaries, grain,
 * glows, vignette, sharpening) cannot be a table and are left out, and named.
 *
 * The table is made by running a lattice of colors through the clip's own filters in FFmpeg, on
 * 32-bit float RGB, so it is the renderers' math, not a copy of it. Its input is what the other
 * application gives it: for footage in a color space, the camera's R'G'B' code values (full range,
 * as recorded); otherwise the Rec.709 picture.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Effect, Project } from "../../core/schema.js";
import { codeToPipeline, colorSpace, type Vec3 } from "../../library/color/index.js";
import { getEffect, resolveEffectParams } from "../../library/effects/index.js";
import { colorConversion } from "./compile.js";
import { convertsColor, ensureColorTables, sceneGradeFor } from "./color-space.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";
import { PIXEL_FILTERS, filterName, splitChain } from "./plan-effects.js";
import { probeAssets } from "./render.js";

/** The color panel's controls that act on neighboring pixels, which a table cannot hold. */
const SPATIAL_COLOR = ["clarity", "sharpen", "vignette", "grain"];

export interface ExportLutResult {
  output: string;
  size: number;
  /** What the table holds, and what it leaves out (spatial effects). */
  included: string[];
  skipped: string[];
  /** What the table expects as input. */
  input: string;
}

/** The pixel-by-pixel filters of a clip's effects (after its grade's split), and what is left out. */
function pixelFilters(effects: Effect[], width: number, height: number): { filters: string[]; included: string[]; skipped: string[] } {
  const [filters, included, skipped] = [[] as string[], [] as string[], [] as string[]];
  const name = (e: Effect) => (e.label ? `${e.type} "${e.label}"` : e.type);
  for (const e of effects) {
    const def = getEffect(e.type);
    if (!def || e.mask || e.keyframes) {
      skipped.push(`${name(e)}${e.mask ? " (masked: a secondary)" : e.keyframes ? " (animated)" : ""}`);
      continue;
    }
    let params = resolveEffectParams(e);
    if (e.type === "color") {
      const spatial = SPATIAL_COLOR.filter((k) => params[k] !== undefined && params[k] !== 0);
      if (spatial.length) skipped.push(`color: ${spatial.join(", ")}`);
      params = Object.fromEntries(Object.entries(params).filter(([k]) => !SPATIAL_COLOR.includes(k)));
    }
    const chain = splitChain(def.toFilter(params, { width, height, fps: 30, duration: 1, noBake: true }));
    if (!chain || !chain.every((f) => PIXEL_FILTERS.has(filterName(f)))) {
      skipped.push(name(e));
      continue;
    }
    // Nothing left that changes color (a color panel with only spatial controls): not part of it.
    if (!chain.some((f) => !["null", "format"].includes(filterName(f)))) continue;
    filters.push(...chain);
    included.push(name(e));
  }
  return { filters, included, skipped };
}

/** Write clip `clipId`'s grade as a `size`-point .cube at `output`. */
export async function exportLut(project: Project, clipId: string, opts: FfmpegOptions & { output: string; size?: 33 | 65; baseDir?: string }): Promise<ExportLutResult> {
  const size = opts.size ?? 33;
  const p = await probeAssets(project, opts);
  await ensureColorTables(p);
  const clip = p.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`Unknown clip "${clipId}"`);
  const asset = p.assets.find((a) => a.id === clip.assetId);
  if (!asset || (asset.type !== "video" && asset.type !== "image")) throw new Error(`Clip "${clipId}" shows no video or picture`);
  const graded = sceneGradeFor(asset, clip.effects);
  const space = convertsColor(asset) ? colorSpace(asset.colorSpace)! : undefined;
  const pixels = pixelFilters(graded.effects, p.settings.width, p.settings.height);
  const included = [...(space ? [`${space.label} to Rec.709 (ACES)`] : []), ...(graded.grade ? ["the grade in ACEScct"] : []), ...pixels.included];
  const filters = [...colorConversion(asset, false, graded.grade), ...pixels.filters];

  // The lattice as one float RGB picture: red across, blue in blocks of `size` across, green down.
  const [w, h] = [size * size, size];
  const plane = (c: number) => {
    const out = Buffer.alloc(w * h * 4);
    for (let g = 0; g < size; g++)
      for (let b = 0; b < size; b++)
        for (let r = 0; r < size; r++) {
          const code: Vec3 = [r / (size - 1), g / (size - 1), b / (size - 1)];
          const rgb = space ? codeToPipeline(space, code) : code;
          out.writeFloatLE(rgb[c]!, (g * w + b * size + r) * 4);
        }
    return out;
  };
  const dir = await mkdtemp(path.join(tmpdir(), "ave-lut-"));
  try {
    const [input, result] = [path.join(dir, "lattice.raw"), path.join(dir, "graded.raw")];
    // gbrpf32le stores green, blue, red planes.
    await writeFile(input, Buffer.concat([plane(1), plane(2), plane(0)]));
    await runFfmpegOrThrow(
      ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "-s", `${w}x${h}`, "-i", input, "-vf", [...(filters.length ? filters : ["null"]), "format=gbrpf32le"].join(","), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrpf32le", result],
      opts,
    );
    const out = await readFile(result);
    const at = (c: number, i: number) => out.readFloatLE((c * w * h + i) * 4);
    const lines = [`TITLE "${clipId} grade"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
    for (let b = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++) {
          const i = g * w + b * size + r;
          lines.push([at(2, i), at(0, i), at(1, i)].map((v) => Math.min(Math.max(v, 0), 1).toFixed(6)).join(" "));
        }
    const output = path.resolve(opts.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${lines.join("\n")}\n`, "utf8");
    return {
      output,
      size,
      included,
      skipped: pixels.skipped,
      input: space ? `${space.label} code values (full range, as recorded), output Rec.709` : "Rec.709 video, output Rec.709",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
