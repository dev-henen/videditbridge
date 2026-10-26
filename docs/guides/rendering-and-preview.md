# Rendering & live preview

Rendering code is in [src/tools/render](../../src/tools/render), and the preview server is in [src/tools/preview](../../src/tools/preview).

## FFmpeg

The binary is chosen in this order: the `ffmpegPath` option, `$FFMPEG_PATH`, the `ffmpeg-static` package, then `ffmpeg` on `PATH`. It must include libass (text and captions) and libfreetype. The `ffmpeg-static` and gyan.dev builds do. `probe(file)` inspects media with `ffmpeg -i`, so ffprobe isn't needed.

## Render functions

```ts
await render(project, {
  output: "out/final.mp4",
  baseDir,                 // where relative media paths resolve
  scale: 0.5,              // fast preview: the whole graph runs at half size
  preset: "ultrafast",     // x264 preset override
  range: { start: 10, end: 20 },
  fontsDir: "./fonts",
  onProgress: (p) => console.log(Math.round(p * 100) + "%"),
  signal,                  // AbortSignal
  keepWorkDir: true,       // keep graph.txt + overlay.ass for debugging
});

await renderFrame(project, 12.5, { output: "frame.png", scale: 0.5 });
await renderContactSheet(project, { output: "sheet.png", columns: 4, rows: 3, thumbWidth: 320 });
```

All of these call `probeAssets` first unless you pass `probe: false`. Probing fills in each asset's missing duration, size and audio flag.

## Reviewing an edit

`reviewEdit(project, { workDir })` (the `review_edit` tool) checks an edit for what a viewer notices and reports each problem with timeline times. It changes nothing.

| Check | What it looks for |
|---|---|
| `text` | Text that is hard to read against the picture behind it, runs off the frame, or overlaps captions or other text |
| `safe-zones` | Text and captions where TikTok, Reels and Shorts draw their buttons and captions (portrait videos; pick one app with `platform`) |
| `frames` | Black or frozen footage, and the same footage used twice |
| `speech` | Words cut off at an edit, words shown twice in captions, captions over silence, and speech the transcript skipped |
| `audio` | Integrated loudness away from the target (-14 LUFS by default), true peaks over -1 dBTP, a voice driven past full scale, music less than 10 dB under the voice |
| `key` | Screen color a chroma key left behind |

It costs one analysis render: `renderForAnalysis` runs the graph once at about 360 px, without text and captions, and writes raw frames at the sample times plus the audio mix and its voice and music parts as WAV files. Black and frozen footage is found by scanning the source clips. A 60 s edit takes about a minute and a half, against several minutes for a full render.

Readability is judged from the text's estimated box (font size times length) and its fill color; text with its own outline, shadow or box counts as readable anywhere. Faces are not detected yet, so text over a face is not reported.

`compileProject(project, opts)` is pure. It returns `{ args, files, filterGraph, timeline, duration, width, height }` without touching disk, which helps for inspecting or testing the generated graph.

## How a project becomes FFmpeg

1. **Inputs.** Each clip, layer and audio clip becomes its own input, trimmed with `-ss`/`-t`. Images use `-loop 1`, and colors and gradients use lavfi sources.
2. **Primary track.** Each clip is normalized (speed, fit, fps, effects, fades, yuv420p, `settb=AVTB`), with matching audio padded to the exact length. Clips are then joined with `xfade` + `acrossfade` for transitions and `concat` for cuts.
3. **Global effects** are applied to the joined track.
4. **Media layers** are composited with `overlay`, using time-shifted streams, alpha fades and slide expressions.
5. **Text, shapes and captions** are written to one ASS subtitle file and burned in with the `ass` filter (libass). Animations are ASS override tags. Each layer is split into enter, hold and exit events so entrance and exit can each use their own motion.
6. **Audio.** Voices are mixed, music is ducked with `sidechaincompress`, everything else is mixed in, and a limiter is applied.
7. The output is H.264 + AAC with `+faststart`.

The graph is passed through `-filter_complex_script`, which avoids Windows command-line length limits. FFmpeg runs in a temporary work directory.

**Preview scaling.** With `scale`, the whole graph runs at reduced resolution, which is about 4× faster at 0.5. The ASS file keeps the full-size coordinate space, so text and captions land exactly where they will in the final render.

## Live preview server

```ts
const preview = await startPreviewServer(session, { port: 4321, autoContactSheet: true });
console.log(preview.url);
// later: await preview.close();
```

Or from the CLI, watching a project file: `ave preview project.json`.

The page shows:

- **Frame viewer** with a scrubber. Each position renders a frame on demand, cached per revision.
- **Contact sheet** that re-renders automatically about 1s after edits stop.
- **Preview video**: a low-res MP4 rendered on request.
- **Timeline** with lanes for primary clips (transitions hatched), layers, audio and caption chunks. Click a lane to move the playhead.
- **Issues** from validation, the **edit history** (newest first), **undo/redo** buttons, the session **log**, and recent **renders** (renders from older revisions are dimmed).

The page updates over server-sent events whenever the session changes. Renders run one at a time through a queue, so the machine doesn't get flooded.

The server accepts any object matching `PreviewSource`, so it works with your own session types. `EditorSession` satisfies it.

### HTTP API

| Endpoint | |
|---|---|
| `GET /` | The preview page |
| `GET /events` | SSE stream of `state` events |
| `GET /api/state` | Current state snapshot (timeline, summary, issues, history, renders) |
| `GET /api/project` | Raw project JSON |
| `GET /api/frame?t=1.5` | PNG frame at 0.5× scale |
| `POST /api/contact-sheet` | Render a contact sheet |
| `POST /api/preview` | Render a preview video |
| `POST /api/undo`, `POST /api/redo` | |
| `GET /media/<path>` | Files from the output directory (supports range requests) |

The server binds to `127.0.0.1` by default. It has no authentication, so don't expose it publicly.
