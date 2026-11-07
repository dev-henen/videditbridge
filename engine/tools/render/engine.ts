import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { nativeTarget } from "../native/index.js";
import type { EnginePlan } from "./plan.js";

/**
 * Client of the GPU render engine (native/ave-render, design section 3.4): a separate process
 * speaking JSON-RPC over stdio, so a driver crash takes down only the engine.
 */

export interface EngineInfo {
  adapter: string;
  backend: string;
  deviceType: string;
  driver: string;
}

export interface EngineRun {
  frames: number;
  /** Seconds the engine took, ffmpeg decoding and encoding included. */
  seconds: number;
  fps: number;
}

/** The engine binary `npm run native` builds for this machine. */
export function engineFile(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return nativeTarget(platform, arch).file.replace(/^ave-native\.(.*)\.node$/, "ave-render.$1") + (platform === "win32" ? ".exe" : "");
}

/** Where the engine is: $AVE_RENDER_PATH, else the local build in native/ave-render. Undefined when neither exists. */
export function enginePath(): string | undefined {
  if (process.env.AVE_RENDER_PATH) return process.env.AVE_RENDER_PATH;
  // Same depth from engine/tools/render and dist/tools/render.
  const local = path.resolve(import.meta.dirname, "..", "..", "..", "native", "ave-render", engineFile());
  return existsSync(local) ? local : undefined;
}

export class EngineError extends Error {}

/** A running engine process: its calls, notifications, and an end. */
interface Connection {
  call(method: string, params?: unknown): Promise<unknown>;
  notify(method: string): void;
  /** Ask it to stop, then make sure it has. */
  close(): Promise<void>;
  /** Whether it has stopped (a crash or close). */
  readonly closed: boolean;
}

function connect(onProgress?: (frame: number, frames: number) => void): Connection {
  const bin = enginePath();
  if (!bin) throw new EngineError("The GPU render engine is not built: run npm run native (or set AVE_RENDER_PATH)");
  const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  let closed = false;
  proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const failAll = (e: Error) => {
    closed = true;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  proc.on("error", (e) => failAll(new EngineError(`Cannot start the render engine (${bin}): ${e.message}`)));
  proc.on("close", (code) => failAll(new EngineError(`The render engine stopped (code ${code})${stderr ? `:\n${stderr.trim()}` : ""}`)));
  proc.stdin.on("error", () => undefined);
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let m: { id?: number; method?: string; params?: { frame: number; frames: number }; result?: unknown; error?: { message: string } };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method === "progress" && m.params) onProgress?.(m.params.frame, m.params.frames);
    else if (typeof m.id === "number") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new EngineError(m.error.message));
      else p?.resolve(m.result);
    }
  });
  const write = (m: object) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const call = (method: string, params?: unknown) =>
    closed
      ? Promise.reject(new EngineError("The render engine has stopped"))
      : new Promise<unknown>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          write({ id, method, params });
        });
  return {
    call,
    notify: (method) => void (closed || write({ method })),
    close: async () => {
      await call("shutdown").catch(() => undefined);
      proc.kill();
    },
    get closed() {
      return closed;
    },
  };
}

/** Run calls on a fresh engine process, then shut it down. */
async function session<T>(work: (call: Connection["call"]) => Promise<T>, opts: { onProgress?: (frame: number, frames: number) => void; signal?: AbortSignal } = {}): Promise<T> {
  const c = connect(opts.onProgress);
  const abort = () => c.notify("cancel");
  opts.signal?.addEventListener("abort", abort);
  try {
    return await work(c.call);
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    await c.close();
  }
}

/** The graphics adapter the engine renders on. */
export function engineInfo(): Promise<EngineInfo> {
  return session(async (call) => (await call("info")) as EngineInfo);
}

/** Render a plan (see planProject). Rejects with the engine's message, or "cancelled" on abort. */
export function runPlan(plan: EnginePlan, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<EngineRun> {
  if (opts.signal?.aborted) return Promise.reject(new EngineError("cancelled"));
  return session(async (call) => (await call("render", plan)) as EngineRun, {
    signal: opts.signal,
    onProgress: opts.onProgress ? (frame, frames) => opts.onProgress!(frames ? frame / frames : 1) : undefined,
  });
}

/**
 * The engine process previews share: it stays up between frames, so a session keeps its plan, color
 * tables and decoders, and nearby frames come quickly. Started on first use, again after a crash.
 */
let preview: Connection | undefined;

function previewEngine(): Connection {
  if (!preview || preview.closed) {
    preview = connect();
    process.once("exit", () => preview && !preview.closed && preview.notify("shutdown"));
  }
  return preview;
}

/** A plan held open by the preview engine, for drawing single frames (see planProject). */
export class FrameSession {
  private constructor(
    private readonly engine: Connection,
    readonly id: number,
    readonly plan: EnginePlan,
  ) {}

  static async open(plan: EnginePlan): Promise<FrameSession> {
    const engine = previewEngine();
    const { session } = (await engine.call("open", plan)) as { session: number };
    return new FrameSession(engine, session, plan);
  }

  /** Whether the engine behind it is still running. */
  get alive(): boolean {
    return !this.engine.closed;
  }

  /**
   * Draw output frame `n` and hand it to ffmpeg with `args`, which read it on stdin as planar 4:2:0 (yuv420p,
   * plan.width x plan.height). Resolves with seconds spent drawing and in all.
   */
  frame(n: number, args: string[]): Promise<{ draw: number; seconds: number }> {
    return this.engine.call("frame", { session: this.id, frame: n, args }) as Promise<{ draw: number; seconds: number }>;
  }

  /**
   * Draw output frames `list` in that order and hand them all to one ffmpeg run with `args`, which
   * read them on stdin as yuv420p (plan.width x plan.height), e.g. to tile a contact sheet.
   */
  frames(list: number[], args: string[]): Promise<{ frames: number; draw: number; seconds: number }> {
    return this.engine.call("frames", { session: this.id, frames: list, args }) as Promise<{ frames: number; draw: number; seconds: number }>;
  }

  /**
   * Draw output frame `n` as BGRA into the memory-mapped file `shared` (native/ave-render/src/shared.rs
   * gives its layout), for the app's viewer. Resolves with its size and sequence number.
   */
  frameShared(n: number, shared: string): Promise<{ width: number; height: number; sequence: number; draw: number; seconds: number }> {
    return this.engine.call("frame", { session: this.id, frame: n, shared }) as Promise<{ width: number; height: number; sequence: number; draw: number; seconds: number }>;
  }

  async close(): Promise<void> {
    if (this.alive) await this.engine.call("close", { session: this.id }).catch(() => undefined);
  }
}
