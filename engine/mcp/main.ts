#!/usr/bin/env node
/**
 * The editor as an MCP server for other AI apps.
 *
 *   ave-mcp [--projects-dir <dir>] [--standalone]                 stdio: Claude desktop, Gemini CLI, Claude Code
 *   ave-mcp --http [--port 3920] [--host 127.0.0.1] [--token <t>]  Streamable HTTP: ChatGPT, custom connectors
 *
 * The projects folder is the app's: --projects-dir or $AVE_PROJECTS_DIR, else ./projects. Apps that
 * show MCP Apps views (Claude, ChatGPT) get the previews in the chat and leave the desktop app out of
 * sight; others drive the desktop app, starting it if needed (see server.ts). --standalone never uses
 * the app. The app's Settings (Connections) sets up the apps for you and can run the HTTP server
 * inside the app; this command is for doing it by hand. See docs/guides/mcp.md.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_MCP_PORT, mcpToken, startMcpHttp } from "./http.js";
import { StandaloneBackend, backendFor, createMcpServer, type EditorBackend, type McpClientInfo } from "./server.js";

// stdout carries the stdio protocol: everything else goes to stderr.
console.log = console.error;
console.info = console.error;

const { values } = parseArgs({
  options: {
    "projects-dir": { type: "string" },
    standalone: { type: "boolean", default: false },
    http: { type: "boolean", default: false },
    port: { type: "string", default: String(DEFAULT_MCP_PORT) },
    host: { type: "string", default: "127.0.0.1" },
    token: { type: "string" },
  },
});

const projectsDir = path.resolve(values["projects-dir"] ?? process.env.AVE_PROJECTS_DIR ?? "projects");
let chosen: Promise<EditorBackend> | undefined;
/** One backend for the process, picked for the first client. */
const backend = (client: McpClientInfo) => (chosen ??= values.standalone ? Promise.resolve(new StandaloneBackend(projectsDir)) : backendFor(client, projectsDir));

const stop = async () => {
  await (await chosen)?.close();
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => void stop());

if (values.http) {
  // Over HTTP every request is a new connection: the apps that connect to an address show views.
  const server = await startMcpHttp({ projectsDir, backend, assumeViews: true }, { token: values.token ?? (await mcpToken()), port: Number(values.port), host: values.host });
  console.error(`VideditBridge MCP server at ${server.url}`);
} else {
  const transport = new StdioServerTransport();
  transport.onclose = () => void stop();
  await createMcpServer({ projectsDir, backend }).connect(transport);
  console.error(`VideditBridge MCP server on stdio, projects in ${projectsDir}`);
}
