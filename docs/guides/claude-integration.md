# Claude integration

The `claude/` layer turns the library into something Claude can operate. It has two parts:

- **`EditorSession`** ([engine/claude/session.ts](../../engine/claude/session.ts)) holds the project being edited, with undo/redo history, a revision counter, a list of rendered artifacts, and `change`, `render` and `log` events.
- **Tools** ([engine/claude/tools.ts](../../engine/claude/tools.ts)) are 46 tools with zod input schemas, listed in the [Claude tools reference](../reference/claude-tools.md).

The tool layer doesn't depend on any Anthropic package. The same definitions serve the Messages API today and an MCP connector later.

## Wiring it up

```ts
import Anthropic from "@anthropic-ai/sdk";
import { EditorSession, executeTool, toAnthropicTools, toToolResultContent } from "ai-video-editor";

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
import { registerTool, addEffect, setCaptions } from "ai-video-editor";

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

## Toward an MCP connector

An MCP server needs to:

1. keep one `EditorSession` per connection or project,
2. list `TOOLS` (names, descriptions, `z.toJSONSchema(tool.input)`), and
3. route each call to `executeTool`, returning text and image content.

