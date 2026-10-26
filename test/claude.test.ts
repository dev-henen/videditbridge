import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalTTS } from "../src/tools/voiceover/local.js";
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
  it("offers choices to the user and clears them", async () => {
    const s = session();
    const seen: (string | null)[] = [];
    s.on("choices", (c) => seen.push(c ? c.question : null));
    const dir = await mkdtemp(path.join(tmpdir(), "ave-choice-"));
    try {
      const a = path.join(dir, "a.wav");
      const b = path.join(dir, "b.png");
      await writeFile(a, "x");
      await writeFile(b, "x");
      const r = await executeTool(s, "offer_choices", {
        question: "Which voice?",
        options: [
          { label: "Heart", audio: a, description: "warm" },
          { label: "A look", image: b },
        ],
      });
      expect(r.isError, r.text).toBeFalsy();
      expect(r.text).toMatch(/End your turn/);
      expect(s.pendingChoices).toMatchObject({ question: "Which voice?", options: [{ label: "Heart", audio: a }, { label: "A look", image: b }] });
      // Missing files are refused, and the offer on screen stays as it was.
      const bad = await executeTool(s, "offer_choices", { question: "Which?", options: [{ label: "x", audio: "nope.wav" }, { label: "y" }] });
      expect(bad.text).toMatch(/do not exist: nope\.wav/);
      expect(s.pendingChoices?.question).toBe("Which voice?");
      expect((await executeTool(s, "offer_choices", { question: "Only one?", options: [{ label: "x" }] })).isError).toBe(true);
      s.clearChoices();
      s.clearChoices();
      expect(s.pendingChoices).toBeUndefined();
      expect(seen).toEqual(["Which voice?", null]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
    expect(search.text).toContain("source 4-4.5s at timeline 00:04.0");
    const r = await executeTool(s, "cleanup_speech", { assetId: "talk", maxPause: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Removed \d+ segments/);
    expect(r.text).toContain('filler "Um"');
    const after = await executeTool(s, "search_transcript", { query: "today" });
    expect(after.text).toMatch(/at timeline 00:0[0-3]/); // moved earlier
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
    // Transcription always has the built-in local model; a missing media file is reported, not thrown.
    const stt = await executeTool(s, "transcribe", { assetId: "talk" });
    expect(stt.isError).toBe(true);
    expect(stt.text).toMatch(/transcribe failed/);
  });

  it("lists local voices and sets the project voice", async () => {
    const s = session();
    const list = await executeTool(s, "list_voices", {});
    expect(list.text).toMatch(/af_heart: Heart, American female, grade A \(project voice\)/);
    expect(list.text).not.toMatch(/am_adam/);
    expect((await executeTool(s, "list_voices", { all: true })).text).toMatch(/am_adam/);
    expect((await executeTool(s, "set_voice", { voice: "bm_george" })).isError).toBeFalsy();
    expect(s.project.metadata.voice).toEqual({ voice: "bm_george" });
    expect((await executeTool(s, "list_voices", { all: true })).text).toMatch(/bm_george: George, British male, grade C \(project voice\)/);
    expect((await executeTool(s, "set_voice", { voice: "nobody" })).isError).toBe(true);
    // The app passes the local voice in explicitly; that is not "another engine".
    const local = new EditorSession(undefined, { tts: new LocalTTS() });
    expect((await executeTool(local, "list_voices", {})).text).not.toMatch(/another voice engine/);
    expect((await executeTool(local, "set_voice", { voice: "nobody" })).isError).toBe(true);
    expect((await executeTool(s, "revoice", { all: true })).text).toMatch(/No narration/);
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
