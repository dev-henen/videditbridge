# Cinematic grading and CGI effects

Movie-level color grading and the visual effects editors ask for most: log footage, secondary corrections, film looks, scene matching, blend modes, any-object masks and tracking, sky and screen replacement, atmospherics, depth, object removal and smooth slow motion, on a GPU render engine with ACES color management. Details of each feature are in its guide (linked below); the history is in git.

## 1. Checklist

### Done

- [x] **Native kernels** (`native/ave-native`): Rust addon, CI builds on Windows, macOS and Linux; audio analysis ported (9.6x faster). See [native/README.md](../../native/README.md).
- [x] **GPU render engine** (`native/ave-render`): the default renderer, previews and the app's live viewer. What it does not draw itself comes from the FFmpeg backend as pieces, so it renders every project. See [the render engine guide](../guides/render-engine.md).
- [x] **Color spaces and camera log** (4.1): S-Log3, V-Log, Apple Log, Canon Log 3, LogC3, LogC4, Blackmagic Gen 5, HLG, PQ; ACES output; grading in ACEScct; 10-bit exports.
- [x] **Secondary corrections** (4.2): `grade_region` with masks.
- [x] **Scene grading** (4.3): `grade_scene`, `match_color`.
- [x] **Film looks** (4.4): seven film effects, six look presets, `apply_look`.
- [x] **Export a grade** (4.5): `export_lut`.
- [x] **Blend modes** (5.1) on layers, on both renderers.
- [x] **Any-object selection and tracking** (5.2): `select_object`, `track_object`. See [the objects guide](../guides/objects.md).
- [x] **Sky replacement** (5.3): `replace_sky`. See [the sky guide](../guides/sky.md).
- [x] **Point and surface tracking** (5.4): `track_points`, `pin_layer`, `pin_mask`, `replace_screen`. See [the tracking guide](../guides/tracking.md).
- [x] **Atmosphere and light** (6): `add_particles`, `add_light`. See [the atmosphere and light guide](../guides/atmosphere-and-light.md).
- [x] **Depth** (7.1): `estimate_depth`, `set_focus`, depth of field, fog, parallax. See [the depth guide](../guides/depth.md).
- [x] **Object removal** (7.2): `remove_object`. See [the removal guide](../guides/removal.md).
- [x] **Smooth slow motion** (7.3): `interpolate`. See [the slow motion guide](../guides/slow-motion.md).

### Left

- [x] 1. **Rust kernels:** cancelling and progress inside them (`TaskControl` and `controlled`, section 3.5).
- [x] 2. **Effect gaps:** radial `chromaticAberration` (4.4) and linear-light `add` and `screen` blending (5.1).
- [x] 3. **Mask shapes:** polygons, keyframes, and shapes pinned to a track (3.2).
- [x] 4. **`replace_screen`:** the insert's matched blur, glare and color, and occlusion by an object mask (5.4).
- [ ] 5. **FFmpeg backend precision** (3.3): the 10-bit pipeline, 16-bit masks, `gbrp16le` RGB stages, ProRes 422 HQ export and a 10-bit segment cache.
- [ ] 6. **Hardware encoding** with VideoToolbox (macOS) and VAAPI (Linux) (3.6).
- [ ] 7. **Claude's checks** (section 8): `review_edit` findings for clipping, skin hue off the skin line, banding, matte flicker, track drift and sky slide.
- [ ] 8. **Desktop app** (section 9): the selected object's blue outline, the matte toggle in the viewer, and scopes next to the findings.

When all eight are done, the whole test suite runs once (section 10). Packaging is on hold until then (section 11).

## 2. Quality bar

| Area | Requirement | Measured by |
|---|---|---|
| Precision | No banding after strong grades | A 10-bit ramp through a heavy grade at 1080p: no run of equal values longer than 4 px |
| Log footage | Converts exactly as the maker defines it | Curves round-trip a ramp within 0.5% of full range; gray card within 2% of 18% |
| Mattes | Clean edges, no flicker | IoU 0.9 (people, large objects) or 0.85 (small) against hand mattes; frame-to-frame change in still areas under 2% |
| Tracking | Graphics stay on surfaces | Synthetic corner error under 0.5 px; real clips drift under 2 px per 5 s |
| Depth | Stable depth | Change in static areas under 3% a frame |
| Speed | Usable on a laptop | Budgets per feature on the reference machine (Intel i3-1005G1) |
| Verifiability | Claude can check its own work | Matte previews (`render_mask`), scopes (`render_scopes`), `review_edit` findings |

## 3. Architecture

### 3.1 The grade

A clip's grade lives in its `effects`, in colorist order: the asset's `colorSpace` (input transform), the unlabeled `color` effect (primary; graded in ACEScct for footage in a color space), labeled `color` effects with a `mask` (secondaries, `grade_region`), the `look`-labeled grade and film effects (`apply_look`), and the ACES Rec.709 output, part of each color space's table.

### 3.2 Masks

Any effect takes an optional `mask`. Kinds: `person`, `face`, `object` (a tracked object), `sky`, `depth` (prepared before rendering, cached), and `key` (HSL qualifier), `luma`, `shape` (ellipse, rectangle or polygon), built in the graph. A shape can move: `keyframes` give its center and scale over time, and `pin_mask` pins it to a track (`corners`: where the frame's corners go over time); the shape is drawn once and carried by `perspective` per frame. Every mask takes `invert`, `feather`, `grow`, `smooth`, `denoise` and `combine` (`add`, `intersect`, `subtract`). `render_mask` shows the matte.

### 3.3 Precision

The engine works in float, decodes footage in a color space at 10 bits, exports 10-bit (`bitDepth` 10: H.264 High 10 or HEVC Main 10) and dithers 8-bit exports of such footage. The FFmpeg backend's graph is still 8-bit (segments, masks, `eq`, `vignette`, Hald tables). Left (checklist 5): segments in `yuv420p10le` with RGB stages in `gbrp16le`, `eq` and `vignette` replaced by 16-bit equivalents, 16-bit masks, a 10-bit segment cache (x264 High 10, measured against the 8-bit cache first), and ProRes 422 HQ as an export choice.

### 3.4 Render engine

`native/ave-render` is a separate executable speaking JSON-RPC over stdio, in Rust on `wgpu` (Direct3D 12, Metal, Vulkan). `plan.ts` turns a project into a plan (pure, following `compile.ts`'s timing and rounding); decoding and encoding go through ffmpeg processes; pictures are `rgba16float` between passes, display-referred like the FFmpeg backend. Color uses our own transforms (each camera curve from its maker's formulas, ACES from the Academy's reference CTL, in `engine/library/color`), baked into one 65-point table per color space that both renderers apply; no OpenColorIO. The engine is the default (`auto`, FFmpeg on failure); what it does not draw itself is drawn by the FFmpeg backend as a piece. Parity with the FFmpeg backend is tested frame by frame. Playback is about 3x FFmpeg on the reference laptop. See [the render engine guide](../guides/render-engine.md).

### 3.5 Rust where speed matters and the move is easy

**Rule.** Code moves to Rust when it is on a hot path (its cost grows with pixels, samples or frames, and it is a measured share of a tool call or render, about 10% or more) and it ports easily behind the same function signature. Everything about the edit itself (schema, operations, catalogs, tools, planning, session, host) stays in TypeScript, as does pixel code that runs rarely or cheaply. Model inference stays in `onnxruntime-node`.

**Interface.** Coarse calls (a whole buffer or source range), typed arrays or file paths, work on a Rust thread pool returning a promise, errors as normal JavaScript errors (a panic never takes down the host). Kernels that work through many frames (`trackRegion`, `depthSequence`) take a `TaskControl`: `controlled({ signal, onProgress }, run)` ties an `AbortSignal` to it, so the kernel stops at its next frame and the call rejects with the signal's reason, and reads its progress four times a second. The particle generator and the remover work in short calls, checked between them.

**A port** keeps the old TypeScript as the test oracle in `test/helpers/` with a parity test, records a benchmark in the guide that uses it, and deletes the TypeScript implementation. No silent TypeScript fallback at runtime.

### 3.6 Platforms

Windows x64, macOS arm64 and x64, Linux x64 (glibc 2.31 or newer). Nothing Windows-only: the app is Avalonia, icons are the bundled Fluent UI System Icons, FFmpeg comes from `ffmpeg-static`, models from `onnxruntime-node` (DirectML, CoreML or CUDA, CPU fallback), the engine on each system's own GPU API, media paths stored relative with forward slashes. CI builds and tests on Windows x64, Ubuntu 22.04 and macOS arm64. Hardware encoding: NVENC, Quick Sync and AMF are built; left (checklist 6): VideoToolbox on macOS and VAAPI on Linux, each verified with a test encode. Fixes found per system are in [Cross-platform: required fixes](cross-platform.md).

## 4. Grading

### 4.1 Color spaces (`set_color_space`)

Asset `colorSpace`: `rec709`, `srgb`, `slog3-sgamut3cine`, `slog3-sgamut3`, `vlog-vgamut`, `applelog`, `clog3-cinemagamut`, `logc3-awg3`, `logc4-awg4`, `bmdfilm-gen5`, `hlg-rec2020`, `pq-rec2020` (`engine/library/color/spaces.ts`, each with its maker's source). HDR is set from the file's tags; for log, Claude judges from the picture and offers choices when unsure. Output through the ACES 1.x Rec.709 transform (soft highlight roll-off). Checked: every curve round-trips within 0.5%; the gray card lands within 2% on both renderers.

### 4.2 Secondary corrections (`grade_region`)

Adds, updates or removes a labeled correction limited to a mask, on a clip, a layer, every clip or the whole video. Grading inside a feathered mask shows no edge.

### 4.3 Scene grading (`grade_scene`, `match_color`)

Matches each scene's shots to a hero clip or a still: an Oklab transfer, Reinhard and per-channel curves are fitted, and the one with the lowest held-out ΔE 2000 wins; hue changes are limited and skin is kept on the skin line. Graded test pairs come back under 2 ΔE 2000.

### 4.4 Film looks (`apply_look`)

Effects `halation`, `bloom`, `anamorphicFlare`, `filmGrain` (seeded, by stock), `gateWeave`, `printFilm`, `lensDistortion`, plus `letterbox`; sizes relative to the frame. Six look presets in `engine/library/looks` (data). Names describe a character, never a film stock. `chromaticAberration` with `radial: true` is a lens's fringing: `lenscorrection` on each RGB plane (red magnified most, green half, blue not), none in the center and growing toward the corners; without it the channels shift evenly.

### 4.5 Export a grade (`export_lut`)

A clip's grade as a 33- or 65-point `.cube` for Resolve, Premiere or a monitor; spatial effects are left out and named. Applied with `lut3d` it reproduces the render within ΔE 2000 0.96.

## 5. Selecting and tracking

### 5.1 Blend modes

`layers[].blend`: `normal`, `screen`, `add`, `multiply`, `overlay`, `softlight`, `lighten`, `darken`, `colordodge`, `difference`, and the linear-light `addlight` and `screenlight` (both values through display gamma 2.4, added or screened, and back: one `lut2` table per channel on FFmpeg, the same math on the engine), on both renderers; a black layer changes nothing in any of the four.

### 5.2 Any object (`select_object`, `track_object`)

From a point, box or name: SAM 2.1 tiny on keyframes, carried between them by Rust tracking, OWLv2 for names. The `object` mask kind uses it. Synthetic IoU 0.955, flicker 0.12%; a 10 s clip in 50 s. See [the objects guide](../guides/objects.md).

### 5.3 Sky (`replace_sky`)

skyseg finds the sky on keyframes, Rust tracking carries the matte and measures the camera's motion; the new sky moves with the camera, matched in brightness, with horizon haze and slight relighting. See [the sky guide](../guides/sky.md).

### 5.4 Points and surfaces (`track_points`, `pin_layer`, `pin_mask`, `replace_screen`)

Rust Lucas-Kanade with RANSAC (translation, similarity or perspective), stored in `project.tracks`; `pin_layer` turns a track into keyframes, `pin_mask` pins a shape mask to it in perspective (0.3 px on the synthetic camera move), `replace_screen` adds a corner-pinned insert. Worst synthetic corner error 0.28 px. `replace_screen` matches the insert to the shot on a frame of the edit: blurred to the sharpness of the scene around the screen, the shot's white balance on its whites and the ambient light on its blacks (`colorlevels`), and a faint diagonal glare screened over it with the same corners. An `occluder` (an object from `select_object`) stays in front: any media layer can be `behindObject`, drawn behind the object's matte rendered in timeline time. See [the tracking guide](../guides/tracking.md).

## 6. Atmosphere and light (`add_particles`, `add_light`)

Seeded Rust particle generator (rain, snow, dust, embers, sparks, confetti, bokeh, smoke, fog) drawn into an alpha video both renderers read as a layer; 2,000 particles at 1080p in 8.8 ms a frame. `add_light` adds light rays or a lens flare that follows a path or track. Layers take masks for holdouts. See [the atmosphere and light guide](../guides/atmosphere-and-light.md).

## 7. Depth, removal and time

### 7.1 Depth (`estimate_depth`, `set_focus`)

Depth Anything V2 Small on keyframes, aligned and carried between them in Rust; flicker 0.09% to 0.22% on project clips. The `depth` mask kind, `depthOfField` (with rack focus and focus that follows an object), `depthFog` and `parallax`. See [the depth guide](../guides/depth.md).

### 7.2 Object removal (`remove_object`)

A tracked object or a fixed box is filled from a clean plate built from other frames (locked-off and moving cameras), with LaMa where no frame shows the area. See [the removal guide](../guides/removal.md).

### 7.3 Smooth slow motion (`interpolate`)

RIFE 4.9 makes the frames slow motion and frame rate conversion need; `set_speed` and `speed_ramp` turn it on by themselves. See [the slow motion guide](../guides/slow-motion.md).

## 8. Claude's working loop

1. Look: `render_frame` at representative times, `render_scopes` for the grade.
2. Change one stage at a time (input, primary, secondaries, look).
3. Check: scopes for clipping and the skin line, `render_mask` at the first, middle and last frame and at fast motion, a contact sheet for flicker and drift.
4. `review_edit`. Left (checklist 7): findings for highlight or shadow clipping over 0.5% of pixels, skin hue more than 10 degrees off the skin line, banding, matte flicker, track drift and sky slide (today it checks text, safe zones, frames, speech, sound and keys).
5. Offer taste decisions as choices (`offer_choices` with look variants).

## 9. Desktop app

Built: a click in the viewer marks a spot that goes to Claude for `select_object`; look variants show as choice cards; the live viewer is drawn by the engine. Left (checklist 8): the selected object's blue outline, a matte toggle in the viewer, scopes in the Review tab next to the findings. UI rules from CLAUDE.md apply.

## 10. Testing

While building, run only the tests of the code that changed (the matching `test/<area>/` file, filtered with `-t`) and its engine parity cases. The whole suite (`npm test`, `FULL_RENDER=1` for every template) runs once after the checklist is done. Models are optional, downloaded on first use, and need a license that allows use in an MIT library. Checks on real footage (log clips, sky pans, screens, crossing objects) wait for a set of openly licensed test clips.

## 11. Packaging (on hold)

After the checklist: prebuilt npm packages of `ave-native` per target (`@ai-video-editor/native-<target>`, which the loader already tries first) with `ave-render`; macOS x64 and glibc 2.31 builds; the bundled host per target; installers (MSIX or MSI, a notarized DMG, AppImage then Flatpak; metadata in `ui/Packaging`).
