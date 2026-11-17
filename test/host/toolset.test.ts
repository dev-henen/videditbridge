import { describe, expect, it } from "vitest";
import { EditorSession } from "../../engine/claude/session.js";
import { TOOLS, toAnthropicTools } from "../../engine/claude/tools.js";
import { EditorAgent, shortenOldResults } from "../../engine/host/agent.js";
import type { AgentMessage, ModelProvider, Turn, TurnRequest } from "../../engine/host/providers.js";
import { CORE_TOOLS, LOAD_TOOLS, ToolSet, moreToolsList } from "../../engine/host/toolset.js";

/** A provider that plays back steps and remembers what each request carried. */
function scripted(steps: ((r: TurnRequest) => Turn)[]) {
  const seen: TurnRequest[] = [];
  const provider: ModelProvider = {
    id: "anthropic",
    async turn(r) {
      seen.push({ ...r, messages: structuredClone(r.messages) as AgentMessage[] });
      const step = steps.shift();
      if (!step) throw new Error("no more steps");
      return step(r);
    },
  };
  return { provider, seen };
}

const names = (r: TurnRequest) => r.tools.map((t) => t.name);

describe("tools sent with each request", () => {
  it("are the core tools and load_tools, with every other tool listed by name in the system prompt", () => {
    for (const n of CORE_TOOLS) expect(TOOLS.some((t) => t.name === n)).toBe(true);
    const specs = new ToolSet().specs();
    expect(specs.map((t) => t.name)).toEqual([...CORE_TOOLS, LOAD_TOOLS]);
    const list = moreToolsList();
    for (const t of TOOLS) expect(list.includes(`- ${t.name}:`)).toBe(!CORE_TOOLS.includes(t.name));
    // Far smaller than every tool at once.
    expect(JSON.stringify(specs).length + list.length).toBeLessThan(JSON.stringify(toAnthropicTools()).length / 4);
  });

  it("grow by load_tools from the next step on, appended at the end, and stay for the conversation", async () => {
    const { provider, seen } = scripted([
      () => ({ content: [{ type: "tool_use", id: "l1", name: LOAD_TOOLS, input: { names: ["detect_beats", "nope"] } }], stopReason: "tool_use" }),
      () => ({ content: [{ type: "text", text: "Ready." }], stopReason: "end_turn" }),
      () => ({ content: [{ type: "text", text: "Still here." }], stopReason: "end_turn" }),
    ]);
    const agent = new EditorAgent(new EditorSession(), { providers: { anthropic: provider } });
    await agent.run("cut to the beat");
    expect(names(seen[0]!)).not.toContain("detect_beats");
    expect(JSON.stringify(seen[1]!.messages.at(-1))).toContain("Loaded detect_beats");
    expect(JSON.stringify(seen[1]!.messages.at(-1))).toContain("No such tools: nope");
    expect(names(seen[1]!).slice(-2)).toEqual(["detect_beats", LOAD_TOOLS]);
    await agent.run("and again");
    expect(names(seen[2]!)).toContain("detect_beats");
  });

  it("include a tool the model called without loading it, and one a saved conversation used", async () => {
    const { provider, seen } = scripted([
      () => ({ content: [{ type: "tool_use", id: "t1", name: "list_sound_effects", input: {} }], stopReason: "tool_use" }),
      () => ({ content: [{ type: "text", text: "Done." }], stopReason: "end_turn" }),
    ]);
    const agent = new EditorAgent(new EditorSession(), { providers: { anthropic: provider } });
    await agent.run("which sounds are there?");
    // It ran anyway.
    expect(JSON.stringify(seen[1]!.messages.at(-1))).toContain("whoosh");
    expect(names(seen[1]!)).toContain("list_sound_effects");

    const saved = new ToolSet(agent.history);
    expect(saved.specs().map((t) => t.name)).toContain("list_sound_effects");
  });

  it("leave out tools that change the project in plan mode", () => {
    const set = new ToolSet();
    set.add("beat_sync");
    const specs = set.specs(true).map((t) => t.name);
    expect(specs).not.toContain("beat_sync");
    expect(specs).not.toContain("add_clip");
    expect(specs).toContain("propose_plan");
    expect(specs).toContain(LOAD_TOOLS);
  });
});

describe("shared shapes in tool schemas", () => {
  it("spell out the mask only in the tools about masks; others point to grade_region", () => {
    const tools = toAnthropicTools();
    const of = (n: string) => JSON.stringify(tools.find((t) => t.name === n)!.input_schema);
    expect(of("grade_region")).toContain('"feather"');
    expect(of("render_mask")).toContain('"feather"');
    expect(of("add_clip")).not.toContain('"feather"');
    expect(of("add_clip")).toContain("the same object as grade_region's mask");
    // The field's own description is kept, before the pointer.
    expect(of("add_clip")).toContain("Apply the effect only where this mask selects");
    expect(JSON.stringify(tools)).not.toContain("x-pointer");
  });
});

describe("shortening earlier results", () => {
  const history = (): AgentMessage[] => [
    { role: "user", content: "read the transcript" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_transcript", input: {} }, { type: "tool_use", id: "t2", name: "render_frame", input: {} }, { type: "tool_use", id: "t3", name: "get_project", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Hello there. ".repeat(500) }] },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "Frame at 2s" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
        { type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "Short summary" }] },
      ],
    },
  ];

  it("keeps the start of long texts, drops pictures, leaves short results, and says how to get them back", () => {
    const messages = history();
    expect(shortenOldResults(messages)).toBeGreaterThan(1000);
    const [long, picture, short] = (messages[2]!.content as { content: { type: string; text?: string }[] }[]).map((b) => b.content);
    expect(long![0]!.text!.startsWith("Hello there.")).toBe(true);
    expect(long![0]!.text!.length).toBeLessThan(700);
    expect(long![0]!.text).toContain("call get_transcript again");
    expect(picture!.map((c) => c.type)).toEqual(["text"]);
    expect(picture![0]!.text).toContain("Frame at 2s");
    expect(picture![0]!.text).toContain("render again");
    expect(short![0]!.text).toBe("Short summary");
  });

  it("changes nothing the second time", () => {
    const messages = history();
    shortenOldResults(messages);
    const once = JSON.stringify(messages);
    expect(shortenOldResults(messages)).toBe(0);
    expect(JSON.stringify(messages)).toBe(once);
  });

  it("runs before each new request, not during one", async () => {
    const { provider, seen } = scripted([
      () => ({ content: [{ type: "tool_use", id: "t1", name: "get_project", input: { includeJson: true } }], stopReason: "tool_use" }),
      () => ({ content: [{ type: "text", text: "Done." }], stopReason: "end_turn" }),
      () => ({ content: [{ type: "text", text: "Next." }], stopReason: "end_turn" }),
    ]);
    const session = new EditorSession();
    // A name long enough that the project's JSON is a long result.
    session.commit({ ...session.project, name: "x".repeat(5000) }, "rename", {});
    const agent = new EditorAgent(session, { providers: { anthropic: provider } });
    await agent.run("look");
    const resultLength = (r: TurnRequest) => JSON.stringify(r.messages[2]).length;
    // The step that asked for it reads it whole.
    expect(resultLength(seen[1]!)).toBeGreaterThan(5000);
    await agent.run("next");
    expect(resultLength(seen[2]!)).toBeLessThan(1500);
  });
});

describe("what requests used", () => {
  it("is kept with the conversation, request by request, and requests that made no step are left out", async () => {
    const { newConversation, recordRequest } = await import("../../engine/host/conversations.js");
    const c = newConversation("claude-opus-5-5");
    const base = { at: "2026-11-17T00:00:00Z", model: "claude-opus-5-5", effort: "low" as const, stopReason: "end_turn", inputTokens: 900, cachedTokens: 600, outputTokens: 40, tools: { get_project: 1 } };
    recordRequest(c, { ...base, steps: 2 });
    recordRequest(c, { ...base, steps: 0 });
    expect(c.requests).toHaveLength(1);
    expect(c.requests![0]).toMatchObject({ steps: 2, effort: "low", inputTokens: 900 });
  });
});
