# Design: cinematic grading and common CGI effects

Status: proposed (2026-10-27). This is the build plan for movie-level color grading and the visual effects editors ask for most: sky replacement, glows and light effects on one object, screen replacement, depth of field, atmospherics, object removal and smooth slow motion.

The bar is professional results, not "a filter that looks similar". Every feature below has a measurable "done when" check, and every result must be something Claude can verify itself (scopes, mattes, frames) before it shows the user. Where a model is involved, candidates are compared on the same clips before one is chosen, as was done for faces (YuNet), person cutout (PP-HumanSeg) and sound (CED-tiny).

Changing the core of the project, and adding other languages, is allowed. Section 3.4 recommends doing so: the picture path moves from FFmpeg filter graphs to a GPU render engine with industry color management, and FFmpeg stays for decoding, encoding and audio. The feature specs in sections 4 to 7 hold for either engine; where an implementation note names an FFmpeg filter, it describes the fallback renderer.

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

## 2. Where the code is today (measured 2026-10-27)

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

## 3. Architecture

### 3.1 The grade, as a colorist builds it

Every clip's picture goes through fixed stages, in this order. Each stage is optional.

1. **Input transform**: the asset's color space (camera log, HLG, PQ, Rec.709) to the working space.
2. **Primary correction**: exposure, white balance, contrast, the existing color panel.
3. **Secondary corrections**: any number of corrections, each limited to a mask (section 3.2).
4. **Look**: film emulation, a creative LUT, grain, halation.
5. **Output transform**: working space to Rec.709 (gamma 2.4) or sRGB; later HDR.

The working space is display-referred Rec.709 in 16-bit (`gbrp16le`) or float (`gbrpf32le`) between stages. A scene-referred working space (for example ACEScct) is a later option; the stage order above already allows it without changing projects.

In the project document, the clip's `effects` keep their meaning. A new optional `grade` object holds the stages, so old projects render unchanged:

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
| `shape` | Ellipse, rectangle or polygon, with keyframes or pinned to a track | In the graph |

Every mask spec also takes `invert`, `feather` (blur radius as a fraction of frame height), `grow` (positive dilates, negative erodes), `smooth` (temporal smoothing, frames), and boolean `combine` (`intersect`, `subtract`, `add` with another mask spec). Masks combine in 16-bit gray.

Any effect, not only grades, takes an optional `mask`: a glow on one object, a blur on the background, sharpening on eyes. `effectsToFilter` wraps the effect in `maskBranch` when a mask is set. This replaces the special cases in `beauty`, `backgroundBlur` and `backgroundReplace` over time.

### 3.3 Pipeline precision

- Segments carry `yuv420p10le` between stages, and RGB stages run in `gbrp16le`. The segment ends become `fps`, `format=yuv420p10le`, `setsar=1`, `settb=AVTB`; `xfade` and `concat` work at 10-bit (verify both in the integration tests).
- Replace `eq` (8-bit) with `colorlevels` plus `curves` or a baked LUT, and `vignette` (8-bit) with a 16-bit `geq` falloff or a baked mask. Add a unit test that fails when a color effect's chain contains a filter known to drop precision.
- The segment cache stores x264 High 10 at CRF 12 (or FFV1 when `cacheLossless` is set). Measure size and speed against the current 8-bit cache before switching.
- Export: H.264 High 10 is not widely played; keep 8-bit H.264 as the default delivery, with dither (`format=yuv420p` after a 16-bit chain, with `zscale=dither=error_diffusion` if measurably better), and add ProRes 422 HQ and HEVC Main 10 as export choices.
- Baked LUTs move from Hald level 8 (64 per axis, 8-bit table) to a 65-point `.cube` written to the cache and applied with `lut3d` in 16-bit, since `haldclut` tables are 8-bit images. Keep the in-graph Hald path for 8-bit previews.

### 3.4 Render engine (recommended core change)

**Why.** The FFmpeg filter graph got the project far, but movie-level work needs things it cannot give:

- **Precision**: several filters are 8-bit (section 2), and compositing (`overlay`, `blend`) works on integer YUV or RGB, not float linear light. Glows, blurs and blends look physically wrong unless done in linear float.
- **Color management**: no OpenColorIO, so no ACES and no camera transforms maintained by the vendors and the industry. Hand-written log curves (section 4.1) are a fallback, not the standard.
- **Speed**: everything runs on the CPU, once per render. Real-time preview of a graded, composited timeline is not reachable on a laptop this way, and every model-based feature competes for the same cores.
- **Expressiveness**: per-frame logic lives in FFmpeg expression strings (see the 3D projection and `geq` masks). Shaders and real code are clearer, testable and far faster.

**Recommendation.** A native render engine for the picture path:

| Part | Choice | Why |
|---|---|---|
| Language | Rust | Memory safety for a long-running engine, good GPU and FFI story, ships to Node like `@resvg/resvg-js` (napi-rs) or as its own process |
| GPU | `wgpu` (DirectX 12, Vulkan, Metal) | One code path for Windows, Linux and macOS; runs on integrated GPUs like the reference laptop's Intel UHD; compute shaders (WGSL) for grading, blurs, keying and compositing |
| Color | OpenColorIO 2 (BSD-3), ACES 1.3 configs (OCIO config "cg" and "studio") | Industry-standard input transforms for every camera, ACEScct grading space, and display transforms. OCIO generates GPU shader code and LUT textures for any transform; a small C++ shim exposes that to Rust |
| Precision | `rgba16f` textures in linear scene-referred (ACEScg) between nodes; grading operators in ACEScct | Float everywhere; no banding; physically correct blends and blurs |
| Decode / encode / audio | FFmpeg libraries (through `ffmpeg-next` in Rust) or the bundled `ffmpeg` binary through pipes at first | Keep FFmpeg's codec coverage; audio stays on the current FFmpeg graph |
| Text and vector | resvg (already used for graphics) and libass for captions, uploaded as textures | Reuse what works |
| ML models | ONNX Runtime with GPU execution providers: DirectML (Windows, any GPU), CUDA (NVIDIA), CoreML (macOS); CPU fallback | Segmentation, depth and interpolation become fast enough for interactive use; larger, better models become practical |

**Shape of the engine.** The project document and the Claude tools stay the contract; only `compile.ts` and `render.ts` gain a second backend.

1. **Plan**: the TypeScript side turns the project into an engine plan (JSON): per output frame range, the sources, transforms, grade nodes, masks, layers and blend modes. This is a pure function like `compileProject`, unit-tested the same way.
2. **Render**: the engine decodes frames, uploads them, runs the node graph per frame on the GPU, and hands frames to the encoder. Masks from models are textures produced by the same engine (models run through ONNX Runtime on the same GPU when possible).
3. **Preview**: the same engine renders single frames and scrubbing previews in real time where the GPU allows, for the app's viewer and for Claude's `render_frame` (much faster than spawning FFmpeg per frame).
4. **Fallback and reference**: the FFmpeg backend stays. Parity tests render the test projects with both backends and compare (mean ΔE 2000 under 1 for 8-bit-safe features, excluding features only the engine has). Machines without a usable GPU use the FFmpeg backend.

**Process boundary.** Start with the engine as a separate executable speaking JSON-RPC over stdio, like `src/host/main.ts` does for the app: it crashes alone, can be rebuilt without touching Node, and is easy to test. Move to an in-process napi-rs module only if the per-frame handoff (preview) measurably needs it.

**Desktop app.** The WPF app can show engine frames through a shared texture or a memory-mapped frame buffer instead of PNG files, which makes the viewer live (scrubbing, A/B before and after, matte overlay). The app remains AI-first; this only makes looking faster.

**Done when** (engine milestone): the engine renders every current template and integration test project; parity with the FFmpeg backend within ΔE 2000 of 1 on 8-bit content; 1080p30 playback of a graded clip with two secondaries and a blended overlay in real time on the reference laptop's integrated GPU, or at least 3x faster than the FFmpeg backend there.

## 4. Grading features

### 4.1 Color spaces and camera log (`set_color_space`)

- **Asset field** `colorSpace`: `rec709` (default), `srgb`, `slog3-sgamut3cine`, `slog3-sgamut3`, `vlog-vgamut`, `applelog`, `clog3-cinemagamut`, `logc3-awg3`, `logc4-awg4`, `dlog-m`, `bmdfilm-gen5`, `hlg-rec2020`, `pq-rec2020`.
- **Detection**: read `color_transfer` and `color_primaries` from the probe (`arib-std-b67` is HLG, `smpte2084` is PQ). Log footage is usually tagged Rec.709, so look for camera metadata tags (Apple Log writes its own), and otherwise judge from the picture: a flat histogram with no blacks below about 10% and no whites above about 70% suggests log. When unsure, Claude asks with `offer_choices`, showing the clip converted with the two or three likeliest curves.
- **With the engine (section 3.4)**: use the OCIO ACES config's camera input transforms (they cover Sony, Panasonic, Apple, Canon, ARRI, RED, Blackmagic and DJI log spaces, maintained by the vendors and the Academy), grade in ACEScct, and output through the ACES display transform or a chosen look's output transform. The hand-written path below is the fallback renderer's.
- **Implementation (fallback)**: for each log space, generate a 65-point `.cube` from the published formulas: the log curve to linear, the camera gamut to Rec.709 primaries (3x3 matrix with Bradford adaptation where white points differ), then a display transform. Cache it in the models folder by name and version. HLG and PQ go through `zscale` (to linear, Rec.2020 to Rec.709) and `tonemap` (start with `hable` and `mobius`, compare against reference renders).
- **Display transform for log**: a plain gamma mapping clips highlights hard. Use a filmic tone curve with a soft shoulder (configurable `highlightRolloff`), so log footage looks like a finished camera image, not a clipped one.
- **References**: Sony "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3"; Panasonic "V-Log/V-Gamut Reference manual"; Apple "Apple Log profile" white paper; ARRI "LogC3" and "LogC4 Specification"; Canon "Canon Log 3" specifications; Blackmagic "Film Generation 5" documentation; DJI "D-Log M" color conversion documentation. Store the formula source next to each curve in code.
- **Done when**: each curve round-trips a synthetic ramp within 0.5% of full range; a gray card in a log test clip lands within 2% of 18% gray after conversion; no clipping before the rolloff on a 10-stop ramp.

### 4.2 Secondary corrections (`grade_region`)

- **Tool**: `grade_region { target, mask, color, label }` adds or updates one secondary on a clip (or every clip, or global). `color` is the same settings object as the color panel.
- **HSL qualifier** (`key` mask): computed per frame in 16-bit: convert to HSV with `geq` on a downscaled copy (half size), smoothstep on each range with `softness`, multiply, upscale the matte, feather. Use hue distance on the circle so red (around 0 and 360 degrees) works. Expose a `denoise` (small median on the matte) for noisy footage.
- **Done when**: on the test clips, a sky key selects sky with IoU 0.9 against a hand matte without catching blue clothing when `combine` with `sky`; a skin key passes through faces in three skin tones; grading inside the mask never shows a hard edge at feather 0.02 or more.

### 4.3 Scene grading and shot matching (`grade_scene`)

- Uses `detect_scenes`; the user (or Claude) picks a hero shot per scene. Other shots are matched to it, or all shots to a reference still (a frame from a film the user names, imported as an image).
- **Matching**: upgrade `match_color` from per-channel curves to a color transfer that also moves saturation and hue: fit a 3D LUT (17 points) from matched color distributions in a perceptual space (Oklab), with the transfer limited to plausible changes (no hue rotation over 15 degrees unless asked). Compare against the current curves method and against Reinhard-style mean and variance transfer in Lab; keep the one with the lowest mean color difference (ΔE 2000) on held-out frames of the same scene.
- Skin tones are protected: faces found by YuNet are sampled, and the match is constrained so their hue stays on the skin line (vectorscope around 123 degrees in Rec.709).
- **Done when**: on graded test pairs (a shot darkened, warmed and desaturated by known amounts), matching brings mean ΔE 2000 under 2; skin hue stays within 5 degrees of the skin line.

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
| `chromaticAberration` | Radial red and blue channel scaling (per-channel `lenscorrection`), stronger toward the edges |
| `lensDistortion` | Barrel or pincushion with `lenscorrection` |

- **Look presets** (catalog items, data not code, like templates): combinations of the above with a primary grade, for example "teal and orange blockbuster", "warm 70s print", "cold thriller", "bleach bypass". Descriptions say when to use each.
- **Done when**: halation never tints anything below the highlight threshold (pixel test); grain is identical across two renders with the same seed and differs per frame; looks are checked on the test clips by eye and with scopes, and stay legal (no clipping beyond 0.5% of pixels at default strength).

### 4.5 Export a grade (`export_lut`)

Write the clip's grade (input transform, primary, look, output; not the secondaries, which are spatial) as a 33- or 65-point `.cube`, so it can be used in DaVinci Resolve, Premiere or a camera monitor. **Done when**: applying the exported LUT with `lut3d` reproduces the rendered grade within ΔE 2000 of 1 on test frames.

## 5. Selecting and tracking anything

### 5.1 Blend modes on layers

- **Schema**: media and graphic layers get `blend`: `normal` (default), `screen`, `add`, `multiply`, `overlay`, `softlight`, `lighten`, `darken`, `colordodge`, `difference`.
- **Implementation**: the layer is placed on a transparent frame-size canvas at its position (as overlay does), then `blend` with `all_mode`, and `maskedmerge` with the layer's alpha times opacity so only the layer's area changes (`blend` ignores alpha). In the 16-bit pipeline, `add` and `screen` for light effects run on linearized values (`zscale` to linear and back) so glows add like light; compare both and keep linear if it measurably looks closer to a reference composite.
- **Done when**: screen and add of a black layer change nothing (pixel exact); each mode matches its formula on a test pattern within 1 code value; a fire clip on black composites over a dark plate with no visible box.

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

### 5.3 Sky segmentation and replacement (`replace_sky`)

- Sky mask: compare text-prompted segmentation ("sky") with a dedicated sky or semantic segmentation model. Note: SegFormer weights are under NVIDIA's non-commercial source code license and cannot be used.
- Replacement: the new sky (image, video or generated gradient) moves with the camera: estimate camera motion from the background track (section 5.4) and move the sky plate by the same amount, scaled for distance. Match the plate to the scene: blur to the scene's sharpness, color-match its horizon band to the scene's horizon, add a soft horizon haze, and relight the foreground slightly toward the new sky's color (a masked grade with low strength).
- **Done when**: on the test clips the sky edge has no halo wider than 2 px at 1080p, the sky does not slide relative to the horizon during pans (drift under 2 px per 5 s), and the foreground tint shift is under ΔE 3 unless asked.

### 5.4 Point and surface tracking (`track_points`, `pin_layer`, `replace_screen`)

- **Algorithm**: pyramidal Lucas-Kanade feature tracking on downscaled gray frames (good-features corners inside the user's region), outlier rejection with RANSAC, and a model per use: translation (point), similarity (scale and rotation), or homography (a flat surface: a screen, a sign, a wall). Smooth with a short bidirectional filter; mark frames where too few features survive and re-detect. Written in TypeScript like the face pipeline, with typed arrays; no new native dependency.
- **pin_layer**: attach any layer to a track: position, scale and rotation keyframes from the track (reuse `simplifyKeys`).
- **replace_screen**: four tracked corners per frame drive `perspective` with `sense=destination` for the inserted video or image (the corner-pin code from 3D layers). Add a matched blur, a slight glare pass and color match to the screen's surroundings so the insert sits in the shot. Occlusion (a finger over the screen) uses an object mask from section 5.2 over the insert.
- **Done when**: synthetic homography tests give corner error under 0.5 px; real phone and monitor clips drift under 2 px per 5 s; a tracked insert survives motion blur on a fast pan without jumping (re-detection within 3 frames).

## 6. Atmosphere and light (`add_particles`, `add_light`)

- **Generator**: deterministic particle simulation in TypeScript (seeded), with emitters, gravity, wind, drag, turbulence (curl noise), size and color over life, motion blur by drawing streaks along velocity, and depth layers (near particles bigger, faster, blurrier). Rendered to RGBA like `create_graphic` and placed as an alpha layer with a blend mode.
- **Presets** (data): rain (light, heavy, with splashes at a ground line), snow, dust motes in light, embers and sparks (rising, flickering), confetti, bokeh orbs, smoke and fog (fractal noise layers drifting, not particles), light rays (radial blur of thresholded highlights from a source point), lens flare (ghosts along the line through the frame center, sized by the source's brightness).
- **Interaction**: particles can be limited by a mask (snow only in the sky region, embers behind a person using the person matte as a holdout), and rain and snow slow down with the speed of the clip.
- **Budget**: 1080p, 2,000 particles, under 40 ms per frame to generate.
- **Done when**: presets look correct in contact sheets on dark and bright plates; renders are identical with the same seed; holdouts leave no edge artifacts.

## 7. Depth, removal and time

### 7.1 Depth (`estimate_depth`, and `depthOfField`, `fog`, `parallax`)

- **Model**: Depth Anything V2 Small (Apache-2.0). The Base, Large and Giant weights are CC-BY-NC-4.0 and must not be used. Compare against other permissively licensed monocular depth models on the test clips.
- **Temporal stability**: per-frame depth is relative and flickers. Align each frame's depth to the previous one with a least-squares scale and shift over static background pixels, then smooth over time. Cache as a 16-bit gray video per clip.
- **depthOfField**: split into 6 to 8 depth bands, blur each with a lens-shaped kernel sized by its distance from the focus distance, composite far to near with matte edges dilated to avoid halos. Focus distance can be keyframed (rack focus) or follow a tracked object.
- **fog**: mix a fog color by depth with an exponential falloff, optional noise drift.
- **parallax** (2.5D photo move): separate the photo into depth layers, fill the gaps behind near layers (inpainting, section 7.2), move a virtual camera.
- **Done when**: depth flicker under 3% in static areas; depth of field leaves no halo wider than 2 px around in-focus subjects on the test clips; a rack focus is smooth with no band edges visible in motion.

### 7.2 Object removal (`remove_object`)

- **Static camera**: build a clean background plate from frames where the area is not covered (temporal median of unmasked pixels), then fill the mask from the plate. This is the most reliable method and handles video correctly.
- **Moving camera or stills**: LaMa inpainting (Apache-2.0) per frame inside the mask, then temporal stabilization of the filled region (blend toward the motion-compensated previous fill). State the limits plainly to the user: large objects on moving shots may wobble.
- **Done when**: on locked-off test clips the removed area is indistinguishable in a contact sheet and has no flicker; on moving clips, flicker in the filled area is under 4%.

### 7.3 Smooth slow motion (`interpolate`)

- **Model**: RIFE (MIT) ONNX, compared with FFmpeg's `minterpolate` (no model, more artifacts) on the test clips. Used by `set_speed` and `speed_ramp` below 1x when the clip has no duplicate frames to spare, and for frame rate conversion.
- **Done when**: 4x slow motion of the test clips shows no tearing on moving edges in a contact sheet, and a 30 to 60 fps conversion passes a frame-difference smoothness check (no repeated frames).

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

Tool descriptions are read by Claude, so each says what the tool is for, what makes a good result, and how to check it (`render_mask`, `render_scopes`, `render_frame` at the worst frame).

## 9. The working loop for Claude

Professional results come from checking, not from one pass. Each grading or VFX task follows this loop, and the tool descriptions say so:

1. Look: `render_frame` at representative times, `render_scopes` for the grade.
2. Change one stage at a time (input, primary, secondaries, look).
3. Check: scopes for clipping and skin line, `render_mask` for any mask at the first, middle and last frame and at fast motion, a contact sheet across the clip for flicker and drift.
4. `review_edit` reports new findings: highlight or shadow clipping over 0.5% of pixels, skin hue off the skin line by more than 10 degrees, banding in smooth areas, matte flicker, track drift, sky slide.
5. Offer choices for taste decisions: render 3 or 4 look variants as thumbnails with `offer_choices`, and let the user pick.

## 10. Desktop app

The app stays AI-first. Additions serve the conversation:

- Pointing at an object in the viewer sends its point to `select_object`; the selection shows as a blue outline.
- A matte toggle in the viewer shows the current mask (white on black) for the selected layer or effect.
- Look variants from `offer_choices` show as thumbnail cards.
- Scopes appear in the Review tab next to findings.
- UI rules apply: compact, dark neutral with blue as the only accent, Segoe Fluent Icons, no emoji, no em or en dashes.

## 11. Test material and licenses

- **Clips**: the local sample projects plus a small set of openly licensed test clips (CC0 or CC-BY, with an `ATTRIBUTION.md` like `projects/nature-30s`): a log clip from each supported camera family where available, a sky pan, a phone screen and a monitor, cars and people crossing, a locked-off shot with an object to remove, fast motion for interpolation. Reference mattes are made by hand once and stored with the test media (not in the repository if large).
- **Synthetic tests** run in the unit suite without media: log ramps, homography warps, blend formulas, grain determinism, mask combine logic.
- **Models**: every model is optional, downloaded on first use into the models folder, and listed with its license in the docs. Before adding one, confirm its license allows use in an MIT-licensed library, and record the comparison that chose it in the guide, as for faces and sound.

## 12. Order of work

Two tracks run side by side: the engine (E) and features (F). Features first land in the FFmpeg backend where that is cheap and correct, so users get them early, and each engine milestone ports them.

| Step | Builds | Depends on | Done when |
|---|---|---|---|
| F1 | Blend modes | Nothing | Section 5.1 checks pass |
| F2 | Mask system, `render_mask`, maskable effects, HSL key and luma masks | Existing masks | Section 4.2 checks pass for key masks |
| F3 | `grade_region` | F2 | Grading inside masks shows no edges |
| F4 | Any-object selection and tracking (model comparison first; ONNX Runtime with DirectML where available) | F2 | Section 5.2 checks pass |
| E1 | Engine skeleton: plan format, separate process, decode, GPU upload, transforms, layers, blend modes, encode | Nothing | Renders the template test projects; parity with FFmpeg backend |
| E2 | OCIO and ACES in the engine: input transforms, ACEScct grading space, display transforms, the color panel as shaders | E1 | Section 4.1 checks pass through OCIO; precision check of section 1 passes |
| E3 | Engine preview: single frames and live viewer for the app and `render_frame` | E1 | Real-time or 3x target of section 3.4 |
| F5 | Point and surface tracking, `pin_layer`, `replace_screen` | F1 | Section 5.4 checks pass |
| F6 | Film look effects and look presets, `export_lut` (engine first: they need float) | E2 | Sections 4.4 and 4.5 checks pass |
| F7 | Sky replacement | F4, F5 | Section 5.3 checks pass |
| F8 | Scene grading | F3 | Section 4.3 checks pass |
| F9 | Particles and light (GPU particles in the engine; CPU generator for the fallback) | F1 | Section 6 checks pass |
| F10 | Depth and depth effects | F2 | Section 7.1 checks pass |
| F11 | Object removal | F4 | Section 7.2 checks pass |
| F12 | Frame interpolation | Nothing | Section 7.3 checks pass |
| E4 | Retire the FFmpeg picture path as the default; keep it as fallback and reference | E1 to E3, parity on everything | All integration tests pass on the engine |

F1 to F4 give the biggest jump for the effort (sky work, glows on one object, grading one part of the frame) and reuse what exists. E1 should start at the same time, since the film look, log and precision work (F6, E2) is only worth doing properly in float. If the engine is not built, the fallback path of section 3.3 (10-bit FFmpeg pipeline, hand-written log LUTs) still reaches a good, but lower, standard.

## 13. Risks and open questions

- **Engine scope.** A render engine is a large project. Keep the plan format small and versioned, port features one at a time behind parity tests, and never let the FFmpeg backend fall behind on correctness while the engine catches up.
- **GPU variety.** Integrated GPUs, old drivers and remote desktops can fail. The engine checks the adapter at start, falls back to the FFmpeg backend, and reports why in the app.
- **Build and packaging.** A Rust engine with an OCIO C++ shim needs prebuilt binaries per platform (Windows x64 first), shipped like `ffmpeg-static` or `@resvg/resvg-js`. Set up CI for those builds before the engine has many features.
- **CPU speed.** Without a GPU, video segmentation, depth and interpolation are heavy on a 2-core laptop. Everything model-based runs before rendering, in the background, cached per clip and source range, with progress; previews use proxies. Measure each against its budget before building on it.
- **10-bit cost.** 10-bit segments are larger and slower to decode. Measure before switching the cache default.
- **Model licenses** change between versions; record the exact weights file and license in code next to the download URL.
- **Temporal consistency** is the main quality risk for every per-frame model (mattes, depth, inpainting). Every such feature includes smoothing and a flicker check.
- **Log detection** from pictures is unreliable; asking the user (with visual choices) is the safe default when metadata is missing.
- **Trademarks**: film looks are named by character ("warm print-like"), never by a manufacturer's stock name.
