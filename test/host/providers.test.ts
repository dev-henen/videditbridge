import { describe, expect, it } from "vitest";
import { EditorSession } from "../../engine/claude/session.js";
import { EditorAgent } from "../../engine/host/agent.js";
import { AGENT_MODELS, DEFAULT_MODEL, assistantOf, providerOf } from "../../engine/host/models.js";
import {
  AnthropicProvider,
  fromGeminiParts,
  fromOpenAIOutput,
  toGeminiContents,
  toOpenAIInput,
  type AgentMessage,
  type ModelProvider,
  type Turn,
  type TurnRequest,
} from "../../engine/host/providers.js";

const PNG = { type: "base64" as const, media_type: "image/png" as const, data: "iVBORw0KGgo=" };

/** A conversation as Claude left it: a request with a picture, a tool call, its result with a frame, and a reply. */
const history: AgentMessage[] = [
  { role: "user", content: [{ type: "image", source: PNG }, { type: "text", text: "make it warmer" }] },
  { role: "assistant", content: [{ type: "text", text: "Looking first." }, { type: "tool_use", id: "toolu_1", name: "render_frame", input: { time: 1 } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Frame at 1s" }, { type: "image", source: PNG }] }] },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
];

describe("AI providers", () => {
  it("keeps Claude the default and tells providers apart by model id", () => {
    expect(DEFAULT_MODEL).toMatch(/^claude-/);
    expect(AGENT_MODELS[0]!.provider).toBe("anthropic");
    expect(new Set(AGENT_MODELS.map((m) => m.provider))).toEqual(new Set(["anthropic", "openai", "google"]));
    expect(providerOf("gpt-6-astra")).toBe("openai");
    expect(providerOf("gpt-7-something-new")).toBe("openai");
    expect(providerOf("gemini-9-pro")).toBe("google");
    expect(providerOf("claude-anything")).toBe("anthropic");
    expect(assistantOf("gemini-4-carbon")).toBe("Gemini");
    expect(assistantOf("gpt-6-luna")).toBe("ChatGPT");
  });

  it("turns a Claude conversation into OpenAI Responses input, pictures and tool results included", () => {
    const input = toOpenAIInput(history) as unknown as Record<string, unknown>[];
    expect(input[0]).toMatchObject({ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }, { type: "input_text", text: "make it warmer" }] });
    expect(input[1]).toEqual({ role: "assistant", content: "Looking first." });
    expect(input[2]).toEqual({ type: "function_call", call_id: "toolu_1", name: "render_frame", arguments: '{"time":1}' });
    expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "toolu_1", output: [{ type: "input_text", text: "Frame at 1s" }, { type: "input_image" }] });
    expect(input[4]).toEqual({ role: "assistant", content: "Done." });
  });

  it("replays OpenAI's own output items as they came, reasoning included", () => {
    const items = [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "secret" }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_project", arguments: "{}" }];
    const input = toOpenAIInput([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_project", input: {} }], native: { provider: "openai", data: items } },
    ]);
    expect(input.slice(1)).toEqual(items);
  });

  it("reads OpenAI output as text and tool calls, and notices a refusal", () => {
    const { content, refused } = fromOpenAIOutput([
      { type: "reasoning", id: "rs", summary: [] },
      { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Cutting.", annotations: [] }] },
      { type: "function_call", id: "fc", call_id: "call_9", name: "split_clip", arguments: '{"clipId":"c1","at":2}' },
    ] as never);
    expect(refused).toBe(false);
    expect(content).toEqual([{ type: "text", text: "Cutting." }, { type: "tool_use", id: "call_9", name: "split_clip", input: { clipId: "c1", at: 2 } }]);
    expect(fromOpenAIOutput([{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] as never).refused).toBe(true);
  });

  it("gives Gemini another model's tool calls as text (they carry no thought signature)", () => {
    const contents = toGeminiContents(history);
    expect(contents[0]).toEqual({ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }, { text: "make it warmer" }] });
    expect(contents[1]!.role).toBe("model");
    expect(contents[1]!.parts!.map((p) => p.text)).toEqual(["Looking first.", '[Called render_frame with {"time":1}]']);
    expect(contents[2]!.parts![0]!.text).toBe("[render_frame returned: Frame at 1s]");
    // The frame the tool rendered still reaches the model.
    expect(contents[2]!.parts![1]).toEqual({ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
  });

  it("replays Gemini's own turns with their signatures, and answers its calls as function responses", () => {
    const parts = [{ text: "thinking", thought: true }, { functionCall: { id: "fc1", name: "get_project", args: {} }, thoughtSignature: "sig" }];
    const content = fromGeminiParts(parts);
    expect(content).toEqual([{ type: "tool_use", id: "fc1", name: "get_project", input: {} }]);
    const contents = toGeminiContents([
      { role: "user", content: "hi" },
      { role: "assistant", content, native: { provider: "google", data: parts } },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "fc1", content: "{}" }] },
    ]);
    expect(contents[1]).toEqual({ role: "model", parts });
    expect(contents[2]!.parts![0]).toEqual({ functionResponse: { id: "fc1", name: "get_project", response: { output: "{}" } } });
  });

  it("joins Gemini's streamed text pieces into one block", () => {
    expect(fromGeminiParts([{ text: "Cut " }, { text: "done." }])).toEqual([{ type: "text", text: "Cut done." }]);
  });

  it("never sends the providers' own data to Claude", async () => {
    let sent: unknown;
    const client = {
      beta: {
        messages: {
          stream: (body: { messages: unknown }) => {
            sent = body.messages;
            return { on: () => undefined, finalMessage: async () => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }) };
          },
        },
      },
    };
    await new AnthropicProvider(client as never).turn({
      model: DEFAULT_MODEL,
      system: "",
      tools: [],
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "x", native: { provider: "google", data: [] } }, { role: "user", content: "again" }],
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(sent)).not.toContain("native");
  });

  it("runs the same editing loop on any provider, and a conversation carries on across them", async () => {
    const session = new EditorSession();
    const seen: { provider: string; messages: number }[] = [];
    const fake = (id: "anthropic" | "openai" | "google"): ModelProvider => {
      let calls = 0;
      return {
        id,
        async turn(r: TurnRequest): Promise<Turn> {
          seen.push({ provider: id, messages: r.messages.length });
          expect(r.tools.some((t) => t.name === "get_project")).toBe(true);
          r.onText?.(`${id} `);
          // First a tool call, then a reply.
          if (calls++ === 0) return { content: [{ type: "tool_use", id: `${id}-1`, name: "get_project", input: {} }], native: { provider: id, data: [id] }, stopReason: "tool_use" };
          return { content: [{ type: "text", text: `${id} done` }], stopReason: "end_turn" };
        },
      };
    };
    const agent = new EditorAgent(session, { model: "gpt-6-astra", providers: { anthropic: fake("anthropic"), openai: fake("openai"), google: fake("google") } });
    let text = "";
    expect(await agent.run("look", { onText: (d) => (text += d) })).toEqual({ stopReason: "end_turn" });
    expect(await agent.run("and again", {}, { model: "gemini-4-carbon" })).toEqual({ stopReason: "end_turn" });
    expect(seen.map((s) => s.provider)).toEqual(["openai", "openai", "google", "google"]);
    expect(text).toBe("openai openai ");
    const h = agent.history;
    // user, assistant tool call, tool result, reply; then the same for the second request.
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(h[1]!.native).toEqual({ provider: "openai", data: ["openai"] });
    expect(h[2]!.content).toMatchObject([{ type: "tool_result", tool_use_id: "openai-1" }]);
    expect(h[7]!.content).toEqual([{ type: "text", text: "google done" }]);
    // The thinking activity names the assistant.
    expect(session.activities.some((a) => a.label === "Gemini is thinking")).toBe(true);
  });
});
