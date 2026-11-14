import { describe, expect, it } from "vitest";
import { EditorSession } from "../../engine/claude/session.js";
import { EditorAgent, estimateTokens } from "../../engine/host/agent.js";
import { AnthropicProvider, type AgentMessage, type ModelProvider, type Turn, type TurnRequest } from "../../engine/host/providers.js";

/** A provider that plays back steps, and remembers what each request carried. */
function scripted(steps: ((r: TurnRequest, agent: EditorAgent) => Turn)[], agentRef: { agent?: EditorAgent }) {
  const seen: TurnRequest[] = [];
  const provider: ModelProvider = {
    id: "anthropic",
    async turn(r) {
      seen.push({ ...r, messages: structuredClone(r.messages) as AgentMessage[] });
      // The summary request has no tools.
      if (!r.tools.length) return { content: [{ type: "text", text: "The user wants a teaser; the title is done." }], stopReason: "end_turn" };
      const step = steps.shift();
      if (!step) throw new Error("no more steps");
      return step(r, agentRef.agent!);
    },
  };
  return { provider, seen };
}

const lastUser = (r: TurnRequest) => JSON.stringify(r.messages[r.messages.length - 1]);

describe("the editing agent's turn", () => {
  it("reads a message the user sends mid-turn at its next step, with the action's results", async () => {
    const ref: { agent?: EditorAgent } = {};
    const { provider, seen } = scripted(
      [
        (_, agent) => {
          // The user types while the model works.
          expect(agent.say("also make the title red")).toBe(true);
          return { content: [{ type: "tool_use", id: "t1", name: "get_project", input: {} }], stopReason: "tool_use" };
        },
        () => ({ content: [{ type: "text", text: "Done, and the title is red." }], stopReason: "end_turn" }),
      ],
      ref,
    );
    const agent = (ref.agent = new EditorAgent(new EditorSession(), { providers: { anthropic: provider } }));
    expect(await agent.run("make a teaser")).toEqual({ stopReason: "end_turn" });
    // The second step saw the tool result and the user's message together.
    expect(lastUser(seen[1]!)).toContain("tool_result");
    expect(lastUser(seen[1]!)).toContain("also make the title red");
    expect(agent.say("too late")).toBe(false);
  });

  it("goes on to answer a message that arrives as it was about to stop", async () => {
    const ref: { agent?: EditorAgent } = {};
    const { provider, seen } = scripted(
      [
        (_, agent) => {
          agent.say("and add music");
          return { content: [{ type: "text", text: "The teaser is ready." }], stopReason: "end_turn" };
        },
        () => ({ content: [{ type: "text", text: "Music added." }], stopReason: "end_turn" }),
      ],
      ref,
    );
    const agent = (ref.agent = new EditorAgent(new EditorSession(), { providers: { anthropic: provider } }));
    await agent.run("make a teaser");
    expect(seen).toHaveLength(2);
    expect(lastUser(seen[1]!)).toContain("and add music");
  });

  it("summarizes the conversation when it reaches the limit, with the cheapest model, and goes on", async () => {
    const ref: { agent?: EditorAgent } = {};
    const used: number[] = [];
    let summaries = 0;
    const { provider, seen } = scripted(
      [
        () => ({ content: [{ type: "tool_use", id: "t1", name: "get_project", input: {} }], stopReason: "tool_use", usage: { inputTokens: 90_000, outputTokens: 500, cachedTokens: 80_000 } }),
        () => ({ content: [{ type: "text", text: "Going on from the summary." }], stopReason: "end_turn", usage: { inputTokens: 3_000, outputTokens: 100, cachedTokens: 0 } }),
      ],
      ref,
    );
    const agent = (ref.agent = new EditorAgent(new EditorSession(), { providers: { anthropic: provider } }));
    await agent.run("make a teaser", { onUsage: (n) => used.push(n), onCompact: () => summaries++ }, { contextLimit: 50_000 });
    expect(summaries).toBe(1);
    const summaryRequest = seen.find((r) => !r.tools.length)!;
    expect(summaryRequest.model).toBe("claude-haiku-5-5");
    expect(JSON.stringify(summaryRequest.messages)).toContain("get_project");
    // After the summary the history is one short message, and the request went on from it.
    const after = seen[seen.length - 1]!;
    expect(after.messages).toHaveLength(1);
    expect(JSON.stringify(after.messages[0])).toContain("summarized to keep requests small");
    expect(used[0]).toBe(90_500);
    expect(agent.contextSize).toBeLessThan(10_000);
  });

  it("does not summarize by itself when automatic summaries are off, but can when asked", async () => {
    const ref: { agent?: EditorAgent } = {};
    const { provider } = scripted(
      [
        () => ({ content: [{ type: "tool_use", id: "t1", name: "get_project", input: {} }], stopReason: "tool_use", usage: { inputTokens: 90_000, outputTokens: 0, cachedTokens: 0 } }),
        () => ({ content: [{ type: "text", text: "Done." }], stopReason: "end_turn" }),
      ],
      ref,
    );
    let summaries = 0;
    const agent = (ref.agent = new EditorAgent(new EditorSession(), { providers: { anthropic: provider } }));
    await agent.run("make a teaser", { onCompact: () => summaries++ }, { contextLimit: 50_000, autoCompact: false });
    expect(summaries).toBe(0);
    await agent.compact({ onCompact: () => summaries++ });
    expect(summaries).toBe(1);
    expect(agent.history.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("marks Claude's prompt for caching: system, tools and the latest message", async () => {
    let body: Record<string, unknown> = {};
    const client = {
      beta: {
        messages: {
          stream: (b: Record<string, unknown>) => {
            body = b;
            return { on: () => undefined, finalMessage: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }) };
          },
        },
      },
    };
    const turn = await new AnthropicProvider(client as never).turn({
      model: "claude-opus-5-5",
      system: "You edit video.",
      tools: [{ name: "a", description: "", input_schema: { type: "object" } }, { name: "b", description: "", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
    });
    expect(body.system).toEqual([{ type: "text", text: "You edit video.", cache_control: { type: "ephemeral" } }]);
    expect((body.tools as { cache_control?: unknown }[]).map((t) => !!t.cache_control)).toEqual([false, true]);
    expect(JSON.stringify(body.messages)).toContain('"cache_control":{"type":"ephemeral"}');
    // The context counts what was read from the cache too.
    expect(turn.usage).toEqual({ inputTokens: 910, outputTokens: 5, cachedTokens: 900 });
    expect(estimateTokens([{ role: "user", content: "x".repeat(400) }])).toBe(100);
  });
});

describe("the prompt cache countdown", () => {
  const usage = { inputTokens: 30_000, outputTokens: 200, cachedTokens: 28_000 };
  const reply = (id: "anthropic" | "google"): ModelProvider => ({ id, turn: async () => ({ content: [{ type: "text", text: "ok" }], usage, stopReason: "end_turn" }) });

  it("keeps Claude's cache for five minutes from the last step, for that model", async () => {
    const agent = new EditorAgent(new EditorSession(), { providers: { anthropic: reply("anthropic") } });
    expect(agent.cacheState).toBeUndefined();
    const before = Date.now();
    await agent.run("hello");
    const cache = agent.cacheState!;
    expect(cache.model).toBe("claude-opus-5-5");
    expect(cache.until).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(cache.until).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    // Summarizing replaces the conversation: nothing cached matches it.
    await agent.compact();
    expect(agent.cacheState).toBeUndefined();
  });

  it("shows no countdown for Gemini, whose cache has no stated lifetime", async () => {
    const agent = new EditorAgent(new EditorSession(), { model: "gemini-4-carbon", providers: { google: reply("google") } });
    await agent.run("hello");
    expect(agent.cacheState).toBeUndefined();
  });
});
