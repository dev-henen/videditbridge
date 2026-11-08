# Rendering & preview

Rendering code is in [engine/tools/render](../../engine/tools/render). People watch edits live in the desktop app (ui), which shows the frames and previews these functions render.

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
  fontsDir: "./fonts",     // extra fonts; the bundled ones are copied in (default: the app fonts folder)
  onProgress: (p) => console.log(Math.round(p * 100) + "%"),
  signal,                  // AbortSignal
  keepWorkDir: true,       // keep graph.txt + overlay.ass for debugging
  cacheDir: ".render/cache", // reuse processed clips between renders (see below)
  hardware: true,          // graphics card encoder for full-quality renders (default)
  backend: "auto",         // draw the picture on the GPU engine when it can (see below)
});

await renderFrame(project, 12.5, { output: "frame.png", scale: 0.5 });
await renderContactSheet(project, { output: "sheet.png", columns: 4, rows: 3, thumbWidth: 320 });
```

All of these call `probeAssets` first unless you pass `probe: false`. Probing fills in each asset's missing duration, size and audio flag.

`backend` picks what draws the picture of `render`: `"ffmpeg"` (the filter graph described below), `"engine"` (the GPU render engine) or `"auto"` (the engine when it can draw the whole project). Without it, renders use `setDefaultBackend`'s choice, which the app takes from its first-run performance test. See [GPU render engine & performance test](render-engine.md).

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

**Frame-exact clips.** Each clip gets exactly the frames whose times fall inside it on the timeline (`trim=end_frame`, padded with a copy of the last frame if a filter came up short). Without this, the fps filter rounded every clip up a frame, and cuts drifted from captions, overlays and sound over a long edit.

## Render cache

With `cacheDir` (Claude sessions set it to `<outputDir>/cache` by default), each primary clip's picture is rendered once to the cache and reused:

- **What is cached:** the source decode, speed, fit, clip effects and fades, plus the global effects that work frame by frame (effects with `perFrame` in the catalog: color, grades, blur, sharpen, vignette, glow, bokeh, grain…). Global effects that change over time (shakes, flashes, light leaks, auto correct) stay on the joined video, after the first of them.
- **The key** is the source file (path, size, modified time), the clip's trim, speed, fit, effects and fades, the output size and frame rate, and the baked global effects. Moving a clip, or editing another, keeps its entry.
- **Format:** x264 ultrafast at CRF 12 in `.mkv`, visually lossless (SSIM 0.99) and quick to read back. About 6.5 MB per second at 1080p.
- **When it fills:** `render`, `renderContactSheet` and `renderForAnalysis` (review) add missing clips, two or three at a time; `renderFrame` only uses what is there. Entries are written to a temporary name first, and the folder is kept under `cacheBytes` (4 GB by default) by deleting the least recently used.

On a laptop (2-core i3), 12 s of a 62 s edit with graded, Ken Burns and glow clips took 112 s uncached, 108 s from an empty cache, 21 s on the next render, and 37 s after changing one clip's grade.

Running a global per-frame effect on each clip instead of the joined video only differs during transitions, where each side is graded before the blend rather than after.

## Proxy media

With `proxies: true`, videos larger than 1920 px are read from a 1280 px copy in the cache's `proxies` folder (x264 with a keyframe every half second, sound copied). Missing proxies are made in the background, one at a time, so the first preview uses the originals and later ones are faster: a 4K preview frame took 2.8 s from the original and 0.64 s from the proxy. `render_frame`, `render_contact_sheet`, `render_preview` and the app's frames use proxies; final renders, thumbnails and measurements (review, color matching) never do. `makeProxies(project)` makes them up front.

## Hardware encoding

`render` encodes on the graphics card when one works, trying each system's own encoders once per process with a tiny test encode: NVENC, Quick Sync, then AMF on Windows; VideoToolbox on macOS (its constant quality needs Apple silicon); NVENC, Quick Sync, then VAAPI on Linux (the device is `$AVE_VAAPI_DEVICE`, by default `/dev/dri/renderD128`, and the frames are uploaded to it at the end of the graph). 10-bit and ProRes exports always encode in software. Quality follows `export.crf` (Quick Sync at quality 22 matched x264 CRF 20 in SSIM and size). It is only used when the x264 preset is slower than `veryfast`, because x264 `ultrafast` previews are already quicker, and a failed hardware encode falls back to x264. Pass `hardware: false` (CLI `--software`) to always use x264. On the same laptop Quick Sync encoded 1080p about 3.6 times faster than x264 `medium`.

**Preview scaling.** With `scale`, the whole graph runs at reduced resolution, which is about 4× faster at 0.5. The ASS file keeps the full-size coordinate space, so text and captions land exactly where they will in the final render.

**Preview reuse.** `render_preview` names the file after what it shows: a hash of the project (without its metadata), the scale and the range, as `preview-<hash>.mp4` in the output folder. When that file is there, it is shown again without rendering, so an unchanged edit (after an undo, or when the app reopens) plays at once. A preview is written under another name first, so a cancelled render is never taken for a finished one.

**Why an export takes longer than a preview.** A preview renders a quarter of the pixels (scale 0.5), reads proxies, and encodes with x264 `ultrafast`; an export renders full size from the originals with the project's preset, and none of the preview's cached clips fit it. Effects that work out a formula at every pixel (`custom` filters with `geq`) grow with the pixel count: one such green-screen stage cost about 8 s a frame at 960x540 and 29 s at 1920x1080 on the reference laptop, which makes a 42 s export take hours. The `chromaKey` effect with a `backdrop` does the same job with compiled filters at about 0.6 s a frame at 1080p.

## Layers behind the subject

A media or graphic layer with `behindSubject: true` goes behind the people in the video (smoke, light beams, props behind a dancer). Before compiling, `render` renders the main picture once (clips, transitions and whole-video effects, no layers, half size, from proxies), finds the people in it with the person cutout model, and caches the cutout by the main picture's content in the cache's `masks` folder, shared by previews and exports. In the graph, after each such layer, the picture from just before it is laid back on top through the cutout (grown two pixels and softened), so the people stay in front of that layer and of nothing that was not already in front. The first render after a change to the clips takes longer while it looks for them.
