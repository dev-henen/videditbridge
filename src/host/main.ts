#!/usr/bin/env node
/**
 * Engine host for the desktop app: runs the editing library and speaks JSON-RPC over stdio.
 *
 *   node dist/host/main.js --projects-dir <dir>
 *
 * Requests: host.info, project.list, project.create, project.open, project.importMedia, state.get,
 *           tools.list, tools.execute, session.undo, session.redo, render.scrub, agent.run, agent.cancel
 * Notifications: state, activity, agent.text, agent.end, log
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EditorSession } from "../claude/session.js";
import { TOOLS, executeTool } from "../claude/tools.js";
import { previewState } from "../tools/preview/server.js";
import { renderFrame } from "../tools/render/render.js";
import { OpenAITranscriber } from "../tools/transcript/providers.js";
import { OpenAITTS } from "../tools/voiceover/providers.js";
import type { AspectRatio } from "../core/util.js";
import { EditorAgent } from "./agent.js";
import { ProjectStore } from "./projects.js";
import { RpcError, StdioRpc, serveLocal, type Handler } from "./rpc.js";
import { HOST_INFO_FILE } from "./remote.js";

// stdout is the protocol channel: route stray console output to stderr.
console.log = console.error;
console.info = console.error;

const { values } = parseArgs({ options: { "projects-dir": { type: "string" } }, allowPositionals: true });
const store = new ProjectStore(path.resolve(values["projects-dir"] ?? process.env.AVE_PROJECTS_DIR ?? "projects"));

let session: EditorSession | undefined;
let projectDir: string | undefined;
let agent: EditorAgent | undefined;
let detach: (() => void) | undefined;

const handlers: Record<string, Handler> = {
  "host.info": () => ({
    version: "0.1.0",
    projectsDir: store.root,
    claudeAvailable: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE),
    // Transcription always works: OpenAI when a key is set, otherwise the built-in local Whisper.
    transcriptionAvailable: true,
  }),
  "project.list": () => store.list(),
  "project.create": async (p) => {
    const { dir, project } = await store.create(String(p.name ?? "Untitled"), (p.aspectRatio as AspectRatio) ?? "16:9");
    return attach(new EditorSession(project, sessionOptions(dir)), dir);
  },
  "project.open": async (p) => {
    const { dir, project } = await store.load(String(p.path));
    return attach(new EditorSession(project, sessionOptions(dir)), dir);
  },
  "project.importMedia": async (p) => {
    const s = requireSession();
    const files = await store.importMedia(projectDir!, (p.paths as string[]) ?? []);
    const results = [];
    for (const src of files) results.push(await executeTool(s, "import_media", { src }));
    return results;
  },
  "state.get": () => snapshot(),
  "tools.list": () => TOOLS.map((t) => ({ name: t.name, description: t.description, mutates: t.mutates })),
  "tools.execute": (p) => executeTool(requireSession(), String(p.name), p.input ?? {}),
  "session.undo": () => requireSession().undo() ?? null,
  "session.redo": () => requireSession().redo() ?? null,
  "render.scrub": (p) => scrub(Number(p.time ?? 0)),
  "agent.run": async (p) => {
    const s = requireSession();
    agent ??= new EditorAgent(s);
    const result = await agent.run(String(p.prompt ?? ""), { onText: (delta) => rpc.notify("agent.text", { delta }) });
    rpc.notify("agent.end", result);
    return result;
  },
  "agent.cancel": () => {
    agent?.cancel();
    return true;
  },
};
const rpc = new StdioRpc(handlers);

function sessionOptions(dir: string) {
  return {
    baseDir: dir,
    outputDir: path.join(dir, ".render"),
    transcriber: process.env.OPENAI_API_KEY ? new OpenAITranscriber() : undefined,
    tts: process.env.OPENAI_API_KEY ? new OpenAITTS() : undefined,
  };
}

function requireSession(): EditorSession {
  if (!session) throw new RpcError(1, "No project is open");
  return session;
}

function snapshot() {
  if (!session || !projectDir) return null;
  // The app reads files directly, so media "URLs" are absolute paths.
  return { ...previewState(session, { mediaUrl: (p) => p }), projectDir, agentRunning: !!agent?.running };
}

/** Make `s` the active session: autosave edits and stream state to the app. */
function attach(s: EditorSession, dir: string) {
  detach?.();
  agent?.cancel();
  session = s;
  projectDir = dir;
  agent = undefined;

  let stateTimer: NodeJS.Timeout | undefined;
  const pushState = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => rpc.notify("state", snapshot()), 80);
  };
  let saveTimer: NodeJS.Timeout | undefined;
  const onChange = () => {
    pushState();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.save(dir, s.project).catch((e) => rpc.notify("log", { level: "error", message: `Autosave failed: ${(e as Error).message}` }));
    }, 300);
  };
  const onActivity = (a: unknown) => {
    rpc.notify("activity", a);
    pushState();
  };
  const onLog = (entry: unknown) => {
    rpc.notify("log", entry);
    pushState();
  };
  s.on("change", onChange);
  s.on("render", pushState);
  s.on("activity", onActivity);
  s.on("log", onLog);
  s.startActivity("file", `Opened "${s.project.name}"`).done();
  detach = () => {
    s.off("change", onChange);
    s.off("render", pushState);
    s.off("activity", onActivity);
    s.off("log", onLog);
    clearTimeout(stateTimer);
  };
  return snapshot();
}

// Frame scrubbing: quiet (no activity/history), cached per revision, and only the latest request renders.
const scrubCache = new Map<string, string>();
let scrubToken = 0;
let scrubChain: Promise<unknown> = Promise.resolve();
async function scrub(time: number): Promise<{ path: string | null; time: number }> {
  const s = requireSession();
  const key = `${s.revision}:${time.toFixed(2)}`;
  const cached = scrubCache.get(key);
  if (cached) return { path: cached, time };
  const token = ++scrubToken;
  const job = scrubChain.then(async () => {
    if (token !== scrubToken) return null; // superseded by a newer scrub
    const dir = path.join(s.options.outputDir, "scrub");
    await mkdir(dir, { recursive: true });
    const out = path.join(dir, `r${s.revision}-${time.toFixed(2)}.png`);
    await renderFrame(s.project, time, { output: out, scale: 0.5, baseDir: s.options.baseDir });
    if (scrubCache.size > 300) scrubCache.clear();
    scrubCache.set(key, out);
    return out;
  });
  scrubChain = job.catch(() => undefined);
  return { path: await job, time };
}

// Remote control: other local processes (scripts, Claude Code, a future MCP connector) can drive
// this same session through a token-protected socket advertised in <projectsDir>/.host.json.
const token = randomBytes(24).toString("hex");
const remote = await serveLocal(handlers, token);
const infoFile = path.join(store.root, HOST_INFO_FILE);
await mkdir(store.root, { recursive: true });
await writeFile(infoFile, JSON.stringify({ port: remote.port, token, pid: process.pid }), "utf8");
process.on("exit", () => rmSync(infoFile, { force: true }));

await rpc.start();
remote.server.close();
process.exit(0);
