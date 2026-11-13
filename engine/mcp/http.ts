import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { appDir } from "../tools/appdirs.js";
import { createMcpServer, type McpServerOptions } from "./server.js";

/**
 * The MCP server over Streamable HTTP, for apps that connect to an address (ChatGPT, Claude and
 * Gemini custom connectors). The endpoint is /mcp/<token>: the token is in the path for apps that
 * cannot send headers (ChatGPT); `Authorization: Bearer <token>` on /mcp works too. Anything else
 * gets 404.
 */

export const DEFAULT_MCP_PORT = 3920;

const tokenFile = () => process.env.AVE_MCP_TOKEN_FILE || path.join(appDir("data"), "mcp-token");

/** The token kept in the app's data folder (made on first use, or again with `renew`), so the address stays the same. */
export async function mcpToken(renew = false): Promise<string> {
  const file = tokenFile();
  const saved = renew ? "" : (await readFile(file, "utf8").catch(() => "")).trim();
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

export interface McpHttpServer {
  /** The local address with the token, e.g. http://127.0.0.1:3920/mcp/<token>. */
  url: string;
  /** The path part with the token, to put after a tunnel's https address. */
  path: string;
  port: number;
  close(): Promise<void>;
}

/** Serve MCP over HTTP: a server and transport per request (stateless); give it one shared backend. */
export async function startMcpHttp(mcpOptions: McpServerOptions, opts: { token: string; port?: number; host?: string }): Promise<McpHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const server: Server = createServer(async (req, res) => {
    if (!authorized(req, opts.token)) {
      res.writeHead(404).end();
      return;
    }
    const mcp = createMcpServer(mcpOptions);
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
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_MCP_PORT, host, () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const urlPath = `/mcp/${opts.token}`;
  return {
    url: `http://${host}:${port}${urlPath}`,
    path: urlPath,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Idle keep-alive connections would hold the port open.
        server.closeAllConnections();
      }),
  };
}
