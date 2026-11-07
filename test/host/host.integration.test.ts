import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";

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
    // No key: Claude is unavailable, so requests fail the same way on every machine.
    const env = { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_PROFILE: "" };
    const proc = spawn(process.execPath, [tsx, "engine/host/main.ts", "--projects-dir", dir], { stdio: "pipe", env });
    host = new HostClient(proc);
  });

  afterAll(async () => {
    host.proc.kill();
    // The engine's decoders may hold the media for a moment after the host goes (Windows locks them).
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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

    const frame = await host.call<{ path: string | null; shared?: string }>("render.scrub", { time: 1 });
    // A picture file, or the shared frame file where the render engine draws previews.
    expect(existsSync(frame.shared ?? frame.path!)).toBe(true);

    const state = await host.call<{ duration: number; clips: unknown[]; activities: { label: string; status: string }[] }>("state.get");
    expect(state.duration).toBe(4);
    expect(state.activities.map((a) => a.label)).toContain("Adding clip from \"talk\"");
    expect(state.activities.every((a) => a.status === "done")).toBe(true);

    const methods = new Set(host.notifications.map((n) => n.method));
    expect(methods.has("activity")).toBe(true);
    expect(methods.has("state")).toBe(true);

    // Options Claude offers reach the app in its state, and dismissing them clears it.
    await host.call("tools.execute", { name: "offer_choices", input: { question: "Which look?", options: [{ label: "Warm", image: fx.image }, { label: "Cool" }] } });
    const offered = await host.call<{ choices: { question: string; options: { label: string; image?: string }[] } | null }>("state.get");
    expect(offered.choices).toMatchObject({ question: "Which look?", options: [{ label: "Warm", image: fx.image }, { label: "Cool" }] });
    await host.call("choices.dismiss");
    expect((await host.call<{ choices: unknown }>("state.get")).choices).toBeNull();

    await new Promise((r) => setTimeout(r, 600)); // autosave debounce
    const saved = JSON.parse(await readFile(path.join(created.projectDir, "project.json"), "utf8")) as { clips: unknown[] };
    expect(saved.clips).toHaveLength(1);

    const list = await host.call<{ name: string }[]>("project.list");
    expect(list[0]!.name).toBe("My Test Film");

    // A/B: once a request starts and the edit changes, the viewer can show a frame from before it.
    expect((await host.call<{ canCompare: boolean }>("state.get")).canCompare).toBe(false);
    await expect(host.call("agent.run", { prompt: "make it longer", display: "make it longer" })).rejects.toThrow();
    await host.call("tools.execute", { name: "add_clip", input: { assetId: "talk" } });
    expect((await host.call<{ canCompare: boolean }>("state.get")).canCompare).toBe(true);
    type Scrubbed = { path: string | null; shared?: string };
    const now = await host.call<Scrubbed>("render.scrub", { time: 1 });
    const before = await host.call<Scrubbed>("render.scrub", { time: 1, before: true });
    const [nowFile, beforeFile] = [now.shared ?? now.path!, before.shared ?? before.path!];
    expect(existsSync(nowFile) && existsSync(beforeFile)).toBe(true);
    expect(beforeFile).not.toBe(nowFile);

    // Live playback: on the engine, frames come as notifications with the edit's sound to play
    // alongside; elsewhere the app plays a rendered preview video instead.
    const played = await host.call<{ live: boolean; audio?: string | null }>("render.play", { time: 0.5 });
    if (process.env.PARITY_LOG) console.log(`render.play: live ${played.live}`);
    if (played.live) {
      expect(existsSync(played.audio!)).toBe(true);
      await new Promise((r) => setTimeout(r, 700));
      await host.call("render.stop");
      await new Promise((r) => setTimeout(r, 200));
      const frames = host.notifications.filter((n) => n.method === "preview.frame").map((n) => (n.params as { time: number }).time);
      if (process.env.PARITY_LOG) console.log(`live playback: ${frames.length} frames in 0.7 s, from ${frames[0]} to ${frames.at(-1)}`);
      expect(frames.length).toBeGreaterThan(3);
      expect(frames[0]).toBeCloseTo(0.5, 1);
      expect(frames.every((t, i) => i === 0 || t > frames[i - 1]!)).toBe(true);
      expect(host.notifications.some((n) => n.method === "preview.ended")).toBe(true);
    }

    await host.call("session.undo");
    await host.call("session.undo");
    expect((await host.call<{ clips: unknown[] }>("state.get")).clips).toHaveLength(0);
  });

  it("keeps several projects open at once, each with its own state, conversations and cover", async () => {
    const a = await host.call<{ projectDir: string }>("project.create", { name: "Tab A" });
    const b = await host.call<{ projectDir: string }>("project.create", { name: "Tab B" });
    await host.call("project.importMedia", { project: a.projectDir, paths: [fx.talk] });
    await host.call("tools.execute", { project: a.projectDir, name: "add_clip", input: { assetId: "talk" } });
    // B was opened last, so it has focus, but A got the clip.
    expect((await host.call<{ clips: unknown[] }>("state.get", { project: a.projectDir })).clips).toHaveLength(1);
    expect((await host.call<{ clips: unknown[] }>("state.get")).clips).toHaveLength(0);
    await host.call("project.focus", { project: a.projectDir });
    expect((await host.call<{ clips: unknown[] }>("state.get")).clips).toHaveLength(1);
    // Notifications say which project they are about.
    const activity = host.notifications.filter((n) => n.method === "activity").at(-1)!.params as { project: string; label: string };
    expect(activity.project).toBe(a.projectDir);

    // Without a key the request fails, and the conversation still records it.
    await expect(host.call("agent.run", { project: b.projectDir, prompt: "[About clip x] cut it", display: "cut it" })).rejects.toThrow();
    const listed = await host.call<{ current: string; conversations: { id: string; title: string; lines: number }[] }>("chat.list", { project: b.projectDir });
    expect(listed.conversations).toMatchObject([{ id: listed.current, title: "cut it", lines: 2 }]);
    await host.call("chat.rename", { project: b.projectDir, id: listed.current, title: "First cut" });
    const fresh = await host.call<{ id: string; transcript: unknown[] }>("chat.new", { project: b.projectDir });
    expect(fresh.transcript).toHaveLength(0);
    const reopened = await host.call<{ title: string; transcript: { role: string; text: string }[] }>("chat.open", { project: b.projectDir, id: listed.current });
    expect(reopened.title).toBe("First cut");
    expect(reopened.transcript.map((l) => l.role)).toEqual(["user", "assistant"]);
    expect(reopened.transcript[1]!.text).toMatch(/^Error:/);
    await host.call("chat.delete", { project: b.projectDir, id: listed.current });
    expect((await host.call<{ conversations: unknown[] }>("chat.list", { project: b.projectDir })).conversations).toHaveLength(0);

    // Closing leaves a cover of the edit; an empty edit gets none (the app shows its default).
    await host.call("project.close", { project: a.projectDir });
    await host.call("project.close", { project: b.projectDir });
    const covers = Object.fromEntries((await host.call<{ dir: string; cover?: string }[]>("project.list")).map((p) => [p.dir, p.cover]));
    expect(covers[a.projectDir]).toBe(path.join(a.projectDir, "cover.png"));
    expect(existsSync(covers[a.projectDir]!)).toBe(true);
    expect(covers[b.projectDir]).toBeUndefined();
    await expect(host.call("state.get", { project: a.projectDir })).rejects.toThrow(/not open/);
  });

  it("reports errors as JSON-RPC errors", async () => {
    await expect(host.call("nope.method")).rejects.toThrow(/Unknown method/);
  });
});
