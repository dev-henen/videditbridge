/**
 * Color space tables on disk: each footage color space's transform to Rec.709
 * (engine/library/color/transform.ts) as a .cube file, written once into the app's cache folder,
 * which both renderers read.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { TRANSFORM_VERSION, colorSpace, cubeFor } from "../../library/color/index.js";
import { appDir } from "../appdirs.js";

/** The folder of the tables (`dir` overrides it). */
export function colorTableDir(dir?: string): string {
  return dir ?? path.join(appDir("cache"), "color");
}

/** The .cube file of a color space's transform. */
export function colorTableFile(spaceId: string, dir?: string): string {
  return path.join(colorTableDir(dir), `${spaceId}-v${TRANSFORM_VERSION}.cube`);
}

/** Whether an asset is in a color space that renders convert (camera log, HDR). */
export function convertsColor(asset: { type: string; colorSpace?: string }): asset is { type: string; colorSpace: string } {
  return (asset.type === "video" || asset.type === "image") && !!asset.colorSpace && !!colorSpace(asset.colorSpace)?.curve;
}

/** Write the tables this project's assets need, once (about 3 s each). */
export async function ensureColorTables(project: Project, dir?: string): Promise<void> {
  const ids = new Set(project.assets.filter(convertsColor).map((a) => (a as { colorSpace: string }).colorSpace));
  for (const id of ids) {
    const file = colorTableFile(id, dir);
    if (existsSync(file)) continue;
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, cubeFor(colorSpace(id)!), "utf8");
    await rename(temp, file);
  }
}
