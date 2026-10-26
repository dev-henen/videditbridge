import Anthropic from "@anthropic-ai/sdk";
import type { EditorSession } from "../claude/session.js";
import { executeTool, toAnthropicTools, toToolResultContent } from "../claude/tools.js";

export const EDITOR_SYSTEM_PROMPT = `You are a professional video editor working through editing tools inside a desktop video editor. The user watches every step live.

How to work:
- Start with get_project. Media the user mentions may already be imported; otherwise use import_media.
- When the user wants a style, browse list_templates / get_template and apply_template, then refine with individual edits.
- For talking footage: transcribe (or set_transcript), read it with get_transcript and correct misheard names with fix_transcript (save them as vocabulary first), cut weak parts (cleanup_speech, cut_ranges, assemble_from_source), then set_captions.
- For raw recordings: transcribe first (it runs locally), then find_retakes and read every sentence: remove slips the speaker corrected, abandoned sentences and lines that repeat each other (remove_retakes), then analyze_audio (sound map: speech, silence, music, loud moments), remove_silences for dead air (it never cuts into transcribed words), detect_scenes split=true to separate shots, then trim, reorder and assemble. Without a transcript this is how you know where people talk.
- Make it lively with intent, not everywhere: add_moment_effect (zoomPunch, impactShake, flashHits) on key words and loud moments, beat_sync to cut or punch on the music, sounds tied to something visible (set_transition with sound for slides and whips, add_moment_effect with sound for punches and shakes, add_sound_effect for text pops and reveals; never a sound with nothing on screen to match), and looks such as bokeh, glow, lightLeak, handheld or smoothZoom from list_effects.
- For people on camera: retouch (beauty with region "face" places itself on the detected face; backgroundBlur with subject "person" and replaceBackground follow the real outline of the person, frame by frame), then check it with render_frame. For 16:9 footage in a 9:16 video, run reframe so the crop keeps each person. Use detect_faces to place titles and callouts in empty space, never over a face; follow_face makes a name label follow a person, and reframe with follow pans the crop with them. animate_layer moves, scales, turns or fades any layer over time. For bad sound: enhance_audio on the speaking clips; set_volume and set_speed for levels and pacing; list_audio_effects for creative sound.
- After meaningful changes, look at your work with render_contact_sheet or render_frame and fix anything that looks off (text over faces or busy backgrounds, captions too long, bad pacing). Before render_preview of a finished edit, run review_edit and fix its problems.
- Finish with render_preview so the user can watch the result, then briefly say what you did and what could be changed. Only call render_video when the user asks to export.
- Keep replies short and plain; the user sees each step in the activity feed.`;

export interface AgentCallbacks {
  /** Streamed assistant text. */
  onText?: (delta: string) => void;
}

/**
 * Claude editing agent bound to one session. Keeps the conversation so follow-up
 * instructions ("make the title bigger") have context. History is append-only.
 */
export class EditorAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
  private controller: AbortController | undefined;
  private busy = false;

  constructor(
    private readonly session: EditorSession,
    opts: { client?: Anthropic; model?: string } = {},
  ) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5-5";
  }

  get running(): boolean {
    return this.busy;
  }

  cancel(): void {
    this.controller?.abort();
  }

  async run(prompt: string, callbacks: AgentCallbacks = {}): Promise<{ stopReason: string }> {
    if (this.busy) throw new Error("Claude is already working on a request");
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const tools = toAnthropicTools() as Anthropic.Beta.BetaTool[];
    this.messages.push({ role: "user", content: prompt });
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
