import { describe, expect, it } from "vitest";
import { EditorSession, TOOLS, executeTool, toAnthropicTools } from "../src/claude/index.js";
import { parseProject } from "../src/core/index.js";

function session() {
  return new EditorSession(
    parseProject({
      settings: { width: 1080, height: 1920 },
      assets: [
        { type: "video", id: "talk", src: "talk.mp4", duration: 10, hasAudio: true },
        { type: "audio", id: "music", src: "music.mp3", duration: 60 },
      ],
      transcripts: {
        talk: {
          words: [
            { text: "Um", start: 0.2, end: 0.4 },
            { text: "welcome", start: 0.6, end: 1.0 },
            { text: "to", start: 1.0, end: 1.1 },
            { text: "the", start: 1.1, end: 1.2 },
            { text: "show.", start: 1.2, end: 1.6 },
            { text: "Today", start: 4.0, end: 4.4 },
            { text: "we", start: 4.4, end: 4.5 },
            { text: "edit.", start: 4.5, end: 5.0 },
          ],
        },
      },
    }),
    { baseDir: process.cwd() },
  );
}

describe("tool definitions", () => {
  it("have unique names and valid JSON schemas", () => {
    const tools = toAnthropicTools();
    expect(new Set(tools.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.input_schema.type).toBe("object");
    }
  });
});

describe("session + tools", () => {
  it("edits through tools with undo/redo and change events", async () => {
    const s = session();
    const events: string[] = [];
    s.on("change", (e) => events.push(e.action));

    let r = await executeTool(s, "add_clip", { assetId: "talk" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/video now 10s/);

    r = await executeTool(s, "add_text", { text: "Hello", start: 0, duration: 2, animationIn: { type: "pop" } });
    expect(s.project.layers).toHaveLength(1);

    r = await executeTool(s, "set_captions", { style: "bold-pop" });
    expect(s.project.captions?.style).toBe("bold-pop");

    r = await executeTool(s, "add_audio", { assetId: "music", loop: true, volume: 0.2 });
    expect(s.project.audio[0]).toMatchObject({ role: "music", loop: true });

    await executeTool(s, "undo", {});
    expect(s.project.audio).toHaveLength(0);
    await executeTool(s, "redo", {});
    expect(s.project.audio).toHaveLength(1);
    expect(events).toEqual(["add_clip", "add_text", "set_captions", "add_audio", "undo add_audio", "redo add_audio"]);
  });

  it("cleans up speech and searches transcripts", async () => {
    const s = session();
    await executeTool(s, "add_clip", { assetId: "talk" });
    const search = await executeTool(s, "search_transcript", { query: "today we" });
    expect(search.text).toContain("source 4-4.5s → timeline 00:04.0");
    const r = await executeTool(s, "cleanup_speech", { assetId: "talk", maxPause: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Removed \d+ segments/);
    expect(r.text).toContain('filler "Um"');
    const after = await executeTool(s, "search_transcript", { query: "today" });
    expect(after.text).toMatch(/timeline 00:0[0-3]/); // moved earlier
  });

  it("applies templates", async () => {
    const s = session();
    const r = await executeTool(s, "apply_template", {
      templateId: "quote-card",
      inputs: { quote: "Make it simple.", author: "Someone" },
    });
    expect(r.isError).toBeFalsy();
    expect(s.project.metadata.template).toBe("quote-card");
    expect(r.text).toContain("Primary track");
  });

  it("reports invalid input and failures as errors instead of throwing", async () => {
    const s = session();
    expect((await executeTool(s, "add_clip", {})).isError).toBe(true);
    expect((await executeTool(s, "remove_clip", { clipId: "nope" })).text).toMatch(/No clip with id/);
    expect((await executeTool(s, "nope", {})).isError).toBe(true);
    expect((await executeTool(s, "transcribe", { assetId: "talk" })).text).toMatch(/No transcription provider/);
  });

  it("lists catalogs", async () => {
    const s = session();
    for (const name of ["list_templates", "list_effects", "list_transitions", "list_animations", "list_caption_styles", "list_components"]) {
      const r = await executeTool(s, name, {});
      expect(r.isError, name).toBeFalsy();
      expect(r.text.split("\n").length, name).toBeGreaterThan(5);
    }
    expect((await executeTool(s, "get_template", { id: "podcast-clip" })).text).toContain("How to edit");
  });
});

describe("registerTool", () => {
  it("makes custom tools listable and executable", async () => {
    const { registerTool } = await import("../src/claude/index.js");
    const { z } = await import("zod");
    registerTool({ name: "echo_test", description: "Echo text back (test tool).", input: z.object({ text: z.string() }), mutates: false, run: async (_s, i) => ({ text: i.text }) });
    expect(toAnthropicTools().some((t) => t.name === "echo_test")).toBe(true);
    expect((await executeTool(session(), "echo_test", { text: "hi" })).text).toBe("hi");
  });
});
