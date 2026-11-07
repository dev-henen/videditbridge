/**
 * Color space tables on disk: each footage color space's transform to Rec.709
 * (engine/library/color/transform.ts) as .cube files, written once into the app's cache folder,
 * which both renderers read. Footage graded in ACEScct (`sceneGradeFor`) uses the transform in two
 * halves, camera to ACEScct and ACEScct to Rec.709, with the grade between them: a shader on the
 * engine, a table of its own on the FFmpeg backend.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Effect, Project } from "../../core/schema.js";
import { TRANSFORM_VERSION, colorSpace, cubeFor, gradeCube, inputCubeFor, outputCube, splitSceneGrade, type SceneGrade } from "../../library/color/index.js";
import type { ColorSettings } from "../../library/effects/color.js";
import { appDir } from "../appdirs.js";

/** The folder of the tables (`dir` overrides it). */
export function colorTableDir(dir?: string): string {
  return dir ?? path.join(appDir("cache"), "color");
}

/** The .cube file of a color space's whole transform to Rec.709. */
export function colorTableFile(spaceId: string, dir?: string): string {
  return path.join(colorTableDir(dir), `${spaceId}-v${TRANSFORM_VERSION}.cube`);
}

/** The camera half (to ACEScct) of a color space's transform. */
export function inputTableFile(spaceId: string, dir?: string): string {
  return path.join(colorTableDir(dir), `${spaceId}-acescct-v${TRANSFORM_VERSION}.cube`);
}

/** The output half (ACEScct to Rec.709), the same for every color space. */
export function outputTableFile(dir?: string): string {
  return path.join(colorTableDir(dir), `acescct-rec709-v${TRANSFORM_VERSION}.cube`);
}

/** A grade as a table (the FFmpeg backend's form), named by its settings. */
export function gradeTableFile(grade: SceneGrade, dir?: string): string {
  const hash = createHash("sha256").update(JSON.stringify([TRANSFORM_VERSION, grade])).digest("hex").slice(0, 16);
  return path.join(colorTableDir(dir), "grades", `grade-${hash}.cube`);
}

/** Whether an asset is in a color space that renders convert (camera log, HDR). */
export function convertsColor(asset: { type: string; colorSpace?: string }): asset is { type: string; colorSpace: string } {
  return (asset.type === "video" || asset.type === "image") && !!asset.colorSpace && !!colorSpace(asset.colorSpace)?.curve;
}

/**
 * For footage in a color space: the primary color effect's ACEScct part (exposure, white balance,
 * contrast, saturation, wheels) and the effects left with the rest of it on the Rec.709 picture.
 * The primary color effect is the unmasked, unlabeled, unanimated `color` effect color_adjust
 * writes; secondaries and animated grades stay on the picture. No grade for other footage.
 */
export function sceneGradeFor(asset: { type: string; colorSpace?: string } | undefined, effects: Effect[]): { grade?: SceneGrade; effects: Effect[] } {
  if (!asset || !convertsColor(asset)) return { effects };
  const i = effects.findIndex((e) => e.type === "color" && !e.mask && !e.label && !e.keyframes);
  if (i < 0) return { effects };
  const { scene, rest } = splitSceneGrade((effects[i]!.params ?? {}) as ColorSettings);
  if (!scene) return { effects };
  const left = Object.keys(rest).length ? [{ ...effects[i]!, params: rest as Record<string, unknown> }] : [];
  return { grade: scene, effects: [...effects.slice(0, i), ...left, ...effects.slice(i + 1)] };
}

async function writeTable(file: string, make: () => string): Promise<void> {
  if (existsSync(file)) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, make(), "utf8");
  await rename(temp, file);
}

/** Write the tables this project needs, once (a few seconds per color space, well under one per grade). */
export async function ensureColorTables(project: Project, dir?: string): Promise<void> {
  const uses = [
    ...project.clips.map((c) => ({ asset: project.assets.find((a) => a.id === c.assetId), effects: c.effects })),
    ...project.layers.flatMap((l) => (l.type === "media" ? [{ asset: project.assets.find((a) => a.id === l.assetId), effects: l.effects }] : [])),
  ];
  for (const { asset, effects } of uses) {
    if (!asset || !convertsColor(asset)) continue;
    const space = colorSpace(asset.colorSpace)!;
    const { grade } = sceneGradeFor(asset, effects);
    if (!grade) {
      await writeTable(colorTableFile(space.id, dir), () => cubeFor(space));
      continue;
    }
    await writeTable(inputTableFile(space.id, dir), () => inputCubeFor(space));
    await writeTable(outputTableFile(dir), outputCube);
    await writeTable(gradeTableFile(grade, dir), () => gradeCube(grade));
  }
}
