import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";

/**
 * Minimal JSON-RPC 2.0, one JSON message per line.
 * Used over stdio (the desktop app) and over a local, token-protected socket (remote control).
 */

export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;
type Write = (msg: unknown) => void;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Parse one line, run its handler, and write the response (if the message has an id). */
async function dispatch(handlers: Record<string, Handler>, line: string, write: Write): Promise<void> {
  let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const { id, method, params } = msg;
  const handler = method ? handlers[method] : undefined;
  if (!handler) {
    if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method "${method}"` } });
    return;
  }
  try {
    const result = await handler(params ?? {});
    if (id !== undefined) write({ jsonrpc: "2.0", id, result: result ?? null });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32000;
    const message = e instanceof Error ? e.message : String(e);
    if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code, message } });
    else process.stderr.write(`[host] ${method} failed: ${message}\n`);
  }
}

/** JSON-RPC over this process's stdin/stdout. stdout carries protocol messages only. */
export class StdioRpc {
  constructor(private readonly handlers: Record<string, Handler>) {}

  /** Push an event to the client. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  start(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.trim()) void dispatch(this.handlers, line, (m) => this.write(m));
    });
    return new Promise((resolve) => rl.on("close", resolve));
  }

  private write(msg: unknown): void {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }
}

const tokensMatch = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Serve the same handlers on 127.0.0.1 for remote control (scripts, Claude Code, the MCP server in engine/mcp),
 * so they drive the exact session the app is showing. Each connection must first call
 * `auth` with the token; anything else before that is rejected.
 */
export function serveLocal(handlers: Record<string, Handler>, token: string): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let authed = false;
    const write: Write = (msg) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
    };
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      if (authed) {
        void dispatch(handlers, line, write);
        return;
      }
      let msg: { id?: unknown; method?: string; params?: { token?: unknown } } = {};
      try {
        msg = JSON.parse(line);
      } catch {
        // fall through to rejection
      }
      if (msg.method === "auth" && typeof msg.params?.token === "string" && tokensMatch(msg.params.token, token)) {
        authed = true;
        write({ jsonrpc: "2.0", id: msg.id ?? null, result: true });
      } else {
        write({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: 401, message: "Unauthorized" } });
        socket.end();
      }
    });
    // A client that exits abruptly resets the connection. readline re-emits the socket error on
    // the interface, and an unhandled 'error' there would crash the host (and close the app).
    socket.on("error", () => undefined);
    rl.on("error", () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}
