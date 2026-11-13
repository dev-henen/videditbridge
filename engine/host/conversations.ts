import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withoutImages, type AgentMessage } from "./agent.js";
import { describeAgentError } from "./errors.js";

/**
 * Conversations with Claude, kept per project in <project>/.conversations/<id>.json: what the chat
 * shows (the transcript) and what Claude remembers (its messages, without pictures), so an old
 * conversation can be read and continued.
 */

export interface ChatLine {
  role: "user" | "assistant";
  text: string;
  /** Files sent with a request, as paths inside the project (media/...). */
  attachments?: string[];
  /** The request failed: what went wrong, in a sentence (the chat shows it apart from the reply). */
  error?: string;
  at: string;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  transcript: ChatLine[];
  messages: AgentMessage[];
}

export interface ConversationEntry {
  id: string;
  title: string;
  updatedAt: string;
  lines: number;
}

export const CONVERSATIONS_DIR = ".conversations";

const folder = (projectDir: string) => path.join(projectDir, CONVERSATIONS_DIR);
const fileOf = (projectDir: string, id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Not a conversation id: "${id}"`);
  return path.join(folder(projectDir), `${id}.json`);
};

/** A new, empty conversation (saved once it has a message). */
export function newConversation(model: string): Conversation {
  const now = new Date().toISOString();
  return { id: `c${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, title: "New conversation", model, createdAt: now, updatedAt: now, transcript: [], messages: [] };
}

/** A title from the first request: its first line, shortened at a word. */
export function titleFrom(text: string): string {
  const line = text.replace(/\[[^\]]*\]\s*/g, "").trim().split(/\r?\n/)[0] ?? "";
  if (line.length <= 48) return line || "New conversation";
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(24, cut.lastIndexOf(" ")))}...`;
}

export async function listConversations(projectDir: string): Promise<ConversationEntry[]> {
  const names = await readdir(folder(projectDir)).catch(() => [] as string[]);
  const out: ConversationEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const c = JSON.parse(await readFile(path.join(folder(projectDir), name), "utf8")) as Conversation;
      out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, lines: c.transcript.length });
    } catch {
      // a damaged file is skipped, not fatal
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadConversation(projectDir: string, id: string): Promise<Conversation> {
  const c = JSON.parse(await readFile(fileOf(projectDir, id), "utf8")) as Conversation;
  // Saved before errors had their own field: the provider's raw report at the end of a reply.
  for (const line of c.transcript) {
    const raw = line.role === "assistant" && !line.error ? line.text.match(/(?:^|\n\n)Error: ([\s\S]*)$/) : null;
    if (!raw) continue;
    line.error = describeAgentError(new Error(raw[1]), c.model);
    line.text = line.text.slice(0, raw.index).trim();
  }
  return c;
}

/** Write it (through a temporary file, so a crash never leaves half a conversation). */
export async function saveConversation(projectDir: string, c: Conversation): Promise<void> {
  await mkdir(folder(projectDir), { recursive: true });
  const file = fileOf(projectDir, c.id);
  const part = `${file}.${process.pid}.part`;
  await writeFile(part, JSON.stringify({ ...c, messages: withoutImages(c.messages) }), "utf8");
  await rename(part, file);
}

export async function deleteConversation(projectDir: string, id: string): Promise<void> {
  await rm(fileOf(projectDir, id), { force: true });
}
