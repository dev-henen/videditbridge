#!/usr/bin/env node
/**
 * The editor as an MCP server for other AI apps.
 *
 *   ave-mcp [--projects-dir <dir>] [--standalone]                 stdio: Claude desktop, Gemini CLI, Claude Code
 *   ave-mcp --http [--port 3920] [--host 127.0.0.1] [--token <t>]  Streamable HTTP: ChatGPT, custom connectors
 *
 * It drives the running desktop app (its projects folder, the same as the app's: --projects-dir or
 * $AVE_PROJECTS_DIR, else ./projects), or with --standalone opens projects itself. The app's Settings
 * (Connections) sets up the apps for you and can run the HTTP server inside the app; this command is
 * for doing it by hand. See docs/guides/mcp.md.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_MCP_PORT, mcpToken, startMcpHttp } from "./http.js";
import { AppBackend, StandaloneBackend, createMcpServer, type EditorBackend } from "./server.js";

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
const backend: EditorBackend = values.standalone ? new StandaloneBackend(projectsDir) : new AppBackend(projectsDir);

const stop = async () => {
  await backend.close();
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => void stop());

if (values.http) {
  const server = await startMcpHttp(backend, { token: values.token ?? (await mcpToken()), port: Number(values.port), host: values.host });
  console.error(`AI Video Editor MCP server (${backend.kind}) at ${server.url}`);
} else {
  const transport = new StdioServerTransport();
  transport.onclose = () => void stop();
  await createMcpServer(backend).connect(transport);
  console.error(`AI Video Editor MCP server (${backend.kind}) on stdio, projects in ${projectsDir}`);
}
