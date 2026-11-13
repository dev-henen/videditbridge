import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOLS } from "../../engine/claude/tools.js";
import { FETCH_MEDIA, MEDIA_META, PREVIEW_URI, StandaloneBackend, UI_EXTENSION, UI_MIME_TYPE, createMcpServer } from "../../engine/mcp/server.js";

const text = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content[0]?.text ?? "") as string;

describe("the editor as an MCP server", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ave-mcp-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every editing tool plus the project tools, and edits a project it saves", async () => {
    const backend = new StandaloneBackend(dir);
    const server = createMcpServer({ projectsDir: dir, backend });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      expect(client.getInstructions()).toContain("open_project");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(TOOLS.length + 3);
      const getProject = tools.find((t) => t.name === "get_project")!;
      expect(getProject.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === "add_text")!.annotations?.readOnlyHint).toBe(false);
      expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);

      // Without a project the tools say what to do.
      const none = await client.callTool({ name: "get_project", arguments: {} });
      expect(none.isError).toBe(true);
      expect(text(none)).toMatch(/open_project/);

      expect(text(await client.callTool({ name: "create_project", arguments: { name: "From MCP", aspectRatio: "9:16" } }))).toMatch(/Opened "From MCP"/);
      const added = await client.callTool({ name: "add_text", arguments: { text: "Hello from MCP", start: 0, duration: 2 } });
      expect(added.isError, text(added)).toBeFalsy();
      // A bad input comes back as a tool error, not a protocol failure.
      expect((await client.callTool({ name: "add_text", arguments: { text: 5 } })).isError).toBe(true);
      await backend.close();
      const list = JSON.parse(text(await client.callTool({ name: "list_projects", arguments: {} }))) as { name: string; dir: string }[];
      const saved = await readFile(path.join(list.find((p) => p.name === "From MCP")!.dir, "project.json"), "utf8");
      expect(saved).toContain("Hello from MCP");

      // Opening by name picks the same project up again.
      expect(text(await client.callTool({ name: "open_project", arguments: { project: "From MCP" } }))).toMatch(/Opened/);
      expect(text(await client.callTool({ name: "get_project", arguments: {} }))).toContain("Hello from MCP");
    } finally {
      await client.close();
    }
  });

  it("shows renders inside apps that show views, and only renders of the editor's projects", async () => {
    const backend = new StandaloneBackend(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "Claude", version: "1" }, { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } } } });
    await Promise.all([createMcpServer({ projectsDir: dir, backend }).connect(a), client.connect(b)]);
    try {
      // The view: listed, and an HTML page for the MCP Apps protocol.
      expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([PREVIEW_URI]);
      const view = (await client.readResource({ uri: PREVIEW_URI })).contents[0] as { mimeType: string; text: string };
      expect(view.mimeType).toBe(UI_MIME_TYPE);
      expect(view.text).toContain("ui/initialize");
      expect(view.text).toContain("ui/notifications/tool-result");
      const tools = (await client.listTools()).tools;
      expect(tools.find((t) => t.name === "render_frame")?._meta).toEqual({ ui: { resourceUri: PREVIEW_URI } });
      expect(tools.find((t) => t.name === FETCH_MEDIA)?._meta).toMatchObject({ ui: { visibility: ["app"] } });

      await client.callTool({ name: "create_project", arguments: { name: "Viewed" } });
      await client.callTool({ name: "add_text", arguments: { text: "Seen in the chat", start: 0, duration: 2 } });
      const frame = (await client.callTool({ name: "render_frame", arguments: { time: 0.5, scale: 0.2 } })) as { isError?: boolean; content: { type: string }[]; _meta?: Record<string, { path: string; mimeType: string }> };
      expect(frame.isError, JSON.stringify(frame.content)).toBeFalsy();
      // The model still sees the frame; the view gets the file to load.
      expect(frame.content.some((c) => c.type === "image")).toBe(true);
      const media = frame._meta?.[MEDIA_META];
      expect(media?.mimeType).toBe("image/png");
      const loaded = (await client.callTool({ name: FETCH_MEDIA, arguments: { path: media!.path } })) as { structuredContent?: { mimeType: string; data: string } };
      expect(loaded.structuredContent?.mimeType).toBe("image/png");
      expect(Buffer.from(loaded.structuredContent!.data, "base64").subarray(1, 4).toString()).toBe("PNG");

      // Nothing else on the computer: not outside the projects, not a project file.
      const list = JSON.parse(text(await client.callTool({ name: "list_projects", arguments: {} }))) as { name: string; dir: string }[];
      const projectFile = path.join(list.find((p) => p.name === "Viewed")!.dir, "project.json");
      for (const p of [projectFile, path.join(dir, "..", "secret.png"), "C:\\Windows\\win.ini"]) {
        expect((await client.callTool({ name: FETCH_MEDIA, arguments: { path: p } })).isError).toBe(true);
      }
    } finally {
      await client.close();
      await backend.close();
    }
  });

  it("gives apps that cannot show views no view and no view tool", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "Gemini CLI", version: "1" });
    await Promise.all([createMcpServer({ projectsDir: dir, backend: new StandaloneBackend(dir) }).connect(a), client.connect(b)]);
    try {
      expect((await client.listResources()).resources).toEqual([]);
      const tools = (await client.listTools()).tools;
      expect(tools.some((t) => t.name === FETCH_MEDIA)).toBe(false);
      expect(tools.find((t) => t.name === "render_preview")?._meta).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  describe("over HTTP", () => {
    let proc: ChildProcess;
    const port = 39000 + (process.pid % 900);
    const token = "test-token-0123456789";
    beforeAll(async () => {
      const tsx = createRequire(import.meta.url).resolve("tsx/cli");
      proc = spawn(process.execPath, [tsx, "engine/mcp/main.ts", "--http", "--standalone", "--port", String(port), "--token", token, "--projects-dir", dir], { stdio: ["ignore", "ignore", "pipe"] });
      await new Promise<void>((resolve, reject) => {
        let log = "";
        proc.stderr!.on("data", (d: Buffer) => {
          log += d.toString();
          if (log.includes("MCP server")) resolve();
        });
        proc.once("exit", (code) => reject(new Error(`exited ${code}: ${log}`)));
      });
    }, 60_000);
    afterAll(() => {
      proc?.kill();
    });

    it("answers only with the token, in the path or as a bearer header", async () => {
      const base = `http://127.0.0.1:${port}`;
      const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) };
      expect((await fetch(`${base}/mcp`, init)).status).toBe(404);
      expect((await fetch(`${base}/mcp/wrong`, init)).status).toBe(404);
      expect((await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })).status).toBe(200);

      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${token}`)));
      try {
        // Over HTTP the apps show views, so the view's own tool is listed too.
        expect((await client.listTools()).tools.length).toBe(TOOLS.length + 4);
        expect(text(await client.callTool({ name: "create_project", arguments: { name: "Over HTTP" } }))).toMatch(/Opened/);
        // Requests are stateless, but the project stays open between them.
        expect(text(await client.callTool({ name: "get_project", arguments: {} }))).toContain("Over HTTP");
      } finally {
        await client.close();
      }
    });
  });
});
