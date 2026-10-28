# CLI: `ave`

After `npm run build`, the `ave` binary is available (`npx ave …`). From source, run `npx tsx engine/cli.ts …`.

Relative media paths in a project file resolve against the project file's folder.

| Command | Description |
|---|---|
| `ave templates [query]` | List templates, optionally filtered (e.g. `ave templates podcast`) |
| `ave template <id> [--json]` | Print a template brief, or its JSON spec with `--json` |
| `ave validate <project.json>` | Validate a project. Exits 1 on errors |
| `ave summary <project.json>` | Print the readable timeline summary |
| `ave render <project.json> <out.mp4>` | Render a video. Options: `--scale 0.5`, `--preset ultrafast`, `--start s`, `--end s`, `--fonts dir`, `--cache dir` (reuse processed clips between runs), `--software` (x264 only, no graphics card encoder) |
| `ave frame <project.json> <time> <out.png>` | Render one frame. Options: `--scale`, `--fonts`, `--cache dir` |
| `ave sheet <project.json> <out.png>` | Render a contact sheet. Options: `--columns 4`, `--rows 3`, `--fonts`, `--cache dir` |
| `ave captions <project.json> <out.srt\|vtt\|ass>` | Export captions; the format comes from the file extension |
| `ave probe <media>` | Print duration, size, fps and audio/video presence as JSON |
| `ave check` | Check that this FFmpeg build has every filter, encoder and decoder the renderer uses; exits 1 and lists what is missing otherwise |
| `ave tools` | Print the Claude tool definitions as JSON (Messages API `tools` format) |

