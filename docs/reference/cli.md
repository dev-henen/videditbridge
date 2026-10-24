# CLI: `ave`

After `npm run build`, the `ave` binary is available (`npx ave …`). From source, run `npx tsx src/cli.ts …`.

Relative media paths in a project file resolve against the project file's folder.

| Command | Description |
|---|---|
| `ave templates [query]` | List templates, optionally filtered (e.g. `ave templates podcast`) |
| `ave template <id> [--json]` | Print a template brief, or its JSON spec with `--json` |
| `ave validate <project.json>` | Validate a project. Exits 1 on errors |
| `ave summary <project.json>` | Print the readable timeline summary |
| `ave render <project.json> <out.mp4>` | Render a video. Options: `--scale 0.5`, `--preset ultrafast`, `--start s`, `--end s`, `--fonts dir` |
| `ave frame <project.json> <time> <out.png>` | Render one frame. Options: `--scale`, `--fonts` |
| `ave sheet <project.json> <out.png>` | Render a contact sheet. Options: `--columns 4`, `--rows 3`, `--fonts` |
| `ave captions <project.json> <out.srt\|vtt\|ass>` | Export captions; the format comes from the file extension |
| `ave preview <project.json> [--port 4321]` | Start the live preview and reload whenever the file changes |
| `ave probe <media>` | Print duration, size, fps and audio/video presence as JSON |
| `ave tools` | Print the Claude tool definitions as JSON (Messages API `tools` format) |

`ave preview` works well alongside an AI that edits `project.json` directly, for example Claude Code: every save shows up in the browser, and parse errors appear in the page's log.
