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
 *           render.scrub, render.play, render.stop, render.matte, render.scopes, choices.dismiss, chat.list, chat.current, chat.open, chat.new, chat.rename, chat.delete,
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
import { AGENT_MODELS, DEFAULT_MODEL, EditorAgent } from "./agent.js";
import { deleteConversation, listConversations, loadConversation, newConversation, saveConversation, titleFrom, type Conversation } from "./conversations.js";
import { COVER_FILE, ProjectStore } from "./projects.js";
import { RpcError, StdioRpc, serveLocal, type Handler } from "./rpc.js";
import { HOST_INFO_FILE } from "./remote.js";

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

const handlers: Record<string, Handler> = {
  "host.info": () => ({
    version: "0.2.0",
    projectsDir: store.root,
    claudeAvailable: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE),
    models: AGENT_MODELS,
    defaultModel: DEFAULT_MODEL,
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
    if (o.agent?.running) throw new RpcError(1, "Claude is still working; stop it or wait before switching conversations");
    o.conversation = await loadConversation(o.dir, String(p.id));
    o.agent = undefined;
    return conversationInfo(o);
  },
  "chat.new": (p) => {
    const o = target(p);
    if (o.agent?.running) throw new RpcError(1, "Claude is still working; stop it or wait before starting a new conversation");
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
      if (o.agent?.running) throw new RpcError(1, "Claude is still working in this conversation");
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
      const end = result.stopReason === "cancelled" ? "(stopped)" : result.stopReason === "refusal" ? "(Claude declined this request)" : "";
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
  "performance.get": async () => (await loadPerformance()) ?? null,
  "performance.run": () => (testing ??= runPerformanceTest().finally(() => (testing = undefined))),
};

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
  applyPerformance(report);
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

// Remote control: other local processes (scripts, Claude Code, a future MCP connector) can drive
// the open projects through a token-protected socket advertised in <projectsDir>/.host.json.
const token = randomBytes(24).toString("hex");
const remote = await serveLocal(
  {
    ...handlers,
    "project.open": async (p) => notifyOpened(await handlers["project.open"]!(p)),
    "project.create": async (p) => notifyOpened(await handlers["project.create"]!(p)),
    "project.close": async (p) => {
      const dir = target(p).dir;
      const r = await handlers["project.close"]!(p);
      rpc.notify("project.closed", { project: dir });
      return r;
    },
  },
  token,
);
function notifyOpened<T>(state: T): T {
  rpc.notify("project.opened", state);
  return state;
}
const infoFile = path.join(store.root, HOST_INFO_FILE);
await mkdir(store.root, { recursive: true });
await writeFile(infoFile, JSON.stringify({ port: remote.port, token, pid: process.pid }), "utf8");
process.on("exit", () => rmSync(infoFile, { force: true }));

// The app closes stdin to stop the host, but on macOS and Linux a signal can come first (the app
// killed, the terminal closed, a service stopping): either way pending saves finish before exit.
let stopping: Promise<never> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    remote.server.close();
    for (const o of open.values()) o.agent?.cancel();
    await store.flush();
    process.exit(0);
  })());
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => void stop());

// Renders use the renderer the performance test chose for this machine.
applyPerformance(await loadPerformance());

// FFmpeg builds differ per platform; say early (on stderr, the host log) when this one lacks something.
void checkFfmpeg()
  .then((c) => !c.ok && console.error(describeFfmpegCheck(c)))
  .catch((e: Error) => console.error(`FFmpeg check failed: ${e.message}`));

await rpc.start();
await stop();
