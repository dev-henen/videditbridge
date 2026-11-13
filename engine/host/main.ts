#!/usr/bin/env node
/**
 * Engine host for the desktop app: runs the editing library and speaks JSON-RPC over stdio.
 *
 *   node dist/host/main.js --projects-dir <dir>
 *
 * Several projects can be open at once (one per tab in the app), each with its own session, Claude
 * conversation and renders. Requests name their project with `project` (its folder); without it they
 * go to the focused project (the app's current tab), which keeps scripts and remote control simple.
 *
 * Requests: host.info, project.list, project.create, project.open, project.close, project.focus,
 *           project.importMedia, state.get, tools.list, tools.execute, session.undo, session.redo,
 *           render.scrub, render.play, render.stop, render.matte, render.scopes, settings.get, settings.set, choices.dismiss, chat.list, chat.current, chat.open, chat.new, chat.rename, chat.delete,
 *           agent.run, agent.cancel, performance.get, performance.run
 * Notifications (each with `project`): state, activity, agent.text, agent.end, log, project.cover, and
 * project.opened / project.closed when remote control opens or closes a project, so the app shows it.
 * Without `project`: performance.progress ({ stage, step, stageProgress, progress, adapter }) while the performance test runs.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { EditorSession } from "../claude/session.js";
import { TOOLS, executeTool } from "../claude/tools.js";
import { sessionState } from "../claude/state.js";
import { clipAtTime, computeTimeline } from "../core/timeline.js";
import { MaskSchema } from "../core/schema.js";
import { renderScopes } from "../tools/render/color-analysis.js";
import { closeFrameSessions, frameBackend, framePlayer, renderFrame, renderFrameShared, renderSoundMix } from "../tools/render/render.js";
import { applyPerformance, benchmarkBackends, loadPerformance, savePerformance, type PerformanceReport } from "../tools/render/benchmark.js";
import { checkFfmpeg, describeFfmpegCheck } from "../tools/render/selftest.js";
import { LocalWhisperTranscriber } from "../tools/transcript/local.js";
import { LocalTTS, RECOMMENDED_VOICES, VOICES } from "../tools/voiceover/local.js";
import type { Project } from "../core/schema.js";
import type { AspectRatio } from "../core/util.js";
import { EditorAgent } from "./agent.js";
import { AGENT_MODELS, DEFAULT_MODEL, PROVIDERS, assistantOf, isProviderId } from "./models.js";
import { deleteConversation, listConversations, loadConversation, newConversation, saveConversation, titleFrom, type Conversation } from "./conversations.js";
import { COVER_FILE, ProjectStore } from "./projects.js";
import { RpcError, StdioRpc, serveLocal, type Handler } from "./rpc.js";
import { HOST_INFO_FILE } from "./remote.js";
import { applySettings, availableProviders, loadSettings, publicSettings, saveSettings, storeKey } from "./settings.js";
import { CLIENT_IDS, MCP_NAME, clientInfo, commandLine, isClientId, mcpLaunch, setClientConnected } from "./connect.js";
import { DEFAULT_MCP_PORT, mcpToken, startMcpHttp, type McpHttpServer } from "../mcp/http.js";
import { AppBackend, appLaunchFile } from "../mcp/server.js";
import { startTunnel, type Tunnel } from "../mcp/tunnel.js";
import { appDir, defaultFontsDir, defaultModelsDir } from "../tools/appdirs.js";

// stdout is the protocol channel: route stray console output to stderr.
console.log = console.error;
console.info = console.error;

const { values } = parseArgs({ options: { "projects-dir": { type: "string" } }, allowPositionals: true });
const store = new ProjectStore(path.resolve(values["projects-dir"] ?? process.env.AVE_PROJECTS_DIR ?? "projects"));

/** An open project: its session, Claude's current conversation, and its scrubbing and cover state. */
interface OpenProject {
  dir: string;
  session: EditorSession;
  conversation: Conversation;
  agent?: EditorAgent;
  detach: () => void;
  scrub: { cache: Map<string, string>; token: number; chain: Promise<unknown> };
  coverTimer?: NodeJS.Timeout;
  /** The edit as it was when the latest request to Claude started: the "before" of the viewer's A/B. */
  before?: { project: Project; revision: number };
  /** The MCP app editing this project when it cannot show previews itself (Gemini CLI, say): the tab shows the edit, without its chat. */
  mcpClient?: string;
  /** Live playback in progress (`render.play`). */
  playback?: { stopped: boolean };
  /** The sound mix of a revision, for live playback. */
  mix?: { revision: number; file: Promise<string | null> };
}

const open = new Map<string, OpenProject>();
/** The project requests without `project` go to: the app's current tab. */
let focused: string | undefined;

const keyOf = (dir: string) => path.resolve(dir);
const MODELS: readonly string[] = AGENT_MODELS.map((m) => m.id);

function target(p: Record<string, unknown>): OpenProject {
  const dir = p.project !== undefined ? keyOf(String(p.project)) : focused;
  const o = dir ? open.get(dir) : undefined;
  if (!o) throw new RpcError(1, p.project !== undefined ? `Project "${String(p.project)}" is not open` : "No project is open");
  return o;
}

const conversationInfo = (o: OpenProject) => ({ id: o.conversation.id, title: o.conversation.title, model: o.conversation.model, transcript: o.conversation.transcript });

/** Who is working in a project's conversation ("Claude", "ChatGPT", "Gemini"), for messages. */
const assistant = (o: OpenProject) => assistantOf(o.conversation.model);

/**
 * Which AI providers have a key, and the models with whether each can be used now. `claudeAvailable`
 * (Claude, the default) is kept for older apps; `aiAvailable` is whether any provider can edit.
 */
function availability() {
  const available = availableProviders();
  return {
    claudeAvailable: available.anthropic,
    aiAvailable: Object.values(available).some(Boolean),
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, assistant: p.assistant, keyUrl: p.keyUrl, keyHint: p.keyHint, available: available[p.id] })),
    models: AGENT_MODELS.map((m) => ({ ...m, assistant: assistantOf(m.id), available: available[m.provider] })),
  };
}

const handlers: Record<string, Handler> = {
  "host.info": () => ({
    version: "0.2.0",
    projectsDir: store.root,
    ...availability(),
    defaultModel: settings.defaultModel && MODELS.includes(settings.defaultModel) ? settings.defaultModel : DEFAULT_MODEL,
    // Transcription and narration run on this machine; no service or key is involved.
    transcriptionAvailable: true,
    voiceAvailable: true,
  }),
  "project.list": () => store.list(),
  // Narration voices for the app: the full list with grades, and which ones are recommended.
  "voices.list": () => ({ voices: VOICES, recommended: RECOMMENDED_VOICES }),
  "project.create": async (p) => {
    const { dir, project } = await store.create(String(p.name ?? "Untitled"), (p.aspectRatio as AspectRatio) ?? "16:9");
    return snapshot(await attach(new EditorSession(project, sessionOptions(dir)), dir));
  },
  "project.open": async (p) => {
    const dir = keyOf(String(p.path).endsWith(".json") ? path.dirname(String(p.path)) : String(p.path));
    const already = open.get(dir);
    if (already) {
      focused = dir;
      return snapshot(already);
    }
    const loaded = await store.load(dir);
    const o = await attach(new EditorSession(loaded.project, sessionOptions(loaded.dir)), loaded.dir);
    if (loaded.recovered) o.session.error("project.json was damaged; opened the previous save instead.");
    return snapshot(o);
  },
  "project.close": async (p) => {
    const o = target(p);
    stopPlayback(o);
    close(o);
    // Leave with a cover showing the edit as it is now.
    await writeCover(o).catch(() => undefined);
    // Its preview sessions hold its media open.
    await closeFrameSessions();
    return true;
  },
  "project.focus": (p) => {
    focused = target(p).dir;
    return true;
  },
  "project.importMedia": async (p) => {
    const o = target(p);
    const files = await store.importMedia(o.dir, (p.paths as string[]) ?? []);
    const results = [];
    for (const src of files) results.push(await executeTool(o.session, "import_media", { src }));
    return results;
  },
  "state.get": (p) => snapshot(target(p)),
  "tools.list": () => TOOLS.map((t) => ({ name: t.name, description: t.description, mutates: t.mutates })),
  "tools.execute": (p) => executeTool(target(p).session, String(p.name), p.input ?? {}),
  "session.undo": (p) => target(p).session.undo() ?? null,
  "session.redo": (p) => target(p).session.redo() ?? null,
  "render.scrub": (p) => scrub(target(p), Number(p.time ?? 0), p.before === true),
  "render.play": (p) => play(target(p), Number(p.time ?? 0)),
  "render.matte": (p) => matte(target(p), Number(p.time ?? 0), typeof p.target === "string" ? p.target : undefined, p.object === true),
  "render.scopes": (p) => scopes(target(p), Number(p.time ?? 0)),
  "render.stop": (p) => {
    stopPlayback(target(p));
    return true;
  },
  /** The user wants the chat in a tab an MCP app is editing ("Use the chat here"). */
  "mcp.release": (p) => {
    const o = target(p);
    o.mcpClient = undefined;
    pushState(o);
    return true;
  },
  "choices.dismiss": (p) => {
    target(p).session.clearChoices();
    return null;
  },

  // Conversations with Claude: the list, and the current one of each project.
  "chat.list": async (p) => {
    const o = target(p);
    return { current: o.conversation.id, conversations: await listConversations(o.dir) };
  },
  /** The conversation the project continues (the latest when it opened; maybe new and not saved yet). */
  "chat.current": (p) => conversationInfo(target(p)),
  "chat.open": async (p) => {
    const o = target(p);
    if (o.agent?.running) throw new RpcError(1, `${assistant(o)} is still working; stop it or wait before switching conversations`);
    o.conversation = await loadConversation(o.dir, String(p.id));
    o.agent = undefined;
    return conversationInfo(o);
  },
  "chat.new": (p) => {
    const o = target(p);
    if (o.agent?.running) throw new RpcError(1, `${assistant(o)} is still working; stop it or wait before starting a new conversation`);
    o.conversation = newConversation(MODELS.includes(String(p.model)) ? String(p.model) : o.conversation.model);
    o.agent = undefined;
    return conversationInfo(o);
  },
  "chat.rename": async (p) => {
    const o = target(p);
    const title = String(p.title ?? "").trim().slice(0, 80);
    if (!title) throw new RpcError(1, "A conversation needs a title");
    const c = p.id === undefined || p.id === o.conversation.id ? o.conversation : await loadConversation(o.dir, String(p.id));
    c.title = title;
    if (c.transcript.length) await saveConversation(o.dir, c);
    return true;
  },
  "chat.delete": async (p) => {
    const o = target(p);
    const id = String(p.id);
    if (id === o.conversation.id) {
      if (o.agent?.running) throw new RpcError(1, `${assistant(o)} is still working in this conversation`);
      o.conversation = newConversation(o.conversation.model);
      o.agent = undefined;
    }
    await deleteConversation(o.dir, id);
    return conversationInfo(o);
  },

  /**
   * Ask Claude. `prompt` is what Claude reads (with notes about what is picked), `display` what the
   * chat shows. `attachments` are files to bring into the project first; pictures among them are
   * also shown to Claude. `model` picks the model for this and later requests of the conversation.
   */
  "agent.run": async (p) => {
    const o = target(p);
    const s = o.session;
    // The viewer's A/B compares with the edit as it is now, before this request.
    o.before = { project: s.project, revision: s.revision };
    // A new request answers (or moves past) any options still on screen.
    s.clearChoices();
    const c = o.conversation;
    if (MODELS.includes(String(p.model))) c.model = String(p.model);
    const display = String(p.display ?? p.prompt ?? "").trim();
    let note = "";
    let attached: string[] = [];
    const sources = ((p.attachments as string[] | undefined) ?? []).filter(Boolean);
    if (sources.length) {
      attached = await store.importMedia(o.dir, sources);
      const lines: string[] = [];
      for (const src of attached) lines.push((await executeTool(s, "import_media", { src })).text.split("\n")[0]!);
      note = `[The user attached ${attached.length === 1 ? "a file" : `${attached.length} files`}, now in the project: ${lines.join(" ")}] `;
    }
    const images = attached.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).map((f) => path.join(o.dir, f));
    c.transcript.push({ role: "user", text: display, ...(attached.length ? { attachments: attached } : {}), at: new Date().toISOString() });
    if (c.title === "New conversation") c.title = titleFrom(display);
    pushState(o);
    let reply = "";
    let result: { stopReason: string } = { stopReason: "error" };
    let agent: EditorAgent | undefined;
    try {
      agent = o.agent ??= new EditorAgent(s, { model: c.model, messages: c.messages });
      result = await agent.run(
        `${note}${String(p.prompt ?? display)}`,
        {
          onText: (delta) => {
            reply += delta;
            rpc.notify("agent.text", { project: o.dir, delta });
          },
        },
        { model: c.model, images },
      );
      return result;
    } catch (e) {
      reply += `${reply ? "\n\n" : ""}Error: ${(e as Error).message}`;
      throw e;
    } finally {
      const end = result.stopReason === "cancelled" ? "(stopped)" : result.stopReason === "refusal" ? `(${assistantOf(c.model)} declined this request)` : "";
      c.transcript.push({ role: "assistant", text: [reply.trim(), end].filter(Boolean).join("\n"), at: new Date().toISOString() });
      if (agent) c.messages = [...agent.history];
      c.updatedAt = new Date().toISOString();
      await saveConversation(o.dir, c).catch((e) => rpc.notify("log", { project: o.dir, level: "error", message: `Could not save the conversation: ${(e as Error).message}` }));
      rpc.notify("agent.end", { project: o.dir, ...result });
      pushState(o);
    }
  },
  "agent.cancel": (p) => {
    target(p).agent?.cancel();
    return true;
  },

  // The performance test the app runs on first start: which renderer (processor or graphics card)
  // becomes the default for this machine. null until it has run.
  /** The Settings tab: what is set (the API key hidden), and the folders the app uses. */
  "settings.get": async () => ({ ...publicSettings(settings), projectsDir: store.root, cacheDir: appDir("cache"), dataDir: appDir("data"), modelsDir: defaultModelsDir(), fontsDir: defaultFontsDir(), performance: (await loadPerformance()) ?? null }),
  /**
   * Change settings; they apply at once and are saved for next time. `apiKey` is the key of
   * `provider` ("anthropic", the default, "openai" or "google"); "" removes it.
   */
  "settings.set": async (p) => {
    const next = { ...settings };
    if (p.provider !== undefined && !isProviderId(p.provider)) throw new RpcError(1, `Unknown provider "${String(p.provider)}"`);
    const provider = isProviderId(p.provider) ? p.provider : "anthropic";
    // The key goes to the system keychain (the settings file only where there is none).
    const keyChanged = typeof p.apiKey === "string" && (await storeKey(next, p.apiKey.trim() || undefined, provider));
    if (typeof p.defaultModel === "string" && MODELS.includes(p.defaultModel)) next.defaultModel = p.defaultModel;
    if (p.renderer === "auto" || p.renderer === "engine" || p.renderer === "ffmpeg") next.renderer = p.renderer;
    if (typeof p.hardwareEncoding === "boolean") next.hardwareEncoding = p.hardwareEncoding;
    settings = next;
    await saveSettings(settings);
    await applySettings(settings);
    // A new key: the agents' clients are made again on the next request (conversations carry on).
    if (keyChanged) for (const o of open.values()) if (!o.agent?.running) o.agent = undefined;
    return { ...publicSettings(settings), ...availability() };
  },
  "performance.get": async () => (await loadPerformance()) ?? null,
  "performance.run": () => (testing ??= runPerformanceTest().finally(() => (testing = undefined))),

  /**
   * Settings, Connections: how other AI apps reach the editor over MCP. The apps that start MCP
   * servers themselves (the Claude app, Gemini CLI) and whether they are connected, the command for
   * apps set up by hand, and the connector address for ChatGPT and others (`connect.http`).
   */
  "connect.get": () => connectState(),
  /** Add the editor to an app's MCP config (`client`: "claude" or "gemini-cli"), or take it out with `connected: false`. */
  "connect.set": async (p) => {
    if (!isClientId(p.client)) throw new RpcError(1, `Unknown app "${String(p.client)}"`);
    await setClientConnected(p.client, p.connected !== false, mcpLaunch(store.root));
    return connectState();
  },
  /**
   * The connector for apps that connect to an address (the Gemini app, ChatGPT): turn it on or off
   * (`enabled`), with a public https address through a tunnel (`public`, what those apps need), change
   * its `port`, or make a new secret path (`renew`, the old address stops working). Turning it on
   * waits until the public address is ready (the first time, after downloading the tunnel program).
   */
  "connect.http": async (p) => {
    if (!REMOTE_APPS && p.enabled === true) throw new RpcError(1, "Connecting the Gemini app and ChatGPT is turned off for now; the Claude app connects in Settings, Connections.");
    const current = settings.mcpHttp ?? { enabled: false };
    const port = Number.isInteger(p.port) && Number(p.port) > 0 && Number(p.port) < 65536 ? Number(p.port) : current.port;
    const enabled = typeof p.enabled === "boolean" ? p.enabled : current.enabled;
    const isPublic = typeof p.public === "boolean" ? p.public : (current.public ?? false);
    settings = { ...settings, mcpHttp: { enabled, ...(port ? { port } : {}), ...(isPublic ? { public: true } : {}) } };
    await saveSettings(settings);
    if (p.renew === true) await mcpToken(true);
    await applyMcpHttp(true);
    return connectState();
  },
};

/**
 * Apps that reach MCP servers only through a public address (the Gemini app, ChatGPT): off for now.
 * They need the editor on the internet (a tunnel), unlike the Claude app, which starts it on this
 * computer. The connector and tunnel code stays (connect.http, mcp/tunnel.ts) for when it comes back;
 * while this is false nothing starts it, not even a setting saved as on.
 */
const REMOTE_APPS = false;

/** The MCP connector the host serves (Settings, Connections), when it is on: the local server and its public address. */
let mcpHttp: { server?: McpHttpServer; error?: string; tunnel?: Tunnel; tunnelStatus?: string; tunnelProgress?: number; tunnelError?: string } = {};
/** Each start of the connector; a tunnel that comes up for an older one is closed. */
let mcpHttpRun = 0;

/**
 * Start, restart or stop the connector to match the settings. The public address starts in the
 * background (at startup), or is waited for (`wait`, when the user just turned it on).
 */
async function applyMcpHttp(wait = false): Promise<void> {
  const run = ++mcpHttpRun;
  mcpHttp.tunnel?.close();
  await mcpHttp.server?.close();
  mcpHttp = {};
  if (!REMOTE_APPS || !settings.mcpHttp?.enabled) return;
  const port = settings.mcpHttp.port ?? DEFAULT_MCP_PORT;
  try {
    // The apps that connect to an address (ChatGPT, Claude) show the previews in their chat, so the
    // projects they edit open here without a tab; the host stays the one program writing them.
    const backend = new AppBackend(store.root, {
      quiet: true,
      call: async (method: string, params: Record<string, unknown>) => {
        const handler = remoteHandlers[method];
        if (!handler) throw new Error(`Unknown method ${method}`);
        return handler(params);
      },
    });
    mcpHttp.server = await startMcpHttp({ projectsDir: store.root, backend, assumeViews: true }, { token: await mcpToken(), port });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    mcpHttp.error = err.code === "EADDRINUSE" ? `Port ${port} is used by another program. Pick another port.` : err.message;
    return;
  }
  if (!settings.mcpHttp.public) return;
  const state = mcpHttp;
  state.tunnelStatus = "Starting";
  const starting = startTunnel(mcpHttp.server.port, {
    onStatus: (text, progress) => {
      state.tunnelStatus = text;
      state.tunnelProgress = progress;
    },
  })
    .then((tunnel) => {
      if (run !== mcpHttpRun) return tunnel.close();
      state.tunnel = tunnel;
      state.tunnelStatus = undefined;
      tunnel.onExit = (message) => {
        if (run !== mcpHttpRun) return;
        state.tunnel = undefined;
        state.tunnelError = message;
      };
    })
    .catch((e: Error) => {
      if (run !== mcpHttpRun) return;
      state.tunnelStatus = undefined;
      state.tunnelError = e.message;
    });
  if (wait) await starting;
}

async function connectState() {
  const launch = mcpLaunch(store.root);
  const line = launch ? commandLine(launch) : null;
  return {
    command: line,
    claudeCode: line ? `claude mcp add --scope user ${MCP_NAME} -- ${line}` : null,
    clients: await Promise.all(CLIENT_IDS.map((id) => clientInfo(id, launch))),
    http: {
      /** Whether the Gemini app and ChatGPT can be connected at all (off for now; see REMOTE_APPS). */
      available: REMOTE_APPS,
      enabled: !!settings.mcpHttp?.enabled,
      public: !!settings.mcpHttp?.public,
      port: mcpHttp.server?.port ?? settings.mcpHttp?.port ?? DEFAULT_MCP_PORT,
      running: !!mcpHttp.server,
      url: mcpHttp.server?.url ?? null,
      path: mcpHttp.server?.path ?? null,
      error: mcpHttp.error ?? null,
      /** The address to paste into the Gemini app or ChatGPT (the tunnel's, with the secret path). */
      publicUrl: mcpHttp.tunnel && mcpHttp.server ? `${mcpHttp.tunnel.url}${mcpHttp.server.path}` : null,
      /** What the public address is doing while it starts, or why it stopped. */
      publicStatus: mcpHttp.tunnelStatus ?? null,
      publicError: mcpHttp.tunnelError ?? null,
      /** How far the setup is (0..1), while the tunnel program downloads. */
      publicProgress: mcpHttp.tunnelProgress ?? null,
    },
  };
}

let testing: Promise<PerformanceReport> | undefined;

async function runPerformanceTest(): Promise<PerformanceReport> {
  let last = 0;
  let stage = "";
  const report = await benchmarkBackends({
    onProgress: (p) => {
      // A few updates a second are enough for progress bars, but every change of stage goes out.
      if (p.stage === stage && Date.now() - last < 200) return;
      [last, stage] = [Date.now(), p.stage];
      rpc.notify("performance.progress", p);
    },
  });
  await savePerformance(report);
  // A renderer picked in the settings stays; "auto" follows the test.
  if (settings.renderer === "auto") applyPerformance(report);
  return report;
}
const rpc = new StdioRpc(handlers);

function sessionOptions(dir: string) {
  return {
    baseDir: dir,
    outputDir: path.join(dir, ".render"),
    transcriber: new LocalWhisperTranscriber(),
    tts: new LocalTTS(),
  };
}

function snapshot(o: OpenProject) {
  // The app reads files directly, so media "URLs" are absolute paths.
  return {
    ...sessionState(o.session),
    project: o.dir,
    projectDir: o.dir,
    agentRunning: !!o.agent?.running,
    choices: o.session.pendingChoices ?? null,
    // The viewer can show the edit as it was before the latest request (`render.scrub` with `before`).
    canCompare: !!o.before && o.before.revision !== o.session.revision,
    conversation: { id: o.conversation.id, title: o.conversation.title, model: o.conversation.model },
    mcpClient: o.mcpClient ?? null,
  };
}

const stateTimers = new Map<string, NodeJS.Timeout>();
function pushState(o: OpenProject) {
  clearTimeout(stateTimers.get(o.dir));
  stateTimers.set(
    o.dir,
    setTimeout(() => open.get(o.dir) === o && rpc.notify("state", snapshot(o)), 80),
  );
}

/** Open a session: autosave edits, stream state to the app, and continue the latest conversation. */
async function attach(s: EditorSession, dirIn: string): Promise<OpenProject> {
  const dir = keyOf(dirIn);
  const latest = (await listConversations(dir))[0];
  const conversation = latest ? await loadConversation(dir, latest.id).catch(() => newConversation(DEFAULT_MODEL)) : newConversation(DEFAULT_MODEL);
  const o: OpenProject = { dir, session: s, conversation, detach: () => undefined, scrub: { cache: new Map(), token: 0, chain: Promise.resolve() } };

  // Every change is saved right away (saves to one folder run in order, each one flushed to disk).
  const onChange = () => {
    pushState(o);
    scheduleCover(o, COVER_DELAY);
    store.save(dir, s.project).catch((e) => rpc.notify("log", { project: dir, level: "error", message: `Autosave failed: ${(e as Error).message}` }));
  };
  const onActivity = (a: object) => {
    rpc.notify("activity", { ...a, project: dir });
    pushState(o);
  };
  const onLog = (entry: object) => {
    rpc.notify("log", { ...entry, project: dir });
    pushState(o);
  };
  const onState = () => pushState(o);
  s.on("change", onChange);
  s.on("render", onState);
  s.on("activity", onActivity);
  s.on("log", onLog);
  s.on("choices", onState);
  o.detach = () => {
    s.off("change", onChange);
    s.off("render", onState);
    s.off("activity", onActivity);
    s.off("log", onLog);
    s.off("choices", onState);
    clearTimeout(stateTimers.get(dir));
    clearTimeout(o.coverTimer);
  };
  open.set(dir, o);
  focused = dir;
  s.startActivity("file", `Opened "${s.project.name}"`).done();
  // A project with an edit but no cover gets one soon.
  if (!(await store.list()).find((e) => keyOf(e.dir) === dir)?.cover) scheduleCover(o, 4000);
  return o;
}

function close(o: OpenProject) {
  o.agent?.cancel();
  o.detach();
  open.delete(o.dir);
  if (focused === o.dir) focused = open.keys().next().value;
}

// Covers: a frame of the edit for the projects page, made when the edit has been quiet for a while
// and nothing else is working, so it never slows Claude or a render down.
const COVER_DELAY = 20_000;
const COVER_WIDTH = 480;

function scheduleCover(o: OpenProject, delay: number) {
  clearTimeout(o.coverTimer);
  o.coverTimer = setTimeout(() => {
    if (open.get(o.dir) !== o) return;
    if (o.agent?.running || o.session.running.length) return scheduleCover(o, COVER_DELAY);
    void writeCover(o)
      .then((cover) => cover && rpc.notify("project.cover", { project: o.dir, cover }))
      .catch((e: Error) => console.error(`Cover for ${o.dir}: ${e.message}`));
  }, delay);
}

/** Render the cover: the frame a third of the way in, at a small size. Returns its path, or undefined for an empty edit. */
async function writeCover(o: OpenProject): Promise<string | undefined> {
  const s = o.session;
  const duration = computeTimeline(s.project).duration;
  if (duration <= 0) return undefined;
  const out = path.join(o.dir, COVER_FILE);
  const part = path.join(o.dir, `.cover-${process.pid}.png`);
  try {
    await renderFrame(s.project, Math.min(duration / 3, Math.max(0, duration - 0.05)), {
      output: part,
      scale: Math.min(1, COVER_WIDTH / s.project.settings.width),
      proxies: true,
      ...s.renderOptions,
    });
    await rename(part, out);
  } finally {
    await rm(part, { force: true });
  }
  return out;
}

/**
 * A scrubbed frame: a picture file (`path`), or, where the GPU engine draws previews, BGRA pixels
 * in the project's memory-mapped frame file (`shared`, layout in native/ave-render/src/shared.rs),
 * which the app copies out. Null `path` and no `shared` when a newer scrub took over.
 */
interface ScrubResult {
  path: string | null;
  time: number;
  shared?: string;
  width?: number;
  height?: number;
  sequence?: number;
}

// Frame scrubbing: quiet (no activity/history), and only the latest request renders. Engine frames
// go through shared memory; picture files are cached per revision.
async function scrub(o: OpenProject, time: number, before = false): Promise<ScrubResult> {
  const s = o.session;
  const state = o.scrub;
  const viaEngine = frameBackend() !== "ffmpeg";
  // A/B: the edit as it was before the latest request, in files of its own.
  const { project, revision } = before && o.before ? o.before : { project: s.project, revision: s.revision };
  const name = before ? "before" : "frame";
  const key = `${name}:${revision}:${time.toFixed(2)}`;
  const cached = state.cache.get(key);
  if (cached && !viaEngine) return { path: cached, time };
  const token = ++state.token;
  const job = state.chain.then(async (): Promise<ScrubResult> => {
    if (token !== state.token) return { path: null, time }; // superseded by a newer scrub
    const dir = path.join(s.options.outputDir, "scrub");
    await mkdir(dir, { recursive: true });
    if (viaEngine) {
      try {
        const frame = await renderFrameShared(project, time, { scale: 0.5, ...s.renderOptions, shared: path.join(dir, `${name}.bin`) });
        return { path: null, time, ...frame };
      } catch {
        // The engine cannot draw this edit (or is not built): a picture file from the FFmpeg backend.
      }
    }
    const out = path.join(dir, `${name}-r${revision}-${time.toFixed(2)}.png`);
    await renderFrame(project, time, { output: out, scale: 0.5, proxies: true, ...s.renderOptions });
    if (state.cache.size > 300) state.cache.clear();
    state.cache.set(key, out);
    return { path: out, time };
  });
  state.chain = job.catch(() => undefined);
  return job;
}

/**
 * The matte at a time for the viewer (white on black, a picture file, not recorded as a render): the
 * first masked effect on the clip `target` (or the clip at that time), else, or with `object`, the
 * object last selected in that clip's video. `label` says what it is; `object` its id, for the outline.
 */
async function matte(o: OpenProject, time: number, targetId?: string, objectOnly = false): Promise<{ path: string | null; label?: string; object?: string; reason?: string }> {
  const s = o.session;
  const p = s.project;
  const tl = computeTimeline(p);
  const clip = (targetId ? tl.clips.find((c) => c.clip.id === targetId) : undefined) ?? clipAtTime(tl, time);
  if (!clip) return { path: null, reason: "No clip here" };
  const masked = objectOnly ? undefined : clip.clip.effects.find((e) => e.mask);
  const objects = Object.entries(p.objects).filter(([, x]) => x.assetId === clip.asset.id);
  const objectId = masked ? undefined : objects[objects.length - 1]?.[0];
  if (!masked && !objectId) return { path: null, reason: objectOnly ? "No selected object in this clip" : "No mask or selected object in this clip" };
  const mask = masked ? masked.mask! : MaskSchema.parse({ kind: "object", object: objectId });
  // The mask cut from the picture as it reaches its effect: the effects before it, then the matte.
  const before = masked ? clip.clip.effects.slice(0, clip.clip.effects.indexOf(masked)) : [];
  const q: Project = {
    ...p,
    layers: [],
    effects: [],
    captions: undefined,
    clips: p.clips.map((c) => (c.id === clip.clip.id ? { ...c, effects: [...before, { type: "maskView", params: { mask, style: "matte" } }] } : c)),
  };
  const t = Math.min(Math.max(time, clip.start), Math.max(clip.start, clip.end - 0.01));
  const dir = path.join(s.options.outputDir, "scrub");
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `matte-r${s.revision}-${clip.clip.id}-${objectOnly ? "object" : "mask"}-${t.toFixed(2)}.png`);
  await renderFrame(q, t, { output: out, scale: 0.5, ...s.renderOptions });
  return { path: out, label: masked ? (masked.label ?? masked.type) : objectId, ...(objectId ? { object: objectId } : {}) };
}

/** Scopes (histogram, waveform, parade, vectorscope) of the frame at a time, for the Review tab; not recorded as a render. */
async function scopes(o: OpenProject, time: number): Promise<{ path: string; time: number }> {
  const s = o.session;
  const dir = path.join(s.options.outputDir, "scrub");
  await mkdir(dir, { recursive: true });
  const t = Math.min(Math.max(0, time), Math.max(0, computeTimeline(s.project).duration - 0.05));
  const frame = path.join(dir, `scopes-frame-r${s.revision}-${t.toFixed(2)}.png`);
  await renderFrame(s.project, t, { output: frame, scale: 0.5, ...s.renderOptions });
  const out = path.join(dir, `scopes-r${s.revision}-${t.toFixed(2)}.png`);
  await renderScopes(frame, out, undefined, { ffmpegPath: s.options.ffmpegPath, grid: true });
  return { path: out, time: t };
}

/** Stop live playback of a project, if it plays. */
function stopPlayback(o: OpenProject): void {
  if (o.playback) o.playback.stopped = true;
  o.playback = undefined;
}

/** The sound of the edit as it is now (a WAV file, made once per revision), or null without sound. */
function soundMix(o: OpenProject): Promise<string | null> {
  const s = o.session;
  if (o.mix?.revision !== s.revision) {
    const file = path.join(s.options.outputDir, "scrub", `mix-r${s.revision}.wav`);
    o.mix = { revision: s.revision, file: renderSoundMix(s.project, { ...s.renderOptions, output: file }).catch(() => null) };
  }
  return o.mix.file;
}

/**
 * Live playback from `time` on the GPU engine: frames are drawn at the edit's pace into the
 * project's shared frame file (`scrub/play.bin`) and announced with `preview.frame` notifications
 * ({ project, time, shared, width, height, sequence }); frames the engine cannot keep up with are
 * skipped. `preview.ended` follows the last one, or a stop. The answer comes when the first frame is
 * ready and gives the sound to play from `time` (null for none). `{ live: false }` where previews do
 * not go to the engine or it cannot draw the edit: the app then plays a rendered preview video.
 */
async function play(o: OpenProject, time: number): Promise<{ live: boolean; audio?: string | null; time?: number }> {
  stopPlayback(o);
  if (frameBackend() === "ffmpeg") return { live: false };
  const s = o.session;
  const state = { stopped: false };
  o.playback = state;
  const shared = path.join(s.options.outputDir, "scrub", "play.bin");
  let player: Awaited<ReturnType<typeof framePlayer>>;
  let audio: string | null;
  try {
    [player, audio] = await Promise.all([framePlayer(s.project, { scale: 0.5, ...s.renderOptions }), soundMix(o)]);
  } catch {
    if (o.playback === state) o.playback = undefined;
    return { live: false };
  }
  if (state.stopped) return { live: true, audio, time };
  const first = Math.min(player.frames - 1, Math.max(0, Math.round(time * player.fps)));
  const frame = await player.draw(first, shared);
  rpc.notify("preview.frame", { project: o.dir, time: first / player.fps, ...frame });
  // Paced by the clock from now, when the app starts the sound.
  const started = performance.now() - (first / player.fps - time) * 1000;
  void (async () => {
    let last = first;
    try {
      while (!state.stopped) {
        const n = Math.round(time * player.fps + ((performance.now() - started) / 1000) * player.fps);
        if (n >= player.frames) break;
        if (n <= last) {
          await new Promise((r) => setTimeout(r, Math.max(1, ((last + 1 - time * player.fps) / player.fps) * 1000 - (performance.now() - started))));
          continue;
        }
        const f = await player.draw(n, shared);
        if (state.stopped) break;
        rpc.notify("preview.frame", { project: o.dir, time: n / player.fps, ...f });
        last = n;
      }
    } catch {
      // The session closed under it (a project closed): playback ends.
    }
    if (o.playback === state) o.playback = undefined;
    rpc.notify("preview.ended", { project: o.dir, stopped: state.stopped });
  })();
  return { live: true, audio, time };
}

// Remote control: other local processes (scripts, Claude Code, the MCP server in engine/mcp) can drive
// the open projects through a token-protected socket advertised in <projectsDir>/.host.json.
const token = randomBytes(24).toString("hex");
/** The handlers for other processes (and the MCP connector): projects they open or close show in the app. */
const remoteHandlers: Record<string, Handler> = {
  ...handlers,
  // MCP marks its calls: `quiet` (the MCP app shows the previews itself: no tab here) or `via` (the
  // app it comes from: the tab shows the edit from there, without its own chat).
  "project.open": async (p) => notifyOpened(markVia(await handlers["project.open"]!(p), p), p),
  "project.create": async (p) => notifyOpened(markVia(await handlers["project.create"]!(p), p), p),
  "tools.execute": async (p) => {
    if (typeof p.via === "string" && p.quiet !== true) {
      const o = target(p);
      if (o.mcpClient !== p.via) {
        o.mcpClient = p.via;
        pushState(o);
      }
    }
    return handlers["tools.execute"]!(p);
  },
  "project.close": async (p) => {
    const dir = target(p).dir;
    const r = await handlers["project.close"]!(p);
    rpc.notify("project.closed", { project: dir });
    return r;
  },
};
const remote = await serveLocal(remoteHandlers, token);
function notifyOpened<T>(state: T, p: Record<string, unknown> = {}): T {
  if (p.quiet !== true) rpc.notify("project.opened", state);
  return state;
}
/** A project opened for an MCP app that cannot show previews: its tab says so and hides the chat. */
function markVia<T>(state: T, p: Record<string, unknown>): T {
  if (typeof p.via !== "string" || p.quiet === true) return state;
  const o = open.get(keyOf(String((state as { projectDir?: string }).projectDir ?? "")));
  if (!o) return state;
  o.mcpClient = p.via;
  return snapshot(o) as T;
}
const infoFile = path.join(store.root, HOST_INFO_FILE);
await mkdir(store.root, { recursive: true });
await writeFile(infoFile, JSON.stringify({ port: remote.port, token, pid: process.pid }), "utf8");
process.on("exit", () => {
  rmSync(infoFile, { force: true });
  // The tunnel program is a process of its own: it must not outlive the app.
  mcpHttp.tunnel?.close();
});

// The app closes stdin to stop the host, but on macOS and Linux a signal can come first (the app
// killed, the terminal closed, a service stopping): either way pending saves finish before exit.
let stopping: Promise<never> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    remote.server.close();
    mcpHttp.tunnel?.close();
    await mcpHttp.server?.close();
    for (const o of open.values()) o.agent?.cancel();
    await store.flush();
    process.exit(0);
  })());
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => void stop());

// How to start the app (it says when it starts the host), so an MCP app that needs the window can open it.
if (process.env.AVE_APP_EXE) {
  const file = appLaunchFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ command: process.env.AVE_APP_EXE, args: [] }), "utf8").catch(() => undefined);
}

// The app's settings: the API key, the renderer (by default what the performance test chose), hardware encoding.
let settings = await loadSettings();
await applySettings(settings);
// The MCP connector address, when it was left on (a failure shows in Settings, not here).
await applyMcpHttp();

// FFmpeg builds differ per platform; say early (on stderr, the host log) when this one lacks something.
void checkFfmpeg()
  .then((c) => !c.ok && console.error(describeFfmpegCheck(c)))
  .catch((e: Error) => console.error(`FFmpeg check failed: ${e.message}`));

await rpc.start();
await stop();
