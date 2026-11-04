# GPU render engine & performance test

The GPU render engine draws the picture of an edit on the graphics card, in float, instead of in FFmpeg's filter graph. It is step E1 of [the cinematic design](../design/cinematic-grade-and-vfx.md) (section 3.4), and it is still growing: it draws part of what the FFmpeg backend draws, and projects that use anything else render with FFmpeg as before. The first time the desktop app starts, a short performance test decides which of the two renders this machine's videos.

## Using it

```ts
await render(project, { output: "out.mp4", backend: "auto" });
```

| `backend` | What renders the picture |
|---|---|
| `"ffmpeg"` | The FFmpeg filter graph on the processor. The default until `setDefaultBackend` is called |
| `"engine"` | The GPU engine. An error names what it cannot draw yet (`engineUnsupported(project)` lists the same) |
| `"auto"` | The engine when it can draw the whole project and is built, else FFmpeg |

The engine renders whole videos only: a `range`, `proxies` (previews), frames, contact sheets and analysis renders use FFmpeg. `setDefaultBackend(backend)` sets the backend of renders that do not name one; the app's host sets it from the performance test.

**Building.** `npm run native` builds the engine with the Rust kernels and copies it to `native/ave-render/ave-render.<platform>-<arch>[-msvc|-gnu][.exe]`, where `enginePath()` finds it (`$AVE_RENDER_PATH` overrides). `engineInfo()` opens the graphics device and names it.

## What it draws

| Area | Drawn by the engine |
|---|---|
| Clips | Video, images, colors and gradients; every fit (cover with focus, contain, stretch, blur); speed, speed ramps and reverse; fade in and out |
| Effects | On clips, media layers and the whole video: every per-pixel color effect (grades, `adjust`, `color` without its spatial controls, temperature, tint, curves, LUT files and more), `blur`, `vignette`, `letterbox`, `chromaticAberration`, `grain`, `glitch`, `flash`, `fadeIn`, `fadeOut`, `zoom`, `kenBurns`, `punchIn`, `pulse` |
| Transitions | Every xfade transition in the catalog except `dissolve`, `radial`, `distance`, the squeezes, the slices and the winds, plus the custom `circlereveal` |
| Media layers | Position, size, fit, opacity, every blend mode, fades and slide animations, position and opacity keyframes, effects |
| Text, shapes, captions | Burned in by the encoder from the same ASS file as the FFmpeg backend |
| Sound | Mixed by the FFmpeg backend's graph, muxed by the engine's encoder |

Every template renders on the engine. Not yet: effects with masks or keyframes, effects that work across frames or regions (denoise, stabilize, sharpen, beauty, background blur and replacement, sky, depth, removal, the motion effects of the motion catalog), the remaining transitions, scale, rotation, 3D and corner pin keyframes on layers, layer masks, rounded corners, shadows, layers behind the subject, smooth motion.

## How it works

1. **Plan.** `planProject(project, opts)` (`engine/tools/render/plan.ts`) is pure, like `compileProject`: it turns the project into an engine plan, one item per clip and layer use, each with the ffmpeg arguments that decode its source, its fitted size and offset, its frames and fades. It uses the FFmpeg backend's own timing (frame counts, xfade offsets, the speed ramp expression), so both backends show the same frame at the same time.
2. **Engine.** `native/ave-render` is a separate process speaking JSON-RPC over stdio (`info`, `render` with `progress` notifications, `cancel`, `shutdown`); a driver crash takes down only the engine. It uses `wgpu`: Direct3D 12 on Windows, Metal on macOS, Vulkan or GL on Linux. It only opens the system's own API, because probing every backend loads Vulkan drivers on Windows too and an old Intel one crashed the process.
3. **Per frame.** Decoders (ffmpeg, a few frames ahead on their own threads) give packed 8-bit YUV (`vuya`). Each item is scaled in two passes with swscale's bicubic (B 0, C 0.6, widened when shrinking) and clamped in YUV, as FFmpeg's scale does, then turned into float RGB. Its effects run as GPU passes, then the primary picture (fades, transitions), the whole-video effects and the layers are composited in `rgba16float`, and the finished frame goes back to YUV for the encoder (ffmpeg, which also burns in the text and muxes the sound).

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
- Blend modes run on RGB clipped to 0..1, as FFmpeg's `gbrp` blend does; normal layers mix unclamped, as overlay does in YUV.
- The `perspective` filter (the zoompan-style motion effects) counts frames from 1.
- `crop` rounds its position to nearest, ties to even (`lrint`), before the chroma grid; `pad` and `overlay` truncate. A 9:16 cover of 16:9 footage lands on a half pixel, so this moved the picture by 2 pixels.
- xfade's pixel format follows the filter after it: when the first whole-video effect takes RGB only (`colorbalance`, `curves`, `colortemperature`, or a baked table), the transitions run on RGB, where dips go to plain black and white, chroma is full size and `fadegrays` averages R, G and B (`transitionsInRgb`).
- libass takes whole milliseconds, so the engine's encoder times frames in AV_TIME_BASE before the `ass` filter, as the backend's are; a caption starting exactly on a frame otherwise showed a frame early.
- `zoomin` fills the frame with one sample of the outgoing clip halfway through; its color comes from xfade's half-size chroma plane, so the engine takes it from the 2 x 2 block that plane covers.
- Some chains drop a clip's last frame in FFmpeg, and the backend repeats the one before; the engine shows the real frame, so the parity test leaves such frames out and counts them.

**Gradients.** FFmpeg's `gradients` source starts at a random angle on every run, so the FFmpeg backend drew gradient assets differently each time. Both renderers now draw them with `gradientSource` (`compile.ts`): one frame from `geq`, the colors evenly spaced along the direction, repeated.

**Parity check.** `test/render/engine.integration.test.ts` renders projects with both backends losslessly and compares every frame: clips with cover, contain, speed, fades and transitions gave a mean ΔE 2000 of 0.38 (worst frame 1.06); layers with opacity, fades, blend modes and text 0.3 (worst 0.49). The test requires a mean under 1 and every frame under 2.

## Speed

On the reference laptop (Intel UHD, 2-core i3), a 7.5 s 1080x1920 edit with two clips, a crossfade, a screen-blended picture and a title took 13.7 to 14.2 s on the engine and 15.8 to 15.9 s on FFmpeg. Encoding takes most of the time, and the engine still waits for each frame's readback before drawing the next; overlapping the two (E3) is the next speed step.

## Performance test

`benchmarkBackends()` renders a 4.5 s 1920x1080 test edit (generated footage, a crossfade, a blended picture overlay, a title) with each renderer, compares 5 frames of the two videos, and picks a default:

- The engine's picture must match FFmpeg's within a mean ΔE 2000 of 3, or it is not used (a driver bug shows up as far more).
- The graphics card is chosen only when it is at least 5% faster: closer results are noise, and FFmpeg draws every effect.
- The report (`PerformanceReport`: choice, reason, adapter, frames per second of each) is kept in the app's data folder (`performance.json`, see `performanceFile()`); `applyPerformance` makes its choice the default (`"auto"` for the graphics card, so projects it cannot draw yet still render).

The whole test takes about 35 s on the reference laptop. Repeated runs there gave 9 to 10 frames per second for each renderer, sometimes one ahead and sometimes the other, so the processor stays the default on it.

**In the app.** On the first start (no report yet), the app opens a performance window before the editor (`ui/Setup/PerformanceWindow`): a gauge with the live render speed in frames per second and a mark at real time, then the speed of each renderer, whether the pictures match, and the choice. The host methods are `performance.get` and `performance.run` (with `performance.progress` notifications: stage, step, progress, adapter, frames). Deleting `performance.json` runs the test again at the next start.
