import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import OpenAI from "openai";
import type { ResponseInputItem, ResponseInputMessageContentList, ResponseOutputItem } from "openai/resources/responses/responses";
import { envKeyOf, providerOf, type ProviderId } from "./models.js";

/**
 * One model turn for each AI provider. The conversation is kept in one format for all of them,
 * the Claude Messages format (text, image, tool_use and tool_result blocks), which is what saved
 * conversations already hold. Each provider turns that history into its own request and its reply
 * back into those blocks, so a conversation can move between models.
 *
 * What a provider must get back exactly as it sent it (OpenAI's reasoning items, Gemini's thought
 * signatures) rides along on the assistant message as `native`, and is replayed when the next turn
 * goes to the same provider. Other providers ignore it.
 */

/** Provider data kept with an assistant turn, replayed only to the provider that made it. */
export interface NativeTurn {
  provider: ProviderId;
  data: unknown;
}

export type AgentMessage = Anthropic.Beta.BetaMessageParam & { native?: NativeTurn };
export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface TurnRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: readonly AgentMessage[];
  signal: AbortSignal;
  onText?: (delta: string) => void;
}

export interface Turn {
  /** The reply as Messages blocks (text and tool_use). */
  content: ContentBlock[];
  native?: NativeTurn;
  /** end_turn, tool_use, pause_turn, max_tokens or refusal. */
  stopReason: string;
  /** What the step used: the whole prompt read (cached part included) and the reply written. */
  usage?: TurnUsage;
}

export interface TurnUsage {
  /** Tokens the model read: system prompt, tools and conversation (how full the context is). */
  inputTokens: number;
  outputTokens: number;
  /** Of the input, read from the provider's cache (cheaper). */
  cachedTokens: number;
}

/**
 * The conversation with a cache mark on its last block, so the next step reads everything up to here
 * from the cache. The mark moves forward each step (the API allows four; system and tools use two).
 */
function withCacheMark(history: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  const last = history[history.length - 1];
  if (!last || (last.role !== "user" && last.role !== "assistant") || !last.content) return history;
  const content = last.content as string | Anthropic.Beta.BetaContentBlockParam[];
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  const end = blocks[blocks.length - 1];
  // Thinking blocks cannot carry a mark; nothing to mark then.
  if (!end || end.type === "thinking" || end.type === "redacted_thinking") return history;
  blocks[blocks.length - 1] = { ...end, cache_control: { type: "ephemeral" } } as Anthropic.Beta.BetaContentBlockParam;
  return [...history.slice(0, -1), { ...last, content: blocks } as Anthropic.Beta.BetaMessageParam];
}

export interface ModelProvider {
  readonly id: ProviderId;
  turn(request: TurnRequest): Promise<Turn>;
}

const MAX_TOKENS = 64000;

const blocksOf = (m: AgentMessage): ContentBlock[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as ContentBlock[]));

type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

/** A base64 image block's type and data (other image sources are not sent by the editor). */
function imageOf(b: ImageBlock): { mediaType: string; data: string } | undefined {
  const src = b.source as { type: string; media_type?: string; data?: string };
  return src.type === "base64" && src.media_type && src.data ? { mediaType: src.media_type, data: src.data } : undefined;
}

/** A tool result's text and pictures. */
function resultParts(b: ToolResultBlock): { text: string; images: { mediaType: string; data: string }[] } {
  if (typeof b.content === "string") return { text: b.content, images: [] };
  const texts: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  for (const c of (b.content ?? []) as ContentBlock[]) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") {
      const img = imageOf(c);
      if (img) images.push(img);
    }
  }
  return { text: texts.join("\n"), images };
}

// ---------------------------------------------------------------- Anthropic (Claude)

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  private client: Anthropic | undefined;
  constructor(client?: Anthropic) {
    this.client = client;
  }

  async turn({ model, system, tools, messages, signal, onText }: TurnRequest): Promise<Turn> {
    this.client ??= new Anthropic();
    // `native` is ours, not the API's.
    const history = messages.map(({ native: _native, ...m }) => m as Anthropic.Beta.BetaMessageParam);
    // Prompt caching: the system prompt, the tools and the conversation so far are the same from one
    // step to the next, so they are read from the cache (about a tenth of the price) instead of paid again.
    const cache = { type: "ephemeral" as const };
    const cachedTools = (tools as Anthropic.Beta.BetaTool[]).map((t, i, all) => (i === all.length - 1 ? { ...t, cache_control: cache } : t));
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: system, cache_control: cache }],
        tools: cachedTools,
        messages: withCacheMark(history),
      },
      { signal },
    );
    stream.on("text", (delta) => onText?.(delta));
    const message = await stream.finalMessage();
    const u = message.usage as Anthropic.Beta.BetaUsage | undefined;
    const cached = (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
    return {
      content: message.content as ContentBlock[],
      stopReason: message.stop_reason ?? "end_turn",
      ...(u ? { usage: { inputTokens: u.input_tokens + cached, outputTokens: u.output_tokens, cachedTokens: u.cache_read_input_tokens ?? 0 } } : {}),
    };
  }
}

// ---------------------------------------------------------------- OpenAI (ChatGPT), Responses API

/** The history as Responses input items. */
export function toOpenAIInput(messages: readonly AgentMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.native?.provider === "openai") {
        input.push(...(m.native.data as ResponseInputItem[]));
        continue;
      }
      for (const b of blocksOf(m)) {
        if (b.type === "text" && b.text) input.push({ role: "assistant", content: b.text });
        else if (b.type === "tool_use") input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    // Tool results first (they answer the calls just before), then what the user wrote or showed.
    const said: ResponseInputMessageContentList = [];
    for (const b of blocksOf(m)) {
      if (b.type === "tool_result") {
        const { text, images } = resultParts(b);
        const out = b.is_error ? `Error: ${text}` : text;
        input.push({
          type: "function_call_output",
          call_id: b.tool_use_id,
          output: images.length
            ? [{ type: "input_text", text: out }, ...images.map((i) => ({ type: "input_image" as const, image_url: `data:${i.mediaType};base64,${i.data}`, detail: "auto" as const }))]
            : out,
        });
      } else if (b.type === "text") said.push({ type: "input_text", text: b.text });
      else if (b.type === "image") {
        const img = imageOf(b);
        if (img) said.push({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}`, detail: "auto" });
      }
    }
    if (said.length) input.push({ role: "user", content: said });
  }
  return input;
}

/** A Responses reply as Messages blocks. */
export function fromOpenAIOutput(output: readonly ResponseOutputItem[]): { content: ContentBlock[]; refused: boolean } {
  const content: ContentBlock[] = [];
  let refused = false;
  for (const item of output) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
        else if (c.type === "refusal") refused = true;
      }
    } else if (item.type === "function_call") {
      let args: unknown = {};
      try {
        args = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        // The tool's own validation reports what is wrong.
        args = { _unparsed: item.arguments };
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input: args });
    }
  }
  return { content, refused };
}

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai" as const;
  private client: OpenAI | undefined;
  constructor(client?: OpenAI) {
    this.client = client;
  }

  async turn({ model, system, tools, messages, signal, onText }: TurnRequest): Promise<Turn> {
    this.client ??= new OpenAI({ apiKey: envKeyOf("openai") });
    const stream = this.client.responses.stream(
      {
        model,
        instructions: system,
        input: toOpenAIInput(messages),
        tools: tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
        max_output_tokens: MAX_TOKENS,
        // Nothing is kept on OpenAI's side; reasoning comes back encrypted so the next turn can carry it.
        store: false,
        include: ["reasoning.encrypted_content"],
      },
      { signal },
    );
    stream.on("response.output_text.delta", (e) => onText?.(e.delta));
    const response = await stream.finalResponse();
    const { content, refused } = fromOpenAIOutput(response.output);
    const native: NativeTurn = { provider: "openai", data: response.output };
    // OpenAI caches a repeated prompt start by itself; the cached part is reported here.
    const u = response.usage;
    const usage: TurnUsage | undefined = u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedTokens: u.input_tokens_details?.cached_tokens ?? 0 } : undefined;
    if (refused && !content.length) return { content, native, usage, stopReason: "refusal" };
    if (content.some((b) => b.type === "tool_use")) return { content, native, usage, stopReason: "tool_use" };
    if (response.status === "incomplete") return { content, native, usage, stopReason: response.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens" };
    return { content, native, usage, stopReason: "end_turn" };
  }
}

// ---------------------------------------------------------------- Google (Gemini)

/**
 * The history as Gemini contents. Gemini's own turns are replayed as it sent them (their thought
 * signatures included). Tool calls another model made carry no signature, which Gemini refuses on
 * a function call, so those calls and their results go in as text.
 */
export function toGeminiContents(messages: readonly AgentMessage[]): Content[] {
  const contents: Content[] = [];
  const names = new Map<string, string>();
  const asText = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = blocksOf(m);
      for (const b of blocks) if (b.type === "tool_use") names.set(b.id, b.name);
      if (m.native?.provider === "google") {
        contents.push({ role: "model", parts: m.native.data as Part[] });
        continue;
      }
      const parts: Part[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        else if (b.type === "tool_use") {
          asText.add(b.id);
          parts.push({ text: `[Called ${b.name} with ${JSON.stringify(b.input ?? {})}]` });
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    const parts: Part[] = [];
    const pictures: Part[] = [];
    for (const b of blocksOf(m)) {
      if (b.type === "tool_result") {
        const name = names.get(b.tool_use_id) ?? "tool";
        const { text, images } = resultParts(b);
        if (asText.has(b.tool_use_id)) parts.push({ text: `[${name} ${b.is_error ? "failed" : "returned"}: ${text}]` });
        else parts.push({ functionResponse: { ...(b.tool_use_id.startsWith("gemini-") ? {} : { id: b.tool_use_id }), name, response: b.is_error ? { error: text } : { output: text } } });
        for (const i of images) pictures.push({ inlineData: { mimeType: i.mediaType, data: i.data } });
      } else if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "image") {
        const img = imageOf(b);
        if (img) parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
      }
    }
    // Pictures from tool results follow the responses, so the model sees the frames it rendered.
    const all = [...parts, ...pictures];
    if (all.length) contents.push({ role: "user", parts: all });
  }
  return contents;
}

/** Gemini's reply parts as Messages blocks (its thoughts left out). */
export function fromGeminiParts(parts: readonly Part[]): ContentBlock[] {
  const content: ContentBlock[] = [];
  let calls = 0;
  for (const p of parts) {
    if (p.thought) continue;
    if (p.text) {
      const last = content[content.length - 1];
      if (last?.type === "text") last.text += p.text;
      else content.push({ type: "text", text: p.text });
    } else if (p.functionCall?.name) {
      calls++;
      content.push({ type: "tool_use", id: p.functionCall.id ?? `gemini-${Date.now().toString(36)}-${calls}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
    }
  }
  return content;
}

const GEMINI_REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

export class GeminiProvider implements ModelProvider {
  readonly id = "google" as const;
  private client: GoogleGenAI | undefined;
  constructor(client?: GoogleGenAI) {
    this.client = client;
  }

  async turn({ model, system, tools, messages, signal, onText }: TurnRequest): Promise<Turn> {
    this.client ??= new GoogleGenAI({ apiKey: envKeyOf("google") });
    const stream = await this.client.models.generateContentStream({
      model,
      contents: toGeminiContents(messages),
      config: {
        systemInstruction: system,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }],
        maxOutputTokens: MAX_TOKENS,
        abortSignal: signal,
      },
    });
    const parts: Part[] = [];
    let finish: string | undefined;
    let blocked = false;
    let usage: TurnUsage | undefined;
    for await (const chunk of stream) {
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const candidate = chunk.candidates?.[0];
      for (const p of candidate?.content?.parts ?? []) {
        parts.push(p);
        if (p.text && !p.thought) onText?.(p.text);
      }
      if (candidate?.finishReason) finish = String(candidate.finishReason);
      // Gemini caches repeated prompt starts by itself and reports the totals as it streams.
      const m = chunk.usageMetadata;
      if (m?.promptTokenCount) usage = { inputTokens: m.promptTokenCount, outputTokens: m.candidatesTokenCount ?? 0, cachedTokens: m.cachedContentTokenCount ?? 0 };
    }
    const content = fromGeminiParts(parts);
    const native: NativeTurn = { provider: "google", data: parts };
    if (blocked || (finish && GEMINI_REFUSALS.has(finish) && !content.length)) return { content, native, usage, stopReason: "refusal" };
    if (content.some((b) => b.type === "tool_use")) return { content, native, usage, stopReason: "tool_use" };
    if (finish === "MAX_TOKENS") return { content, native, usage, stopReason: "max_tokens" };
    return { content, native, usage, stopReason: "end_turn" };
  }
}

/** A provider for a model id. */
export function providerFor(model: string, given: Partial<Record<ProviderId, ModelProvider>> = {}): ModelProvider {
  const id = providerOf(model);
  return given[id] ?? (id === "openai" ? new OpenAIProvider() : id === "google" ? new GeminiProvider() : new AnthropicProvider());
}
