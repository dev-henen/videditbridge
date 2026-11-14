import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EditorSession } from "../../engine/claude/session.js";
import { TOOLS, executeTool } from "../../engine/claude/tools.js";
import { memoryContext } from "../../engine/claude/workspace.js";
import { EditorAgent } from "../../engine/host/agent.js";
import type { ModelProvider, Turn, TurnRequest } from "../../engine/host/providers.js";
import { makeFixtures } from "../helpers/media.js";

/** Everything outside the project, as it was: a list of files with their sizes. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out.sort();
}

describe("the AI's reach beyond the project: files, memory, plans", () => {
  let root: string;
  let library: string;
  let elsewhere: string;
  let project: string;
  let session: EditorSession;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "ave-workspace-"));
    library = path.join(root, "Videos");
    elsewhere = path.join(root, "Private");
    project = path.join(root, "projects", "trip");
    await mkdir(path.join(library, "2024 Beach trip"), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await mkdir(project, { recursive: true });
    const fx = await makeFixtures();
    await copyFile(fx.talk, path.join(library, "2024 Beach trip", "beach sunset.mp4"));
    await copyFile(fx.music, path.join(library, "upbeat song.m4a"));
    await writeFile(path.join(library, "script.md"), "# Beach trip\n\nOpen on the sunset. Then the kids running.\n");
    await writeFile(path.join(elsewhere, "secret.txt"), "not for the AI");
    await copyFile(fx.talk, path.join(elsewhere, "private clip.mp4"));
    session = new EditorSession(undefined, { baseDir: project, searchRoots: [library], memoryFile: path.join(root, "memory.json"), cacheDir: false });
  }, 60_000);
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the user's media and documents by name, only in the folders they allow", async () => {
    const media = await executeTool(session, "search_files", { query: "beach" });
    expect(media.isError, media.text).toBeFalsy();
    expect(media.text).toContain("beach sunset.mp4");
    expect((await executeTool(session, "search_files", { kind: "audio" })).text).toContain("upbeat song.m4a");
    expect((await executeTool(session, "search_files", { kind: "document" })).text).toContain("script.md");
    // Never outside: another folder, or a way out of an allowed one.
    expect((await executeTool(session, "search_files", { query: "private" })).text).not.toContain("private clip");
    expect((await executeTool(session, "search_files", { folder: elsewhere })).isError).toBe(true);
    expect((await executeTool(session, "search_files", { folder: path.join(library, "..", "Private") })).isError).toBe(true);
  });

  it("reads documents the user keeps, and nothing outside the allowed folders", async () => {
    const script = await executeTool(session, "read_document", { path: path.join(library, "script.md") });
    expect(script.text).toContain("Open on the sunset");
    expect((await executeTool(session, "read_document", { path: path.join(elsewhere, "secret.txt") })).isError).toBe(true);
    expect((await executeTool(session, "read_document", { path: path.join(library, "upbeat song.m4a") })).isError).toBe(true);
  });

  it("copies media into the project only, as an asset, changing nothing outside", async () => {
    const before = await snapshot(root).then((all) => all.filter((f) => !f.startsWith(project)));
    const copied = await executeTool(session, "copy_to_project", { path: path.join(library, "2024 Beach trip", "beach sunset.mp4"), id: "sunset" });
    expect(copied.isError, copied.text).toBeFalsy();
    expect(session.project.assets.find((a) => a.id === "sunset")).toBeTruthy();
    expect(await readdir(path.join(project, "media"))).toEqual(["beach sunset.mp4"]);
    // Copying it again does not make a second file.
    await executeTool(session, "copy_to_project", { path: path.join(library, "2024 Beach trip", "beach sunset.mp4"), id: "sunset2" });
    expect(await readdir(path.join(project, "media"))).toEqual(["beach sunset.mp4"]);
    // Only media, only from the allowed folders.
    expect((await executeTool(session, "copy_to_project", { path: path.join(library, "script.md") })).isError).toBe(true);
    expect((await executeTool(session, "copy_to_project", { path: path.join(elsewhere, "private clip.mp4") })).isError).toBe(true);
    const after = await snapshot(root).then((all) => all.filter((f) => !f.startsWith(project) && !f.endsWith("memory.json")));
    expect(after).toEqual(before);
  });

  it("remembers about the user and about the project, tells the model, and forgets on request", async () => {
    const general = await executeTool(session, "remember", { text: "Likes bold yellow captions", scope: "general" });
    await executeTool(session, "remember", { text: "The video is for the family group chat", scope: "project" });
    const context = await memoryContext(session, "Always keep videos under 60 seconds.");
    expect(context).toContain("Always keep videos under 60 seconds.");
    expect(context).toContain("Likes bold yellow captions");
    expect(context).toContain("family group chat");
    expect(JSON.parse(await readFile(path.join(project, ".memory.json"), "utf8")).items).toHaveLength(1);
    const id = general.text.match(/\[(m\w+)\]/)![1]!;
    expect((await executeTool(session, "forget", { id })).isError).toBeFalsy();
    expect(await memoryContext(session)).not.toContain("yellow captions");
  });

  it("proposes a plan and, in plan mode, changes nothing until it is approved", async () => {
    const offered: string[][] = [];
    let call = 0;
    const provider: ModelProvider = {
      id: "anthropic",
      async turn(r: TurnRequest): Promise<Turn> {
        offered.push(r.tools.map((t) => t.name));
        expect(r.system).toContain("Plan mode is on");
        call++;
        // First it tries to edit anyway, then proposes.
        if (call === 1) return { content: [{ type: "tool_use", id: "t1", name: "add_text", input: { text: "Hi", start: 0, duration: 1 } }], stopReason: "tool_use" };
        if (call === 2)
          return { content: [{ type: "tool_use", id: "t2", name: "propose_plan", input: { title: "20 second teaser", steps: ["Cut the sunset", "Add captions"] } }], stopReason: "tool_use" };
        return { content: [{ type: "text", text: "Here is my plan." }], stopReason: "end_turn" };
      },
    };
    const revision = session.revision;
    const agent = new EditorAgent(session, { providers: { anthropic: provider } });
    await agent.run("make a teaser", {}, { planMode: true });
    expect(offered[0]).toContain("propose_plan");
    expect(offered[0]).toContain("search_files");
    expect(offered[0]).not.toContain("add_text");
    expect(offered[0]).not.toContain("copy_to_project");
    expect(session.revision).toBe(revision);
    expect(JSON.stringify(agent.history)).toContain("Plan mode is on: nothing can change");
    expect(session.pendingPlan).toMatchObject({ title: "20 second teaser", steps: ["Cut the sunset", "Add captions"] });
    expect(TOOLS.filter((t) => ["search_files", "read_document", "remember", "forget", "propose_plan"].includes(t.name)).every((t) => !t.mutates)).toBe(true);
  });
});
