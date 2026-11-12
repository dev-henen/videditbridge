# GPU render engine & performance test

The GPU render engine draws the picture of an edit on the graphics card, in float, instead of in FFmpeg's filter graph. It is the default renderer ([the cinematic design](../design/cinematic-grade-and-vfx.md), section 3.4). What it does not draw itself yet comes from the FFmpeg backend as pieces (see Pieces), so it renders every project. The FFmpeg backend stays as the fallback and the reference. The first time the desktop app starts, a short performance test checks that the engine works on this machine.

## Using it

```ts
await render(project, { output: "out.mp4", backend: "auto" });
```

| `backend` | What renders the picture |
|---|---|
| `"ffmpeg"` | The FFmpeg filter graph on the processor |
| `"engine"` | The GPU engine. An error when it is not built or fails |
| `"auto"` | The engine, and FFmpeg when the engine is not built, the options need FFmpeg, or the engine fails (reported on stderr). The default until `setDefaultBackend` is called |

Both renderers work on BT.601 YUV, which FFmpeg uses wherever a filter needs RGB: footage stored with BT.709 or BT.2020 is brought to it as it is read (`workingMatrix`, the asset's `colorMatrix`), and the finished picture is written as BT.709 and tagged so (`OUTPUT_MATRIX`). A single frame restarted in the middle of a clip keeps the whole decode's frame count (with the asset's `fps`), so it shows the frame the export has there even when the footage's rate differs from the edit's.

The engine opens the graphics device at start and builds each shader pipeline on first use, with all of them started on threads at once: it answers in under a second where building them in a row took 11 s on the reference laptop (Intel UHD, Direct3D 12).

Videos with a `range` or `proxies`, and analysis renders, use FFmpeg. Single frames (`renderFrame`, `renderFrameShared`), live playback and contact sheets draw on the engine's long-lived preview sessions (see Previews). `setDefaultBackend(backend, frames)` sets the backend of renders that do not name one, and of frames and contact sheets; the app's host sets both from the performance test.

**Building.** `npm run native` builds the engine with the Rust kernels and copies it to `native/ave-render/ave-render.<platform>-<arch>[-msvc|-gnu][.exe]`, where `enginePath()` finds it (`$AVE_RENDER_PATH` overrides). `engineInfo()` opens the graphics device and names it.

## What it draws

| Area | Drawn by the engine |
|---|---|
| Clips | Video, images, colors and gradients; every fit (cover with focus, contain, stretch, blur); speed, speed ramps and reverse; fade in and out |
| Effects | On clips, media layers and the whole video: every per-pixel color effect (grades, `adjust`, `color` without its spatial controls, temperature, tint, curves, LUT files and more), `blur`, `vignette`, `letterbox`, `chromaticAberration`, `grain`, `glitch`, `flash`, `fadeIn`, `fadeOut`, `zoom`, `kenBurns`, `punchIn`, `pulse`; the film looks (`halation`, `bloom`, `anamorphicFlare`, `filmGrain`, `gateWeave`, `printFilm`, `lensDistortion`); the light effects (`glow`, `lightRays`, `lightLeak`, `bokehLights`); the camera moves (`handheld`, `vibrate`, `earthquake`, `impactShake`, `shake`, `tilt`, `smoothZoom`, `zoomPunch`, `heartbeat`); `pixelate`, `mirror`, `bokeh`, `sharpen`, `zoomBlur`, `vhs` |
| Transitions | Every transition in the catalog, xfade's and the custom `circlereveal` |
| Media layers | Position, size, fit, opacity, every blend mode, fades and slide animations, position and opacity keyframes, rounded corners, effects |
| Text, shapes, captions | Burned in by the encoder from the same ASS file as the FFmpeg backend |
| Sound | Mixed by the FFmpeg backend's graph on its own (`audioOnly`: no video is decoded for it), muxed by the engine's encoder |

Every template renders on the engine. Drawn as FFmpeg pieces for now (`engineBridged(project)` lists them in a project): effects with masks or keyframes, effects that work across frames or regions (`denoise`, `stabilize`, `autoCorrect`, `motionBlur`, `trails`, `rackFocus`, `chromaKey`, `beauty`, background blur and replacement, sky, depth, removal), the color panel's vignette and clarity, scale, rotation, 3D and corner pin keyframes on layers, shadows, layer masks, layers behind the subject, smooth motion and moving crop focus.

**How effects become operations** (`plan-effects.ts`). Each one copies its FFmpeg filters:

- **Shared numbers.** An effect's numbers come from one function both renderers call (`GLOWS`, `grainSpec`, `gateWeave` and `lensDistortion` in `film.ts`; `glowEffect`, `lightRays`, `lightLeakSpeeds` and `bokehOrbs` in `motion.ts`), so the FFmpeg graph and the engine plan cannot drift apart.
- **FFmpeg's expressions** are evaluated per frame by `engine/core/expr.ts`, which follows libavutil's eval.c in doubles. Camera moves are read from the effect's own `scale`, `rotate` and `crop` chain, and `perspective` moves from its corner expressions (`on` counts from 1). A clip's frames are at j times 1/fps; whole-video effects run on the joined picture, on AV_TIME_BASE.
- **Plain chains** of filters the engine copies (color filters, `rgbashift`, `gblur`, `noise`, `eq`, `drawgrid`, `unsharp`, flips, `dilation`, `convolution`, a scale down and back up) are turned into operations filter by filter. The interpreter follows the frame format FFmpeg negotiates: RGB after RGB-only filters, back to YUV at a YUV-only filter, and a `scale` that feeds RGB-only filters converts to RGB itself.
- **Branches**: `branch` runs steps on a copy and blends it back with blend's formulas (blend_modes.c; float in RGB, 8-bit integers on luma). `average` averages several pairwise, as a chain of `blend=average` does. The glows are built this way.
- **A smaller size** (`at`): steps run on a scaled-down copy, then it is scaled back up (bicubic, area or nearest). On YUV frames FFmpeg scales 4:2:0 chroma planes on their own, so chroma takes the same path at half the size and is joined as planes. Pixelate's chroma blocks are twice its luma blocks this way (mean ΔE 2000 7.5 before, 0.46 after). `dilation` works on chroma blocks too, as on its planes (bokeh: 1.10 before, 0.23 after).
- **Copied filter internals**, from FFmpeg 6.1's source:
  - `gblur` with sigma and sigmaV, on YUV (chroma at half size) or RGB.
  - `perspective`: the source point in 1/256 pixels and its cubic with 11-bit weights (A = -0.6), or linear.
  - `lenscorrection`: its radius, and its bilinear, which reads half a pixel past the point.
  - `rotate`: about the picture's center, bilinear, black outside.
  - `crop`: rounded to nearest, kept inside, then on the chroma grid.
  - `unsharp` (`sharpen`): its cascade of two-tap sums is a binomial kernel (1 4 6 4 1 each way at 5 x 5), summed in 32 bits and rounded down by its scale bits; the amount in 1/65536 steps, on 8-bit luma.
  - `mix` (`zoomBlur`): the 8-bit planes summed, times its float 1 / n, rounded to nearest (lrintf).
  - `drawgrid` (`vhs`): the color's alpha byte (`black@0.199` is 50 / 255, as av_parse_color truncates), and 4:2:0 chroma blended once for every grid pixel of its 2 x 2 block, truncated each time, so a line every other row desaturates every chroma row (mean ΔE 2000 6.6 before, under the noise test's 1.5 after).
  - Back to YUV after RGB filters (`vhs`: `rgbashift` then `eq`): the engine's YUV steps convert each pixel as they read it.
- **Random noise.** `filmGrain`, like `grain` and `glitch`, is random in both renderers, so it matches FFmpeg in strength, not pixels; the same seed gives the same grain.

Parity per effect (`test/render/engine.integration.test.ts`, each asserted not to be bridged), mean ΔE 2000:

| Effect | Mean ΔE 2000 |
|---|---|
| `halation`, `bloom`, `anamorphicFlare` | 0.37, 0.34, 0.44 |
| `glow` | 0.27 |
| `gateWeave` | 0.16 |
| `lensDistortion` | 0.68 |
| `lightRays`, `lightLeak`, `bokehLights` | 0.34, 0.25, 0.14 |
| The camera moves | 0.08 to 0.30 |
| `pixelate` | 0.46 |
| `mirror` | 0.02 |
| `bokeh` | 0.23 |
| `sharpen` | 0.04 |
| `zoomBlur` | 0.19 |
| Glows on media layers, with transparency | 0.40 |

`filmGrain` and `vhs` pass the noise test (the picture under a blur, and the noise strength within 20%).

## Pieces

Where the engine does not draw something itself, the FFmpeg backend draws that piece of the picture and the engine reads it like any other source: `compileProject` with `piece` writes the backend's own graph for the piece, with raw frames on stdout, no sound and no text, and the engine's decoder runs it (`engineGaps` in `plan.ts` decides what becomes a piece). So a piece is the backend's picture, and masks, model mattes and media inputs work as there (`render` makes them first, `enginePieceInputs`).

| Piece | When | What the backend draws | The engine adds |
|---|---|---|---|
| Clip | A clip's fit or effects | The clip as the primary track shows it, fades left out | Fades, transitions, whole-video effects, layers |
| Layer | A media layer's effects, keyframes, shadow, 3D | The layer placed on a clear frame-size canvas (`yuva420p`), for the frames it can show on | The blend over the picture |
| Base | Whole-video effects, layer masks, layers behind the subject | The primary track and the media layers up to the last such layer | The layers above, the text |

Parity (`test/render/engine.integration.test.ts`, "pieces"): mean ΔE 2000 0.35 for clip pieces next to the engine's own transitions and fades, 0.09 for a base piece under an engine layer, 0.06 for layer pieces. A piece runs at FFmpeg's speed, and in previews it starts again with an output seek (`{time}` in `seekArgs`), which still runs the graph from the piece's start. Preview sessions keep the masks a piece reads open, as they keep media open (Windows locks the files); `closeFrameSessions` closes them.

## How it works

1. **Plan.** `planProject(project, opts)` (`engine/tools/render/plan.ts`) is pure, like `compileProject`: it turns the project into an engine plan, one item per clip and layer use, each with the ffmpeg arguments that decode its source, its fitted size and offset, its frames and fades. It uses the FFmpeg backend's own timing (frame counts, xfade offsets, the speed ramp expression), so both backends show the same frame at the same time.
2. **Engine.** `native/ave-render` is a separate process speaking JSON-RPC over stdio (`info`, `render` with `progress` notifications, `cancel`, `shutdown`); a driver crash takes down only the engine. It uses `wgpu`: Direct3D 12 on Windows, Metal on macOS, Vulkan or GL on Linux. It only opens the system's own API, because probing every backend loads Vulkan drivers on Windows too and an old Intel one crashed the process.
3. **Per frame.** Decoders (ffmpeg, a few frames ahead on their own threads) give 8-bit YUV in the format the FFmpeg backend scales that source in: planar 4:2:0 for video and JPEG pictures on the primary track (`yuv420p`) and for every layer source (`yuva420p`, with alpha), packed 4:4:4 (`vuya`) for other pictures and gradients on the primary track, which the backend scales in RGB. Each item is scaled in two passes with swscale's bicubic (B 0, C 0.6, widened when shrinking) and clamped in YUV, as FFmpeg's scale does: planar sources scale luma at full size and chroma from its half-size planes (centered, swscale's default siting), then join into float RGB, each chroma sample covering its 2 x 2 block. Its effects run as GPU passes, then the primary picture (fades, transitions), the whole-video effects and the layers are composited in `rgba16float`, and the finished frame goes back to planar 4:2:0 for the encoder (ffmpeg, which also burns in the text and muxes the sound). Chroma that is the same over its 2 x 2 block (it came in at half size) goes out as it was; chroma that went through full-size RGB goes down as swscale takes RGB to 4:2:0 (each horizontal pair averaged, the rows scaled down with its bicubic).

**Effects** (`engine/tools/render/plan-effects.ts`, `native/ave-render/src/effects.rs`) follow their FFmpeg filters:

- **Color effects** are baked, not rewritten, where the FFmpeg backend bakes them. The planner runs the effect's own `toFilter` with `noBake`, checks that every filter in the chain works pixel by pixel, and the engine runs that chain once on a Hald identity image (`haldClutChain`, the same table `bakeColor` makes for the FFmpeg backend), then applies the 64-point table with tetrahedral interpolation, as `haldclut` does. Neighboring color effects share one table. Chains the backend runs as they are (cheap ones, below `bakeColor`'s cost line) are split the way FFmpeg runs them: `eq` works on the YUV frames without clipping them to RGB, so the engine runs it as its own pass with eq's fixed-point math, and only the RGB filters around it (`colorbalance`, `curves` and the like, which FFmpeg feeds clipped RGB) become tables. A new color effect needs no engine work.
- **Motion** (`kenBurns`, `punchIn`, `pulse`, `zoom`): the planner computes each frame's crop rectangle from the effect's parameters; the zoompan-style effects sample between pixels (`perspective`), `zoom` crops whole pixels and scales with the bicubic passes.
- **Blur** is gblur's recursive filter (one step, right then left along rows, down then up columns), not a true Gaussian; chroma gets twice the sigma, as FFmpeg's half-size chroma planes do.
- **Noise** (`grain`, `glitch`) is random in both renderers, so it matches in strength, not pixels: uniform over the strength, or gaussian with deviation strength / sqrt(3), on the YUV planes, or on R, G and B after glitch's channel shift (which leaves FFmpeg's frames in RGB).
- **Transitions** copy xfade's formulas, including the float rounding of its progress (frame times in microseconds, the ratio in 32-bit floats; slides truncate `progress * width`, so this moves the seam a pixel) and its separate offsets for the half-size chroma planes. `hblur` uses running sums per row instead of a window per pixel.

**Matching FFmpeg.** The parity work found FFmpeg behaviors the engine copies:

- Conversions are BT.601 limited range both ways, as the backend's untagged conversions are, so YUV values come back as they went in. Values past video black and white stay in YUV to the end; clipping them in RGB shifted the other channels.
- A fade's start and length are rounded to whole frames (FFmpeg converts them to the 1/fps timebase), so `st=0.3, d=0.5` at 15 fps runs from frame 5 over 8 frames.
- xfade's black and white are luma 0 and 255 with chroma 127, past video black and white.
- A layer is gone after its source's last frame, and that last frame shows only at its own time (overlay's end of stream).
- A layer is on where the backend's `enable='between(t,start,end)'` is, and there `t` is the frame's time in microseconds times 1e-6, in doubles. That lands just under some starts (frame 12 at 15 fps gives 0.7999999999999999), so a layer starting at 0.2, 0.4 or 0.8 s at 15 fps shows a frame late, and the engine does the same.
- A layer's frames are moved to its start with `setpts=PTS+start/TB` on the 1/fps timebase, and setpts truncates: frame k of a layer shows at output frame k + trunc(start / (1 / fps)), in doubles (`offset` in the plan). A layer starting between frames (0.1 s at 15 fps) shows its fades and keyframes a frame earlier than its start suggests.
- xfade works on `yuv444p` (FFmpeg converts its inputs), and its result is scaled back to 4:2:0 as planes, chroma with swscale's bicubic both across and down. The engine packs a transition's frames that way when chroma differs within a block, where other pictures go down as swscale takes RGB to 4:2:0. dissolve shows it most: its pixels switch between two pictures one by one (mean ΔE 2000 1.57 before, 0.69 after).
- dissolve and the winds use xfade's `frand`, the fraction of sinf of angles up to about 1e5 times 43758.545: the GPU's sin does not match there, so the engine works it out on the processor once per plan (a table of one float a pixel), pixel-exact against FFmpeg on a black to white dissolve. The slices' bands fall on whole numbers every tenth of the frame, where the GPU's division can fall just under, so their fraction comes from integers.
- Blend modes run on RGB clipped to 0..1, as FFmpeg's `gbrp` blend does; normal layers mix unclamped, as overlay does in YUV.
- The `perspective` filter (the zoompan-style motion effects) counts frames from 1.
- `crop` rounds its position to nearest, ties to even (`lrint`), before the chroma grid; `pad` and `overlay` truncate. A 9:16 cover of 16:9 footage lands on a half pixel, so this moved the picture by 2 pixels.
- xfade's pixel format follows the filter after it: when the first whole-video effect takes RGB only (`colorbalance`, `curves`, `colortemperature`, or a baked table), the transitions run on RGB, where dips go to plain black and white, chroma is full size and `fadegrays` averages R, G and B (`transitionsInRgb`).
- libass takes whole milliseconds, so the engine's encoder times frames in AV_TIME_BASE before the `ass` filter, as the backend's are; a caption starting exactly on a frame otherwise showed a frame early.
- `zoomin` fills the frame with one sample of the outgoing clip halfway through; its color comes from xfade's half-size chroma plane, so the engine takes it from the 2 x 2 block that plane covers.
- Some chains drop a clip's last frame in FFmpeg, and the backend repeats the one before; the engine shows the real frame, so the parity test leaves such frames out and counts them.

**Gradients.** FFmpeg's `gradients` source starts at a random angle on every run, so the FFmpeg backend drew gradient assets differently each time. Both renderers now draw them with `gradientSource` (`compile.ts`): one frame from `geq`, the colors evenly spaced along the direction, repeated.

**Parity check.** `test/render/engine.integration.test.ts` renders projects with both backends losslessly and compares every frame: clips with cover, contain, speed, fades and transitions gave a mean ΔE 2000 of 0.34 (worst frame 0.89); layers with opacity, fades, blend modes and text 0.21 (worst 0.35). The test requires a mean under 1 and every frame under 2. Every test edit is 2 seconds or shorter (`MAX_SECONDS`; templates are cut to their first 2 seconds), so the whole file, with every template (`FULL_RENDER=1`), runs in about 11 minutes on the reference laptop.

## Speed

On the reference laptop (Intel UHD, 2-core i3), a 7.5 s 1080x1920 edit with two clips, a crossfade, a screen-blended picture and a title took 13.7 to 14.2 s on the engine and 15.8 to 15.9 s on FFmpeg, encoding to H.264 included; the encoder takes most of that.

Drawing alone (output thrown away), a 1080p30 clip graded with `cinematic` and a vignette, with a picture screen-blended over it, runs at 27 to 31 frames per second on the engine against 9.5 on FFmpeg, about 3x and close to real time. Each frame draws on the GPU while the one before is read back (two readback buffers).

**4:2:0 decoding (2026-11-06).** The decoders used to convert every frame to 4:4:4 VUYA on the processor, which made them the limit (89 frames per second for the 720p test clip). They now hand over 4:2:0 as decoded (325 frames per second, 1.5 bytes a pixel on the pipe instead of 4), the GPU scales the chroma planes at half size, and the engine gives the encoder 4:2:0 (2.7x less to read back, and no conversion in the encoder). In the same session on the reference laptop, which ran about 20% slower than for the numbers above (FFmpeg at 7 to 7.5 frames per second), the graded clip drew at 21.8 frames per second on average over 7 runs, against 17.9 before the change (the old engine built from the previous commit, runs alternated), about 3x FFmpeg. The decoder is no longer the limit: a flat color draws at 35 to 40 frames per second there, so the GPU passes are. Parity improved with it: of the 75 comparisons of the parity test (its earlier, longer edits), 60 came closer to FFmpeg (effects on video most, e.g. `vibrant` 0.13 to 0.02 and `kenBurns` 0.45 to 0.14 mean ΔE), while `chromaticAberration` went from 0.32 to 0.64: shifting R, G and B by whole pixels shows that FFmpeg upsamples chroma with its bicubic on the way to RGB, where the engine repeats each sample over its block.

## Previews

`renderFrame` draws on the engine by default (`setDefaultBackend`'s second argument), and on FFmpeg where the performance test found the engine not working. The preview engine is one long-lived process (`FrameSession` in `engine.ts`): each version of a project is planned once and kept open (the last three), with its color tables and decoders, so the app's scrubbing and Claude's `render_frame` do not start over. Video sources that play forwards at constant speed can start their decoder at any frame (`PlanSeek`); a decoder behind the frame wanted, or more than 1.5 s short of it, starts again there, and nearby frames read on. A frame on its own is the same picture as in an export (the parity test checks it against the engine's export, frame for frame).

**Frames for the app (2026-11-07).** `renderFrameShared(project, time, { shared })` draws a frame on the preview engine and writes it into a memory-mapped file as BGRA (a 32-byte header with a sequence number that is odd while a frame is being written, then the pixels; `native/ave-render/src/shared.rs`), with no picture file and no ffmpeg run. The app's host answers `render.scrub` this way when previews go to the engine (the project's `scrub/frame.bin`), and with a picture file otherwise, or when the engine cannot draw the edit; the app maps the file and copies the pixels into the bitmap on screen (`ui/Preview/SharedFrame.cs`). On the reference laptop a neighboring 320x180 frame took 27 ms this way against 65 to 94 ms as a picture file, and the pixels match the picture file within a mean ΔE 2000 of 0.19 (the copy turns 4:2:0 into RGB more simply than ffmpeg). Closing a project closes the preview sessions (`closeFrameSessions`), whose decoders keep its media open.

**Live viewer in the app (2026-11-07).** Two more host methods use the same shared memory:

- **Playback.** `render.play` ({ time }) plays the edit from the playhead on the preview engine (`framePlayer`: the session stays open and frames are drawn by number): frames go into `scrub/play.bin` at the edit's pace, each announced with a `preview.frame` notification ({ project, time, shared, width, height, sequence }), and frames the engine cannot keep up with are skipped; `preview.ended` follows the last frame or `render.stop`. The answer gives the edit's sound (`renderSoundMix`, a WAV file made once per revision) for the app to play alongside from the same time with LibVLC. Where previews do not go to the engine, or it cannot draw the edit, the answer is `{ live: false }` and the app plays a rendered preview video as before. On the reference laptop a half-size preview of a test edit played 19 frames in 0.7 s at 30 fps, none skipped.
- **A/B.** The host keeps the edit as it was when the latest request to Claude started; once Claude has changed it, state has `canCompare`, and `render.scrub` with `before: true` draws the frame at the playhead from that edit (into `scrub/before.bin`). The viewer's Before button flips between the two.

**Contact sheets (2026-11-07).** `renderContactSheet` draws on the preview engine like single frames: it picks the frames FFmpeg's `select` would pick (`contactSheetFrames`, which copies select's rule and its time arithmetic; the test checks it against FFmpeg's own select), the engine draws only those, and one short ffmpeg run scales and tiles them as the backend does, where FFmpeg runs its graph over the whole edit. FFmpeg's own sheet sits about a pixel off its own single frames; on a fractal still that is a mean ΔE 2000 of 2.5 against its frame, where the engine's sheet is within 0.5 of both renderers' frames.

**Text in previews (2026-11-07).** Sessions draw the text and captions themselves (`textLayer` in `planProject`, the plan's `text`). A decoder that stays open with the session runs libass on the same ASS file, on frames timed in AV_TIME_BASE as the encoder's are, and like the video decoders it starts again at any frame (`seekArgs`, with `-fps_mode passthrough`: otherwise ffmpeg repeats the first frame to fill the time before it). It draws each frame twice, over black (Y 16, U and V 128) and over (235, 240, 240), stacked. libass blends each plane linearly, so the two give each plane's blend factor and what it adds, and the engine puts the text on in YUV as it packs the frame, luma at full size and chroma at half size, as libass does on the encoder's 4:2:0 frames. A transparent picture does not work for this: libass applies a color's own opacity to the alpha twice, which fades cannot undo. Fonts now load once per session instead of once per frame, and the short ffmpeg run that follows only writes the picture. On the reference laptop, a 320x180 preview with a fading title (`test/render/engine-text.integration.test.ts`) took 65 to 94 ms for a neighboring frame and 0.5 s for a jump back, where the decoders start again, against about 0.4 s for the old ffmpeg run alone; the frames match the engine's export within a mean ΔE 2000 of 0.07 over the text. Opening a session (the first frame) still takes about 5 s there. Exports keep burning the text in the encoder. Font preparation for previews is cached for 30 seconds (`prepareFontsRecent`).

## Performance test

`benchmarkBackends()` renders a 4.5 s 1920x1080 test edit (generated footage, a crossfade, a blended picture overlay, a title) with each renderer, compares 5 frames of the two videos, and checks the engine works:

- The engine's picture must match FFmpeg's within a mean ΔE 2000 of 3, or it is not used (a driver bug shows up as far more).
- The engine is the default wherever it works, whichever was faster on the test (it also draws previews live); FFmpeg is the default only where it fails or draws a wrong picture.
- The report (`PerformanceReport`: choice, reason, adapter, frames per second of each) is kept in the app's data folder (`performance.json`, see `performanceFile()`); `applyPerformance` sets `"auto"` when the engine worked and `"ffmpeg"` when it did not. Reports from before the engine became the default (2026-11-07), which chose by speed, are read the same way.

The whole test takes about 35 s on the reference laptop. Repeated runs there gave 9 to 10 frames per second for each renderer.

**In the app.** On the first start (no report yet), the app opens a performance window before the editor (`ui/Setup/PerformanceWindow`): a gauge with the live render speed in frames per second and a mark at real time, then the speed of each renderer, whether the pictures match, and the choice. The host methods are `performance.get` and `performance.run` (with `performance.progress` notifications: stage, step, progress, adapter, frames). Deleting `performance.json` runs the test again at the next start.
