import { readFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { EditorSession } from "../claude/session.js";
import { TOOLS, executeTool, toAnthropicTools, type ToolResult } from "../claude/tools.js";
import { EDITOR_SYSTEM_PROMPT } from "../host/agent.js";
import { ProjectStore } from "../host/projects.js";
import { RemoteHost } from "../host/remote.js";
import type { AspectRatio } from "../core/util.js";
import { LocalWhisperTranscriber } from "../tools/transcript/local.js";
import { LocalTTS } from "../tools/voiceover/local.js";

/**
 * The editor as an MCP server, so other AI apps (the Claude, ChatGPT and Gemini apps, Gemini CLI,
 * Claude Code) can edit with its tools. By default it drives the desktop app through its remote
 * control socket (<projectsDir>/.host.json): edits land in the project the app shows, live, and the
 * app saves them. Standalone, it opens a project folder itself and saves it, for use without the app.
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

/** Drive the running desktop app (it shows every edit; the project it has open is the one edited). */
export class AppBackend implements EditorBackend {
  readonly kind = "app";
  private host: RemoteHost | undefined;
  /** The project opened or created through MCP; otherwise the app's current tab. */
  private project: string | undefined;

  constructor(private readonly projectsDir: string) {}

  /** Connect, again after the app restarted. */
  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.host ??= await RemoteHost.connect(this.projectsDir);
      try {
        return await this.host.call<T>(method, params);
      } catch (e) {
        if (attempt > 0 || !/closed/i.test((e as Error).message)) throw e;
        this.host = undefined;
      }
    }
  }

  listProjects = () => this.call("project.list");

  async openProject(target: string) {
    const r = nameOf(await this.call("project.open", { path: await this.resolveProject(target) }));
    this.project = r.dir;
    return r;
  }

  async createProject(name: string, aspectRatio: AspectRatio) {
    const r = nameOf(await this.call("project.create", { name, aspectRatio }));
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
    try {
      return await this.call<ToolResult>("tools.execute", { name, input, ...(this.project ? { project: this.project } : {}) });
    } catch (e) {
      // The project opened through MCP was closed in the app: go on with the app's current tab.
      if (this.project && /is not open/.test((e as Error).message)) {
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

const object = (properties: Record<string, object>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });

/** Tools for choosing the project, on top of the editing tools (which act on the open project). */
const PROJECT_TOOLS: Tool[] = [
  { name: "list_projects", description: "List the video projects in the editor's projects folder (name, folder, last change).", inputSchema: object({}), annotations: { readOnlyHint: true } },
  {
    name: "open_project",
    description: "Open a project by its name or folder; the editing tools then act on it. With the desktop app running it opens in a tab there, so the user watches the edits.",
    inputSchema: object({ project: { type: "string", description: "Project name (from list_projects) or folder" } }, ["project"]),
  },
  {
    name: "create_project",
    description: "Create a new, empty video project and open it.",
    inputSchema: object({ name: { type: "string" }, aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5", "21:9"], default: "16:9" } }, ["name"]),
  },
];

/** The editing tools in MCP form, with whether each changes the project. */
export function mcpTools(): Tool[] {
  const mutates = new Map(TOOLS.map((t) => [t.name, t.mutates]));
  const editing = toAnthropicTools().map(
    (t): Tool => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema as Tool["inputSchema"],
      annotations: { readOnlyHint: !mutates.get(t.name), destructiveHint: false, openWorldHint: false },
    }),
  );
  return [...PROJECT_TOOLS, ...editing];
}

/** A tool result as MCP content: its text, and the frames it rendered as pictures. */
export async function toMcpResult(result: ToolResult): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: result.text }];
  for (const img of result.images ?? []) {
    const data = await readFile(img.path).catch(() => undefined);
    if (data) content.push({ type: "image", data: data.toString("base64"), mimeType: img.mediaType });
  }
  return { content, ...(result.isError ? { isError: true } : {}) };
}

const INSTRUCTIONS = `${EDITOR_SYSTEM_PROMPT}

Choosing the project: the editing tools act on the open project. With the desktop app running that is the app's current tab (or the one open_project or create_project opened). Start with list_projects and open_project when the user names a project.`;

/** An MCP server over a backend. Make one per connection; the backend can be shared. */
export function createMcpServer(backend: EditorBackend, version = "0.2.0"): Server {
  const server = new Server({ name: "ai-video-editor", title: "AI Video Editor", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const tools = mcpTools();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === "list_projects") return { content: [{ type: "text", text: JSON.stringify(await backend.listProjects(), null, 2) }] };
      if (name === "open_project" || name === "create_project") {
        const r =
          name === "open_project"
            ? await backend.openProject(String(args.project ?? ""))
            : await backend.createProject(String(args.name ?? "Untitled"), (String(args.aspectRatio ?? "16:9") as AspectRatio) || "16:9");
        return { content: [{ type: "text", text: `Opened "${r.name}" (${r.dir}). The editing tools now act on it.` }] };
      }
      return await toMcpResult(await backend.execute(name, args));
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });
  return server;
}
