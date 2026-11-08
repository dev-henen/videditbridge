# Design: cinematic grading and common CGI effects

Status: every step of the order of work is done (2026-11-07). Section 2 is the checklist of what is left (8 items), section 11 the testing, section 12 the packaging (on hold). Proposed 2026-10-27; F1 to F3 and N0 done 2026-10-28, F4, F5 and F7 done 2026-10-30, F8 and F9 done 2026-11-01, F10 done 2026-11-02, F11, F12 and N1 done 2026-11-03, E1 done 2026-11-04, E2, E3, F6 and E4 done 2026-11-07. This is the build plan for movie-level color grading and the visual effects editors ask for most: sky replacement, glows and light effects on one object, screen replacement, depth of field, atmospherics, object removal and smooth slow motion.

The bar is professional results, not "a filter that looks similar". Every feature below has a measurable "done when" check, and every result must be something Claude can verify itself (scopes, mattes, frames) before it shows the user. Where a model is involved, candidates are compared on the same clips before one is chosen, as was done for faces (YuNet), person cutout (PP-HumanSeg) and sound (CED-tiny).

Changing the core of the project, and adding other languages, is allowed. Code on a hot path is moved to Rust where that is easy, and the rest stays in TypeScript (section 3.5); section 3.4 recommends a new core: the picture path moves from FFmpeg filter graphs to a GPU render engine with industry color management, and FFmpeg stays for decoding, encoding and audio. The feature specs in sections 4 to 7 hold for either engine; where an implementation note names an FFmpeg filter, it describes the fallback renderer.

## 1. What "professional" means here

| Area | Requirement | How it is measured |
|---|---|---|
| Precision | No banding in skies, gradients and vignettes after strong grades | Render a 10-bit gradient ramp through a heavy grade; count distinct output levels per 100 px of ramp (8-bit pipeline gives visible steps; target: no run of equal values longer than 4 px at 1080p) |
| Log footage | Camera log converts to Rec.709 exactly as the manufacturer defines it | Synthetic ramps encoded with each published log curve, converted back; max error under 0.5% of full range against the whitepaper formulas |
| Mattes | Clean edges, no flicker, no holes | IoU against hand-made reference mattes on test clips (target 0.9 for people and large objects, 0.85 for small objects); temporal flicker = mean absolute frame-to-frame matte change in regions that do not move (target under 2%) |
| Tracking | Graphics stay glued to surfaces | Synthetic: a known image warped by known homographies, corner error under 0.5 px. Real clips: drift under 2 px per 5 s at 1080p |
| Depth | Stable, ordered depth | Frame-to-frame depth change in static areas under 3% after alignment; ordering correct on test scenes (near object nearer than wall) |
| Speed | Usable on a laptop | Budgets per feature, measured on the reference machine (Intel i3-1005G1, 2 cores, 4 threads), listed per section |
| Verifiability | Claude can check its own work | Every mask has a matte preview, every grade can be checked with scopes, and `review_edit` reports the new failure modes (clipping, banding, matte flicker, track drift) |

## 2. Status and remaining work

Every step of the order of work (section 13) is done: native kernels (N0, N1), the GPU render engine as the default renderer (E1 to E4), and the features of sections 4 to 7 (F1 to F12). Each feature section ends with what was built and how it differs from the plan.

What is left to wrap up, as a checklist (tick an item when it is done; tests are in section 11, packaging is on hold in section 12):

- [ ] 1. **Rust kernels:** cancelling and progress inside them (`AbortSignal`, section 3.5).
- [ ] 2. **Effect gaps:** radial `chromaticAberration` (section 4.4) and linear-light `add` and `screen` blending (section 5.1).
- [ ] 3. **Mask shapes:** polygons, keyframes, and shapes pinned to a track (section 3.2).
- [ ] 4. **`replace_screen`:** the insert's matched blur, glare and color, and occlusion by an object mask (section 5.4).
- [ ] 5. **FFmpeg backend precision** (section 3.3): the 10-bit pipeline, 16-bit masks, `gbrp16le` RGB stages, ProRes 422 HQ export and a 10-bit segment cache.
- [ ] 6. **Hardware encoding** with VideoToolbox (macOS) and VAAPI (Linux) (section 3.6).
- [ ] 7. **Claude's checks** (section 9): `review_edit` findings for clipping, skin hue off the skin line, banding, matte flicker, track drift and sky slide.
- [ ] 8. **Desktop app** (section 10): the selected object's blue outline, the matte toggle in the viewer, and scopes next to the findings.

## 3. Architecture

### 3.1 The grade, as a colorist builds it

Every clip's picture goes through fixed stages, in this order. Each stage is optional.

1. **Input transform**: the asset's color space (camera log, HLG, PQ, Rec.709) to the working space.
2. **Primary correction**: exposure, white balance, contrast, the existing color panel.
3. **Secondary corrections**: any number of corrections, each limited to a mask (section 3.2).
4. **Look**: film emulation, a creative LUT, grain, halation.
5. **Output transform**: working space to Rec.709 (gamma 2.4) or sRGB; later HDR.

The working space is display-referred Rec.709 in 16-bit (`gbrp16le`) or float (`gbrpf32le`) between stages. A scene-referred working space (for example ACEScct) is a later option; the stage order above already allows it without changing projects.

**As built.** There is no separate `grade` object: the stages live in the clip's `effects`, in this order, so old projects render unchanged. The input transform is the asset's `colorSpace` (section 4.1); the primary is the unlabeled `color` effect (for footage in a color space it is graded in ACEScct, between the two halves of the transform); secondaries are labeled `color` effects with a `mask` (`grade_region`); the look is the `look`-labeled grade and film effects (`apply_look`); the output transform is the ACES Rec.709 output, part of each color space's table. The original proposal was a `grade` object:

```json
"grade": {
  "input": "slog3-sgamut3cine",
  "primary": { "exposure": 0.3, "temperature": -8, "contrast": 12 },
  "secondaries": [
    { "mask": { "kind": "key", "hue": [190, 240], "saturation": [0.15, 1], "softness": 0.2 }, "color": { "saturation": 15, "temperature": -10 }, "label": "deeper sky" },
    { "mask": { "kind": "face" }, "color": { "exposure": 0.2, "warmth": 5 }, "label": "lift faces" }
  ],
  "look": { "film": "kodak-2383-like", "grain": 0.3, "halation": 0.4 },
  "output": "rec709"
}
```

### 3.2 Masks: one system for every feature

Generalize `personMask` and `faceMask` into one mask provider. A mask spec describes what to select; the renderer prepares the matte video (cached like today's masks) or builds it in the graph.

| `kind` | Source | Prepared |
|---|---|---|
| `person` | PP-HumanSeg cutout (exists) | Before render, cached |
| `face` | YuNet face ellipses (exists) | Before render, cached |
| `object` | A tracked object from `select_object` (section 5.2), by track id | Before render, cached |
| `sky` | Segmentation (section 5.3) | Before render, cached |
| `key` | HSL qualifier: hue, saturation and luma ranges with softness | In the graph, per frame (16-bit) |
| `luma` | Luma range (highlights only, shadows only) | In the graph |
| `depth` | A depth range from the depth map (section 7.1) | Before render, cached |
| `shape` | Ellipse or rectangle, fixed for the clip (polygons, keyframes and pinning to a track are not built) | In the graph |

Every mask spec also takes `invert`, `feather` (blur radius as a fraction of frame height), `grow` (positive dilates, negative erodes), `smooth` (temporal smoothing, frames), and boolean `combine` (`intersect`, `subtract`, `add` with another mask spec). Masks combine in 8-bit gray for now (the 16-bit pipeline of section 3.3 is not built).

Any effect, not only grades, takes an optional `mask`: a glow on one object, a blur on the background, sharpening on eyes. `effectToFilter` wraps the effect in `maskedEffect` when a mask is set (built, F2). The special cases in `beauty`, `backgroundBlur` and `backgroundReplace` are still there. On the GPU engine a masked effect is still drawn by FFmpeg as a piece (E4).

### 3.3 Pipeline precision

**Status: not built on the FFmpeg backend**, whose graph stays 8-bit (segments, masks, `eq`, `vignette`, the 8-bit Hald tables). Precision came through the engine instead (E2): it works in float, decodes footage in a color space at 10 bits, exports 10-bit (`bitDepth` 10: H.264 High 10 or HEVC Main 10), and dithers 8-bit exports of such footage. The FFmpeg backend writes 10-bit files from its 8-bit graph. ProRes is not offered as an export, and the segment cache is still 8-bit x264. The plan below stands for the backend:

- Segments carry `yuv420p10le` between stages, and RGB stages run in `gbrp16le`. The segment ends become `fps`, `format=yuv420p10le`, `setsar=1`, `settb=AVTB`; `xfade` and `concat` work at 10-bit (verify both in the integration tests).
- Replace `eq` (8-bit) with `colorlevels` plus `curves` or a baked LUT, and `vignette` (8-bit) with a 16-bit `geq` falloff or a baked mask. Add a unit test that fails when a color effect's chain contains a filter known to drop precision.
- The segment cache stores x264 High 10 at CRF 12 (or FFV1 when `cacheLossless` is set). Measure size and speed against the current 8-bit cache before switching.
- Export: H.264 High 10 is not widely played; keep 8-bit H.264 as the default delivery, with dither (`format=yuv420p` after a 16-bit chain, with `zscale=dither=error_diffusion` if measurably better), and add ProRes 422 HQ and HEVC Main 10 as export choices.
- Baked LUTs move from Hald level 8 (64 per axis, 8-bit table) to a 65-point `.cube` written to the cache and applied with `lut3d` in 16-bit, since `haldclut` tables are 8-bit images. Keep the in-graph Hald path for 8-bit previews.

### 3.4 Render engine (recommended core change)

**Why.** The FFmpeg filter graph got the project far, but movie-level work needs things it cannot give:

- **Precision**: several filters are 8-bit (appendix A), and compositing (`overlay`, `blend`) works on integer YUV or RGB, not float linear light. Glows, blurs and blends look physically wrong unless done in linear float.
- **Color management**: no OpenColorIO, so no ACES and no camera transforms maintained by the vendors and the industry. Hand-written log curves (section 4.1) are a fallback, not the standard.
- **Speed**: everything runs on the CPU, once per render. Real-time preview of a graded, composited timeline is not reachable on a laptop this way, and every model-based feature competes for the same cores.
- **Expressiveness**: per-frame logic lives in FFmpeg expression strings (see the 3D projection and `geq` masks). Shaders and real code are clearer, testable and far faster.

**Recommendation.** A native render engine for the picture path:

| Part | Choice | Why |
|---|---|---|
| Language | Rust | Memory safety for a long-running engine, good GPU and FFI story, ships to Node like `@resvg/resvg-js` (napi-rs) or as its own process |
| GPU | `wgpu` (DirectX 12, Vulkan, Metal) | One code path for Windows, Linux and macOS; runs on integrated GPUs like the reference laptop's Intel UHD; compute shaders (WGSL) for grading, blurs, keying and compositing |
| Color | Our own transforms (decided 2026-11-07, instead of OpenColorIO): each camera curve and gamut from its maker's published formulas, ACES matrices, ACEScct and the ACES 1.x output transform ported from the Academy's reference CTL, in TypeScript (`engine/library/color`), baked into one 65-point table per color space that both renderers apply | No C++ library to build and ship on three systems; every transform is tested against its published formula. OpenColorIO (configs maintained by the vendors and the Academy) stays an option if the transforms we keep fall behind |
| Precision | `rgba16f` textures in linear scene-referred (ACEScg) between nodes; grading operators in ACEScct. As built: `rgba16float` display-referred between passes, as the FFmpeg backend is, since compositing in linear light breaks parity with it; footage in a color space is graded in ACEScct | Float everywhere; no banding; physically correct blends and blurs |
| Decode / encode / audio | FFmpeg libraries (through `ffmpeg-next` in Rust) or the bundled `ffmpeg` binary through pipes at first | Keep FFmpeg's codec coverage; audio stays on the current FFmpeg graph |
| Text and vector | resvg (already used for graphics) and libass for captions, uploaded as textures | Reuse what works |
| ML models | ONNX Runtime with GPU execution providers: DirectML (Windows, any GPU), CUDA (NVIDIA), CoreML (macOS); CPU fallback. As built: models run before rendering through `onnxruntime-node`, and the engine reads their mattes from the cache, not from its own inference | Segmentation, depth and interpolation become fast enough for interactive use; larger, better models become practical |

**Shape of the engine.** The project document and the Claude tools stay the contract; only `compile.ts` and `render.ts` gain a second backend.

1. **Plan**: the TypeScript side turns the project into an engine plan (JSON): per output frame range, the sources, transforms, grade nodes, masks, layers and blend modes. This is a pure function like `compileProject`, unit-tested the same way.
2. **Render**: the engine decodes frames, uploads them, runs the node graph per frame on the GPU, and hands frames to the encoder. Masks from models are textures produced by the same engine (models run through ONNX Runtime on the same GPU when possible).
3. **Preview**: the same engine renders single frames and scrubbing previews in real time where the GPU allows, for the app's viewer and for Claude's `render_frame` (much faster than spawning FFmpeg per frame).
4. **Fallback and reference**: the FFmpeg backend stays. Parity tests render the test projects with both backends and compare (mean ΔE 2000 under 1 for 8-bit-safe features, excluding features only the engine has). Machines without a usable GPU use the FFmpeg backend.

**Process boundary.** Start with the engine as a separate executable speaking JSON-RPC over stdio, like `engine/host/main.ts` does for the app: it crashes alone, can be rebuilt without touching Node, and is easy to test. Move to an in-process napi-rs module only if the per-frame handoff (preview) measurably needs it.

**Desktop app.** The WPF app can show engine frames through a shared texture or a memory-mapped frame buffer instead of PNG files, which makes the viewer live (scrubbing, A/B before and after, matte overlay). The app remains AI-first; this only makes looking faster.

**Status (2026-11-07).** Built as described (E1 to E4): a separate executable over JSON-RPC, decoding and encoding through ffmpeg processes, parity tests on every feature, previews and the app's live viewer through a memory-mapped frame. It is the default renderer; what it does not draw itself yet comes from the FFmpeg backend as pieces (E4 notes), and machines where it fails use the FFmpeg backend. The milestone below is met for templates and parity, and the speed is at its line (playback about 3x FFmpeg on the reference laptop).

**Done when** (engine milestone): the engine renders every current template and integration test project; parity with the FFmpeg backend within ΔE 2000 of 1 on 8-bit content; 1080p30 playback of a graded clip with two secondaries and a blended overlay in real time on the reference laptop's integrated GPU, or at least 3x faster than the FFmpeg backend there.

### 3.5 Language rule: Rust where speed matters and the move is easy

**Rule.** Code is moved to Rust when it is on a hot path and the move is easy. Code that does not need it stays in TypeScript.

- **Hot path**: its cost grows with pixels, audio samples or frames, and it is a measurable share of a tool call or a render.
- **Easy move**: it is self-contained, with plain inputs and outputs (typed arrays, numbers, file paths), so it can be ported behind the same function signature and checked for parity.

Code that is hot but tangled with the edit logic is first separated into a plain kernel, then moved. **New code with a speed budget in section 1 starts in Rust**: the render engine, mask processing outside the GPU, tracking, particles, depth alignment, inference, and inpainting and interpolation glue.

TypeScript keeps everything about the edit itself: the project document and its schema, `core/operations`, the catalogs (effects, templates and the rest stay data), tool definitions and their descriptions, planning (turning a project into an FFmpeg graph or an engine plan), the session, the host and its JSON-RPC to the app. It also keeps code that touches pixels or samples but runs rarely or cheaply, where a port would add a build dependency for no felt gain.

**Decision test.**

1. Does it run per frame, per audio window or per pixel, or does section 1 give it a speed budget? If not, keep it in TypeScript.
2. If so, is it a measurable share of the time? Profile it on a real project. Under about 10% of the tool call or render, keep it in TypeScript.
3. If so, can it be ported behind the same signature with a parity test? Then move it. If not, first split out the kernel, then move the kernel.

**Packaging.** One Cargo workspace in `native/`:

| Crate | Ships as | Holds |
|---|---|---|
| `ave-render` | A separate executable (section 3.4), prebuilt for every target of section 3.6 | The GPU render engine (built; OCIO was dropped, decoding and encoding go through ffmpeg processes, and no models run in it yet) |
| `ave-native` | A Node addon built with napi-rs, prebuilt for every target of section 3.6 as optional npm packages (like `@resvg/resvg-js`) | The CPU kernels marked **Move** below, and the kernels of new features |

**Model inference stays where it is cheapest to ship.** Today's models run through `onnxruntime-node`, which is already native code, ships for Windows, macOS and Linux, and has GPU execution providers per platform (DirectML on Windows, CoreML on macOS, CUDA on Linux). Measured overhead around inference in TypeScript is small (see the table), so it stays. Inference moves into Rust (`ort`) only where frames already live in Rust, as in the engine, so they do not cross into JavaScript and back.

**Interface rules.**

- **Coarse calls**: a whole clip, buffer or source range per call, never per pixel or per frame across the JavaScript boundary.
- **Data in and out**: typed arrays without copying, and file paths for anything bigger than a frame.
- **Never block Node**: work runs on a Rust thread pool (rayon) and returns a promise, so the host stays responsive while the app shows progress. Progress callbacks are throttled to a few per second, and an `AbortSignal` sets a cancel flag the kernels check.
- **Errors**: they cross the boundary as normal JavaScript errors with a clear message, and a panic never takes down the host.

**Existing hot spots, and what happens to each.** Measured on the reference laptop (2026-10-27). Each port adds a binary per target of section 3.6, so only clear wins move:

| Today (TypeScript) | Measured | Decision | Why |
|---|---|---|---|
| `tools/audio/analyze.ts` (`frameFeatures`, `fft`, `soundScores`, `onsetEnvelope`, `tempo`) | 232 s of audio: decode (FFmpeg) 1.6 s, sound map 1.2 s, beats 1.3 s; TypeScript is about 60% of audio analysis | **Move** to `ave-native` audio | Runs on every sound map, beat detection and review over whole recordings; pure functions over sample arrays, easy to port. Results are cached per file, so the gain shows on first analysis |
| `tools/vision/segment.ts` (`personProbability`, `resizeMask`, `stabilizeMask`) | 1.4 ms per frame, next to about 25 ms per frame for the whole cutout (model about 11 ms, the rest decode and encode) | **Stay** in TypeScript | About 6% of the time; under the 10% line. GPU inference saves far more |
| `tools/vision/facemask.ts` (`paintFaces`) | 0.4 ms per frame, next to about 16 ms per frame of face detection | **Stay** in TypeScript | About 2% of the time |
| `tools/vision/faces.ts` (letterboxing, `decodeYunet`, NMS) and `tools/audio/classify.ts` | Small next to inference, which is native already | **Stay** in TypeScript, with inference in `onnxruntime-node` | The time is in the model; use GPU execution providers instead of moving code |
| `tools/graphics` (placeholder evaluation, frame loop, piping to FFmpeg) | Per-frame SVG fill | **Stay** in TypeScript | The heavy part (rasterizing) is already Rust in resvg; evaluating placeholders is small. Revisit if a profile shows the loop matters |
| `tools/review` (`backdropContrast`, frame scans) and `render/color-analysis.ts` (levels, histograms) | Per-pixel statistics on a few frames | **Stay** in TypeScript | Runs on a handful of small frames per review; FFmpeg does the decoding |
| `tools/transcript/local.ts` (`speechPieces`, `levelSpeech`) | Per-sample leveling | **Stay** in TypeScript | Runs once per transcription and is tiny next to Whisper itself |
| `trackFaces`, keyframe math, captions, planning (`compileProject`) | Per-track or per-project logic | **Stay** in TypeScript | Not per pixel or sample; it is edit logic |

New code from sections 4 to 7 with a speed budget is written in Rust from the start, as listed under **Rule**.

**How a port is done.**

1. Write the Rust kernel behind the same TypeScript function signature, so callers and tools do not change.
2. Keep the TypeScript version only as the test oracle. A parity test feeds both the same recorded inputs (real audio, frames and model outputs from the test media) and requires identical results, or results within a stated tolerance for floating point.
3. Record a benchmark on the reference laptop (before and after, same input) in the relevant guide. A port that does not measurably help is not merged, and the code stays in TypeScript.
4. Delete the TypeScript implementation once parity holds, so there is one source of truth. Machines where the native package cannot load get a clear error naming the package, not a silent slow path. The FFmpeg render backend (section 3.4) is the one deliberate fallback.

**Status.** Both crates are built with `npm run native`, and CI builds and tests them on Windows x64, Ubuntu 22.04 and macOS arm64. Not built: `AbortSignal` and progress inside kernels (none needs them yet). Prebuilt npm packages per target (`@ai-video-editor/native-<target>`, which the loader already tries first) and macOS x64 and glibc 2.31 builds are on hold: packaging comes after everything else is done. Apart from those, the milestone below is met.

**Done when** (native milestone): every **Move** row of the table runs in Rust on every target of section 3.6, with parity tests passing and a recorded speedup. The sound map of a 10-minute recording takes under 2 s, not counting decoding. The host stays responsive (JSON-RPC answers under 50 ms) while any kernel runs. Re-measure the **Stay** rows when their inputs grow (4K masks, longer clips) and move them if they cross the 10% line.

### 3.6 Platforms: Windows, macOS and Linux

The app will be built for Windows, macOS and Linux. Everything above must work on all three, and every choice is checked against that.

**Targets.** Windows x64, macOS on Apple silicon (arm64) and on Intel (x64), and Linux x64 (glibc 2.31 or newer, so Ubuntu 20.04 and later). Windows arm64 and Linux arm64 come later. Every native binary (`ave-render`, `ave-native`) is built for each target in CI, never on a user's machine.

| Part | Today | Across platforms |
|---|---|---|
| Desktop app | Done: Avalonia UI (`ui/`), builds for Windows, macOS and Linux | Move to **Avalonia UI** (C#, XAML close to WPF, MIT, renders the same on all three). View models, `EngineClient` and the JSON-RPC protocol carry over; the views are rewritten. Compare with Tauri (Rust and a web UI) only if Avalonia falls short; the web preview was removed on purpose, so a native UI is the default |
| Icons | Done: Fluent UI System Icons bundled (`ui/Assets/Fonts`) | Bundle **Fluent UI System Icons** (MIT, by Microsoft), the same visual language, as an app font on every platform |
| Node host | The app starts a bundled host when there is one (`EngineClient.BundledHost`), else the installed `node`; building the bundles is on hold: packaging comes after everything else is done | Bundle the host as a Node single executable application (or a bundled Node runtime) per target, so users install one app |
| FFmpeg | `ffmpeg-static`; the self-test (`cli check`) runs in CI on each system | Already per platform. Check that each build has the filters and encoders the renderer uses (a startup self-test, like the hardware encoder check) |
| Hardware encoding | NVENC, Quick Sync, AMF (VideoToolbox and VAAPI not built yet) | Add VideoToolbox on macOS and VAAPI (plus NVENC and Quick Sync) on Linux, each verified with a test encode as today |
| Models | `onnxruntime-node` | Per platform already. GPU execution: DirectML on Windows, CoreML on macOS, CUDA on Linux (when present), CPU everywhere as the fallback |
| SVG graphics | `@resvg/resvg-js` | Prebuilt per platform already |
| GPU engine | Built: Direct3D 12, Metal, Vulkan, or GL on Linux, opening only the system's own API | `wgpu` uses Direct3D 12 on Windows, Metal on macOS and Vulkan on Linux, one code path |
| Fonts | System fonts per platform plus the fonts folder | Already handled per platform. Ship the font packs in the fonts folder so text renders the same everywhere |
| Paths | Done: renders read asset paths in the project form (forward slashes, relative inside the media folder, `withProjectPaths`) | Store media paths relative to the project folder, with forward slashes, so projects move between machines and systems |

**Distribution** (on hold: packaging comes after everything else is done; the per-system metadata is in `ui/Packaging`). Windows: a signed installer (MSIX or MSI). macOS: a signed and notarized `.app` in a DMG, with a universal (arm64 and x64) build or one per architecture. Linux: AppImage first, then Flatpak. The native Node packages and FFmpeg go inside each package, so nothing downloads at install time except models and fonts on first use.

**Testing.** CI runs the unit tests on all three systems, and the render integration tests (FFmpeg, fonts, models) on each target at least nightly. Rendered frames from each platform are compared, and differences beyond rounding (fonts, filters, GPU) are treated as bugs. As built: CI runs the whole suite, renders included, on Windows x64 and Ubuntu 22.04 for pull requests, and on macOS arm64 too otherwise, and keeps the renders; comparing frames across systems is not automated yet.

**Required fixes.** Everything found in the code that blocks or differs on macOS and Linux (the WPF app, absolute paths in project files, Arial defaults, FFmpeg builds and more) is listed with locations and fixes in [Cross-platform: required fixes](cross-platform.md).

## 4. Grading features

### 4.1 Color spaces and camera log (`set_color_space`)

- **Asset field** `colorSpace`: `rec709` (default), `srgb`, `slog3-sgamut3cine`, `slog3-sgamut3`, `vlog-vgamut`, `applelog`, `clog3-cinemagamut`, `logc3-awg3`, `logc4-awg4`, `dlog-m`, `bmdfilm-gen5`, `hlg-rec2020`, `pq-rec2020`. Built: all but `dlog-m`, for which DJI has published no formula (E2 notes).
- **Detection**: read `color_transfer` and `color_primaries` from the probe (`arib-std-b67` is HLG, `smpte2084` is PQ). Log footage is usually tagged Rec.709, so look for camera metadata tags (Apple Log writes its own), and otherwise judge from the picture: a flat histogram with no blacks below about 10% and no whites above about 70% suggests log. When unsure, Claude asks with `offer_choices`, showing the clip converted with the two or three likeliest curves.
- **Both renderers (decided 2026-11-07)**: the makers' published curves and gamuts in our own code (`engine/library/color/spaces.ts`), to ACES, and out through the ACES 1.x output transform (ported from the Academy's reference CTL), baked into one 65-point table per color space that FFmpeg (`lut3d`) and the engine apply alike. OpenColorIO was the first plan; it was dropped to avoid building and shipping a C++ library on three systems. The color panel's primaries grade footage in a color space in ACEScct, in both renderers.
- **Implementation (fallback, superseded by the tables above)**: for each log space, generate a 65-point `.cube` from the published formulas: the log curve to linear, the camera gamut to Rec.709 primaries (3x3 matrix with Bradford adaptation where white points differ), then a display transform. Cache it in the models folder by name and version. HLG and PQ go through `zscale` (to linear, Rec.2020 to Rec.709) and `tonemap` (start with `hable` and `mobius`, compare against reference renders).
- **Display transform for log**: a plain gamma mapping clips highlights hard. Use a filmic tone curve with a soft shoulder (configurable `highlightRolloff`), so log footage looks like a finished camera image, not a clipped one. As built: the ACES output transform gives the soft shoulder; there is no `highlightRolloff` setting.
- **References**: Sony "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3"; Panasonic "V-Log/V-Gamut Reference manual"; Apple "Apple Log profile" white paper; ARRI "LogC3" and "LogC4 Specification"; Canon "Canon Log 3" specifications; Blackmagic "Film Generation 5" documentation; DJI "D-Log M" color conversion documentation. Store the formula source next to each curve in code.
- **Done when**: each curve round-trips a synthetic ramp within 0.5% of full range; a gray card in a log test clip lands within 2% of 18% gray after conversion; no clipping before the rolloff on a 10-stop ramp.
- **Status**: met on synthetic footage (E2). Judging log from the picture and showing conversions as choices is left to Claude with `set_color_space`.

### 4.2 Secondary corrections (`grade_region`)

- **Tool**: `grade_region { target, mask, color, label }` adds or updates one secondary on a clip (or every clip, or global). `color` is the same settings object as the color panel.
- **HSL qualifier** (`key` mask): computed per frame in 16-bit: convert to HSV with `geq` on a downscaled copy (half size), smoothstep on each range with `softness`, multiply, upscale the matte, feather. Use hue distance on the circle so red (around 0 and 360 degrees) works. Expose a `denoise` (small median on the matte) for noisy footage.
- **Done when**: on the test clips, a sky key selects sky with IoU 0.9 against a hand matte without catching blue clothing when `combine` with `sky`; a skin key passes through faces in three skin tones; grading inside the mask never shows a hard edge at feather 0.02 or more.
- **Status**: built (F2, F3); the matte is 8-bit and made at full size, not on a half-size copy.

### 4.3 Scene grading and shot matching (`grade_scene`)

- Uses `detect_scenes`; the user (or Claude) picks a hero shot per scene. Other shots are matched to it, or all shots to a reference still (a frame from a film the user names, imported as an image).
- **Matching**: upgrade `match_color` from per-channel curves to a color transfer that also moves saturation and hue: fit a 3D LUT (17 points) from matched color distributions in a perceptual space (Oklab), with the transfer limited to plausible changes (no hue rotation over 15 degrees unless asked). Compare against the current curves method and against Reinhard-style mean and variance transfer in Lab; keep the one with the lowest mean color difference (ΔE 2000) on held-out frames of the same scene.
- Skin tones are protected: faces found by YuNet are sampled, and the match is constrained so their hue stays on the skin line (vectorscope around 123 degrees in Rec.709).
- **Done when**: on graded test pairs (a shot darkened, warmed and desaturated by known amounts), matching brings mean ΔE 2000 under 2; skin hue stays within 5 degrees of the skin line.
- **Status**: built and met on graded test pairs (F8); the transfer is baked into a 64-level table.

### 4.4 Film look (`film_look` effect, and look presets)

Each is an effect with clear parameters, built from measured references, applied in 16-bit:

| Effect | Method |
|---|---|
| `halation` | Threshold the brightest highlights (soft knee), wide blur (about 1.5% of frame height), tint warm red-orange, add back. Strength scales with highlight brightness, not globally |
| `bloom` | Same structure with a neutral tint and a narrower, multi-radius blur |
| `filmGrain` | Grain that depends on luminance (strongest in midtones, as on film), size relative to the frame (not pixels, so 4K and previews match), new each frame, applied before the output transform. Stocks as presets: fine 50D-like, medium 250D-like, coarse 500T-like |
| `gateWeave` | A slow random walk of sub-pixel offset and tiny rotation through `perspective`, seeded so renders repeat |
| `printFilm` | A print-film-like tone and color response: S-curve with soft toe and shoulder, mild channel crosstalk and a warm-highlight, cool-shadow split, baked to a LUT. Names say "-like": no trademarked stock is claimed |
| `letterbox` | 2.39:1, 2.00:1, 1.85:1 bars with optional soft edge; framing guides in the app |
| `anamorphicFlare` | Threshold highlights, very wide horizontal blur, blue-cyan tint, add |
| `chromaticAberration` | Radial red and blue channel scaling (per-channel `lenscorrection`), stronger toward the edges. Not built: the existing `chromaticAberration` shifts the channels evenly |
| `lensDistortion` | Barrel or pincushion with `lenscorrection` |

- **Look presets** (catalog items, data not code, like templates): combinations of the above with a primary grade, for example "teal and orange blockbuster", "warm 70s print", "cold thriller", "bleach bypass". Descriptions say when to use each.
- **Done when**: halation never tints anything below the highlight threshold (pixel test); grain is identical across two renders with the same seed and differs per frame; looks are checked on the test clips by eye and with scopes, and stay legal (no clipping beyond 0.5% of pixels at default strength).
- **Status**: built as separate effects (`halation`, `bloom`, `anamorphicFlare`, `filmGrain`, `gateWeave`, `printFilm`, `lensDistortion`; `letterbox` existed) and six look presets applied with `apply_look`, not one `film_look` effect (F6). The pixel and grain checks pass. The engine draws only `printFilm` natively, the rest as FFmpeg pieces.

### 4.5 Export a grade (`export_lut`)

Write the clip's grade (input transform, primary, look, output; not the secondaries, which are spatial) as a 33- or 65-point `.cube`, so it can be used in DaVinci Resolve, Premiere or a camera monitor. **Done when**: applying the exported LUT with `lut3d` reproduces the rendered grade within ΔE 2000 of 1 on test frames.

**Status**: built (F6): mean ΔE 2000 0.96 on a graded synthetic S-Log3 clip. Spatial effects (secondaries, grain, glows, the color panel's vignette and clarity) are left out and named.

## 5. Selecting and tracking anything

### 5.1 Blend modes on layers

- **Schema**: media and graphic layers get `blend`: `normal` (default), `screen`, `add`, `multiply`, `overlay`, `softlight`, `lighten`, `darken`, `colordodge`, `difference`.
- **Implementation**: the layer is placed on a transparent frame-size canvas at its position (as overlay does), then `blend` with `all_mode`, and `maskedmerge` with the layer's alpha times opacity so only the layer's area changes (`blend` ignores alpha). As built: the blended frame is cut to the layer's alpha with `alphamerge` and overlaid (F1); the engine blends in its layer pass. In the 16-bit pipeline, `add` and `screen` for light effects run on linearized values (`zscale` to linear and back) so glows add like light; compare both and keep linear if it measurably looks closer to a reference composite.
- **Done when**: screen and add of a black layer change nothing (pixel exact); each mode matches its formula on a test pattern within 1 code value; a fire clip on black composites over a dark plate with no visible box.
- **Status**: built on both renderers (F1, E1). Not built: linear-light `add` and `screen` (no 16-bit pipeline on the backend, and the engine stays display-referred for parity).

### 5.2 Any-object selection and tracking (`select_object`, `track_object`)

- **Prompting**: a point or box (from the app's "point at a spot", or Claude's own coordinates from a frame it rendered), or text ("the red car"). Text goes through an open-vocabulary detector to get a box, then segmentation.
- **Candidates to compare** (licenses must allow MIT distribution; check each before use):
  - Segmentation from a point or box: SlimSAM (Apache-2.0, ONNX exports exist for transformers.js), MobileSAM (Apache-2.0), EfficientSAM, SAM 2 tiny (Apache-2.0; check the ONNX export and its speed on CPU).
  - Video propagation (keep the same object across frames): SAM 2's memory, or Cutie (check license), or per-frame segmentation seeded with the previous frame's box from a tracker (section 5.4), with temporal smoothing.
  - Text to box: OWLv2 (Apache-2.0) and Grounding DINO tiny (Apache-2.0). Avoid AGPL detectors (Ultralytics YOLO) in this MIT library.
- **Output**: a mask video per clip and object (cached), plus a track: per-frame box and center, usable by graphics (like `follow_face`).
- **Edges**: refine the matte at the boundary (guided filter against the frame at full size), so hair and fine edges survive the model's low resolution.
- **Budget**: under 200 ms per frame at the model's input size on the reference laptop for propagation; a 10 s clip at 30 fps under 60 s, in the background, with progress.
- **Done when**: IoU 0.85 or more on the test clips (cars, people, a phone, a cup), flicker under 2%, no identity switch when two similar objects cross on the test clip.
- **Status**: built (F4): SAM 2.1 tiny on keyframes, carried between them by Rust tracking, and OWLv2 for names; met on synthetic and project footage.

### 5.3 Sky segmentation and replacement (`replace_sky`)

- Sky mask: compare text-prompted segmentation ("sky") with a dedicated sky or semantic segmentation model. Note: SegFormer weights are under NVIDIA's non-commercial source code license and cannot be used.
- Replacement: the new sky (image, video or generated gradient) moves with the camera: estimate camera motion from the background track (section 5.4) and move the sky plate by the same amount, scaled for distance. Match the plate to the scene: blur to the scene's sharpness, color-match its horizon band to the scene's horizon, add a soft horizon haze, and relight the foreground slightly toward the new sky's color (a masked grade with low strength).
- **Done when**: on the test clips the sky edge has no halo wider than 2 px at 1080p, the sky does not slide relative to the horizon during pans (drift under 2 px per 5 s), and the foreground tint shift is under ΔE 3 unless asked.
- **Status**: built (F7) with skyseg; met on generated footage. The horizon match is brightness and haze, not a full color transfer.

### 5.4 Point and surface tracking (`track_points`, `pin_layer`, `replace_screen`)

- **Algorithm**: pyramidal Lucas-Kanade feature tracking on downscaled gray frames (good-features corners inside the user's region), outlier rejection with RANSAC, and a model per use: translation (point), similarity (scale and rotation), or homography (a flat surface: a screen, a sign, a wall). Smooth with a short bidirectional filter; mark frames where too few features survive and re-detect. Written in Rust in `ave-native` (section 3.5), working on the decoded gray pyramid across threads; one call tracks a whole source range.
- **pin_layer**: attach any layer to a track: position, scale and rotation keyframes from the track (reuse `simplifyKeys`).
- **replace_screen**: four tracked corners per frame drive `perspective` with `sense=destination` for the inserted video or image (the corner-pin code from 3D layers). Add a matched blur, a slight glare pass and color match to the screen's surroundings so the insert sits in the shot. Occlusion (a finger over the screen) uses an object mask from section 5.2 over the insert.
- **Done when**: synthetic homography tests give corner error under 0.5 px; real phone and monitor clips drift under 2 px per 5 s; a tracked insert survives motion blur on a fast pan without jumping (re-detection within 3 frames).
- **Status**: built (F5); synthetic tests pass (worst corner 0.28 px). Not built: the insert's matched blur, glare and color match (Claude adds a blur and a grade instead), occlusion by an object mask.

## 6. Atmosphere and light (`add_particles`, `add_light`)

- **Generator**: deterministic particle simulation in Rust (seeded; compute shaders in the engine, a multi-threaded CPU version in `ave-native` for the fallback renderer), with emitters, gravity, wind, drag, turbulence (curl noise), size and color over life, motion blur by drawing streaks along velocity, and depth layers (near particles bigger, faster, blurrier). Rendered to RGBA like `create_graphic` and placed as an alpha layer with a blend mode.
- **Presets** (data): rain (light, heavy, with splashes at a ground line), snow, dust motes in light, embers and sparks (rising, flickering), confetti, bokeh orbs, smoke and fog (fractal noise layers drifting, not particles), light rays (radial blur of thresholded highlights from a source point), lens flare (ghosts along the line through the frame center, sized by the source's brightness).
- **Interaction**: particles can be limited by a mask (snow only in the sky region, embers behind a person using the person matte as a holdout), and rain and snow slow down with the speed of the clip.
- **Budget**: 1080p, 2,000 particles, under 40 ms per frame to generate.
- **Done when**: presets look correct in contact sheets on dark and bright plates; renders are identical with the same seed; holdouts leave no edge artifacts.
- **Status**: built (F9): the Rust generator draws into an alpha video both renderers read as a layer; 2,000 particles at 1080p in 8.8 ms a frame. Not built: GPU particles in the engine, weather that interacts with the scene.

## 7. Depth, removal and time

### 7.1 Depth (`estimate_depth`, and `depthOfField`, `fog`, `parallax`)

- **Model**: Depth Anything V2 Small (Apache-2.0). The Base, Large and Giant weights are CC-BY-NC-4.0 and must not be used. Compare against other permissively licensed monocular depth models on the test clips.
- **Temporal stability**: per-frame depth is relative and flickers. Align each frame's depth to the previous one with a least-squares scale and shift over static background pixels, then smooth over time. Cache as a 16-bit gray video per clip.
- **depthOfField**: split into 6 to 8 depth bands, blur each with a lens-shaped kernel sized by its distance from the focus distance, composite far to near with matte edges dilated to avoid halos. Focus distance can be keyframed (rack focus) or follow a tracked object.
- **fog**: mix a fog color by depth with an exponential falloff, optional noise drift.
- **parallax** (2.5D photo move): separate the photo into depth layers, fill the gaps behind near layers (inpainting, section 7.2), move a virtual camera.
- **Done when**: depth flicker under 3% in static areas; depth of field leaves no halo wider than 2 px around in-focus subjects on the test clips; a rack focus is smooth with no band edges visible in motion.
- **Status**: built (F10) with Depth Anything V2 Small; flicker 0.09% to 0.22% on project clips. On the engine, depth effects are FFmpeg pieces.

### 7.2 Object removal (`remove_object`)

- **Static camera**: build a clean background plate from frames where the area is not covered (temporal median of unmasked pixels), then fill the mask from the plate. This is the most reliable method and handles video correctly.
- **Moving camera or stills**: LaMa inpainting (Apache-2.0) per frame inside the mask, then temporal stabilization of the filled region (blend toward the motion-compensated previous fill). State the limits plainly to the user: large objects on moving shots may wobble.
- **Done when**: on locked-off test clips the removed area is indistinguishable in a contact sheet and has no flicker; on moving clips, flicker in the filled area is under 4%.
- **Status**: built (F11), with plates for moving cameras too (not per-frame inpainting) and LaMa where no frame shows the area; met on generated and project footage.

### 7.3 Smooth slow motion (`interpolate`)

- **Model**: RIFE (MIT) ONNX, compared with FFmpeg's `minterpolate` (no model, more artifacts) on the test clips. Used by `set_speed` and `speed_ramp` below 1x when the clip has no duplicate frames to spare, and for frame rate conversion.
- **Done when**: 4x slow motion of the test clips shows no tearing on moving edges in a contact sheet, and a 30 to 60 fps conversion passes a frame-difference smoothness check (no repeated frames).
- **Status**: built (F12) with RIFE 4.9; met on project clips.

## 8. Claude's tools

| Tool | Does |
|---|---|
| `set_color_space` | Set or detect an asset's color space; shows the conversion |
| `grade_region` | Add a correction limited to a mask |
| `render_mask` | Render a mask as a white-on-black frame (or a red overlay) so Claude can check it before grading or compositing |
| `grade_scene` | Match a scene's shots to a hero shot or a reference still |
| `export_lut` | Save a grade as a `.cube` |
| `select_object` / `track_object` | Mask and track any object from a point, box or text |
| `replace_sky` | Sky replacement with camera motion and matching |
| `track_points` / `pin_layer` / `replace_screen` | Tracking, attaching layers, corner-pin inserts |
| `add_particles` / `add_light` | Atmospherics and light effects |
| `estimate_depth` | Depth map for depth effects and depth masks |
| `remove_object` | Object removal |
| `update_layer` (`blend`) | Blend modes on layers |
| `apply_look` | A look preset on a clip, layer, every clip or the whole video (added with F6) |
| `set_focus` | Depth of field from a point, box, distance or tracked object, and rack focus (added with F10) |
| `interpolate` | Smooth slow motion and frame rate conversion (added with F12) |

All of these are built.

Tool descriptions are read by Claude, so each says what the tool is for, what makes a good result, and how to check it (`render_mask`, `render_scopes`, `render_frame` at the worst frame).

## 9. The working loop for Claude

Professional results come from checking, not from one pass. Each grading or VFX task follows this loop, and the tool descriptions say so:

1. Look: `render_frame` at representative times, `render_scopes` for the grade.
2. Change one stage at a time (input, primary, secondaries, look).
3. Check: scopes for clipping and skin line, `render_mask` for any mask at the first, middle and last frame and at fast motion, a contact sheet across the clip for flicker and drift.
4. `review_edit` reports new findings: highlight or shadow clipping over 0.5% of pixels, skin hue off the skin line by more than 10 degrees, banding in smooth areas, matte flicker, track drift, sky slide. **Not built yet**: `review_edit` still checks text, safe zones, frames, speech, sound and keys only; clipping and skin show in `render_scopes`, mattes in `render_mask`.
5. Offer choices for taste decisions: render 3 or 4 look variants as thumbnails with `offer_choices`, and let the user pick.

## 10. Desktop app

The app stays AI-first. Additions serve the conversation:

- Pointing at an object in the viewer sends its point to `select_object`; the selection shows as a blue outline. Built in part: a click in the viewer marks a spot that goes to Claude with the next message, and Claude calls `select_object` with it; the outline is not built.
- A matte toggle in the viewer shows the current mask (white on black) for the selected layer or effect. Not built (Claude uses `render_mask`).
- Look variants from `offer_choices` show as thumbnail cards. Built (`ui/Session/ChoiceCard`).
- Scopes appear in the Review tab next to findings. Not built.
- UI rules apply: compact, dark neutral with blue as the only accent, the bundled Fluent UI System Icons, no emoji, no em or en dashes.
- The app is the Avalonia version (section 3.6), with the live viewer drawn by the engine (E3).

## 11. Testing

**When.** While features are built, each change runs the tests of the code it touches (the matching folder under `test/`, filtered to the cases concerned) and its parity tests on the engine. The whole suite, with every render (`npm test`, `FULL_RENDER=1` for every template), runs once after everything in section 2 is implemented, or when a change touches the core.

**Material and licenses.**

- **Clips**: the local sample projects plus a small set of openly licensed test clips (CC0 or CC-BY, with an `ATTRIBUTION.md` like `projects/nature-30s`): a log clip from each supported camera family where available, a sky pan, a phone screen and a monitor, cars and people crossing, a locked-off shot with an object to remove, fast motion for interpolation. Reference mattes are made by hand once and stored with the test media (not in the repository if large).
- **Synthetic tests** run in the unit suite without media: log ramps, homography warps, blend formulas, grain determinism, mask combine logic.
- **Models**: every model is optional, downloaded on first use into the models folder, and listed with its license in the docs. Before adding one, confirm its license allows use in an MIT-licensed library, and record the comparison that chose it in the guide, as for faces and sound.

**Checks that wait for the test clips.** Each feature was built and checked on synthetic and project footage; these checks of its "Done when" need the clips above:

| Section | Check |
|---|---|
| 4.1 | A gray card in real camera log clips lands at 18% gray; no clipping before the roll-off |
| 4.2 | A sky key with IoU 0.9 against a hand matte, without blue clothing; a skin key through faces in three skin tones |
| 4.3 | Matching real multi-camera scenes; skin on the skin line in three skin tones |
| 4.4 | The looks by eye and with scopes |
| 5.1 | A fire clip on black over a dark plate with no visible box |
| 5.2 | IoU 0.85 on hand mattes (cars, people, a phone, a cup); no identity switch when two similar objects cross |
| 5.3 | Real sky pans: no halo, no slide |
| 5.4 | Drift on real phone and monitor clips; re-detection after motion blur on a fast pan |
| 6 | Presets on real plates; holdouts against real people |
| 7.1 | Halo width around real people; rack focus on the test clips |
| 7.2 | A person crossing a locked-off shot; a car on a pan |
| 7.3 | 4x slow motion of fast motion; 30 to 60 fps conversion |

## 12. Packaging (on hold)

On hold until everything in section 2 is done. What it covers, from sections 3.5 and 3.6:

- Prebuilt npm packages of `ave-native` per target (`@ai-video-editor/native-<target>`, which the loader already tries first), and `ave-render` shipped with them.
- Builds for macOS x64 and for Linux on glibc 2.31 (CI builds Windows x64, Ubuntu 22.04 and macOS arm64 today).
- The bundled host per target (`ave-host`, or `node` with `dist/host/main.js`; the app already starts one when it is there).
- Installers: MSIX or MSI on Windows, a signed and notarized DMG on macOS, an AppImage then Flatpak on Linux (metadata in `ui/Packaging`).

## 13. Order of work

Three tracks run side by side: native kernels (N), the engine (E) and features (F). Features first land in the FFmpeg backend where that is cheap and correct, so users get them early, and each engine milestone ports them. Per section 3.5, any feature step with a speed budget writes its kernels in Rust from the start, so N0 comes before F4.

| Step | Builds | Depends on | Done when | Status |
|---|---|---|---|---|
| N0 | `native/` Cargo workspace, napi-rs `ave-native` package with prebuilt binaries for every target of section 3.6, CI builds on Windows, macOS and Linux, parity test harness | Nothing | One kernel (the sound map) runs from Rust with parity and a recorded speedup | **Done** (2026-10-28); prebuilt npm packages on hold: packaging comes after everything else is done. See notes below |
| N1 | Port the **Move** rows of the section 3.5 table, one per change, each with parity and a benchmark | N0 | Native milestone of section 3.5 met; ported TypeScript versions deleted | **Done** (2026-11-03) within N0. See notes below |
| F1 | Blend modes | Nothing | Section 5.1 checks pass | **Done** (2026-10-28), FFmpeg backend. See notes below |
| F2 | Mask system, `render_mask`, maskable effects, HSL key and luma masks | Existing masks | Section 4.2 checks pass for key masks | **Done** (2026-10-28) for `person`, `face`, `key`, `luma`, `shape`. See notes below |
| F3 | `grade_region` | F2 | Grading inside masks shows no edges | **Done** (2026-10-28) |
| F4 | Any-object selection and tracking (model comparison first; inference through `onnxruntime-node` with the GPU provider of each platform) | F2, N0 | Section 5.2 checks pass | **Done** (2026-10-30) on synthetic and project footage. See notes below |
| E1 | Engine skeleton: plan format, separate process, decode, GPU upload, transforms, layers, blend modes, encode | Nothing | Renders the template test projects; parity with FFmpeg backend | **Done** (2026-11-04): all 33 templates render on the engine at parity (every template's frames within ΔE 2 of the FFmpeg backend, mean under 1). See notes below |
| E2 | ACES in the engine (no OCIO, see section 3.4): input transforms, ACEScct grading space, display transforms, the color panel as shaders | E1 | Section 4.1 checks pass; precision check of section 1 passes | **Done** (2026-11-07): color spaces (Canon Log 3 added; DJI D-Log M has no published formula), `set_color_space`, HDR detection, the ACES output transform, the conversion in both renderers, grading in ACEScct (a shader on the engine, a table on FFmpeg), 10-bit exports and dither; the precision check passes on 10-bit exports. See notes below |
| E3 | Engine preview: single frames and live viewer for the app and `render_frame` | E1 | Real-time or 3x target of section 3.4 | **Done** (2026-11-07): single frames through a long-lived preview engine with the text drawn by the engine, the app's live viewer (shared memory, playback, A/B), drawing overlapped with readback, 4:2:0 decoding with chroma scaled on the GPU; playback speed at about 3x FFmpeg. See notes below |
| F5 | Point and surface tracking in Rust, `pin_layer`, `replace_screen` | F1, N0 | Section 5.4 checks pass | **Done** (2026-10-30) on synthetic footage. See notes below |
| F6 | Film look effects and look presets, `export_lut` (engine first: they need float) | E2 | Sections 4.4 and 4.5 checks pass | **Done** (2026-11-07), FFmpeg backend (print film on the engine too): seven film look effects, six look presets, `apply_look`, `export_lut`. See notes below |
| F7 | Sky replacement | F4, F5 | Section 5.3 checks pass | **Done** (2026-10-30) on synthetic footage, FFmpeg backend. See notes below |
| F8 | Scene grading | F3 | Section 4.3 checks pass | **Done** (2026-11-01) on graded test pairs. See notes below |
| F9 | Particles and light (GPU particles in the engine; Rust CPU generator for the fallback) | F1, N0 | Section 6 checks pass | **Done** (2026-11-01), Rust generator and FFmpeg backend. See notes below |
| F10 | Depth and depth effects (inference and depth alignment in Rust) | F2, N0 | Section 7.1 checks pass | **Done** (2026-11-02), alignment in Rust, inference in ONNX Runtime, FFmpeg backend. See notes below |
| F11 | Object removal (plate building and inpainting glue in Rust) | F4 | Section 7.2 checks pass | **Done** (2026-11-03) on generated footage and project clips, FFmpeg backend. See notes below |
| F12 | Frame interpolation (inference in Rust) | N0 | Section 7.3 checks pass | **Done** (2026-11-03), inference in ONNX Runtime, FFmpeg backend. See notes below |
| E4 | Retire the FFmpeg picture path as the default; keep it as fallback and reference | E1 to E3, parity on everything | All integration tests pass on the engine | **Done** (2026-11-07): the engine is the default (`auto`, FFmpeg on failure), and what it does not draw itself comes from the FFmpeg backend as pieces, so it renders every project; the rest of the transitions, rounded corners and the sound without a video decode moved to the engine. See notes below |

### Progress notes

A record of each step as it was finished.

**Engine ports, first part (2026-11-08).** Native on the engine, out of the FFmpeg pieces:
- **Film looks**: `halation`, `bloom`, `anamorphicFlare`, `filmGrain`, `gateWeave`, `lensDistortion`.
- **Light**: `glow`, `lightRays`, `lightLeak`, `bokehLights`.
- **Camera moves**: `handheld`, `vibrate`, `earthquake`, `impactShake`, `shake`, `tilt`, `smoothZoom`, `zoomPunch`, `heartbeat`.
- **Others**: `pixelate`, `mirror`, `bokeh`.

Each one copies its FFmpeg filters, from FFmpeg 6.1's source: blend's formulas; gblur with sigmaV and on RGB; perspective's 1/256 map and 11-bit cubic; lenscorrection's half-pixel bilinear; rotate; crop's rounding. Each has a parity test asserting it is not bridged: mean ΔE 2000 0.02 to 0.68. `filmGrain` matches in noise strength, as `grain` does.

New general parts:
- `engine/core/expr.ts` evaluates FFmpeg's expression language per frame, as libavutil does.
- A chain interpreter turns plain filter chains into operations, following FFmpeg's format negotiation.
- `branch` and `average` operations.
- A smaller-size operation that scales 4:2:0 chroma on its own, as FFmpeg does. It took pixelate from 7.5 to 0.46.

Also fixed: a failed engine run no longer hides its error behind the work folder's cleanup.

**Engine ports, second part (2026-11-08).** Native on the engine, out of the FFmpeg pieces: `sharpen` (mean ΔE 2000 0.04), `zoomBlur` (0.19) and `vhs` (the noise test). From FFmpeg 6.1's source:
- `unsharp`: its cascade of two-tap sums is a binomial kernel, summed in 32 bits, with its fixed-point amount, on 8-bit luma (an `unsharp` operation, in conv.wgsl).
- `mix`: 8-bit planes summed, times its float 1 / n, rounded with lrintf (a `mix` operation: zoomBlur's five scaled copies are `move`s).
- `drawgrid`: the color's alpha is a truncated byte, and each 4:2:0 chroma sample is blended once for every grid pixel of its block. With a line every other row that desaturates every chroma row, which was most of vhs's gap (mean ΔE 2000 6.6 before).
- Chains go back to YUV at a YUV-only filter after RGB ones (vhs's `eq` after `rgbashift`), which the engine needs nothing for: its YUV steps convert each pixel.

The piece tests now use effects still bridged (`motionBlur`, `rackFocus`); `halation` and `lensDistortion` there had been native since the first part.

Open in this group:
- `vhs`: a chain that goes from RGB back to YUV, whose conversion is not copied yet. It is left to FFmpeg until then.
- `denoise` (hqdn3d), `sharpen` (unsharp), `autoCorrect` (normalize), `motionBlur` (tmix), `trails` (lagfun), `zoomBlur`, `rackFocus`, `chromaKey`, `stabilize` (deshake), and the mask, model and removal effects. FFmpeg's code for each is fetched and read; hqdn3d splits into a row pass and a column pass, so it stays exact on the GPU.
 Their "Open" lists were current when written: section 2 has the features still to build, section 11 the checks still to run, section 12 the packaging on hold.

**E4, the engine as the default (done 2026-11-07).** Decided with the user: a bridge first, then ports. What the engine does not draw itself becomes a piece the FFmpeg backend draws (`compileProject`'s `piece`, chosen by `engineGaps` in `plan.ts`): a clip's picture, a media layer placed on a clear canvas, or the base picture (the primary track and the layers up to the last one that needs the picture under it: whole-video effects, layer masks, layers behind the subject). The engine reads a piece like any other source, so it matches the backend exactly (pieces next to the engine's own fades, transitions and blends: mean ΔE 2000 0.06 to 0.35), and masks, model mattes and media inputs work as there. `engineUnsupported` is now empty for every project; `engineBridged` lists the pieces. Renders default to `auto` (the engine, and FFmpeg when it is not built or fails, reported on stderr), and the performance test only checks that the engine works (its picture within ΔE 3). Moved to the engine in the same step:

- **The last transitions**: dissolve, radial, distance, squeezeh and squeezev, the four slices and the two winds, from xfade's C source (FFmpeg 6.1). xfade works on `yuv444p` and its result goes back to 4:2:0 as planes, so the engine now packs a transition's frames with swscale's planar bicubic (dissolve from 1.57 to 0.69). `frand` is a table worked out on the processor (pixel-exact against FFmpeg), and the slices' bands come from integers. All 29 transition tests: mean ΔE 2000 0.30 to 0.89.
- **Rounded corners** on media layers (mean 0.22).
- **The sound without a video decode**: `audioOnly` compiles the sound alone (pictures become flat frames), for engine renders and live playback; it also stopped the sound pass from failing on layers masked to the person or the sky, which need mattes it was not given.
- **A layer timing bug** found on the way: the backend's `setpts=PTS+start/TB` truncates to whole frames, so a layer starting between frames shows its frames one frame earlier than the engine did; the plan now carries each layer's frame offset.

Open: native ports of what is still a piece (the film looks other than print film, glows, sharpen, denoise, stabilize and the motion catalog's shakes, effects with masks or keyframes, scale, rotation, 3D and corner pin keyframes, shadows, layer masks, behind the subject, the color panel's vignette and clarity), GPU particles, 4:2:0-aware fitting, faster GPU passes and first frame. A piece runs at FFmpeg's speed, and in previews restarts from its own start.

**F6, film looks (done 2026-11-07).** Built on the FFmpeg backend first, against the step's "engine first": the engine draws print film (its filters bake into a table like other color effects), and projects with the other film effects render on FFmpeg (`engineUnsupported`) until E4 brings them to the engine.

- **Effects** (`engine/library/effects/film.ts`), sizes relative to the frame so previews and 4K match: `halation` (highlights above a threshold with a soft knee, a blur of 1.5% of the frame height, red-orange, added back on 16-bit RGB), `bloom` (the same, neutral, two radii averaged), `anamorphicFlare` (a very wide, flat blur, blue-cyan), `filmGrain` (gray noise at a grain size relative to the frame, by stock: fine, medium, coarse; soft-light on luma only, so it is strongest in the midtones; seeded), `gateWeave` (a smooth seeded wander of sub-pixel offset and a tiny rotation through `perspective`), `printFilm` (S-curve with soft toe and rolled shoulder, mild channel crosstalk, warm highlights and cool shadows) and `lensDistortion` (`lenscorrection`). Radial chromatic aberration is not built; the existing `chromaticAberration` shifts channels evenly. Checked (`test/render/film.integration.test.ts`, 13 s): halation leaves a frame without highlights within the 16-bit round trip (2 levels) and adds more red than blue around a bright square; grain is identical with the same seed, differs per frame and is stronger in the midtones than the shadows; every effect clips under 0.5% more of the frame than the plain picture at its default strength.
- **Look presets** (`engine/library/looks`, data): blockbuster teal and orange, warm 70s print, cold thriller, bleach bypass, dreamy glow and anamorphic night, each a grade plus film effects, with a description of when to use it. `apply_look` puts one on a clip, a layer, every clip or the whole video at a strength, labeled `look` after the edit's own grade; the next look replaces it, and `color_adjust` leaves the look's grade alone.
- **`export_lut`** (`engine/tools/render/export-lut.ts`): a clip's grade as a 33- or 65-point `.cube`, made by running a lattice of colors through the clip's own filters in FFmpeg on float RGB: the color space's transform, the grade in ACEScct and every per-pixel effect; spatial ones (secondaries, grain, glows, the color panel's vignette and clarity) are left out and named. For footage in a color space the table takes the camera's code values (full range), as other applications give a camera LUT. Checked on colorful synthetic S-Log3 graded with exposure, contrast, saturation, white balance and print film: the table applied with `lut3d` to the camera signal reproduces the render within a mean ΔE 2000 of 0.96 (section 4.5 asks for 1; the rest is the renderer's 8-bit print-film table against the export's float one).

Open: the film effects on the engine (E4), radial chromatic aberration, the looks checked on the test clips by eye and with scopes (section 11).

**E2, color management (done 2026-11-07).** Decided with the user: our own transforms instead of OpenColorIO (section 3.4's Color row). Built so far:

- **Color spaces** (`engine/library/color/spaces.ts`): S-Log3 with S-Gamut3.Cine and S-Gamut3, V-Log, Apple Log, ARRI LogC3 (EI 800) and LogC4, Blackmagic Film Gen 5, HLG and PQ (reference white at 1.0 per BT.2408), each curve and gamut from its maker's document, with the source next to it, plus ACES AP0 and AP1, ACEScct and Bradford adaptation. Checked (`test/library/color-spaces.test.ts`, under a second): every curve round-trips a ramp within 0.5% of full range and 14 stops within 0.5%, rises without folds, and puts 18% gray where its maker does (S-Log3 at code 420, V-Log 0.4233, LogC3 0.391, LogC4 0.2784, Gen 5 0.3835); the AP0, AP1 and Rec.709 matrices match the published ones. Canon Log 3 came later the same day (below); DJI D-Log M has no published formula.
- **The output transform** (`aces.ts`): the RRT and the Rec.709 100-nit dim-surround ODT, ported from the reference CTL. 18% gray lands at 0.3895; stops above roll off softly (0.76, 0.94, 0.99 at +2, +4, +6) and reach white about 8 stops up.
- **In the project**: assets have `colorSpace`; `set_color_space` sets it (Claude is told how log looks and to offer choices when unsure); HDR is set from the file's tags when probed (`arib-std-b67`, `smpte2084`), which the probe now reads with the pixel format.
- **Rendering** (`transform.ts`, `color-space.ts`): one 65-point `.cube` per space, written once into the app's cache folder (about 3 s). Its input is the pipeline's RGB (both renderers decode YUV with the BT.601 limited-range matrix); the transform undoes that and reads the file's R'G'B' with the space's matrix and range: camera log as recorded code values (full range, as S-Log3's 420 for gray), HLG and PQ in BT.2020 narrow range. FFmpeg tags the frames BT.601 and applies `lut3d` on float RGB before the fit; the engine decodes such footage at 10 bits (half floats) and applies the table as its first effect, in a float 3D texture. FFmpeg's `lut3d` reads a table's input range as a scale without the offset, so the range starts at 0 (0 to 1.25). A clip fit with `contain` on such footage renders on FFmpeg for now (the engine converts after the fit, which would turn the background too). Checked on synthetic 10-bit S-Log3 footage (`test/render/color-space.integration.test.ts`, 12 s): the gray card lands at 0.392 on both renderers against 0.3895 from the transform (section 4.1 asks for 2%), a 12-stop ramp rises without clipping before the roll-off, and the two renderers match within a mean ΔE 2000 of 0.02.

Then, the same day:

- **Canon Log 3** (`clog3-cinemagamut`): Canon's three-segment curve and Cinema Gamut, from Canon's published functions as given by antlerpost.com's Canon Cinema Gamut page (code values over the full 0..1023 range; Canon's 0.9 turns its scene linear, gray 0.2, into reflection, gray 0.18). 18% gray lands at 0.3434, Canon's 34.3%. **DJI D-Log M** stays out: DJI has published no white paper or formula for it (only for D-Log/D-Gamut and D-Log2), and the community stand-in (D-Gamut with an HLG curve) is not the maker's transform.
- **Grading in ACEScct** (`engine/library/color/grade.ts`): for footage in a color space, the color panel's primaries (exposure, temperature, tint, contrast around 18% gray, saturation, the shadow, midtone and highlight wheels) act on scene light, between the camera half and the output half of the transform (`inputCubeFor`, `outputCube`); the rest of the panel stays on the Rec.709 picture. The primary color effect (unmasked, unlabeled, not animated) is split (`sceneGradeFor`); secondaries and animated grades are left as they were. The engine runs the grade as a shader (`grade.wgsl`, the constants worked out once by `gradeConstants`), so a change needs no table; the FFmpeg backend bakes the same math into a table per grade. Checked (`test/library/color-grade.test.ts`, `test/render/color-space.integration.test.ts`): +1 stop doubles linear light, contrast keeps 18% gray, white balance keeps luminance, the two halves make the whole transform; on synthetic S-Log3 graded with exposure, white balance, contrast, saturation and a wheel, the gray card lands at 0.5916 on both renderers against 0.5945 from the math, and the renderers match within a mean ΔE 2000 of 0.70.
- **Precision**: exports take `bitDepth` 10 (H.264 High 10 or HEVC Main 10 with the project's codec): the engine packs 10-bit samples and the encoder keeps them. 8-bit exports of footage in a color space get a uniform dither of half a step, which breaks steps into fine grain (a triangular one of a full step cost too much likeness to the FFmpeg backend: a mean ΔE of 0.95 there). Section 1's check, a 10-bit ramp through a heavy grade at 1080p: on a 10-bit export the longest run of equal values in the gradient is 3 px over 529 levels (target: 4); an 8-bit export cannot pass it (256 levels over 1920 px), and its longest run there is 8 px, dithered. The FFmpeg backend writes 10-bit files from its 8-bit graph (section 3.3's 10-bit pipeline is a separate step).

Open: checks on real camera clips (section 11), DJI D-Log M once DJI publishes it, the color panel's spatial controls (vignette, clarity) on the engine, grading ordinary Rec.709 footage in ACEScct too.

**E3, engine preview (done 2026-11-07; begun 2026-11-04).** The frame loop became a `Composer` that draws any frame, used both by exports (in order) and by sessions: the engine keeps plans open (`open`, `frame`, `close`), and `renderFrame` draws through one long-lived preview engine (`FrameSession`), one session per version of the project. Video sources that play forwards at constant speed can start their decoder at any frame (`PlanSeek`); a frame on its own is the same picture as in an export (checked against the engine's export, frame for frame). A frame of the documentary template at half size takes 0.4 to 0.9 s anywhere in the edit, against 0.8 to 3.9 s for FFmpeg; drawing is 7 ms to 0.4 s, and most of the rest is the ffmpeg run that burns in the text (libass) and writes the picture. Single frames go to the engine whenever the performance test found it working, even where FFmpeg exports faster. Exports overlap drawing with readback (two readback buffers): drawing alone, a graded 1080p30 clip with a screen-blended overlay runs at 27 to 31 frames per second against 9.5 on FFmpeg (section 3.4 asks for real time or 3x; this is at the line). Then (2026-11-06) the decoders stopped converting to 4:4:4 VUYA on the processor, which had made them the limit: video and JPEG pictures come as 4:2:0 (`yuv420p`, layers `yuva420p`), the GPU scales chroma at half size as FFmpeg's scale does (centered siting, measured), and the engine gives the encoder 4:2:0, keeping chroma that came in at half size as it was and bringing full-size chroma down as swscale does. The decoder went from 89 to 325 frames per second on the test clip; the graded 1080p clip drew 22% faster than the previous build in alternated runs, and 60 of the 75 parity comparisons came closer to FFmpeg (numbers in [the render engine guide](../guides/render-engine.md)). The GPU passes are now the limit. Then (2026-11-07) sessions draw the text and captions themselves: libass in a decoder that stays open draws each frame over two backgrounds, which give each plane's blend factor, and the engine puts the text on in YUV as it packs the frame, as libass does in the encoder; fonts load once per session, and a neighboring preview frame takes 65 to 94 ms. The app's live viewer came the same day: frames go from the engine to the app through a memory-mapped file instead of PNG files (a neighboring frame 27 ms against 65 to 94 ms), Play draws the edit live on the engine at its pace with the sound mix alongside, and a Before button shows the frame as it was before the latest request to Claude (A/B). Contact sheets draw on the engine too: the frames FFmpeg's select picks (checked against select itself), drawn by the engine and tiled by one short ffmpeg run. Playback stays at about 3x FFmpeg (section 3.4 asks for real time or 3x); the GPU passes are the limit now, and the first frame of a session still takes about 5 s on the reference laptop.

**E1, render engine skeleton (done 2026-11-04).** Second round: effects, transitions and the templates. Every template now renders on the engine: `FULL_RENDER=1` renders all 33 on both backends at half size, with captions, and compares every frame (mean ΔE 2000 under 1, every frame under 2; grain and glitch compared under a blur, being random in both). Effects (`engine/tools/render/plan-effects.ts`, `native/ave-render/src/effects.rs`) follow their filters: color effects are baked from their own filter chains into the same Hald table `bakeColor` makes, where the backend bakes them, and otherwise run as FFmpeg runs them, `eq` as a native YUV pass with its fixed-point math and tables only for the RGB filters; `blur` is gblur's recursive filter; the zoompan-style motion effects get a crop rectangle per frame; vignette, letterbox, flash, fades, channel shifts and noise copy their filters. 29 more xfade transitions and the custom circlereveal copy xfade's formulas (`hblur` with running sums per row). Fit blur, slide animations, position and opacity keyframes and layer effects came too. Matching the templates turned up more FFmpeg behavior to copy: `crop` rounds to nearest (ties to even), xfade runs on RGB when the first whole-video effect takes RGB only (plain black and white then, and clipped inputs), xfade's progress is computed in 32-bit floats from microsecond timestamps, the `perspective` filter counts frames from 1, libass needs AV_TIME_BASE timestamps, and noise strength matches the filter's formula once `gray` readback's range expansion is taken out of the measurement. It also found a bug in the FFmpeg backend: its `gradients` source starts at a random angle on every run, so gradient assets (template backgrounds among them) rendered differently each time; both renderers now draw them with `gradientSource`. Known difference: `zoomin` fills the frame with one sample of the outgoing clip halfway through, and on pictures whose neighboring pixels differ strongly in color the engine's full chroma and FFmpeg's 4:2:0 chroma disagree at that sample, so the template test leaves those frames out (zoomin itself is checked on a smooth picture). Open, beyond E1: 4:2:0-aware fitting (the remaining chroma differences on sharp color edges), effects with masks or keyframes and those working across frames or regions, scale, rotation, 3D and corner pin keyframes, layer masks, rounded corners, shadows, the last transitions (dissolve, radial, distance, squeezes, slices, winds), the sound without a second decode, overlapping readback with drawing (E3), and building the engine in CI for every target. (Since done: readback overlap in E3; rounded corners, the last transitions and the sound in E4, the rest as FFmpeg pieces; the engine builds in CI on three systems.)

First round (2026-11-03). `native/ave-render` is a separate executable speaking JSON-RPC over stdio (`info`, `render` with `progress`, `cancel`, `shutdown`; a panic is an error reply), on `wgpu` 30. It opens only the system's own API (Direct3D 12, Metal, Vulkan or GL on Linux): letting wgpu probe every backend loaded the Vulkan driver on Windows too, and the reference laptop's old Intel one crashed the process. `planProject` (`engine/tools/render/plan.ts`) is pure, like `compileProject`, and follows its timing and rounding; `engineUnsupported` lists what the engine cannot draw, and `render` takes `backend` (`ffmpeg`, `engine`, `auto`, which falls back to FFmpeg). Decoding and encoding stay in ffmpeg processes through pipes (section 3.4 allows that at first); the sound and the ASS overlay come from the FFmpeg backend's graph and are muxed by the engine's encoder. Pictures come in and go out as 8-bit BT.601 YUV (`vuya`) and are float RGB (`rgba16float`) in between, display-referred like the FFmpeg backend: scene-linear ACEScg comes with E2, since compositing in linear light breaks parity with the backend. Drawn: clips (video, images, colors, gradients; fit cover with focus, contain, stretch; speed, ramps, reverse; fades), the `fade`, `fadeblack` and `fadewhite` transitions, and media layers (placement, fit, opacity, every blend mode, fades). Parity (`test/render/engine.integration.test.ts`, lossless renders on both backends compared frame by frame): mean ΔE 2000 0.38 (worst frame 1.06) for clips, 0.3 (worst 0.49) for layers; getting there meant copying FFmpeg's fade rounding to whole frames, xfade's black and white (luma 0 and 255, chroma 127), overlay's end of stream, blend's clipping to RGB, and keeping values past video black and white in YUV to the end. Speed on the reference laptop: a 7.5 s 1080x1920 edit in 13.7 to 14.2 s against 15.8 to 15.9 s on FFmpeg, with encoding most of the time and the engine still waiting for each frame's readback. The app runs a performance test on its first start (`benchmarkBackends`; `ui/Setup/PerformanceWindow`): both renderers draw a 4.5 s 1080p edit, the engine's picture must match within ΔE 3, the graphics card is chosen when at least 5% faster, and the choice becomes the default renderer for that machine (on the reference laptop the two come out within a few percent, so FFmpeg stays). Numbers and details are in [the render engine guide](../guides/render-engine.md). Open: the effects the templates use (so they render on the engine), fit blur, keyframes, slide animations, the other transitions, layer masks, rounded corners, shadows, 3D and corner pins; the sound without a second decode of the video; overlapping readback with drawing; building the engine in CI for every target.

**N1, Move rows (done 2026-11-03, within N0).** The section 3.5 table has one **Move** row, the audio analysis. N0 profiled it and ported `frameFeatures`, 82% of the time; segmentation, tempo and beats measured under 1% each, so by the decision test they stay in TypeScript. The TypeScript kernel is only the parity oracle in `test/helpers/audio-reference.ts`. Nothing else is left to port; re-measure the **Stay** rows when their inputs grow.

**F12, frame interpolation (done 2026-11-03).** `clips[].interpolate` turns on smooth motion; `set_speed` and `speed_ramp` set it by themselves when a video clip now shows frames its footage lacks (`smooth: false` opts out), and the new `interpolate` tool turns it on for clips (also for footage below the edit's frame rate, the frame rate conversion case) and prepares the frames with a report and a frame to look at. Only the frames the edit shows are made (`engine/tools/video/interpolate.ts`): each output frame's source time comes from the clip's time map (speed, ramp, reverse), a real frame is used within a twentieth of a frame of one, and RIFE makes the rest at the fraction between its two neighbors, so a ramp's fast parts cost nothing; identical neighbors and cuts inside a clip (a mean difference over 40 levels) hold the nearer frame. The result is the clip's retimed picture in source order at the project frame rate (long side up to 1920, at the render cache's intermediate quality), planned and cached like masks (`interpolate` jobs keyed by the source and every frame's source time), and `compile.ts` reads it in place of the source; quick previews on proxies use it once prepared and repeat frames until then, since making it takes minutes. Models compared on six project clips with every other frame dropped and remade, scored against the real ones, in [the slow motion guide](../guides/slow-motion.md): RIFE 4.9 (MIT, 21 MB, an export taking the time as a seventh input channel) 35.2 dB mean, better on every clip, over `minterpolate` 33.4, blending 30.5; an ensemble export scored the same and has no license on its page, a midpoint-only export cannot make 0.25 or 0.75. Inference stays in ONNX Runtime, as section 3.5 settles (the table's "inference in Rust" predates that): the padding and conversion around it are well under 1% of a frame's time. DirectML is 2.5 to 3.5 times faster than the CPU here and the provider check keeps it. Measured on the reference laptop: a box moving 8 px a frame slowed 4x moves 2 px every output frame, never repeated, and stays 80 px wide (no doubled edges), while with smooth motion off frames repeat; 15 fps footage in a 30 fps edit steps evenly (`test/video/interpolate.integration.test.ts`); push-ups at 720p slowed 4x, 105 frames made in 126 s, consecutive frames differing by 3.2 to 4.2 levels and no tearing at the head, arms or gloves; the same clip in a 60 fps edit, no repeated frames. Open: the section 7.3 checks on the test clips of section 11 (fast motion); speed (about a second a frame at 720p with a graphics card, several without); masks and removals on made frames come from the nearest real frame; motion blur in the footage stays.

**F11, object removal (done 2026-11-03).** `remove_object` takes a tracked object (`select_object`; tracked first if it is not yet) or a fixed box of the edit's frame (a logo, a sign; mapped to the source through the clip's fit) out of video and photo clips, through the new `removeObject` effect (`objects`, `regions`, `grow`, `feather`), placed first so grades apply to the fill; calling again adds to the clip's removal, `remove` takes one object or all of it out. The fill is prepared before rendering like a mask (`engine/tools/vision/removal.ts`, a `removal` job after the object masks it reads) and cached per clip range as FFV1 with transparency (long side up to 1920); `compile.ts` brings it in through the same timing and fit as model masks and the effect overlays it. It differs from section 7.2 in one way: moving cameras also get a plate, not per-frame inpainting. The background is tracked as a homography per frame (`trackRegion` away from the mask; affine was worse on a forward move, 8.6 against 7.1 levels); 9 frames in 10 within a pixel at the corners make the shot locked off. The new Rust `Remover` (`native/ave-native/src/remove.rs`) keeps a pool of frames (3 a second, 8 to 48, within 320 MB) and fills each frame's hole (the mask grown, then feathered; Felzenszwalb distance transforms near the mask only) from them moved onto it: on a locked-off shot exact copies and the median of every pool frame that sees the pixel, on a moving one the median of the 5 nearest in time with exposure matched on a ring (a denser pool and fewer or more neighbors changed little). What no frame shows goes to LaMa (big-lama ONNX, Apache-2.0, fixed 512 input, a crop 2.5 times the gap on the frame as filled so far); it won against MI-GAN (MIT) on seven project frames, better PSNR on 6 and no invented structure, and is recorded in [the removal guide](../guides/removal.md). Each model result becomes a layer later frames take from along the camera's motion, and the next run treats it as known, which is the temporal stabilization: an object that never moves on a tripod shot costs one run and stays put. Leftovers under 3 px thick are filled by push-pull instead. Frames are read with one streamed decode per pass (`streamFrames`; seeking per chunk re-decoded from the last keyframe, 2.5 s a seek on 10-bit AV1), and LaMa uses one session (DirectML fails on its Fourier layers on the reference laptop; the provider check keeps the CPU). Measured on the reference laptop (`test/vision/removal.integration.test.ts`, `test/render/removal.integration.test.ts`, `native` unit tests): a locked-off generated shot rebuilt exactly with no flicker; a sign over a sub-pixel pan, 0.43 levels and 0.23% flicker a frame (target 4%), and through a render 35.8 levels from the clean plate before and 3.7 after (the encode); a never-revealed box, one model run for 60 frames, identical on each; a photo painted once and held. On project footage, a plain area "removed" from real moving shots, with the original as truth: a forest on a forward move 100% from real frames, 7.1 levels, 3.5% flicker, 240 ms a frame at 1080p; fog over mountains 0.9% flicker; a slow zoom on a waterfall (75% painted, water cannot be painted back) 3.2%; a pen on a locked-off desk gone with the grain continuing, about 40 s for 4 s. Open: the section 7.2 checks on real objects (a person crossing a locked-off shot, a car on a pan) with the test clips of section 11; parallax on deep moving shots (one homography for the background; depth-layered plates could use F10); moving things behind the object come back as other frames showed them; three decodes per removal, slow on AV1 sources; LaMa for the parallax effect's larger moves.

**F10, depth (done 2026-11-02).** `estimate_depth` shows and measures a clip's depth; a `depth` mask kind (`distance: [a, b]`) works in any effect, `grade_region` and `render_mask`; `set_focus` sets the new `depthOfField` effect from a point, box, distance or tracked object (focus follows the object), or racks it between subjects; `depthFog` and `parallax` (a 2.5D move, on photos too) come through `add_effect`. Models compared on eight project frames and recorded in [the depth guide](../guides/depth.md): Depth Anything V2 Small (Apache-2.0) over V1 Small (soft edges) and DPT-Hybrid MiDaS (blurry, 5x larger, 2x slower); DepthPro is excluded by license. It runs in ONNX Runtime, not Rust, as section 3.5 settles for inference (DirectML is slower than the CPU for it on the reference laptop, 1.7 against 1.2 s, and the provider check keeps the CPU). It looks at keyframes twice a second (`engine/tools/vision/depth.ts`); the new Rust kernel `depthSequence` fits each keyframe to the previous one moved with the camera (least squares from a robust start, trimming the pixels that disagree), carries depth between keyframes along the camera's motion (`trackRegion`, affine, whole picture) from both sides, snaps edges with a float guided filter (now shared with the 8-bit one) and blends lightly over time. Distance is 0..1 per clip, the first moment's 2nd..98th percentiles at 0.1..0.9 so later frames have room, stored as 16-bit gray FFV1 in the render cache; photos get a single frame, held. Depth of field cuts 6 soft bands; each band's color is a normalized blur of the band alone in 16 bits (no subject colors in the blurred background), and bands go on far to near covering their blurred matte and, sharply, themselves and everything nearer (no gaps, exact where bands meet); a rack sends new blur strengths to each band's `gblur` ten times a second (`sendcmd`). Parallax fills what nearer layers uncover with a floored normalized blur and cross-fades layers over half a layer; 8-bit normalized blurs had drawn cyan seams, which the 16-bit path removed. Measured on the reference laptop: flicker in static areas 0.09% to 0.22% a frame on three project clips (target 3%), 16 s for 3 s of footage; with a model stand-in drifting in scale every keyframe, one scale and 0.06% flicker (`test/vision/depth.integration.test.ts`); with exact depth, no halo beyond 2 px around a sharp subject, a rack focus without jumps between bands, depth masks and fog limited to the far part, parallax moving a near box 34 px and a far wall 8 px (`test/render/depth.integration.test.ts`). inpainting for larger parallax moves (F11); subjects moving fast between keyframes lag up to a quarter second before the edge filter catches them.

**F9, particles and light (done 2026-11-01).** `add_particles` and `update_particles` draw a preset (rain, heavyRain, snow, dust, embers, sparks, confetti, bokeh, smoke, fog; data in `engine/library/particles`) with density, size, speed, wind, color, birth area, ground line and seed into a full-frame media layer with the preset's blend mode; the asset records its settings (`particles`), so it can be redrawn. The generator is new Rust (`native/ave-native/src/particles.rs`, the `ParticleRenderer` class): emitters, gravity, drag toward the wind, curl-noise turbulence, size, opacity and color over life, streaks along the motion over the shutter, spinning and tumbling rects, bokeh discs, glows, random depth (near particles bigger, faster and blurrier), ground splashes, flicker, and drifting multi-layer fractal noise for smoke and fog, simulated twice a frame with SplitMix64 and drawn in 16-row bands in parallel, each band painting in the same order, so frames are identical however they are requested. Simulated time per frame follows the speed of the footage under the layer (speed ramps included). Frames stream into an FFV1 video with transparency (`writeAlphaVideo`, now shared with `create_graphic`), so renders only read a file. Media layers gained `mask`: key, luma and shape mattes are cut from the picture under the layer, and person and sky come from mattes of the finished main picture, made once at half size like the `behindSubject` cutout (`finishedMattes`; its cache key now leaves out assets only layers use, so redrawing a layer keeps the mattes). `add_light` adds `lightRays` (FFmpeg: highlights over a threshold at quarter size, 6 zoom passes about the source for 64 log-spaced samples per ray, tinted and screened) or a lens flare (natural, anamorphic or subtle: glow, streak and ghosts along the line through the frame center, drawn by the same Rust renderer), which follows a path or a track and is sized by the picture's brightness at the source, measured 4 times a second; a flare on a dark spot is refused. Measured on the reference laptop: 2,000 particles at 1080p in 8.8 ms a frame (budget 40 ms), smoke and fog 35 to 37 ms; 5 s at 1080p drawn and encoded in 5.6 to 10 s. Checks (`test/render/particles.integration.test.ts`, `test/native/native.test.ts`): every preset shows on a dark plate, and covering ones on a bright plate, in contact sheets written to `test/.output/particles`; same seed, identical renders, in any batches; fog held out by a key mask untouched beyond 12 px of the feathered edge and fading monotonically across it; snow masked to the sky leaves the ground untouched; rays from a sun behind branches form shafts and fade with distance; a flare's ghost lands on the line through the center. Numbers are in [the atmosphere and light guide](../guides/atmosphere-and-light.md). GPU particles in the engine (E1); weather that interacts with the scene (wet surfaces, settling snow, splashes on real surfaces rather than one ground line).

**F8, scene grading (done 2026-11-01).** `grade_scene` matches each scene's shots to its reference, a hero clip or an imported still, and `match_color` (one reference) now runs on the same matcher (`engine/tools/render/color-transfer.ts`). Each shot is rendered at three frames as it comes out of its clip (no whole-video grade, no earlier match). Three methods are fitted on the outer two frames and scored on the middle one, and the lowest score wins: the Oklab transfer of section 4.3 (lightness by 15 quantiles, the a/b plane by the linear Monge-Kantorovich map between the two color covariances, scale factors held to 0.4x to 2.5x), Reinhard mean and spread per Oklab channel, and the old per-channel RGB curves. The score is the mean ΔE 2000 between CIELAB quantiles (5% to 95%) of the matched held-out frame and of the reference, which compares color distributions and needs no matching pixels. The hue limit eases off the chroma part until 90% of colorful pixels turn at most `maxHueShift` (15 degrees by default). Skin protection samples faces found by YuNet and, when the match leaves their average more than 5 degrees off the vectorscope skin line (123 degrees, Rec.709), adds a hue turn limited to skin hues (a Gaussian of 25 degrees around the skin's Oklab hue, faded out below chroma 0.02); curves cannot carry it, so they only win when skin stays on the line. The result is a new `colorMatch` effect holding the fitted numbers, last on the clip. A transfer renders as `geq` on a Hald identity image baked by `bakeColor` into a 64-level table, so the project stays self-contained and undo-safe and a render pays for the math once. The spec's 17-point 3D LUT is this baked table. Two FFmpeg findings came out of it: `bakeColor` pins a format before each entry, so `geq` needs `format=gbrp` in the same entry (it now counts every filter of an entry), and `pow()` gives NaN for negative bases, so cubes are written as products. Measured: the CIEDE2000 implementation matches Sharma, Wu and Dalal's reference pairs to 4 decimals; graded test pairs (darkened 0.6 stop, warmed and desaturated 30%; 1 stop darker; brighter, cooler and 40% desaturated) come back from 8.6, 11.0 and 6.0 ΔE 2000 to 0.99, 0.01 and 1.87, pixel by pixel, with skin within 5 degrees of the line (`test/render/color-match.test.ts`); through the tools and renderer, a regraded shot went from 21.6 to 1.4 ΔE against its hero (`test/render/color-match.integration.test.ts`); the baked table renders within 1.5 ΔE of the numeric transfer. Open: section 4.3 checks on real multi-camera scenes and skin in three skin tones (the test clips of section 11); the score compares per-channel quantiles, which ignores how colors pair up across channels.

**F7, sky replacement (done 2026-10-30).** A `sky` mask kind (any effect, `grade_region`, `render_mask`) and `replace_sky`, which sets up the new `skyReplace` effect. Models compared on nine project frames and recorded in [the sky guide](../guides/sky.md): skyseg (U-2-Net for sky, MIT, 1.3 s a frame on the CPU) over UperNet ConvNeXt-tiny ADE20K (4.8 s, soft edges), DETR panoptic (9.4 s, blobby), CLIPSeg (0.7 s, far too coarse) and OWLv2 with SAM 2.1 (16.7 s, misses sea and dusk shots); SegFormer and MaskFormer are excluded by license. skyseg runs on keyframes once a second (`engine/tools/vision/sky.ts`); the matte is carried between them by `trackRegion` on half-size frames, forward and back with validity weighting (warps report where they left the picture, so sky coming into view in a pan is not lost), snapped to edges by `guidedFilter` at 768 px and smoothed over time. The same pass measures the camera's motion from a band of distant scenery under the sky (similarity, full size, chained across keyframes), which `replace_sky` maps into the edit's frame, smooths and simplifies into `motion` keyframes. DirectML takes 22 s to create a session for skyseg and then halves its time, so the CPU starts at once and the graphics card takes over in the background for jobs of 40 model frames or more. The effect crops the new sky to cover the frame with room to move, matches brightness (`gain`), softens it, moves it per frame, lays on horizon haze (a wide, short spread of the scenery, so towers get no glow; the color is the new sky's horizon, paler), relights the scenery slightly, and composites through the matte grown a pixel over the outline. Effects can now read picture assets (`EffectContext.media`, `usesMedia`), and the render cache key covers those files. `numberExpr` now builds a balanced if() tree, since long keyframe lists (a tracked path) exceeded FFmpeg's nesting limit. Measured on the reference laptop: on a generated skyline, no old sky along the edge, the new sky covering at most 2 rows of the outline, scenery ΔE under 3, haze only along the skyline (`test/render/sky.integration.test.ts`); on a generated pan, worst IoU 0.998, edge within 1.3 px, camera motion 0.33 px off after 3 s (`test/vision/sky.integration.test.ts`); 4 s of 720p handheld footage in 25 s. Open: section 5.3 checks on real sky pans (the test clips of section 11); pale bands above haze-blended ridges and old sky inside fine structures (lattices, wires); the horizon color match is a brightness match plus haze, not a color transfer.

**F5, point and surface tracking (done 2026-10-30).** `track_points` marks four corners of a flat surface or a point with the square around it (edit frame fractions at a timeline time, mapped to the source through the clip's fit without rounding) and stores it in `project.tracks`; it is tracked through every primary clip of its video with the Rust `trackRegion` (perspective for corners, similarity for a point, or translation), forward and backward from the marked frame on 960 px gray frames, smoothed with a centered [1 2 1] filter, and cached per clip range in the render cache (`engine/tools/vision/points.ts`). `margin` adds a screen's bezel to the tracked area. `pin_layer` turns a track into position, scale and rotation keyframes that keep the layer's offset; `replace_screen` adds a media layer with the new `keyframes.corners` (a corner pin in frame fractions), which `compile.ts` renders with `perspective` (`sense=destination`, per-frame expressions, padded corners placed by the same homography so edges stay clean). Both bake keyframes, so renders never track. `numberExpr` now keeps five decimals for values (three moved positions in 2 px steps at 1080p). Measured on the reference laptop: synthetic homographies tracked forward and backward under 0.5 px (`test/vision/points.test.ts`); through encode, `track_points` and `replace_screen`, worst corner error 0.28 px over 59 frames, and the rendered insert sits on the moved surface (`test/vision/points.integration.test.ts`); a pinned layer within 1.8 px; a 10 s 1080p pan 0.25 px off after 10 s, tracked in 14.5 s (48 ms a frame). Two output-preserving changes to the Rust kernel took tracking from 83 to 48 ms a frame: Lucas-Kanade samples the template window once per level, and pyramids are built row-parallel. Numbers are in [the tracking guide](../guides/tracking.md). the insert's matched blur, glare and color match (for now Claude adds a blur and a grade through `effects`); occlusion of the insert by an object mask (a finger over the screen).

**F4, any-object selection and tracking (done 2026-10-30).** `select_object` (a box, a point or a name, in the edit's frame at a timeline time, mapped to the source through the clip's fit) stores the object in `project.objects`; masks use it with `kind: "object"`; `track_object` follows it through the clips and reports confidence and unsure ranges. Models, compared on seven project frames and recorded in [the objects guide](../guides/objects.md): SAM 2.1 hiera tiny for segmentation (3.7 s a frame; IoU 0.98 to 0.99 with SAM 2.1 small on box prompts; SlimSAM failed on boxes; DirectML on the Intel GPU no faster), OWLv2 base for names (8 of 8 found; Grounding DINO tiny fails in the transformers.js pipeline). Since no SAM-class model segments every frame within budget on the reference laptop, SAM runs on keyframes every 1.5 s, and the mask is carried between them by new Rust kernels (`trackRegion`: Shi-Tomasi corners inset from the mask edge, pyramidal Lucas-Kanade with a forward-backward check, RANSAC for translation, similarity, affine or homography; `warpMasks`; `guidedFilter` for edges). Spans are tracked both ways and blended; where the two directions disagree in the middle, SAM segments a frame there and the halves are solved again, which fixed fast non-rigid motion (a person turning). Each keyframe keeps the SAM answer that overlaps the prediction most, against identity switches. Measured on the reference laptop: a synthetic textured object on a known path, mean IoU 0.955 (worst frame 0.892), flicker 0.12% (`test/vision/objects.integration.test.ts` asserts 0.85 and 2%); a 10 s phone clip in 50 s, 165 ms a frame (budget 200 ms, 60 s); the fast-turning person costs more (adaptive keyframes). SAM 2.1 large as a numeric reference (its download did not finish on the test connection).


**N0, native workspace (done 2026-10-28, except publishing).** `native/` is a Cargo workspace with `ave-native` (napi-rs 3, rayon, rustfft), loaded through `engine/tools/native` and built with `npm run native`; see [native/README.md](../../native/README.md). Profiling the audio analysis on the reference laptop showed `frameFeatures` (level, zero crossings and a 512-point spectrum per 10 ms frame) at 82% of the sound map and beat detection, and everything else under 1%. So `frameFeatures` is the first kernel, and segmentation, tempo and beats stay in TypeScript. It runs as an `AsyncTask` with rayon chunks, so it never blocks Node. `analyzeSamples`, `detectBeats` and `levelSpeech` became async, and `speechPieces` takes the map, because of that. The old TypeScript kernel is the parity oracle in `test/helpers/audio-reference.ts`. `test/native/native.test.ts` checks synthetic edge cases and the recorded test media: features within float rounding, and identical sound maps and beats. Measured on the reference laptop: frame features of 232 s of audio 940 ms in TypeScript, 98 ms in Rust (9.6x); the sound map and beats of a 10-minute recording 302 ms (target under 2 s); event loop delayed at most 39 ms during the call (target 50 ms). The numbers are in [the raw footage guide](../guides/raw-footage.md). CI builds the addon and runs the Rust tests on Windows, Linux and macOS (arm64), and keeps each build as an artifact. On hold until everything else is done (packaging): publishing per-platform npm packages (`@ai-video-editor/native-<target>`, which the loader already tries first); macOS x64 and Linux on glibc 2.31 builds (CI uses Ubuntu 22.04, glibc 2.35). Open: `AbortSignal` and progress in kernels (this one finishes in well under a second, so neither was needed yet).


**F1, blend modes (done 2026-10-28).** `layers[].blend` on media and graphic layers, set through `add_media_overlay`, `create_graphic` and `update_layer` (`compile.ts`, `BLEND_MODES`). The layer is placed on a clear frame-size canvas, blended in `gbrp` with the picture as the backdrop (blend's first input, so `overlay` and `colordodge` follow the usual definitions), and shown through the layer's alpha with opacity and fades. Conversions to and from RGB use nearest-neighbor chroma, which makes the round trip exact. Checked in `test/render/masks.integration.test.ts`: screen and add of a black layer change nothing (pixel exact), and multiply matches its formula within 3 code values (8-bit YUV in and out). Open: the linear-light comparison for `add` and `screen` waits for the 16-bit pipeline (section 3.3) or the engine, and the "fire clip on black" check needs the test clips of section 11.

**F2, masks (done 2026-10-28).** `MaskSchema` in `core/schema.ts`, with any effect taking `mask` and `label`. `library/effects/masks.ts` builds the mattes: `person` and `face` from the prepared streams (one copy per mask, counted by `maskStreams`), `key` and `luma` as an HSL qualifier (circular hue, HSV saturation, Rec.709 luma, smoothstep softness) baked into a Hald CLUT once and applied at full size, and `shape` drawn once. Each mask also takes `invert`, `feather`, `grow`, `smooth`, `denoise` and `combine` (`add`, `intersect`, `subtract`). `effectToFilter` wraps every masked effect in `maskedEffect`. `render_mask` shows the matte (white on black, or a red overlay) where the effect sits in the chain. Checked: a hue key selects a blue area and rejects red, hue ranges wrap through red, grays never pass a hue test. `object` and `sky` kinds came with F4 and F7. Not yet built: the `depth` kind (F10); mask shapes with keyframes or pinned to a track (F5 pins layers, not mask shapes). The masks still run in the 8-bit pipeline (section 3.3 is not started). The special cases in `beauty`, `backgroundBlur` and `backgroundReplace` are kept for now. Open: IoU against hand mattes for sky and skin keys (section 4.2) waits for the test clips.

**F3, `grade_region` (done 2026-10-28).** Adds, updates (color settings merge, a new mask replaces the old) or removes a labeled secondary on a clip, a layer, `all-clips` or `global`, and rejects person and face masks where no stream exists. Secondaries go after the whole-frame `color` effect and before stylizing (`setMaskedEffect`), and `color_adjust` and `get_color` only touch the whole-frame grade. Checked: grading inside a feathered mask ramps smoothly across the edge (feather 0.05 gives a 90% to 10% ramp of more than 8 px at 180 px height), and pixels outside the mask are unchanged.

F1 to F4 give the biggest jump for the effort (sky work, glows on one object, grading one part of the frame) and reuse what exists. N0 comes first because every model-based feature builds on it. E1 should start at the same time, since the film look, log and precision work (F6, E2) is only worth doing properly in float. If the engine is not built, the fallback path of section 3.3 (10-bit FFmpeg pipeline, hand-written log LUTs) still reaches a good, but lower, standard.

## 14. Risks and open questions

- **Engine scope.** A render engine is a large project. Keep the plan format small and versioned, port features one at a time behind parity tests, and never let the FFmpeg backend fall behind on correctness while the engine catches up.
- **GPU variety.** Integrated GPUs, old drivers and remote desktops can fail. The engine checks the adapter at start, falls back to the FFmpeg backend, and reports why in the app. As built: the performance test sets FFmpeg as the default where the engine fails or draws a wrong picture, and `auto` falls back to FFmpeg when a render on the engine fails.
- **Build and packaging.** The Rust engine and the `ave-native` addon need prebuilt binaries for every target of section 3.6, shipped like `ffmpeg-static` or `@resvg/resvg-js`. Users must never need a Rust toolchain. CI builds both on three systems (N0); publishing them per target is on hold: packaging comes after everything else is done. Dropping OpenColorIO (E2) removed the C++ shim.
- **Two languages.** Contributors now need Rust as well as TypeScript, and a bug can sit on either side of the boundary. The rule of section 3.5 keeps the line clear (measured hot paths that port easily go to Rust; everything about the edit, and anything not worth porting, stays in TypeScript), parity tests pin behavior during ports, and the boundary stays coarse so it is easy to reason about.
- **CPU speed.** Without a GPU, video segmentation, depth and interpolation are heavy on a 2-core laptop. Everything model-based runs before rendering, in the background, cached per clip and source range, with progress; previews use proxies. Measure each against its budget before building on it.
- **10-bit cost.** 10-bit segments are larger and slower to decode. Measure before switching the cache default.
- **Model licenses** change between versions; record the exact weights file and license in code next to the download URL.
- **Temporal consistency** is the main quality risk for every per-frame model (mattes, depth, inpainting). Every such feature includes smoothing and a flicker check.
- **Log detection** from pictures is unreliable; asking the user (with visual choices) is the safe default when metadata is missing.
- **Trademarks**: film looks are named by character ("warm print-like"), never by a manufacturer's stock name.

## Appendix A. Where the code was when this was proposed (measured 2026-10-27)

A snapshot, kept for the measurements. Everything under **Missing** has been built since (section 13).

- **8-bit pipeline.** Every primary segment ends in `format=yuv420p` (see CLAUDE.md, renderer gotchas). Strong grades band.
- **Filter precision** with 10-bit input (`yuv420p10le`), read with `showinfo` after each filter:

  | Filter | Output format | Notes |
  |---|---|---|
  | `eq` | `yuv420p` | **Drops to 8-bit**: replace in the 10-bit pipeline |
  | `vignette` | `yuv420p` | **Drops to 8-bit**: replace |
  | `colorbalance`, `curves`, `lut3d`, `vibrance`, `colortemperature`, `colorchannelmixer` | `gbrp10le` | Keeps 10-bit |
  | `huesaturation`, `selectivecolor` | `rgb48le` | 16-bit |
  | `exposure` | `gbrpf32le` | Float |
  | `gblur`, `unsharp` | `yuv420p10le` | Keeps 10-bit |
  | `noise` | `yuv420p16le` | 16-bit |

- **Available in the bundled FFmpeg:** `zscale` (zimg), `colorspace`, `tonemap`, `lut3d`, `haldclut`, `blend`, `maskedmerge`, `minterpolate`, `v360`, `perspective`. 10-bit encoders: x264 (High 10), x265 (Main 10), ProRes (`prores_ks`), FFV1.
- **Already built and reusable:**
  - Per-clip mask videos prepared before rendering and fed through the clip's timing and fit (`EffectContext.personMask`, `faceMask`, `render.ts#planMasks`), and `maskBranch` (run a chain on a copy, show it through a mask).
  - Baking per-pixel color chains into a Hald CLUT in the graph (`bakeColor`), so a grade is already a 3D LUT internally.
  - Pinhole projection of layers (`rotateX`, `rotateY`) and per-frame corner expressions through `perspective`.
  - Animated alpha layers from code (`create_graphic` writes FFV1 with alpha), proxies, the segment cache, scopes, `match_color`, `detect_scenes`, the sound and face models and their download and caching helpers (`ensureModelFile`, `loadOrt`).
- **Missing:** blend modes, any-object masks, tracking of anything but faces, color space handling, depth, particles, removal, interpolation.
