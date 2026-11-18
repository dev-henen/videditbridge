import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A project's history: everything that happened to it, kept for good in the project folder (one JSON
 * line per entry, appended), so the History tab shows it across restarts. Unlike the undo list it
 * has no limit and does not shrink on undo. Entries are finished activities (edits, renders, files,
 * each with its result or error) and the undo and redo the app does directly.
 */
export interface JournalEntry {
  at: string;
  kind: "tool" | "render" | "file" | "info" | "undo" | "redo";
  text: string;
  /** The result or the error, in a sentence or two. */
  detail?: string;
  status?: "done" | "error";
}

export const JOURNAL_FILE = ".history.jsonl";

/** The longest detail kept per entry: the history says what happened, not every word of it. */
const DETAIL_CHARS = 400;
/** The most entries the app is sent at once (the newest); the file keeps them all. */
export const JOURNAL_SHOWN = 5000;

const fileOf = (projectDir: string) => path.join(projectDir, JOURNAL_FILE);

/** Writes to one project's history run in order. */
const chains = new Map<string, Promise<void>>();

export function appendJournal(projectDir: string, entry: JournalEntry): Promise<void> {
  const line = JSON.stringify({ ...entry, ...(entry.detail ? { detail: cut(entry.detail) } : {}) }) + "\n";
  const next = (chains.get(projectDir) ?? Promise.resolve()).then(() => appendFile(fileOf(projectDir), line, "utf8")).catch(() => undefined);
  chains.set(projectDir, next);
  return next;
}

/** The project's history, newest first (at most `limit` entries). Lines that do not read are skipped. */
export async function readJournal(projectDir: string, limit = JOURNAL_SHOWN): Promise<JournalEntry[]> {
  await chains.get(projectDir);
  let text: string;
  try {
    text = await readFile(fileOf(projectDir), "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line) as JournalEntry;
      if (typeof e.at === "string" && typeof e.text === "string") out.push(e);
    } catch {
      // a line cut short by a crash: skip it
    }
  }
  return out;
}

function cut(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > DETAIL_CHARS ? `${one.slice(0, DETAIL_CHARS - 3)}...` : one;
}
