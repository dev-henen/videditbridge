import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";

/** Written by a running engine host so other processes can drive the session the app shows. */
export const HOST_INFO_FILE = ".host.json";

export interface HostInfo {
  port: number;
  token: string;
  pid: number;
}

/** Client for a running engine host (the open desktop app). */
export class RemoteHost {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly socket: Socket) {
    const rl = createInterface({ input: socket });
    rl.on("line", (line) => {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    // If the app goes away mid-call, reject pending calls (on close) instead of crashing.
    socket.on("error", () => undefined);
    rl.on("error", () => undefined);
    socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("Connection to the app closed"));
      this.pending.clear();
    });
  }

  /** Connect to the host serving `projectsDir` (reads its .host.json). */
  static async connect(projectsDir: string): Promise<RemoteHost> {
    let info: HostInfo;
    try {
      info = JSON.parse(await readFile(path.join(projectsDir, HOST_INFO_FILE), "utf8")) as HostInfo;
    } catch {
      throw new Error(`The editor app is not running (no ${HOST_INFO_FILE} in ${projectsDir}). Start the app first.`);
    }
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(info.port, "127.0.0.1", () => resolve(s));
      s.once("error", () => reject(new Error("Could not reach the editor app. Is it still running?")));
    });
    const client = new RemoteHost(socket);
    await client.call("auth", { token: info.token });
    return client;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Shorthand for running an editing tool in the app's session. */
  tool<T = { text: string; isError?: boolean; data?: unknown }>(name: string, input: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>("tools.execute", { name, input });
  }

  close(): void {
    this.socket.end();
  }
}
