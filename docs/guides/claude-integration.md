# Claude integration

The `claude/` layer turns the library into something Claude can operate. It has two parts:

- **`EditorSession`** ([engine/claude/session.ts](../../engine/claude/session.ts)) holds the project being edited, with undo/redo history, a revision counter, a list of rendered artifacts, and `change`, `render` and `log` events.
- **Tools** ([engine/claude/tools.ts](../../engine/claude/tools.ts)) are 46 tools with zod input schemas, listed in the [Claude tools reference](../reference/claude-tools.md).

The tool layer doesn't depend on any Anthropic package. The same definitions serve the Messages API today and an MCP connector later.

## Wiring it up

```ts
import Anthropic from "@anthropic-ai/sdk";
import { EditorSession, executeTool, toAnthropicTools, toToolResultContent } from "videditbridge";

const session = new EditorSession(undefined, { baseDir: process.cwd() });
const tools = toAnthropicTools();                       // [{ name, description, input_schema }]

// In your agent loop, for each tool_use block:
const result = await executeTool(session, block.name, block.input);
results.push({
  type: "tool_result",
  tool_use_id: block.id,
  is_error: result.isError ?? false,
  content: await toToolResultContent(result),          // text + base64 PNGs for rendered frames
});
```

[examples/claude-agent.ts](../../examples/claude-agent.ts) is a complete streaming agent loop (`claude-opus-5-5`, with refusal fallbacks enabled):

```bash
npx tsx examples/claude-agent.ts "Turn interview.mp4 into a 60s LinkedIn clip with captions"
```

## Tool behavior

- `executeTool` never throws. Invalid input, unknown ids and FFmpeg failures come back as `{ isError: true, text }` with a message Claude can act on, for example "No clip with id "x". Clip ids: c1, c2".
- Each editing tool records one undo step and reports the new video length. It also lists any validation errors the edit introduced, so Claude notices mistakes right away.
- Tools that return images (`render_frame`, `render_contact_sheet`) set `result.images`. `toToolResultContent` turns these into image blocks so Claude can see the frame.
- Run tool calls from one turn in order. Edits depend on each other.

## A good editing workflow for Claude

Put this in your system prompt (the example includes a version of it):

1. `get_project` to get oriented, then `import_media` for the user's files.
2. For a known style: `list_templates`, then `get_template` (read its editing guidance), then `apply_template`.
3. For speech: `transcribe` or `set_transcript`, then `get_transcript`, then `cleanup_speech` / `assemble_from_source` / `cut_ranges`, then `set_captions`.
4. Refine with clips, effects, layers, components and audio.
5. **Check the result** with `review_edit` (unreadable or misplaced text, safe zones, black or frozen footage, cut words, caption sync, loudness, music level, key residue, clipping, skin tones and banding from the grade, flickering mattes, drifting tracks and sliding skies), then `render_contact_sheet` (whole-video overview) and `render_frame` (detail). Fix what it finds and run `review_edit` again.
6. `render_preview` for the user. Call `render_video` only when asked for the final file.

`get_project` returns a compact text summary rather than raw JSON (pass `includeJson: true` if you need it), which keeps context use low.

## Letting the user choose

Some decisions are taste: the narration voice, the music, a title style. Claude makes the options (`preview_voice` for voices, `render_frame` for looks), calls `offer_choices` with a question and two to six options (a label, and optionally an `audio` file to play or an `image` to look at), and ends its turn. The session keeps them in `session.pendingChoices` and emits a `choices` event.

Your app shows the options, and sends the pick back as the next message, for example `[Choice: Which voice should narrate?] I pick "Heart".` Call `session.clearChoices()` when the user picks, types something else, or closes them. The desktop app shows them as cards in its Claude tab, with play buttons and thumbnails.

## Claude, ChatGPT and Gemini in the desktop app

The app's agent ([engine/host/agent.ts](../../engine/host/agent.ts)) edits with Claude by default, and also with OpenAI's and Google's models. The model id picks the provider ([engine/host/models.ts](../../engine/host/models.ts) lists the models, Claude's first); the tools, the system prompt and the editing loop are the same for all of them.

| Provider | Assistant | Key (Settings tab, or environment) | API |
| --- | --- | --- | --- |
| Anthropic (default) | Claude | `ANTHROPIC_API_KEY` | Messages |
| OpenAI | ChatGPT | `OPENAI_API_KEY` | Responses, stateless (`store: false`) |
| Google | Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `generateContent` |

The conversation is kept in one format, the Messages format, which is what saved conversations hold, and [engine/host/providers.ts](../../engine/host/providers.ts) converts it for each provider. So a conversation can switch models between requests. What a provider needs back exactly as it sent it (OpenAI's encrypted reasoning, Gemini's thought signatures) is kept with that assistant turn as `native` and replayed only to the same provider. Gemini refuses a function call without its signature, so tool calls made by another model reach Gemini as text.

Each key is stored in the system keychain under its own entry (`settings.set` with `provider` and `apiKey`). `host.info` and `settings.set` report `providers` and `models` with `available`, plus `aiAvailable` (any provider) and `claudeAvailable`.

### Keeping requests small

Every step of the loop sends the whole prompt again, so the agent keeps it small:

- **Core tools, the rest on request.** A request carries the tools for everyday edits (`CORE_TOOLS` in [engine/host/toolset.ts](../../engine/host/toolset.ts)) and `load_tools`. Every other tool is listed in the system prompt with its first sentence. The model loads tools by name, and they stay loaded for the conversation (also when it is opened again, from the tools its history used). A listed tool called without loading still runs and gets loaded. The list only grows at its end, so the providers' prompt caches stay valid. MCP clients still get every tool. This takes a request from about 45,000 tokens of tools to about 9,000.
- **Shared shapes once.** `toAnthropicTools` spells the mask out only in `grade_region` and `render_mask`. Elsewhere (effects in `add_clip`, overlays, particles, light) the schema points to `grade_region`'s mask with a few examples. Inputs are still validated against the full schema. A new large shape shared by many tools goes in `SHARED_SHAPES` in [engine/claude/tools.ts](../../engine/claude/tools.ts).
- **Earlier results shortened.** Before each new request, tool results of earlier requests that are longer than 2,000 characters keep their first 500 and a note to call the tool again, and their pictures become a note (`shortenOldResults`). During a request nothing changes, so its steps read from the cache.
- **Fewer steps.** The system prompt asks the model to make independent calls in one step and to prefer tools that do many things at once (`cut_ranges` with every range).
- **Parts of transcripts.** `get_transcript` takes `from` and `to` (source seconds) and returns only the sentences in that range, so work on one part of a long recording does not read all of it.
- **Small pictures.** `render_frame` defaults to 768 pixels on the long side and `render_contact_sheet` fits the whole sheet in 1,000 pixels (about 450 and 1,400 tokens). The model can still ask for a bigger `scale` or `thumbWidth`.
- **Effort.** The chat's effort picker (Low, Medium, High; Medium by default, and the last pick is kept in settings as `effort`) goes with each `agent.run` and reaches each provider as its own setting: Claude's `output_config.effort`, OpenAI's `reasoning.effort`, Gemini's `thinkingLevel`. Low suits small changes and spends far fewer output tokens.
- **An hour of cache on Claude.** Claude's cache marks use `ttl: "1h"`, since people often take more than 5 minutes between requests. Writing it costs 2x the input price (5 minutes: 1.25x), but each step writes only what is new and reads the rest at a tenth.

### What requests use

After each request the host adds a record to the conversation file (`requests` in `<project>/.conversations/<id>.json`, the last 500): time, model, effort, how it ended, steps, input tokens (and how many of those came from the cache), output tokens, and how often each tool ran. Use them to see what an edit costs before tuning anything.

## Providers

```ts
new EditorSession(project, {
  baseDir,                                 // relative media paths resolve here
  outputDir,                               // renders, frames and voice-overs go here (default <baseDir>/.render)
  // transcriber and tts default to the local engines (LocalWhisperTranscriber, LocalTTS).
  // Pass another engine only if you want one, e.g. the optional OpenAITranscriber.
  fontsDir: "./fonts",
  cacheDir,                                // render cache (default <outputDir>/cache); false turns it off
});
```

## Adding your own tool

```ts
import { z } from "zod";
import { registerTool, addEffect, setCaptions } from "videditbridge";

registerTool({
  name: "make_it_pop",
  description: "Apply the house style: vibrant grade and bold-pop captions.",
  input: z.object({}),
  mutates: true,
  async run(session) {
    let p = addEffect(session.project, "global", { type: "vibrant" });
    p = setCaptions(p, { style: "bold-pop" });
    session.commit(p, "make_it_pop");
    return { text: "Applied house style." };
  },
});
```

The tool then appears in `toAnthropicTools()`, runs through `executeTool`, and shows up in the generated docs.

## MCP server

The same tools are served over MCP for other AI apps (the Claude, ChatGPT and Gemini apps, Gemini CLI, Claude Code), driving the open desktop app or a session of their own. `createMcpServer(backend)` in [engine/mcp/server.ts](../../engine/mcp/server.ts) lists `TOOLS` with their JSON schemas and routes each call to `executeTool`, returning text and image content. Setup for each app is in the [MCP guide](mcp.md).

