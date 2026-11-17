import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../../engine/host/projects.js";

describe("deleting a project", () => {
  let root: string;
  let store: ProjectStore;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ave-projects-"));
    store = new ProjectStore(path.join(root, "projects"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("removes the project's folder with everything in it, and it leaves the list", async () => {
    const { dir } = await store.create("Beach day");
    await mkdir(path.join(dir, "media"), { recursive: true });
    await writeFile(path.join(dir, "media", "clip.mp4"), "x");
    const other = await store.create("Other");
    await store.remove(dir);
    expect(existsSync(dir)).toBe(false);
    expect((await store.list()).map((p) => p.dir)).toEqual([other.dir]);
  });

  it("refuses anything that is not a project directly inside the projects folder", async () => {
    // The projects folder itself, a folder outside it, a folder inside a project, a folder without a project.
    const { dir } = await store.create("Kept");
    const outside = path.join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "project.json"), "{}");
    const nested = path.join(dir, "media");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "project.json"), "{}");
    const empty = path.join(store.root, "not-a-project");
    await mkdir(empty);
    await expect(store.remove(store.root)).rejects.toThrow(/Only projects in the projects folder/);
    await expect(store.remove(outside)).rejects.toThrow(/Only projects in the projects folder/);
    await expect(store.remove(nested)).rejects.toThrow(/Only projects in the projects folder/);
    await expect(store.remove(empty)).rejects.toThrow(/no project/);
    for (const d of [dir, outside, nested, empty]) expect(existsSync(d)).toBe(true);
  });
});
