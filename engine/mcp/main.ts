#!/usr/bin/env node
/**
 * The editor as an MCP server for other AI apps.
 *
 *   ave-mcp [--projects-dir <dir>] [--standalone]                 stdio: Claude desktop, Gemini CLI, Claude Code
 *   ave-mcp --http [--port 3920] [--host 127.0.0.1] [--token <t>]  Streamable HTTP: ChatGPT, Claude custom connectors
 *
 * It drives the running desktop app (its projects folder, the same as the app's: --projects-dir or
 * $AVE_PROJECTS_DIR, else ./projects), or with --standalone opens projects itself.
 *
 * Over HTTP the endpoint is http://<host>:<port>/mcp/<token>: the token is in the path for apps that
 * cannot send headers (a header `Authorization: Bearer <token>` on /mcp works too). It is kept in the
 * app's data folder so the URL stays the same. ChatGPT reaches only public HTTPS addresses, so put a
 * tunnel in front (see docs/guides/mcp.md).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { appDir } from "../tools/appdirs.js";
import { AppBackend, StandaloneBackend, createMcpServer, type EditorBackend } from "./server.js";

// stdout carries the stdio protocol: everything else goes to stderr.
console.log = console.error;
console.info = console.error;

const { values } = parseArgs({
  options: {
    "projects-dir": { type: "string" },
    standalone: { type: "boolean", default: false },
    http: { type: "boolean", default: false },
    port: { type: "string", default: "3920" },
    host: { type: "string", default: "127.0.0.1" },
    token: { type: "string" },
  },
});

const projectsDir = path.resolve(values["projects-dir"] ?? process.env.AVE_PROJECTS_DIR ?? "projects");
const backend: EditorBackend = values.standalone ? new StandaloneBackend(projectsDir) : new AppBackend(projectsDir);

/** The HTTP token: given, or kept in the app's data folder (made on first use). */
async function httpToken(): Promise<string> {
  if (values.token) return values.token;
  const file = process.env.AVE_MCP_TOKEN_FILE || path.join(appDir("data"), "mcp-token");
  const saved = (await readFile(file, "utf8").catch(() => "")).trim();
  if (saved) return saved;
  const token = randomBytes(24).toString("hex");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Whether a request carries the token, in the path or as a bearer header. */
function authorized(req: IncomingMessage, token: string): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const fromPath = url.pathname.match(/^\/mcp\/([^/]+)\/?$/)?.[1];
  if (fromPath) return same(decodeURIComponent(fromPath), token);
  const header = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return url.pathname.replace(/\/$/, "") === "/mcp" && !!header && same(header, token);
}

async function serveHttp(): Promise<void> {
  const token = await httpToken();
  const server = createServer(async (req, res) => {
    if (!authorized(req, token)) {
      res.writeHead(404).end();
      return;
    }
    // Stateless: a server and transport per request, over the one shared backend.
    const mcp = createMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(`MCP request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  const port = Number(values.port);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, values.host, () => resolve());
  });
  console.error(`AI Video Editor MCP server (${backend.kind}) at http://${values.host}:${port}/mcp/${token}`);
}

const stop = async () => {
  await backend.close();
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => void stop());

if (values.http) await serveHttp();
else {
  const transport = new StdioServerTransport();
  transport.onclose = () => void stop();
  await createMcpServer(backend).connect(transport);
  console.error(`AI Video Editor MCP server (${backend.kind}) on stdio, projects in ${projectsDir}`);
}
