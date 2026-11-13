import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { EditorSession } from "../claude/session.js";
import { TOOLS, executeTool, toAnthropicTools, type ToolResult } from "../claude/tools.js";
import { EDITOR_SYSTEM_PROMPT } from "../host/agent.js";
import { ProjectStore } from "../host/projects.js";
import { HOST_INFO_FILE, RemoteHost } from "../host/remote.js";
import { appDir } from "../tools/appdirs.js";
import type { AspectRatio } from "../core/util.js";
import { LocalWhisperTranscriber } from "../tools/transcript/local.js";
import { LocalTTS } from "../tools/voiceover/local.js";
import { PREVIEW_VIEW_HTML } from "./view.js";

/**
 * The editor as an MCP server, so other AI apps (the Claude, ChatGPT and Gemini apps, Gemini CLI,
 * Claude Code) can edit with its tools.
 *
 * The preview shows in one place. Apps that show MCP Apps views (Claude, ChatGPT) get the previews,
 * frames and contact sheets inside the chat, and the desktop app stays out of the way: edits go
 * through it without opening a tab when it is running (so one program writes the project), or the
 * server edits the project itself. Apps that cannot show a view (Gemini CLI, Claude Code) drive the
 * desktop app, which opens the project as the preview window, without its own chat, and is started
 * when it is not running.
 */

/** Where the tools run: the open app, or a session of the MCP server's own. */
export interface EditorBackend {
  readonly kind: "app" | "standalone";
  listProjects(): Promise<unknown>;
  openProject(target: string): Promise<{ dir: string; name: string }>;
  createProject(name: string, aspectRatio: AspectRatio): Promise<{ dir: string; name: string }>;
  execute(name: string, input: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

const nameOf = (state: unknown) => {
  const s = state as { projectDir?: string; project?: string; name?: string };
  return { dir: String(s.projectDir ?? s.project ?? ""), name: String(s.name ?? "") };
};

/** Calls a host method (the app's JSON-RPC handlers). */
export type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface AppBackendOptions {
  /** Calls the host's handlers directly (the MCP server inside the app's host) instead of the socket. */
  call?: HostCall;
  /** Keep the app out of sight: projects open without a tab (the MCP app shows the previews). */
  quiet?: boolean;
  /** The MCP app's name: the app shows the project with a note that it is edited from there, and no chat. */
  via?: string;
  /** Start the desktop app when it is not running. */
  launch?: boolean;
}

/** Where the desktop app records how to start it (app-launch.json in the app's data folder). */
export const appLaunchFile = () => process.env.AVE_APP_LAUNCH_FILE || path.join(appDir("data"), "app-launch.json");

/**
 * Drive the desktop app (it shows every edit; the project it has open is the one edited): through
 * its remote control socket from another process, or, inside the app's host, its handlers directly.
 */
export class AppBackend implements EditorBackend {
  readonly kind = "app";
  private host: RemoteHost | undefined;
  /** The project opened or created through MCP; otherwise the app's current tab. */
  private project: string | undefined;
  private readonly projectsDir: string;
  private readonly opts: AppBackendOptions;

  constructor(projectsDir: string, callOrOpts: HostCall | AppBackendOptions = {}) {
    this.projectsDir = projectsDir;
    this.opts = typeof callOrOpts === "function" ? { call: callOrOpts } : callOrOpts;
  }

  /** What MCP adds to project and tool calls: keep the app quiet, or name the app it is edited from. */
  private get marks(): Record<string, unknown> {
    return { ...(this.opts.quiet ? { quiet: true } : {}), ...(this.opts.via ? { via: this.opts.via } : {}) };
  }

  /** Connect, again after the app restarted, and start the app first when asked to. */
  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.opts.call) return (await this.opts.call(method, params)) as T;
    for (let attempt = 0; ; attempt++) {
      this.host ??= await this.connect();
      try {
        return await this.host.call<T>(method, params);
      } catch (e) {
        if (attempt > 0 || !/closed/i.test((e as Error).message)) throw e;
        this.host = undefined;
      }
    }
  }

  private async connect(): Promise<RemoteHost> {
    try {
      return await RemoteHost.connect(this.projectsDir);
    } catch (e) {
      if (!this.opts.launch) throw e;
    }
    await launchApp(this.projectsDir);
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        return await RemoteHost.connect(this.projectsDir);
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`The editor app did not start in time. Open it, then try again. (${(e as Error).message})`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  listProjects = () => this.call("project.list");

  async openProject(target: string) {
    const r = nameOf(await this.call("project.open", { path: await this.resolveProject(target), ...this.marks }));
    this.project = r.dir;
    return r;
  }

  async createProject(name: string, aspectRatio: AspectRatio) {
    const r = nameOf(await this.call("project.create", { name, aspectRatio, ...this.marks }));
    this.project = r.dir;
    return r;
  }

  /** A project by folder, or by name from the app's list. */
  private async resolveProject(target: string): Promise<string> {
    const list = (await this.call<{ dir: string; name: string }[]>("project.list").catch(() => [])) ?? [];
    const hit = list.find((p) => p.name.toLowerCase() === target.toLowerCase() || path.basename(p.dir) === target);
    return hit?.dir ?? path.resolve(this.projectsDir, target);
  }

  async execute(name: string, input: unknown): Promise<ToolResult> {
    if (this.opts.quiet && !this.project)
      return { text: "No project is open here. Call list_projects, then open_project or create_project.", isError: true };
    try {
      return await this.call<ToolResult>("tools.execute", { name, input, ...this.marks, ...(this.project ? { project: this.project } : {}) });
    } catch (e) {
      // The project opened through MCP was closed in the app: go on with the app's current tab.
      if (this.project && !this.opts.quiet && /is not open/.test((e as Error).message)) {
        this.project = undefined;
        return this.execute(name, input);
      }
      throw e;
    }
  }

  async close() {
    this.host?.close();
  }
}

/** Whether the desktop app is running for this projects folder (its host answers). */
export async function appRunning(projectsDir: string): Promise<boolean> {
  if (!existsSync(path.join(projectsDir, HOST_INFO_FILE))) return false;
  try {
    (await RemoteHost.connect(projectsDir)).close();
    return true;
  } catch {
    return false;
  }
}

/** Start the desktop app (as it recorded in app-launch.json) on this projects folder. */
export async function launchApp(projectsDir: string): Promise<void> {
  let launch: { command?: string; args?: string[] };
  try {
    launch = JSON.parse(await readFile(appLaunchFile(), "utf8")) as typeof launch;
  } catch {
    throw new Error("The editor app is not running, and it has not been opened on this computer yet. Open it once, then try again.");
  }
  if (!launch.command || !existsSync(launch.command)) throw new Error("The editor app is not running, and it could not be found where it was. Open it, then try again.");
  const child = spawn(launch.command, launch.args ?? [], { detached: true, stdio: "ignore", env: { ...process.env, AVE_PROJECTS_DIR: projectsDir } });
  child.unref();
}

/** Edit without the app: one project at a time, opened from the projects folder and saved on every change. */
export class StandaloneBackend implements EditorBackend {
  readonly kind = "standalone";
  private readonly store: ProjectStore;
  private current: { dir: string; session: EditorSession; detach: () => void } | undefined;

  constructor(projectsDir: string) {
    this.store = new ProjectStore(projectsDir);
  }

  listProjects = () => this.store.list();

  private attach(dir: string, session: EditorSession) {
    this.current?.detach();
    const save = () => void this.store.save(dir, session.project).catch((e: Error) => console.error(`Could not save ${dir}: ${e.message}`));
    session.on("change", save);
    this.current = { dir, session, detach: () => session.off("change", save) };
    return { dir, name: session.project.name };
  }

  private sessionFor(dir: string, project: ConstructorParameters<typeof EditorSession>[0]) {
    return new EditorSession(project, { baseDir: dir, outputDir: path.join(dir, ".render"), transcriber: new LocalWhisperTranscriber(), tts: new LocalTTS() });
  }

  async openProject(target: string) {
    const list = await this.store.list().catch(() => []);
    const hit = list.find((p) => p.name.toLowerCase() === target.toLowerCase() || path.basename(p.dir) === target);
    const loaded = await this.store.load(hit?.dir ?? target);
    return this.attach(loaded.dir, this.sessionFor(loaded.dir, loaded.project));
  }

  async createProject(name: string, aspectRatio: AspectRatio) {
    const { dir, project } = await this.store.create(name, aspectRatio);
    return this.attach(dir, this.sessionFor(dir, project));
  }

  async execute(name: string, input: unknown): Promise<ToolResult> {
    if (!this.current) return { text: "No project is open. Call list_projects, then open_project or create_project.", isError: true };
    return executeTool(this.current.session, name, input);
  }

  async close() {
    this.current?.detach();
    await this.store.flush();
  }
}

// ---------------------------------------------------------------- MCP Apps: the preview inside the chat

/** The MCP Apps extension, and the view it shows. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const UI_MIME_TYPE = "text/html;profile=mcp-app";
export const PREVIEW_URI = "ui://videditbridge/preview.html";
/** Where a result names the file its view shows (result _meta; the model does not read it). */
export const MEDIA_META = "videditbridge/media";
/** The view's own tool: the bytes of a rendered file. Only the view can call it. */
export const FETCH_MEDIA = "fetch_media";
/** Tools whose results the view shows. */
const VIEW_TOOLS = new Set(["render_preview", "render_frame", "render_contact_sheet"]);
/** The most the view loads into the chat (a data: URL; the views allow no other source). */
const MAX_MEDIA_BYTES = 40 * 1024 * 1024;

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** The file a view tool's result shows: its picture, or the file it names in its data (render_preview). */
function mediaOf(result: ToolResult): { path: string; mimeType: string } | undefined {
  const file = result.images?.[0]?.path ?? (result.data as { path?: unknown } | undefined)?.path;
  if (typeof file !== "string") return undefined;
  const mimeType = MIME[path.extname(file).toLowerCase()];
  return mimeType ? { path: file, mimeType } : undefined;
}

/** A rendered file the view may load: in a project's render folder, of a picture or video type, not too big. */
async function readMedia(projectsDir: string, file: string): Promise<{ mimeType: string; data: string }> {
  const full = path.resolve(file);
  const rel = path.relative(path.resolve(projectsDir), full);
  const mimeType = MIME[path.extname(full).toLowerCase()];
  if (!mimeType || rel.startsWith("..") || path.isAbsolute(rel) || !rel.split(path.sep).includes(".render")) throw new Error("Only renders of the editor's projects can be shown.");
  const size = (await stat(full)).size;
  if (size > MAX_MEDIA_BYTES) throw new Error(`This render is ${Math.round(size / 1e6)} MB, too big to show in the chat. Render a shorter range or a smaller scale.`);
  return { mimeType, data: (await readFile(full)).toString("base64") };
}

// ---------------------------------------------------------------- the server

const object = (properties: Record<string, object>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });

/** Tools for choosing the project, on top of the editing tools (which act on the open project). */
const PROJECT_TOOLS: Tool[] = [
  { name: "list_projects", description: "List the video projects in the editor's projects folder (name, folder, last change).", inputSchema: object({}), annotations: { readOnlyHint: true } },
  {
    name: "open_project",
    description: "Open a project by its name or folder; the editing tools then act on it.",
    inputSchema: object({ project: { type: "string", description: "Project name (from list_projects) or folder" } }, ["project"]),
  },
  {
    name: "create_project",
    description: "Create a new, empty video project and open it.",
    inputSchema: object({ name: { type: "string" }, aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5", "21:9"], default: "16:9" } }, ["name"]),
  },
];

/** The editing tools in MCP form, with whether each changes the project; with `ui`, the view on the render tools and the view's own tool. */
export function mcpTools(ui = false): Tool[] {
  const mutates = new Map(TOOLS.map((t) => [t.name, t.mutates]));
  const editing = toAnthropicTools().map(
    (t): Tool => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema as Tool["inputSchema"],
      annotations: { readOnlyHint: !mutates.get(t.name), destructiveHint: false, openWorldHint: false },
      ...(ui && VIEW_TOOLS.has(t.name) ? { _meta: { ui: { resourceUri: PREVIEW_URI } } } : {}),
    }),
  );
  const own: Tool[] = ui
    ? [
        {
          name: FETCH_MEDIA,
          description: "The preview view loads a rendered file with this (not for the model).",
          inputSchema: object({ path: { type: "string" } }, ["path"]),
          annotations: { readOnlyHint: true },
          _meta: { ui: { resourceUri: PREVIEW_URI, visibility: ["app"] } },
        },
      ]
    : [];
  return [...PROJECT_TOOLS, ...editing, ...own];
}

/** A tool result as MCP content: its text, the frames it rendered as pictures, and (for the view) the file it shows. */
export async function toMcpResult(result: ToolResult, ui = false): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: result.text }];
  for (const img of result.images ?? []) {
    const data = await readFile(img.path).catch(() => undefined);
    if (data) content.push({ type: "image", data: data.toString("base64"), mimeType: img.mediaType });
  }
  const media = ui && !result.isError ? mediaOf(result) : undefined;
  return { content, ...(result.isError ? { isError: true } : {}), ...(media ? { _meta: { [MEDIA_META]: media } } : {}) };
}

const INSTRUCTIONS = `${EDITOR_SYSTEM_PROMPT}

Choosing the project: the editing tools act on the open project. Start with list_projects, then open_project (or create_project).
Showing the user: render_preview, render_frame and render_contact_sheet show their result to the user (in the chat where the app can show it, otherwise in the editor's window). Show a preview after meaningful changes.`;

/** Who connected: whether it shows MCP Apps views, and its name. */
export interface McpClientInfo {
  ui: boolean;
  name: string;
}

/** Whether a client said it shows MCP Apps views (HTML ones). */
export function clientShowsViews(capabilities: unknown): boolean {
  const ext = (capabilities as { extensions?: Record<string, { mimeTypes?: string[] }> } | undefined)?.extensions?.[UI_EXTENSION];
  return !!ext && (!ext.mimeTypes || ext.mimeTypes.includes(UI_MIME_TYPE));
}

export interface McpServerOptions {
  /** The projects folder the view may load renders from. */
  projectsDir: string;
  /** The backend, or how to pick one once the client is known (on its first tool call). */
  backend: EditorBackend | ((client: McpClientInfo) => EditorBackend | Promise<EditorBackend>);
  /** Treat the client as showing views without asking (stateless HTTP, where each request is a new connection). */
  assumeViews?: boolean;
  version?: string;
}

/** An MCP server over a backend. Make one per connection; the backend can be shared. */
export function createMcpServer(opts: McpServerOptions): Server {
  const server = new Server(
    { name: "videditbridge", title: "VideditBridge", version: opts.version ?? "0.2.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const client = (): McpClientInfo => ({
    ui: opts.assumeViews === true || clientShowsViews(server.getClientCapabilities()),
    name: server.getClientVersion()?.title ?? server.getClientVersion()?.name ?? "another app",
  });
  let picked: Promise<EditorBackend> | undefined;
  const backend = () => (picked ??= Promise.resolve(typeof opts.backend === "function" ? opts.backend(client()) : opts.backend));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools(client().ui) }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: client().ui ? [{ uri: PREVIEW_URI, name: "Video preview", description: "Plays the previews and shows the frames the editor renders.", mimeType: UI_MIME_TYPE }] : [],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== PREVIEW_URI) throw new Error(`No resource ${req.params.uri}`);
    return { contents: [{ uri: PREVIEW_URI, mimeType: UI_MIME_TYPE, text: PREVIEW_VIEW_HTML, _meta: { ui: { prefersBorder: true } } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === FETCH_MEDIA) {
        const media = await readMedia(opts.projectsDir, String(args.path ?? ""));
        return { content: [{ type: "text", text: `${media.mimeType}, ${Math.round((media.data.length * 3) / 4 / 1024)} KB` }], structuredContent: media };
      }
      const b = await backend();
      if (name === "list_projects") return { content: [{ type: "text", text: JSON.stringify(await b.listProjects(), null, 2) }] };
      if (name === "open_project" || name === "create_project") {
        const r =
          name === "open_project"
            ? await b.openProject(String(args.project ?? ""))
            : await b.createProject(String(args.name ?? "Untitled"), (String(args.aspectRatio ?? "16:9") as AspectRatio) || "16:9");
        return { content: [{ type: "text", text: `Opened "${r.name}" (${r.dir}). The editing tools now act on it.` }] };
      }
      return await toMcpResult(await b.execute(name, args), client().ui);
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });
  return server;
}

/**
 * The backend for a client, from another process (ave-mcp): an app that shows views keeps the
 * preview to itself (through the running desktop app without a tab, else standalone); one that
 * cannot drives the desktop app, starting it when needed, which shows the project without its chat.
 */
export async function backendFor(client: McpClientInfo, projectsDir: string): Promise<EditorBackend> {
  if (client.ui) return (await appRunning(projectsDir)) ? new AppBackend(projectsDir, { quiet: true }) : new StandaloneBackend(projectsDir);
  return new AppBackend(projectsDir, { via: client.name, launch: true });
}
