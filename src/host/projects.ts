import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseProject, type Project } from "../core/schema.js";
import { createProject } from "../core/operations.js";
import type { AspectRatio } from "../core/util.js";

/**
 * On-disk project storage used by the app:
 *   <projectsDir>/<slug>/project.json   the edit
 *   <projectsDir>/<slug>/media/         imported media
 *   <projectsDir>/<slug>/out/           exports
 *   <projectsDir>/<slug>/.render/       previews, frames, voice-overs
 */

export const PROJECT_FILE = "project.json";

export interface ProjectEntry {
  name: string;
  dir: string;
  updatedAt: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 60) || "project";

export class ProjectStore {
  constructor(readonly root: string) {}

  async list(): Promise<ProjectEntry[]> {
    await mkdir(this.root, { recursive: true });
    const entries: ProjectEntry[] = [];
    for (const d of await readdir(this.root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = path.join(this.root, d.name, PROJECT_FILE);
      if (!existsSync(file)) continue;
      try {
        const raw = JSON.parse(await readFile(file, "utf8")) as { name?: string };
        entries.push({ name: raw.name ?? d.name, dir: path.join(this.root, d.name), updatedAt: (await stat(file)).mtime.toISOString() });
      } catch {
        // skip unreadable projects
      }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(name: string, aspectRatio: AspectRatio = "16:9"): Promise<{ dir: string; project: Project }> {
    await mkdir(this.root, { recursive: true });
    const base = slugify(name);
    let dir = path.join(this.root, base);
    for (let n = 2; existsSync(dir); n++) dir = path.join(this.root, `${base}-${n}`);
    await mkdir(path.join(dir, "media"), { recursive: true });
    const project = createProject({ name, aspectRatio });
    await this.save(dir, project);
    return { dir, project };
  }

  /** Accepts a project folder or a project.json path. */
  async load(target: string): Promise<{ dir: string; project: Project }> {
    const file = target.endsWith(".json") ? target : path.join(target, PROJECT_FILE);
    const project = parseProject(JSON.parse(await readFile(file, "utf8")));
    return { dir: path.dirname(path.resolve(file)), project };
  }

  /** Atomic write so a crash never leaves a half-written project. */
  async save(dir: string, project: Project): Promise<void> {
    const file = path.join(dir, PROJECT_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  }

  /** Copy files into the project's media folder. Returns paths relative to the project. */
  async importMedia(dir: string, sources: string[]): Promise<string[]> {
    const mediaDir = path.join(dir, "media");
    await mkdir(mediaDir, { recursive: true });
    const out: string[] = [];
    for (const src of sources) {
      const abs = path.resolve(src);
      if (abs.startsWith(mediaDir + path.sep)) {
        out.push(path.relative(dir, abs).split(path.sep).join("/"));
        continue;
      }
      const ext = path.extname(abs);
      const stem = path.basename(abs, ext);
      let name = `${stem}${ext}`;
      for (let n = 2; existsSync(path.join(mediaDir, name)); n++) name = `${stem}-${n}${ext}`;
      await copyFile(abs, path.join(mediaDir, name));
      out.push(`media/${name}`);
    }
    return out;
  }
}
