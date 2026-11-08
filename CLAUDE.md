# ai-video-editor, notes for Claude

TypeScript (ESM, NodeNext: relative imports end in `.js`). Node ≥ 20. Rendering is FFmpeg via `ffmpeg-static`. Hot CPU kernels are Rust (`native/`), reached only through `engine/tools/native`. The GPU render engine (`native/ave-render`) is a separate process reached only through `engine/tools/render/engine.ts`.

## Layout
- `engine/` TypeScript (the editing engine: library, Claude tools, CLI, app host), `native/` Rust (speed-critical kernels), `ui/` C# desktop app, `assets/` bundled fonts and models, `scripts/` doc and native builds.
- `ui/` has one folder per part of the screen (`Shell`, `Tabs`, `Preview`, `Timeline`, `Session`, `Chat`, `Projects`), plus `Setup` (the first-start performance test window, shown before the editor), `Settings` (the settings tab: API key, default model, renderer, hardware encoding, folders; kept by the host in settings.json in the app's data folder, `settings.get` and `settings.set`), `Engine` (host client) and `Shared`. The menu button at the top left opens a side panel (`Shell/MainWindow`) with the open tabs, recently closed projects, a new tab and settings. Namespaces follow folders. A part is a UserControl with its own handlers and styles. `Shell/MainWindow` lays out the tabs (in the title bar) and one page per tab; `Shell/ProjectView` lays out one project's page (commands bar, `Session` on the left, preview and timeline, `Chat` on the right) and connects its parts' events.
- Tests live in `test/<area>/`, mirroring `engine` (`core`, `library`, `render`, `audio`, `vision`, `video`, `transcript`, `claude`, `host`, `native`), plus `test/repo/` for repository-wide checks and `test/helpers/` for fixtures and oracles. Put a new test in the folder of the code it tests.

## Commands
- `npm test` runs unit and integration tests; integration renders real video (~3 min). `FULL_RENDER=1 npm test` renders all templates.
- `npx vitest run --exclude "**/*.integration.test.ts"` gives fast unit tests only.
- `npx tsc --noEmit` typechecks. `npx tsx engine/cli.ts <cmd>` runs the CLI from source.
- `npm run native` builds the Rust addon (`native/ave-native`) and the GPU render engine (`native/ave-render`) for this machine; tests need them. `cd native && cargo test --release` runs the Rust tests (on Windows add `--target x86_64-pc-windows-msvc` inside the Visual Studio environment; `npm run native` does that itself).
- Scratch renders go in `test/.output/` (gitignored).
- `npm run docs` regenerates `docs/reference/*` (except `api.md` and `cli.md`, which are hand-written) from the catalogs and tools. Run it after changing any tool, effect, transition, animation, caption style, component or template. `test/repo/docs.test.ts` fails when these files are stale. Keep `docs/guides/*` accurate by hand.

## Rust (native/)
- Move code to Rust only when it is on a hot path (per pixel, sample or frame, and a measured share of the time) and ports easily behind the same function; see section 3.5 of `docs/design/cinematic-grade-and-vfx.md`.
- Calls are coarse (a whole buffer), run off the JavaScript thread and return promises; a panic becomes an error. A kernel that works through many frames takes a `TaskControl` (call it through `controlled` with the caller's `signal`), counts a step per frame and stops when cancelled.
- A port keeps the old TypeScript in `test/helpers/` as the oracle for a parity test, and records a benchmark in the guide that uses it. No silent TypeScript fallback at runtime.

## Architecture rules
- Layers: `core` ← `library` ← `tools` ← `claude`. `core` and `library` must never import from `tools` or `claude`. `applyTemplate` takes an injected `probe` for this reason.
- `core/operations.ts` functions are pure: clone, then return a new Project. The session stores history snapshots, so mutating breaks undo.
- Captions are derived at render time from `project.transcripts` through clip mapping (`tools/captions/build.ts#timelineWords`). Don't store timeline-time captions when transcripts exist.
- Catalog items (effects, transitions, animations, caption styles, components, templates) are self-describing. Descriptions are read by Claude, so keep them clear and specific.
- Templates are pure JSON specs (`library/templates/catalog/*`) interpreted by `builder.ts`. Add new looks as data, not code.

## Desktop app (ui, C# Avalonia, Windows/macOS/Linux)
- It talks to `engine/host/main.ts` over stdio JSON-RPC. stdout carries protocol messages only; the host routes `console.log` to stderr. To add a host method, define it in `main.ts` and call it from `ProjectViewModel` (one per open project; its calls carry `project`) or `AppViewModel` (the app and its tabs).
- Several projects are open at once, one per tab, each with its own session, conversations and renders; nothing in a tab's page is shared with another tab. Host notifications carry `project`, and the app routes them to that tab.
- Projects live in `projects/<slug>/` (gitignored app storage), and the host autosaves them, with `cover.png` (a frame of the edit, for the projects page; the app draws a default cover until there is one) and `.conversations/` (chats with Claude, continued when the project opens).
- The app is AI-first: people edit by asking Claude. It is not a manual editor (not competing with CapCut or Premiere), so direct interaction serves the conversation (pointing Claude at a clip, reviewing what it offers, undo) rather than drag-to-trim editing.
- UI rules from the user:
  - compact default window (960x460)
  - dark neutral palette with blue as the primary color (buttons, selection, playhead, focus); no purple or other accents
  - icon glyphs from the bundled Fluent UI System Icons font (`Icons.cs` names them; `Assets/Fonts`), not Segoe (Windows-only)
  - no emoji, no em or en dashes in any text
  - the timeline is a compact preview strip by default
- Nothing Windows-only: dialogs through `StorageProvider`, video and audio through LibVLC (`Playback/Player.cs`, frames drawn into a bitmap so overlays stay on top), UI font Segoe UI on Windows and bundled Inter elsewhere.
- Build with `dotnet build ui` (add `-r linux-x64` or `-r osx-arm64` to check the other systems compile). Test the host with `test/host/host.integration.test.ts`.

## GPU render engine (plan.ts, native/ave-render)
- `render` takes `backend` (`ffmpeg`, `engine`, `auto`); the default comes from the app's first-start performance test (`setDefaultBackend`). See `docs/guides/render-engine.md`.
- `plan.ts` copies `compile.ts`'s timing and rounding (frame counts, xfade offsets, fit sizes, crop and overlay positions). Change both together, and run `test/render/engine.integration.test.ts` (both backends, compared frame by frame).
- The engine is the default (`auto`, FFmpeg on failure). A feature the engine cannot draw yet goes in `engineGaps`, which makes that part of the picture a piece the FFmpeg backend draws for it (`compileProject`'s `piece`); porting a feature means drawing it natively and taking it out of `engineGaps`. `native/ave-render/src/plan.rs` mirrors the plan types.

## Renderer gotchas (compile.ts)
- Every primary segment ends with `fps`, `format=yuv420p` (`yuv420p10le` in deep renders: 10-bit and ProRes exports), `setsar=1` and `settb=AVTB`. `concat` outputs AV_TIME_BASE, and `xfade` fails if the timebases differ.
- Effects pin formats with `yuvFormat`, `rgbFormat`, `gbrFormat` and `grayFormat` (helpers.ts), never a literal 8-bit format on the picture path, so deep renders stay deep. Deep RGB is 12-bit: FFmpeg 6.1's blend screen is wrong on 16-bit planes.
- Text, shapes and captions all go into one ASS file (`overlay.ass`, with PlayRes equal to the project size, even for scaled previews), applied with the `ass` filter. ffmpeg runs with `cwd` set to the work dir so the filename needs no escaping.
- Image outputs (frame, contact sheet) must consume the audio graph with `anullsink`.
- The filter graph goes through `-filter_complex_script` to avoid Windows command-line limits.
- File paths inside filter arguments go through `escapeFilterPath`. It escapes for two levels, since `\`, `'` and `:` are legal in macOS and Linux names.
- Default fonts are the bundled open fonts in `assets/fonts/` (Arimo, Archivo Black, Gelasio and others), never system fonts like Arial. Renders call `prepareFonts`, which copies them into the fonts folder and replaces missing system fonts (`FONT_REPLACEMENTS`).
- App data folders come from `engine/tools/appdirs.ts` (`defaultModelsDir`, `defaultFontsDir`); don't hard-code `~/.cache`.
