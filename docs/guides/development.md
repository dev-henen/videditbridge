# Building from source

How to build and run VideditBridge from this repository, how it is laid out, and where to extend it. For using the app, see the [user guide](https://dev-henen.github.io/videditbridge/). For using the engine as a library, see [Getting started](getting-started.md).

## What you need

- Node 20 or newer.
- Rust (stable), for the native kernels and the GPU render engine. On Windows also the Visual Studio C++ build tools and the Windows SDK.
- .NET 10 SDK, for the desktop app.
- On Linux, VLC for video playback in the app (`sudo apt install vlc`). Windows and macOS get LibVLC with the app.

## Build and test

```bash
npm install              # ffmpeg-static, onnxruntime-node, transformers and kokoro-js are optional dependencies
npm run native           # builds the Rust addon (native/ave-native) and the GPU render engine (native/ave-render)
npm test                 # unit and integration tests (integration renders are skipped without FFmpeg)
FULL_RENDER=1 npm test   # also renders every template end to end
npm run build
```

`npx vitest run --exclude "**/*.integration.test.ts"` runs only the fast unit tests, and `npx tsc --noEmit` typechecks.

On Linux x64, install with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install`. Without it, onnxruntime-node's install script tries to download CUDA binaries from a GitHub release that no longer exists, and npm quietly leaves out onnxruntime-node, transformers and kokoro-js (transcription, voices and the vision models). The app runs its models on the processor, so nothing is lost. `node scripts/check-optional-deps.mjs` says whether every optional dependency installed.

### FFmpeg

The FFmpeg binary is looked up in this order: the `ffmpegPath` option, `$FFMPEG_PATH`, `ffmpeg-static`, then `ffmpeg` on `PATH`. It needs libass and libfreetype, which the `ffmpeg-static` and gyan.dev builds include.

### The desktop app

```bash
dotnet run --project ui          # pass a project folder to open it directly
dotnet build ui -r linux-x64     # or osx-arm64: check that the other systems compile
```

The app starts the engine host itself (`engine/host`, JSON-RPC over stdio). In development it needs Node 20 or newer (found on `PATH`, in the usual Homebrew and nvm places, or through `AVE_NODE`) and this repository's `node_modules`. Installers are built by `scripts/package-app.ts` on each system; see [ui/Packaging/README.md](../../ui/Packaging/README.md).

## Repository layout

One folder per part, named for what it is: `engine/` (TypeScript), `native/` (Rust) and `ui/` (C#). Each owns its code and build.

```
engine/              TypeScript: the editing engine (library, AI tools, CLI, host for the app)
  core/              Project schema (zod), timeline math, pure edit operations, validation, summaries
  library/           Catalogs: effects (and masks), transitions, animations, caption styles, components, templates
  tools/             Render (FFmpeg and the GPU engine), audio, vision, transcript, captions, voice-over, graphics, fonts, review
    native/          Loader for the Rust addon (native/ave-native)
  claude/            EditorSession (state, undo and redo, events, live activities) and the tool definitions
  host/              Engine host for the desktop app: JSON-RPC over stdio, project storage, the agent loop and providers
  mcp/               The MCP server, so other AI apps can edit (see mcp.md)
  cli.ts             The `ave` command line
native/              Rust: ave-native (CPU kernels as a Node addon) and ave-render (the GPU render engine). See native/README.md
ui/                  C# (Avalonia): the desktop app for Windows, macOS and Linux, one folder per part of the screen
  Shell/             The window, its tabs and the page of one project
  Tabs/              The tab strip
  Preview/           Frames and video (LibVLC), live follow, scrubbing, pointing at a spot
  Timeline/          The timeline strip
  Session/           The side panel: activity, review, summary, history
  Chat/              The chat with the AI: messages, the model and effort pickers, plans
  Projects/          The projects page
  Settings/          The settings tab: AI models, connections, rendering, folders
  Setup/             The first-start performance test
  Engine/            The JSON-RPC client that starts and talks to engine/host
  Shared/            Icons and helpers
  Assets/ Packaging/ Fonts and icons; per-system packaging
test/                Tests, grouped like engine/, plus repo/ (repository-wide checks) and helpers/ (fixtures and oracles)
assets/              Bundled open fonts and models
scripts/             Docs, native builds, packaging, the user guide site
site/                The user guide (published to GitHub Pages)
docs/                guides/ (hand-written), reference/ (generated), design/ (plans and their status)
examples/            claude-agent.ts: an AI editing a video while you watch the preview
```

Dependencies only point downward: `host → claude → tools → library → core`. `core` and `library` never import `tools` or `claude`. Rust code is reached only through `engine/tools/native`, and the GPU engine only through `engine/tools/render/engine.ts`. Every area can be imported on its own: `videditbridge/core`, `/library`, `/tools`, `/claude`.

## Extending

- `registerEffect`, `registerComponent`, `registerCaptionStyle` and `registerTemplate` add to the catalogs. Templates are validated JSON, so an AI can write them too; see [Templates](templates.md).
- Template text can use placeholders: `{{slot}}`, `{{item.field}}`, `{{index}}`, `{{theme.accentColor}}`, `{{list.0.media}}`.
- Transcription and voice-over run locally by default (`LocalWhisperTranscriber`, `LocalTTS`). Implement `TranscriptionProvider` or `TTSProvider` to plug in another engine. Optional classes for OpenAI, Deepgram and ElevenLabs are included; they need your own key and are never used unless you pass one in.
- A new tool goes in `engine/claude/tools.ts`; see [Claude integration](claude-integration.md#adding-your-own-tool). After changing any tool or catalog item, run `npm run docs` to regenerate `docs/reference`.

## Known limits

- Rendering a single frame decodes the timeline up to that point, so frames late in long videos are slower.
- Media layers support fade and slide animations; the other animations apply to text and shapes.
