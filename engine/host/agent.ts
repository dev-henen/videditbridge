import type Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { EditorSession } from "../claude/session.js";
import { TOOLS, executeTool, toAnthropicTools, toToolResultContent } from "../claude/tools.js";
import { DEFAULT_MODEL, assistantOf, providerOf, type ProviderId } from "./models.js";
import { AnthropicProvider, providerFor, type AgentMessage, type ContentBlock, type ModelProvider } from "./providers.js";

export const EDITOR_SYSTEM_PROMPT = `You are a professional video editor working through editing tools inside a desktop video editor. The user watches every step live.

How to work:
- Start with get_project. Media the user mentions may already be imported; otherwise use import_media.
- When the user wants a style, browse list_templates / get_template and apply_template, then refine with individual edits. apply_template also runs the template's automation (narration in the project voice, transcription, retake and filler removal, beat sync, transition sounds); get_template lists it, so don't repeat those steps by hand.
- For talking footage: transcribe (or set_transcript), read it with get_transcript and correct misheard names with fix_transcript (save them as vocabulary first), cut weak parts (cleanup_speech, cut_ranges, assemble_from_source), then set_captions.
- For raw recordings: transcribe first (it runs locally), then find_retakes and read every sentence: remove slips the speaker corrected, abandoned sentences and lines that repeat each other (remove_retakes), then analyze_audio (sound map: speech, silence, music, loud moments), remove_silences for dead air (it never cuts into transcribed words), detect_scenes split=true to separate shots, then trim, reorder and assemble. Without a transcript this is how you know where people talk.
- Edit like a professional editor, not a clip arranger: never lay whole recordings on the timeline as they are. Watch the footage first (render_contact_sheet, analyze_audio, detect_scenes), pick the best moments, and cut them into shots (add_clip with in/duration, split_clip, assemble_from_source). Vary the framing between shots (wide, medium, close with the zoom effect or reframe), interleave sources instead of playing each one through, and give each shot a reason: a new move, a reaction, a change of angle. Keep the pace to the content: short shots (1-2 bars) for energy, longer holds for a hero moment or an opening.
- With music, the music sets the structure: detect_beats for the tempo, analyze_audio for its sections, then plan a shot list on the bar grid before adding clips. Cut on downbeats, change scene or look on phrase changes (usually every 4 or 8 bars), and end on the music's real ending or a phrase end (cut the music on downbeats to fit, never fade out mid-phrase). When people dance or move rhythmically, match the music to them: measure their tempo, pick music near it, use set_speed to lock the moves to the beat and choose in points so the moves land on beats. If the user asks you to find music, pick it by tempo and style rather than at random, and credit its license.
- Choose transitions on purpose: hard cuts are the default and carry most of a fast edit; save transitions for phrase changes and shifts in place or mood (whip or zoomin for energy, glitch for a digital or game look, fadewhite or a flashHits for a drop, fadeblack for an ending or a time jump). One or two kinds per video read as a style; a different one on every cut reads as an amateur edit. Put the middle of a transition on the beat.
- Make it lively with intent, not everywhere: add_moment_effect (zoomPunch, impactShake, flashHits) on key words and loud moments, beat_sync to cut or punch on the music, sounds tied to something visible (set_transition with sound for slides and whips, add_moment_effect with sound for punches and shakes, add_sound_effect for text pops and reveals; never a sound with nothing on screen to match), and looks such as bokeh, glow, lightLeak, handheld or smoothZoom from list_effects.
- For people on camera: retouch (beauty with region "face" places itself on the detected face; backgroundBlur with subject "person" and replaceBackground follow the real outline of the person, frame by frame), then check it with render_frame. For 16:9 footage in a 9:16 video, run reframe so the crop keeps each person. Use detect_faces to place titles and callouts in empty space, never over a face; follow_face makes a name label follow a person, and reframe with follow pans the crop with them. animate_layer moves, scales, turns or fades any layer over time; animate_effect ramps an effect's settings; speed_ramp makes fast-then-slow-motion moments. For bad sound: enhance_audio on the speaking clips; set_volume and set_speed for levels and pacing; list_audio_effects for creative sound.
- After meaningful changes, look at your work with render_contact_sheet or render_frame and fix anything that looks off (text over faces or busy backgrounds, captions too long, bad pacing). Before render_preview of a finished edit, run review_edit and fix its problems.
- Finish with render_preview so the user can watch the result, then briefly say what you did and what could be changed. Only call render_video when the user asks to export.
- A request may start with "[About the clip|text layer|media layer|shape layer|audio clip <id> picked in the timeline, ...]". Then "this", "it" and "here" mean that item: act on it by its id, and keep other items as they are unless asked.
- A request may also carry "[Spot picked in the frame: x .., y .. ... at ..s on the timeline]": "here" means that point (frame fractions, the same as layer positions). Place things there, or use it to tell which person or object is meant (detect_faces shows who is at that point).
- When taste decides (the narration voice, the music, a title style), let the user choose: make the options (preview_voice for voices, render_frame for looks), call offer_choices, and end your turn. Their pick comes back as the next message, starting with "[Choice:".
- The user's own files: when they mention footage, music, photos or a script they have ("my beach videos", "the song in Downloads", "follow my script"), find it with search_files, read documents with read_document, and bring media in with copy_to_project. You can only read their folders and copy media into the project; never suggest that you changed anything else.
- Memory: you are told the user's standing instructions and what you remember about them and this project; follow them. When you learn something lasting (a preference, their brand, who is in the video, what it is for), save it with remember (general for every project, project for this one). Do not save one-off steps.
- Plans: for big or open requests (a full edit from raw footage, a restyle) or when asked, look first, then propose_plan and end your turn; edit once the user approves (their message starts with "[Plan approved"). For small, clear changes, just make them.
- Keep replies short and plain; the user sees each step in the activity feed.`;

/** Added to the system prompt in plan mode: look, then propose, change nothing. */
export const PLAN_MODE = `Plan mode is on: the user wants a plan before any edit. Do not change the project (editing tools are not available now). Look at what you need (get_project, render_contact_sheet, analyze_audio, get_transcript, search_files, read_document), then call propose_plan with concrete steps and end your turn.`;

export { AGENT_MODELS, DEFAULT_MODEL } from "./models.js";
export type { AgentMessage } from "./providers.js";

export interface AgentCallbacks {
  /** Streamed assistant text. */
  onText?: (delta: string) => void;
  /** How full the context is now (tokens), after each step. */
  onUsage?: (contextTokens: number) => void;
  /** The conversation so far was summarized to keep requests small. */
  onCompact?: (summary: string) => void;
}

export interface AgentRequest {
  /** Model id for this request (AGENT_MODELS); the agent's model when left out. */
  model?: string;
  /** Pictures the model should see with the request, as PNG, JPEG, GIF or WebP files. */
  images?: string[];
  /** Added to the system prompt: the user's instructions and what the model remembers (workspace.ts, memoryContext). */
  context?: string;
  /** Plan mode: only tools that change nothing, and propose_plan at the end. */
  planMode?: boolean;
  /**
   * The most tokens the conversation may hold before it is summarized (the user's setting). Every
   * step reads the whole conversation, so a long one costs more and more; this keeps it bounded.
   */
  contextLimit?: number;
  /** Summarize by itself at the limit (default true); otherwise only when asked (compact). */
  autoCompact?: boolean;
}

/** The provider's cheapest model, which writes the summaries. */
const SUMMARY_MODEL: Record<ProviderId, string> = { anthropic: "claude-haiku-5-5", openai: "gpt-6-luna", google: "gemini-3.5-flash-lite" };

const SUMMARY_SYSTEM = `You compress a conversation between a user and an AI video editor so the editor can continue without the full history. Write a concise summary (at most about 400 words) with: the user's goals and preferences, what has been done (the key edits, with clip and layer ids where they matter), decisions and anything the user rejected, open questions, and the task under way now with its next step. Plain text, no preamble.`;

/** About how many tokens messages hold: four characters a token, a picture about 1,600. */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  let pictures = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.type === "image") {
        pictures++;
        return;
      }
      for (const [k, x] of Object.entries(o)) if (k !== "native") walk(x);
    }
  };
  for (const m of messages) walk(m.content);
  return Math.ceil(chars / 4) + pictures * 1600;
}

/** The conversation as plain text for the summary (no tools, so any model can read it). */
function transcriptOf(messages: readonly AgentMessage[]): string {
  const out: string[] = [];
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content } as ContentBlock] : (m.content as ContentBlock[]);
    for (const b of blocks) {
      if (b.type === "text" && b.text.trim()) out.push(`${m.role === "user" ? "User" : "Editor"}: ${cut(b.text.trim(), 4000)}`);
      else if (b.type === "tool_use") out.push(`Editor used ${b.name} ${cut(JSON.stringify(b.input ?? {}), 300)}`);
      else if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content : ((b.content ?? []) as ContentBlock[]).map((c) => (c.type === "text" ? c.text : "[picture]")).join(" ");
        out.push(`  result${b.is_error ? " (error)" : ""}: ${cut(text, 500)}`);
      } else if (b.type === "image") out.push("[picture]");
    }
  }
  return out.join("\n");
}

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** The API's limit for one image. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The conversation without pictures, for saving: rendered frames and contact sheets are large, and
 * Claude can render them again. Each picture becomes a short note.
 */
export function withoutImages(messages: AgentMessage[]): AgentMessage[] {
  const strip = (blocks: unknown): unknown =>
    Array.isArray(blocks)
      ? blocks.map((b: { type?: string; content?: unknown }) =>
          b.type === "image" ? { type: "text", text: "[picture not kept; render it again to look]" } : b.type === "tool_result" ? { ...b, content: strip(b.content) } : b,
        )
      : blocks;
  return messages.map((m) => ({ ...m, content: strip(m.content) }) as AgentMessage);
}

/**
 * The editing agent bound to one session: Claude by default, or ChatGPT or Gemini (the model id
 * picks the provider, see models.ts). Keeps the conversation so follow-up instructions ("make the
 * title bigger") have context, and it carries on when the model changes. History is append-only.
 */
export class EditorAgent {
  private readonly providers: Partial<Record<ProviderId, ModelProvider>>;
  private model: string;
  private readonly messages: AgentMessage[];
  private controller: AbortController | undefined;
  private busy = false;

  constructor(
    private readonly session: EditorSession,
    opts: {
      /** An Anthropic client for Claude's requests. */
      client?: Anthropic;
      /** Providers to use instead of the built-in ones (tests). */
      providers?: Partial<Record<ProviderId, ModelProvider>>;
      model?: string;
      messages?: AgentMessage[];
    } = {},
  ) {
    this.providers = { ...(opts.client ? { anthropic: new AnthropicProvider(opts.client) } : {}), ...opts.providers };
    this.model = opts.model ?? DEFAULT_MODEL;
    this.messages = [...(opts.messages ?? [])];
  }

  get running(): boolean {
    return this.busy;
  }

  /** The conversation so far, in the Messages API format. */
  get history(): readonly AgentMessage[] {
    return this.messages;
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** How many tokens the context held at the last step the provider measured, and how many messages that covered. */
  private contextTokens = 0;
  private measured = 0;

  /** How full the context is now: the last measure plus an estimate of what came after it. */
  get contextSize(): number {
    return this.contextTokens + estimateTokens(this.messages.slice(this.measured));
  }

  /**
   * Summarize the conversation so far (with the provider's cheapest model) and go on from the summary:
   * a long conversation then costs a short one's price per step. The project is not affected.
   */
  async compact(callbacks: AgentCallbacks = {}): Promise<string> {
    if (this.busy) throw new Error(`${assistantOf(this.model)} is working; compact when it is done`);
    if (this.messages.length < 2) return "";
    const provider = (this.providers[providerOf(this.model)] ??= providerFor(this.model));
    const summary = await this.summarize(provider, new AbortController().signal);
    // Outside a request: the summary, and an answer, so the next request follows as usual.
    this.messages.splice(0, this.messages.length, { role: "user", content: this.summaryText(summary) }, { role: "assistant", content: "Understood. I have the summary of our conversation and will go on from there." });
    this.contextTokens = estimateTokens(this.messages);
    this.measured = this.messages.length;
    callbacks.onCompact?.(summary);
    callbacks.onUsage?.(this.contextTokens);
    return summary;
  }

  /** Inside a request: everything so far becomes one message with the summary, and the request goes on from it. */
  private async compactNow(provider: ModelProvider, signal: AbortSignal, callbacks: AgentCallbacks): Promise<void> {
    const summary = await this.summarize(provider, signal);
    this.messages.splice(0, this.messages.length, { role: "user", content: `${this.summaryText(summary)}\n\nGo on with the task under way.` });
    this.contextTokens = estimateTokens(this.messages);
    this.measured = this.messages.length;
    callbacks.onCompact?.(summary);
    callbacks.onUsage?.(this.contextTokens);
  }

  private summaryText(summary: string): string {
    return `[The conversation so far, summarized to keep requests small. The project itself is up to date: call get_project to see it.]\n${summary}\n[End of summary]`;
  }

  private async summarize(provider: ModelProvider, signal: AbortSignal): Promise<string> {
    const transcript = transcriptOf(this.messages);
    const turn = await provider.turn({
      model: SUMMARY_MODEL[provider.id] ?? this.model,
      system: SUMMARY_SYSTEM,
      tools: [],
      messages: [{ role: "user", content: `Summarize this conversation:\n\n${transcript}` }],
      signal,
    });
    const text = turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (!text) throw new Error("The summary came back empty; the conversation was left as it was.");
    return text;
  }

  /** Messages the user sent while a request runs, for the model's next step (as in Claude Code). */
  private inbox: string[] = [];

  /**
   * The user wrote while the model works: it reads the message at its next step (after the action
   * under way), and goes on with it in mind. False when nothing is running (send it as a request).
   * A message still waiting when a request is stopped goes with the next request.
   */
  say(text: string): boolean {
    if (!this.busy) return false;
    this.inbox.push(text);
    return true;
  }

  /** The user's messages that arrived since the last step, as text for the model (and empties the inbox). */
  private takeInbox(): string | undefined {
    if (!this.inbox.length) return undefined;
    const text = this.inbox.map((m) => `[The user wrote while you were working:] ${m}`).join("\n\n");
    this.inbox = [];
    return text;
  }

  /**
   * A request stopped while tools ran leaves the model's tool calls without results, which the APIs
   * refuse; answer them as cancelled before going on.
   */
  private closeOpenToolCalls(): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const calls = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
    if (!calls.length) return;
    this.messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, is_error: true, content: "Stopped by the user before this ran." })) });
  }

  private async userContent(prompt: string, images: string[] = []): Promise<string | ContentBlock[]> {
    if (!images.length) return prompt;
    const blocks: ContentBlock[] = [];
    for (const file of images) {
      const type = IMAGE_TYPES[extname(file).toLowerCase()];
      const data = type ? await readFile(file).catch(() => undefined) : undefined;
      if (!type || !data || data.length > MAX_IMAGE_BYTES) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: type, data: data.toString("base64") } });
    }
    return [...blocks, { type: "text", text: prompt }];
  }

  async run(prompt: string, callbacks: AgentCallbacks = {}, request: AgentRequest = {}): Promise<{ stopReason: string }> {
    if (this.busy) throw new Error(`${assistantOf(this.model)} is already working on a request`);
    this.busy = true;
    if (request.model) this.model = request.model;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    // Plan mode offers only tools that change nothing (propose_plan among them).
    const tools = toAnthropicTools(request.planMode ? TOOLS.filter((t) => !t.mutates) : TOOLS);
    const system = [EDITOR_SYSTEM_PROMPT, request.planMode ? PLAN_MODE : "", request.context ?? ""].filter(Boolean).join("\n\n");
    this.closeOpenToolCalls();
    // Messages left from a stopped request come first, so they are not lost.
    const left = this.takeInbox();
    const first = left ? [left, prompt].join("\n\n") : prompt;
    this.messages.push({ role: "user", content: await this.userContent(first, request.images) });
    const id = providerOf(this.model);
    const provider = (this.providers[id] ??= providerFor(this.model));
    const thinking = this.session.startActivity("info", `${assistantOf(this.model)} is thinking`);
    try {
      // Whether this request has written any text yet (the next step's text then starts a new paragraph).
      let spoke = false;
      for (let turn = 0; turn < 80; turn++) {
        if (signal.aborted) return { stopReason: "cancelled" };
        // At the limit, the conversation so far becomes a summary before the next step reads it all again.
        if (request.contextLimit && request.autoCompact !== false && this.contextTokens + estimateTokens(this.messages.slice(this.measured)) >= request.contextLimit) {
          await this.compactNow(provider, signal, callbacks);
        }
        // Each step's text starts a new paragraph after an earlier step's (they arrive as one stream).
        let fresh = true;
        const onText = (delta: string) => {
          if (fresh && spoke) callbacks.onText?.("\n\n");
          fresh = false;
          spoke = true;
          callbacks.onText?.(delta);
        };
        const reply = await provider.turn({ model: this.model, system, tools, messages: this.messages, signal, onText });
        if (reply.usage) {
          // Exact from here: what the model read and wrote is the context now.
          this.contextTokens = reply.usage.inputTokens + reply.usage.outputTokens;
          this.measured = this.messages.length + 1;
          callbacks.onUsage?.(this.contextTokens);
        }

        if (reply.stopReason === "refusal") return { stopReason: "refusal" };
        // An empty reply still needs content: the Messages format refuses an empty assistant turn.
        const content = reply.content.length ? reply.content : [{ type: "text" as const, text: "(no reply)" }];
        this.messages.push({ role: "assistant", content, ...(reply.native ? { native: reply.native } : {}) });
        if (reply.stopReason === "pause_turn") continue;
        const toolUses = reply.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
        if (reply.stopReason !== "tool_use" || toolUses.length === 0) {
          // The user wrote while this step ran: answer that before ending the turn.
          const said = reply.stopReason === "end_turn" ? this.takeInbox() : undefined;
          if (!said) return { stopReason: reply.stopReason };
          this.messages.push({ role: "user", content: said });
          continue;
        }

        // Edits depend on each other: run in order, return all results in one user message.
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          // A model can still ask for a tool it was not offered: in plan mode, editing waits for approval.
          const result =
            request.planMode && TOOLS.find((t) => t.name === use.name)?.mutates
              ? { text: "Plan mode is on: nothing can change until the user approves a plan. Call propose_plan.", isError: true }
              : await executeTool(this.session, use.name, use.input);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: result.isError ?? false,
            content: (await toToolResultContent(result)) as Anthropic.Beta.BetaToolResultBlockParam["content"],
          });
        }
        // What the user wrote meanwhile rides with the results, so the next step takes it into account.
        const said = this.takeInbox();
        this.messages.push({ role: "user", content: said ? [...results, { type: "text", text: said }] : results });
      }
      return { stopReason: "turn_limit" };
    } catch (e) {
      if (signal.aborted) return { stopReason: "cancelled" };
      throw e;
    } finally {
      thinking.done();
      this.busy = false;
      this.controller = undefined;
    }
  }
}
