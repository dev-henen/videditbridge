import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { appDir } from "../tools/appdirs.js";
import { findDuplicate, listFiles } from "../tools/media/files.js";
import type { EditorSession } from "./session.js";
import type { ToolDefinition, ToolResult } from "./tools.js";

/**
 * The AI's reach beyond the project, kept small and safe:
 * - Files: it can search the user's media and document folders (the usual ones, plus folders the
 *   user adds), read text documents there, and copy media into the project. It never changes,
 *   moves or deletes anything outside the project; the only write is a copy into <project>/media.
 * - Memory: what it remembers about the user (every project) and about this project, shown to it
 *   with every request and visible and removable in the app.
 * - Plans: a proposed edit plan the user approves before anything changes.
 */

// ---------------------------------------------------------------- folders it may search

/** The user's usual media and document folders that exist on this computer. */
export function defaultSearchRoots(home = os.homedir()): string[] {
  return ["Videos", "Movies", "Pictures", "Music", "Downloads", "Desktop", "Documents"].map((d) => path.join(home, d)).filter((d) => existsSync(d));
}

/** The folders a session may search: its own list, else the usual ones. */
export const searchRoots = (s: EditorSession): string[] => (s.options.searchRoots?.length ? s.options.searchRoots : defaultSearchRoots());

const KINDS = {
  video: [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts", ".3gp", ".wmv"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".wma"],
  image: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".svg"],
  document: [".txt", ".md", ".srt", ".vtt", ".ass", ".csv", ".json", ".html", ".htm", ".rtf", ".xml", ".yaml", ".yml"],
} as const;
type Kind = keyof typeof KINDS;
const kindOf = (file: string): Kind | undefined => {
  const ext = path.extname(file).toLowerCase();
  return (Object.keys(KINDS) as Kind[]).find((k) => (KINDS[k] as readonly string[]).includes(ext));
};
const MEDIA: Kind[] = ["video", "audio", "image"];

/** Folders never worth searching (system, app and build folders, and hidden ones). */
const SKIP = new Set(["node_modules", "AppData", "Library", "$RECYCLE.BIN", "System Volume Information", "Program Files", "Windows", ".git", "__pycache__"]);

/** A real path inside one of the folders (links followed, so a shortcut cannot lead outside), or undefined. */
async function inside(file: string, roots: string[]): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(path.resolve(file));
  } catch {
    return undefined;
  }
  for (const root of roots) {
    const r = await realpath(root).catch(() => undefined);
    if (!r) continue;
    const rel = path.relative(r, real);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return real;
  }
  return undefined;
}

interface Found {
  path: string;
  kind: Kind;
  size: number;
  modified: string;
}

/** Walk the folders for files whose name has every word of the query, newest first; bounded in files and time. */
async function search(roots: string[], words: string[], kinds: Kind[], limit: number): Promise<{ found: Found[]; complete: boolean }> {
  const found: Found[] = [];
  const deadline = Date.now() + 8000;
  let seen = 0;
  let complete = true;
  const queue = [...roots];
  while (queue.length) {
    if (Date.now() > deadline || seen > 60000) {
      complete = false;
      break;
    }
    const dir = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      seen++;
      const kind = kindOf(e.name);
      if (!kind || !kinds.includes(kind)) continue;
      const name = full.toLowerCase();
      if (!words.every((w) => name.includes(w))) continue;
      const st = await stat(full).catch(() => undefined);
      if (st) found.push({ path: full, kind, size: st.size, modified: st.mtime.toISOString() });
    }
  }
  found.sort((a, b) => b.modified.localeCompare(a.modified));
  return { found: found.slice(0, limit), complete };
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// ---------------------------------------------------------------- memory

export interface MemoryItem {
  id: string;
  text: string;
  at: string;
}

/** The general memory file: the session's, else memory.json in the app's data folder. */
const generalFile = (s: EditorSession) => s.options.memoryFile ?? path.join(appDir("data"), "memory.json");
/** A project's memory, kept with it. */
const projectFile = (s: EditorSession) => path.join(s.options.baseDir, ".memory.json");

export async function readMemory(file: string): Promise<MemoryItem[]> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { items?: MemoryItem[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

export async function writeMemory(file: string, items: MemoryItem[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  await writeFile(part, JSON.stringify({ items }, null, 2), "utf8");
  await rename(part, file);
}

export const generalMemory = (s: EditorSession) => readMemory(generalFile(s));
export const projectMemory = (s: EditorSession) => readMemory(projectFile(s));

/** Remove an item by id from either memory; true when found. */
export async function forgetMemory(s: EditorSession, id: string): Promise<boolean> {
  for (const file of [generalFile(s), projectFile(s)]) {
    const items = await readMemory(file);
    const left = items.filter((m) => m.id !== id);
    if (left.length !== items.length) {
      await writeMemory(file, left);
      return true;
    }
  }
  return false;
}

/**
 * What the model is told with every request: the user's instructions, then what it remembers about
 * them and about this project. Empty when there is nothing.
 */
export async function memoryContext(s: EditorSession, instructions?: string): Promise<string> {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(`The user's standing instructions (follow them unless this request says otherwise):\n${instructions.trim()}`);
  const general = await generalMemory(s);
  if (general.length) parts.push(`What you remember about the user (from earlier projects):\n${general.map((m) => `- ${m.text} [${m.id}]`).join("\n")}`);
  const project = await projectMemory(s);
  if (project.length) parts.push(`What you remember about this project:\n${project.map((m) => `- ${m.text} [${m.id}]`).join("\n")}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- the tools

function tool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}
const ok = (text: string, data?: unknown): ToolResult => ({ text, ...(data !== undefined ? { data } : {}) });
const fail = (text: string): ToolResult => ({ text, isError: true });

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  tool({
    name: "search_files",
    description:
      "Find the user's own media and documents on this computer by name: videos, music, photos, and text documents (scripts, notes, subtitles). Searches only the folders the user allows (by default Videos, Pictures, Music, Downloads, Desktop and Documents), newest first. " +
      "Read-only: it changes nothing. Use copy_to_project to bring media into the project and read_document to read a document.",
    input: z.object({
      query: z.string().optional().describe("Words that must all be in the file's name or folder, e.g. 'beach 2024' or 'interview'. Leave out to list the newest files."),
      kind: z.enum(["video", "audio", "image", "document", "media", "any"]).default("media").describe("media: video, audio and pictures"),
      folder: z.string().optional().describe("Search only this folder (it must be inside an allowed folder)"),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    mutates: false,
    run: async (s, i) => {
      const allowed = searchRoots(s);
      if (!allowed.length) return fail("No folders are allowed for searching. The user can add some in Settings, Folders.");
      let roots = allowed;
      if (i.folder) {
        const f = await inside(i.folder, allowed);
        if (!f) return fail(`"${i.folder}" is not inside a folder the user allows: ${allowed.join(", ")}.`);
        roots = [f];
      }
      const kinds: Kind[] = i.kind === "any" ? ["video", "audio", "image", "document"] : i.kind === "media" ? MEDIA : [i.kind];
      const words = (i.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const { found, complete } = await search(roots, words, kinds, i.limit);
      if (!found.length) return ok(`Nothing found${i.query ? ` for "${i.query}"` : ""} in ${roots.join(", ")}.${complete ? "" : " (The search stopped early: try a narrower folder.)"}`, { files: [] });
      const lines = found.map((f) => `${f.path} (${f.kind}, ${mb(f.size)}, ${f.modified.slice(0, 10)})`);
      return ok(`${found.length} file${found.length === 1 ? "" : "s"}, newest first:\n${lines.join("\n")}${complete ? "" : "\n(The search stopped early; there may be more in a narrower folder.)"}`, { files: found });
    },
  }),
  tool({
    name: "read_document",
    description:
      "Read a text document the user keeps (a script, notes, a shot list, subtitles), from the folders they allow or from the project, to follow it in the edit. Text formats only (.txt, .md, .srt, .vtt, .csv, .json, .html, .rtf and similar); PDF and Word files cannot be read yet. Read-only.",
    input: z.object({
      path: z.string(),
      maxChars: z.number().int().min(200).max(60000).default(20000),
    }),
    mutates: false,
    run: async (s, i) => {
      const file = await inside(s.resolve(i.path), [...searchRoots(s), s.options.baseDir]);
      if (!file) return fail(`"${i.path}" is not in a folder the user allows, or does not exist.`);
      if (kindOf(file) !== "document") return fail(`${path.basename(file)} is not a text document this can read (${KINDS.document.join(", ")}).`);
      const text = await readFile(file, "utf8");
      const cut = text.length > i.maxChars;
      return ok(`${path.basename(file)} (${text.length} characters${cut ? `, first ${i.maxChars} shown` : ""}):\n\n${cut ? text.slice(0, i.maxChars) : text}`);
    },
  }),
  tool({
    name: "copy_to_project",
    description:
      "Copy media the user keeps on this computer (from search_files) into the project, and add it as an asset ready for add_clip, add_audio or add_media_overlay. " +
      "Only video, audio and pictures, only from the folders the user allows; the original is never changed or moved. A file already in the project is not copied again.",
    input: z.object({
      path: z.string().describe("The file, as search_files listed it"),
      id: z.string().optional().describe("Asset id to give it"),
      label: z.string().optional(),
    }),
    mutates: true,
    run: async (s, i) => {
      const file = await inside(i.path, searchRoots(s));
      if (!file) return fail(`"${i.path}" is not in a folder the user allows, or does not exist.`);
      const kind = kindOf(file);
      if (!kind || !MEDIA.includes(kind)) return fail(`${path.basename(file)} is not video, audio or a picture; only media can be copied into the project.`);
      const mediaDir = path.join(s.options.baseDir, "media");
      await mkdir(mediaDir, { recursive: true });
      let dest = await findDuplicate(file, await listFiles(mediaDir));
      if (!dest) {
        const ext = path.extname(file);
        const stem = path.basename(file, ext);
        let name = `${stem}${ext}`;
        for (let n = 2; existsSync(path.join(mediaDir, name)); n++) name = `${stem}-${n}${ext}`;
        dest = path.join(mediaDir, name);
        await copyFile(file, dest);
      }
      // Hand over to import_media for the asset (probing, ids, undo).
      const { executeTool } = await import("./tools.js");
      const imported = await executeTool(s, "import_media", { src: s.projectPath(dest), ...(i.id ? { id: i.id } : {}), ...(i.label ? { label: i.label } : {}) });
      if (imported.isError) return imported;
      return ok(`Copied ${path.basename(file)} into the project (${s.projectPath(dest)}). ${imported.text}`, imported.data);
    },
  }),
  tool({
    name: "remember",
    description:
      "Remember something for later requests: about the user in general (a style they like, their brand colors, their channel, how they want captions) or about this project (who the people are, what the video is for, decisions made). " +
      "Save lasting preferences and facts, not one-off steps. Keep each item short. The user sees and can remove what you remember.",
    input: z.object({
      text: z.string().min(3).max(400),
      scope: z.enum(["general", "project"]).describe("general: every project; project: this one"),
    }),
    mutates: false,
    run: async (s, i) => {
      const file = i.scope === "general" ? generalFile(s) : projectFile(s);
      const items = await readMemory(file);
      if (items.some((m) => m.text.toLowerCase() === i.text.trim().toLowerCase())) return ok("Already remembered.");
      const item: MemoryItem = { id: `m${randomBytes(3).toString("hex")}`, text: i.text.trim(), at: new Date().toISOString() };
      await writeMemory(file, [...items, item]);
      s.emit("memory", { scope: i.scope });
      return ok(`Remembered (${i.scope === "general" ? "for every project" : "for this project"}): ${item.text} [${item.id}]`);
    },
  }),
  tool({
    name: "forget",
    description: "Forget something you remembered, by its id (shown in brackets in what you remember), when it is wrong or the user asks.",
    input: z.object({ id: z.string() }),
    mutates: false,
    run: async (s, i) => {
      const done = await forgetMemory(s, i.id);
      if (done) s.emit("memory", { scope: "any" });
      return done ? ok(`Forgot ${i.id}.`) : fail(`Nothing remembered with id ${i.id}.`);
    },
  }),
  tool({
    name: "propose_plan",
    description:
      "Propose an edit plan for the user to approve before you change anything: for big or open requests (a full edit from raw footage, a restyle), or whenever the user asks for a plan. " +
      "Look first (get_project, render_contact_sheet, analyze_audio, search_files) so the plan is concrete. The app shows it as a card with Approve and Change it. End your turn right after calling it; the user's answer arrives as their next message.",
    input: z.object({
      title: z.string().describe("What the plan makes, e.g. '30 second vertical teaser'"),
      steps: z.array(z.string()).min(1).max(15).describe("The edits in order, each one line"),
      notes: z.string().optional().describe("Assumptions or questions, briefly"),
    }),
    mutates: false,
    run: async (s, i) => {
      s.proposePlan(i.title, i.steps, i.notes);
      return ok("The plan is shown to the user with Approve and Change it. End your turn now.");
    },
  }),
];
