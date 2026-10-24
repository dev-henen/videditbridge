/**
 * Claude edits a video with the library's tools while you watch in the live preview.
 *
 *   npx tsx examples/claude-agent.ts "Make a 30s vertical highlight from talk.mp4 with bold captions"
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile). Optional: OPENAI_API_KEY enables
 * transcription and voice-over. Media paths in the prompt resolve against the current directory.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EditorSession, executeTool, toAnthropicTools, toToolResultContent } from "../src/claude/index.js";
import { startPreviewServer } from "../src/tools/preview/index.js";
import { OpenAITranscriber } from "../src/tools/transcript/index.js";
import { OpenAITTS } from "../src/tools/voiceover/index.js";

const SYSTEM = `You are a professional video editor working through editing tools.

How to work:
- Start with get_project. Import media with import_media before using it.
- When the user wants a style, browse list_templates / get_template and apply_template; then refine the result with individual edits.
- For talking footage: transcribe (or set_transcript), read it with get_transcript, cut weak parts (cleanup_speech, cut_ranges, assemble_from_source), then set_captions.
- After meaningful changes, LOOK at your work with render_contact_sheet or render_frame and fix anything off (text overlapping faces, captions too long, bad pacing).
- The user watches a live preview of every edit, so make steady, purposeful changes.
- Finish with render_preview, then summarize what you did and the remaining options. Only call render_video when the user asks for the final file.`;

const prompt = process.argv.slice(2).join(" ") || "Create a 10 second quote-card video that says 'Make it simple, but significant.' by Don Draper.";

const session = new EditorSession(undefined, {
  baseDir: process.cwd(),
  transcriber: process.env.OPENAI_API_KEY ? new OpenAITranscriber() : undefined,
  tts: process.env.OPENAI_API_KEY ? new OpenAITTS() : undefined,
});
const preview = await startPreviewServer(session);
console.log(`Live preview: ${preview.url}\n`);

const client = new Anthropic();
const tools = toAnthropicTools() as Anthropic.Beta.BetaTool[];
const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];

try {
  for (let turn = 0; turn < 60; turn++) {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      output_config: { effort: "high" },
      // Retry declined requests on a fallback model automatically.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools,
      messages,
    });
    stream.on("text", (delta) => process.stdout.write(delta));
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      console.error("\nRequest declined.");
      break;
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: message.content });

    // Edits depend on each other, so run them in order; return all results in one user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      console.log(`\n→ ${use.name} ${JSON.stringify(use.input).slice(0, 160)}`);
      // executeTool validates the input against the tool's schema and never throws.
      const result = await executeTool(session, use.name, use.input);
      console.log(`  ${result.isError ? "✗" : "✓"} ${result.text.split("\n")[0]}`);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: result.isError ?? false,
        content: (await toToolResultContent(result)) as Anthropic.Beta.BetaToolResultBlockParam["content"],
      });
    }
    messages.push({ role: "user", content: results });
  }
} finally {
  console.log(`\n\nPreview still running at ${preview.url} — Ctrl+C to exit.`);
}
