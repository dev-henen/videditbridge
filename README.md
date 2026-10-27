# ai-video-editor

An AI-native video editing library. The edit is a plain JSON document that Claude (or any model) can read and change through ~46 tools. Rendering goes through FFmpeg.

- **33 templates** that describe a style of video in JSON (viral talking head, podcast clip, listicle, documentary, real-estate tour, wedding film…). Claude can read them, follow their editing guidance, and write new ones.
- **Transcription on your machine**: a local Whisper model gives word-timed transcripts with no account or key. Also reads Whisper, Deepgram, AssemblyAI, SRT and VTT files. Search speech, find fillers, stutters, retakes and repeats, and cut them. Captions stay in sync after every edit.
- **14 caption styles** (bold-pop/Hormozi, karaoke, word-by-word, boxed, neon, cinematic…), exportable as SRT, VTT or ASS.
- **38 effects** (color grades, Ken Burns, punch-in zooms, shake, glitch, letterbox…), **46 transitions**, and **14 text animations**.
- **14 components**: lower-thirds, title cards, CTAs, subscribe buttons, quotes, number badges, countdowns, end screens.
- **Voice-over on your machine**: a local neural voice model (27 English voices) with measured word timings, so narration gets captions. No account or key.
- **Desktop app**: a native Windows app (app/VideoEditor) where you edit by asking Claude and watch every edit land, with the timeline, frames, preview video and review findings. Claude can also render frames and contact sheets to check its own work.

**Documentation:** [docs/](docs/README.md) has guides plus a reference for every Claude tool, template, effect, transition, animation, caption style and component.

## Desktop app

`app/VideoEditor` is a native Windows app (C# / WPF, .NET 10). It opens projects stored in `projects/` and shows a live session view:

- what is running now, with progress
- an activity feed
- a viewer that follows the latest render
- a compact timeline strip
- an "Ask Claude" box (requires `ANTHROPIC_API_KEY` to be set)

```bash
dotnet run --project app/VideoEditor          # pass a project folder to open it directly
```

The app starts the engine host itself (`src/host`, JSON-RPC over stdio). It needs Node 20+ on PATH and this repository's `node_modules`.

## Layout

```
src/
  core/        Project schema (zod), timeline math, pure edit operations, validation, summaries
  library/     Catalogs: effects, transitions, animations, caption-styles, components, templates
  tools/       transcript, captions, voiceover, render (FFmpeg), preview (live web UI)
  claude/      EditorSession (state, undo/redo, events, live activities) + tool definitions for Claude
  host/        Engine host for the desktop app: JSON-RPC over stdio, project storage, Claude agent loop
  cli.ts       `ave` command line
app/           Native desktop app (C# WPF)
examples/      claude-agent.ts: Claude editing a video while you watch the preview
test/          unit tests + real FFmpeg integration renders
```

Dependencies only point downward: `host → claude → tools → library → core`. `core` and `library` never import `tools` or `claude`.

Every area can be imported on its own: `ai-video-editor/core`, `/library`, `/tools`, `/claude`.

## Setup

```bash
npm install          # includes ffmpeg-static as an optional dependency
npm test             # unit + integration tests (integration renders are skipped if FFmpeg is missing)
FULL_RENDER=1 npm test   # also renders every template end-to-end
npm run build
```

The FFmpeg binary is looked up in this order: `ffmpegPath` option, `$FFMPEG_PATH`, `ffmpeg-static`, then `ffmpeg` on `PATH`. It needs libass and libfreetype, which the `ffmpeg-static` and gyan.dev builds include.

## Quick start

### Build from a template

```ts
import { applyTemplate, probe, render } from "ai-video-editor";

const { project, warnings } = await applyTemplate("viral-talking-head", {
  main: { src: "talk.mp4", transcript },          // transcript enables captions
  hook: "Nobody tells you this about editing",
  cta: "Follow for part 2",
  music: "beat.mp3",
}, { probe: (src) => probe(src) });

await render(project, { output: "out/short.mp4" });
```

### Edit by hand (pure functions, never mutate)

```ts
import { createProject, addAsset, addClip, addLayer, setCaptions, addComponent } from "ai-video-editor";

let p = createProject({ aspectRatio: "16:9" });
p = addAsset(p, { type: "video", id: "a", src: "a.mp4" });
p = addClip(p, { assetId: "a", in: 2, duration: 8, effects: [{ type: "cinematic" }] });
p = addLayer(p, { type: "text", text: "Chapter 1", start: 0, duration: 3, animationIn: { type: "pop" } });
p = addComponent(p, { component: "lower-third", start: 1, params: { name: "Ada", title: "Engineer" } }).project;
```

### Let Claude edit

```ts
import { EditorSession, executeTool, toAnthropicTools, toToolResultContent } from "ai-video-editor";

const session = new EditorSession();
const tools = toAnthropicTools();                       // pass as `tools` to the Messages API
// for each tool_use block from Claude:
const result = await executeTool(session, block.name, block.input);
const content = await toToolResultContent(result);      // text + rendered frames as images
```

`examples/claude-agent.ts` has the complete loop:

```bash
npx tsx examples/claude-agent.ts "Turn podcast.mp4 into a 45s vertical clip with karaoke captions"
```

The tool layer has no dependency on the Anthropic SDK. The future connector (an MCP server) can wrap `TOOLS` and `executeTool` directly.

## The project document

```jsonc
{
  "settings": { "width": 1080, "height": 1920, "fps": 30 },
  "assets":  [{ "type": "video", "id": "talk", "src": "talk.mp4" }],
  "clips":   [{ "id": "c1", "assetId": "talk", "in": 3, "duration": 12,
                "effects": [{ "type": "punchIn" }], "transition": { "type": "fade", "duration": 0.4 } }],
  "layers":  [{ "type": "text", "id": "t1", "text": "Wait for it", "start": 0, "duration": 3,
                "position": { "x": 0.5, "y": 0.2 }, "animationIn": { "type": "pop" } }],
  "audio":   [{ "id": "m", "assetId": "beat", "role": "music", "loop": true, "volume": 0.2 }],
  "transcripts": { "talk": { "words": [{ "text": "Hello", "start": 3.1, "end": 3.4 }] } },
  "captions": { "style": "bold-pop" }
}
```

- `clips` form the primary track and play back-to-back. A clip's `transition` blends it in from the previous clip.
- `layers` draw on top in array order: `media` for PiP and b-roll, `text`, and `shape`. Text and shapes are rendered with libass, so they always sit above media layers.
- Positions and sizes are fractions of the frame (0-1). Times are in seconds.
- Captions are rebuilt from source transcripts at render time, so they survive trims, cuts, reordering and speed changes.
- Music is ducked under speech by default (sidechain compression).

`projectJsonSchema()` returns the JSON Schema. `validateProject()` reports problems before a render, and `summarizeProject()` gives a compact text timeline for a model to read.

## Previews

The desktop app (app/VideoEditor) shows edits as they land: the timeline, frames, preview video, history and review findings. In code, `renderFrame`, `renderContactSheet` and `render` with `scale` give the same previews.

Previews render the whole filter graph at reduced size. Text stays in full-size coordinates, so the layout matches the final render.

## CLI

```
ave templates [query]            ave template <id> [--json]
ave validate <project.json>      ave summary <project.json>
ave render <project.json> <out.mp4> [--scale 0.5] [--preset ultrafast] [--start s --end s]
ave frame <project.json> <t> <out.png>     ave sheet <project.json> <out.png>
ave captions <project.json> <out.srt|vtt|ass>
ave probe <media>   ave tools
```

## Extending

- `registerEffect`, `registerComponent`, `registerCaptionStyle` and `registerTemplate` add to the catalogs. Templates are validated JSON, so Claude can author them.
- Template text can use placeholders: `{{slot}}`, `{{item.field}}`, `{{index}}`, `{{theme.accentColor}}`, `{{list.0.media}}`.
- Transcription and voice-over run locally by default (`LocalWhisperTranscriber`, `LocalTTS`). Implement `TranscriptionProvider` or `TTSProvider` to plug in another engine. Optional classes for OpenAI, Deepgram and ElevenLabs are included for anyone who wants them; they need your own key and are never used unless you pass one in.

## Known limits

- Rendering a single frame decodes the timeline up to that point, so frames late in long videos are slower.
- Shapes are rectangles only. Media layers support fade and slide animations; the other animations apply to text and shapes.
- Fonts come from the system. Pass `fontsDir` to use bundled `.ttf`/`.otf` files.
