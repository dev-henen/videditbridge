import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseProject, type Project } from "../core/schema.js";
import { createProject } from "../core/operations.js";
import type { AspectRatio } from "../core/util.js";
import { findDuplicate, listFiles } from "../tools/media/files.js";

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

let tmpSeq = 0;

/** Write, flush to disk, keep the old file as .bak, then swap the new file in. */
async function writeDurably(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  const h = await open(tmp, "w");
  try {
    await h.writeFile(text, "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    if (existsSync(file)) await copyFile(file, `${file}.bak`);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

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

  /**
   * Accepts a project folder or a project.json path. If the file is missing or unreadable, the
   * previous save (project.json.bak) is used, so a damaged file never loses the project.
   */
  async load(target: string): Promise<{ dir: string; project: Project; recovered?: boolean }> {
    const file = target.endsWith(".json") ? target : path.join(target, PROJECT_FILE);
    const dir = path.dirname(path.resolve(file));
    try {
      return { dir, project: parseProject(JSON.parse(await readFile(file, "utf8"))) };
    } catch (e) {
      const bak = `${file}.bak`;
      if (!existsSync(bak)) throw e;
      return { dir, project: parseProject(JSON.parse(await readFile(bak, "utf8"))), recovered: true };
    }
  }

  private saving = new Map<string, Promise<void>>();

  /**
   * Crash-safe write: the new file is written and flushed to disk under a unique temporary name,
   * the current file is kept as project.json.bak, and then the new one takes its place. Saves to
   * one folder run one at a time, in order.
   */
  save(dir: string, project: Project): Promise<void> {
    const text = `${JSON.stringify(project, null, 2)}\n`;
    const prev = this.saving.get(dir) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => writeDurably(path.join(dir, PROJECT_FILE), text));
    this.saving.set(dir, next);
    next.then(
      () => this.saving.get(dir) === next && this.saving.delete(dir),
      () => this.saving.get(dir) === next && this.saving.delete(dir),
    );
    return next;
  }

  /** Wait for every pending save. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.saving.values()]);
  }

  /**
   * Copy files into the project's media folder. A file whose content is already there is not
   * copied again; its existing copy is used. Returns paths relative to the project.
   */
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
      const same = await findDuplicate(abs, await listFiles(mediaDir));
      if (same) {
        out.push(`media/${path.basename(same)}`);
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
