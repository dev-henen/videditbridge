import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { EditorSession } from "../claude/session.js";
import { executeTool, toAnthropicTools, toToolResultContent } from "../claude/tools.js";

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
- Keep replies short and plain; the user sees each step in the activity feed.`;

/** Models the app offers, the first being the default. */
export const AGENT_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", description: "Most capable, for full edits" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", description: "Fast and capable" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", description: "Fastest, for small changes" },
] as const;
export const DEFAULT_MODEL = AGENT_MODELS[0].id;

export type AgentMessage = Anthropic.Beta.BetaMessageParam;

export interface AgentCallbacks {
  /** Streamed assistant text. */
  onText?: (delta: string) => void;
}

export interface AgentRequest {
  /** Model id for this request (AGENT_MODELS); the agent's model when left out. */
  model?: string;
  /** Pictures Claude should see with the request, as PNG, JPEG, GIF or WebP files. */
  images?: string[];
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
 * Claude editing agent bound to one session. Keeps the conversation so follow-up
 * instructions ("make the title bigger") have context. History is append-only.
 */
export class EditorAgent {
  private readonly client: Anthropic;
  private model: string;
  private readonly messages: AgentMessage[];
  private controller: AbortController | undefined;
  private busy = false;

  constructor(
    private readonly session: EditorSession,
    opts: { client?: Anthropic; model?: string; messages?: AgentMessage[] } = {},
  ) {
    this.client = opts.client ?? new Anthropic();
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

  /**
   * A request stopped while tools ran leaves Claude's tool calls without results, which the API
   * refuses; answer them as cancelled before going on.
   */
  private closeOpenToolCalls(): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const calls = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use");
    if (!calls.length) return;
    this.messages.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, is_error: true, content: "Stopped by the user before this ran." })) });
  }

  private async userContent(prompt: string, images: string[] = []): Promise<string | Anthropic.Beta.BetaContentBlockParam[]> {
    if (!images.length) return prompt;
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const file of images) {
      const type = IMAGE_TYPES[extname(file).toLowerCase()];
      const data = type ? await readFile(file).catch(() => undefined) : undefined;
      if (!type || !data || data.length > MAX_IMAGE_BYTES) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: type, data: data.toString("base64") } });
    }
    return [...blocks, { type: "text", text: prompt }];
  }

  async run(prompt: string, callbacks: AgentCallbacks = {}, request: AgentRequest = {}): Promise<{ stopReason: string }> {
    if (this.busy) throw new Error("Claude is already working on a request");
    this.busy = true;
    if (request.model) this.model = request.model;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const tools = toAnthropicTools() as Anthropic.Beta.BetaTool[];
    this.closeOpenToolCalls();
    this.messages.push({ role: "user", content: await this.userContent(prompt, request.images) });
    const thinking = this.session.startActivity("info", "Claude is thinking");
    try {
      for (let turn = 0; turn < 80; turn++) {
        if (signal.aborted) return { stopReason: "cancelled" };
        const stream = this.client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: 64000,
            output_config: { effort: "high" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: EDITOR_SYSTEM_PROMPT,
            tools,
            messages: this.messages,
          },
          { signal },
        );
        stream.on("text", (delta) => callbacks.onText?.(delta));
        const message = await stream.finalMessage();

        if (message.stop_reason === "refusal") return { stopReason: "refusal" };
        if (message.stop_reason === "pause_turn") {
          this.messages.push({ role: "assistant", content: message.content });
          continue;
        }
        this.messages.push({ role: "assistant", content: message.content });
        const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason !== "tool_use" || toolUses.length === 0) return { stopReason: message.stop_reason ?? "end_turn" };

        // Edits depend on each other: run in order, return all results in one user message.
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const result = await executeTool(this.session, use.name, use.input);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: result.isError ?? false,
            content: (await toToolResultContent(result)) as Anthropic.Beta.BetaToolResultBlockParam["content"],
          });
        }
        this.messages.push({ role: "user", content: results });
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
