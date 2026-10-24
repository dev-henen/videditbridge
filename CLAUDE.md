# ai-video-editor, notes for Claude

TypeScript (ESM, NodeNext: relative imports end in `.js`). Node ≥ 20. Rendering is FFmpeg via `ffmpeg-static`.

## Commands
- `npm test` runs unit and integration tests; integration renders real video (~3 min). `FULL_RENDER=1 npm test` renders all templates.
- `npx vitest run --exclude "**/*.integration.test.ts"` gives fast unit tests only.
- `npx tsc --noEmit` typechecks. `npx tsx src/cli.ts <cmd>` runs the CLI from source.
- Scratch renders go in `test/.output/` (gitignored).
- `npm run docs` regenerates `docs/reference/*` (except `api.md` and `cli.md`, which are hand-written) from the catalogs and tools. Run it after changing any tool, effect, transition, animation, caption style, component or template. `test/docs.test.ts` fails when these files are stale. Keep `docs/guides/*` accurate by hand.

## Architecture rules
- Layers: `core` ← `library` ← `tools` ← `claude`. `core` and `library` must never import from `tools` or `claude`. `applyTemplate` takes an injected `probe` for this reason.
- `core/operations.ts` functions are pure: clone, then return a new Project. The session stores history snapshots, so mutating breaks undo.
- Captions are derived at render time from `project.transcripts` through clip mapping (`tools/captions/build.ts#timelineWords`). Don't store timeline-time captions when transcripts exist.
- Catalog items (effects, transitions, animations, caption styles, components, templates) are self-describing. Descriptions are read by Claude, so keep them clear and specific.
- Templates are pure JSON specs (`library/templates/catalog/*`) interpreted by `builder.ts`. Add new looks as data, not code.

## Desktop app (app/VideoEditor, C# WPF)
- It talks to `src/host/main.ts` over stdio JSON-RPC. stdout carries protocol messages only; the host routes `console.log` to stderr. To add a host method, define it in `main.ts` and call it from `MainViewModel`.
- Projects live in `projects/<slug>/` (gitignored app storage), and the host autosaves them.
- UI rules from the user:
  - compact default window (960x460)
  - monochrome palette, no purple or other color accents
  - icon glyphs from Segoe Fluent Icons
  - no emoji, no em or en dashes in any text
  - the timeline is a compact preview strip by default
- Build with `dotnet build app/VideoEditor`. Test the host with `test/host.integration.test.ts`.

## Renderer gotchas (compile.ts)
- Every primary segment ends with `fps`, `format=yuv420p`, `setsar=1` and `settb=AVTB`. `concat` outputs AV_TIME_BASE, and `xfade` fails if the timebases differ.
- Text, shapes and captions all go into one ASS file (`overlay.ass`, with PlayRes equal to the project size, even for scaled previews), applied with the `ass` filter. ffmpeg runs with `cwd` set to the work dir so the filename needs no escaping.
- Image outputs (frame, contact sheet) must consume the audio graph with `anullsink`.
- The filter graph goes through `-filter_complex_script` to avoid Windows command-line limits.
