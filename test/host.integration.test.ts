import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();

/** Tiny JSON-RPC client over the host's stdio, like the desktop app uses. */
class HostClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notifications: { method: string; params: unknown }[] = [];

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
    });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
}

describe.skipIf(!hasFfmpeg)("engine host (JSON-RPC over stdio)", () => {
  let fx: Fixtures;
  let dir: string;
  let host: HostClient;

  beforeAll(async () => {
    fx = await makeFixtures();
    dir = await mkdtemp(path.join(tmpdir(), "ave-host-"));
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const proc = spawn(process.execPath, [tsx, "src/host/main.ts", "--projects-dir", dir], { stdio: "pipe" });
    host = new HostClient(proc);
  });

  afterAll(async () => {
    host.proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a project, edits it, streams activities and autosaves", async () => {
    const info = await host.call<{ projectsDir: string }>("host.info");
    expect(info.projectsDir).toBe(dir);

    const created = await host.call<{ projectDir: string; name: string }>("project.create", { name: "My Test Film", aspectRatio: "16:9" });
    expect(created.projectDir).toBe(path.join(dir, "my-test-film"));

    const imported = await host.call<{ text: string }[]>("project.importMedia", { paths: [fx.talk] });
    expect(imported[0]!.text).toContain('Imported "talk"');
    expect(existsSync(path.join(created.projectDir, "media", "talk.mp4"))).toBe(true);

    const added = await host.call<{ text: string; isError?: boolean }>("tools.execute", { name: "add_clip", input: { assetId: "talk" } });
    expect(added.isError).toBeFalsy();

    const frame = await host.call<{ path: string }>("render.scrub", { time: 1 });
    expect(existsSync(frame.path)).toBe(true);

    const state = await host.call<{ duration: number; clips: unknown[]; activities: { label: string; status: string }[] }>("state.get");
    expect(state.duration).toBe(4);
    expect(state.activities.map((a) => a.label)).toContain("Adding clip from \"talk\"");
    expect(state.activities.every((a) => a.status === "done")).toBe(true);

    const methods = new Set(host.notifications.map((n) => n.method));
    expect(methods.has("activity")).toBe(true);
    expect(methods.has("state")).toBe(true);

    // Options Claude offers reach the app in its state, and dismissing them clears it.
    await host.call("tools.execute", { name: "offer_choices", input: { question: "Which look?", options: [{ label: "Warm", image: frame.path }, { label: "Cool" }] } });
    const offered = await host.call<{ choices: { question: string; options: { label: string; image?: string }[] } | null }>("state.get");
    expect(offered.choices).toMatchObject({ question: "Which look?", options: [{ label: "Warm", image: frame.path }, { label: "Cool" }] });
    await host.call("choices.dismiss");
    expect((await host.call<{ choices: unknown }>("state.get")).choices).toBeNull();

    await new Promise((r) => setTimeout(r, 600)); // autosave debounce
    const saved = JSON.parse(await readFile(path.join(created.projectDir, "project.json"), "utf8")) as { clips: unknown[] };
    expect(saved.clips).toHaveLength(1);

    const list = await host.call<{ name: string }[]>("project.list");
    expect(list[0]!.name).toBe("My Test Film");

    await host.call("session.undo");
    expect((await host.call<{ clips: unknown[] }>("state.get")).clips).toHaveLength(0);
  });

  it("reports errors as JSON-RPC errors", async () => {
    await expect(host.call("nope.method")).rejects.toThrow(/Unknown method/);
  });
});
