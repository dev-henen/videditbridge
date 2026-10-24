import { createInterface } from "node:readline";

/**
 * Minimal JSON-RPC 2.0 over stdio, one JSON message per line.
 * stdout carries protocol messages only; diagnostics go to stderr.
 */

export type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class StdioRpc {
  constructor(private readonly handlers: Record<string, Handler>) {}

  /** Push an event to the client. */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  start(input: NodeJS.ReadableStream = process.stdin): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.trim()) void this.handle(line);
    });
    return new Promise((resolve) => rl.on("close", resolve));
  }

  private write(msg: unknown): void {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }

  private async handle(line: string): Promise<void> {
    let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const { id, method, params } = msg;
    const handler = method ? this.handlers[method] : undefined;
    if (!handler) {
      if (id !== undefined) this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method "${method}"` } });
      return;
    }
    try {
      const result = await handler(params ?? {});
      if (id !== undefined) this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32000;
      const message = e instanceof Error ? e.message : String(e);
      if (id !== undefined) this.write({ jsonrpc: "2.0", id, error: { code, message } });
      else process.stderr.write(`[host] ${method} failed: ${message}\n`);
    }
  }
}
