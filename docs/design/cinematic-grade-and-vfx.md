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
- [x] 5. **FFmpeg backend precision** (3.3): the 10-bit pipeline, 16-bit masks, `gbrp16le` RGB stages, ProRes 422 HQ export and a 10-bit segment cache.
- [x] 6. **Hardware encoding** with VideoToolbox (macOS) and VAAPI (Linux) (3.6).
- [x] 7. **Claude's checks** (section 8): `review_edit` findings for clipping, skin hue off the skin line, banding, matte flicker, track drift and sky slide.
- [x] 8. **Desktop app** (section 9): the selected object's blue outline, the matte toggle in the viewer, and scopes next to the findings.

When all eight are done, the whole test suite runs once (section 10). Packaging follows (section 11).

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

Any effect takes an optional `mask`. Kinds: `person`, `face`, `object` (a tracked object), `sky`, `depth` (prepared before rendering, cached), and `key` (HSL qualifier), `luma`, `shape` (ellipse, rectangle or polygon), built in the graph. A shape can move: `keyframes` give its center and scale over time, and `pin_mask` pins it to a track (`corners`: where the frame's corners go over time); the shape is drawn once and carried by `perspective` per frame. Every mask takes `invert`, `feather`, `grow`, `smooth`, `denoise` and `combine` (`add`, `intersect`, `subtract`). `render_mask` shows the matte. The person cutout reads each frame twice when the people in it are small (a wide shot): the whole frame, then the area around them from closer, which keeps legs and arms.

### 3.3 Precision

The engine works in float, decodes footage in a color space at 10 bits, exports 10-bit (`bitDepth` 10: H.264 High 10 or HEVC Main 10) and dithers 8-bit exports of such footage. The FFmpeg backend runs deep for 10-bit and ProRes exports (`isDeepExport`): 10-bit YUV between stages, segment ends and clip cache (x264 High 10), 12-bit planar RGB for RGB stages (16-bit planes hit a bug in FFmpeg 6.1's blend screen) and 16-bit mattes; effects pin formats through `yuvFormat`, `rgbFormat`, `gbrFormat` and `grayFormat`. Blended layers are placed on their canvas in RGB (6.1's overlay darkens a translucent layer on a clear 10-bit YUV canvas). 8-bit renders are unchanged. FFmpeg 6.1's haldclut reads planar RGB in the wrong channel order, so baked color tables and key masks take packed RGB (`haldFormat`: 16-bit in deep renders). Both renderers pass section 1's precision check on 10-bit exports (longest run 3 px over 530 levels on FFmpeg). ProRes 422 HQ (`prores_ks` profile 3, 10-bit 4:2:2, a .mov) is an export on both (`render_video` format prores). Both renderers work on BT.601 YUV, the matrix FFmpeg converts with wherever a filter needs RGB: footage stored with BT.709 (its tag, or an untagged HD file) or BT.2020 is brought to it as it is read (the asset's `colorMatrix`, set by probe; FFmpeg's `colorspace` filter, since swscale's own matrix change shifts levels), and the finished picture is written as BT.709 and tagged so. Frames, the viewer and the exported file then show the same colors, the footage's own. Still 8-bit inside a deep render: keyers, color tables (8-bit Hald images, interpolated), depth and sky mattes.

### 3.4 Render engine

`native/ave-render` is a separate executable speaking JSON-RPC over stdio, in Rust on `wgpu` (Direct3D 12, Metal, Vulkan). `plan.ts` turns a project into a plan (pure, following `compile.ts`'s timing and rounding); decoding and encoding go through ffmpeg processes; pictures are `rgba16float` between passes, display-referred like the FFmpeg backend. Color uses our own transforms (each camera curve from its maker's formulas, ACES from the Academy's reference CTL, in `engine/library/color`), baked into one 65-point table per color space that both renderers apply; no OpenColorIO. The engine is the default (`auto`, FFmpeg on failure); what it does not draw itself is drawn by the FFmpeg backend as a piece. Parity with the FFmpeg backend is tested frame by frame. The engine builds its shader pipelines on first use, all started on threads when it opens the device, so it answers in under a second (building all of them first took 11 s on the reference laptop at every start). Playback is about 3x FFmpeg on the reference laptop. See [the render engine guide](../guides/render-engine.md).

### 3.5 Rust where speed matters and the move is easy

**Rule.** Code moves to Rust when it is on a hot path (its cost grows with pixels, samples or frames, and it is a measured share of a tool call or render, about 10% or more) and it ports easily behind the same function signature. Everything about the edit itself (schema, operations, catalogs, tools, planning, session, host) stays in TypeScript, as does pixel code that runs rarely or cheaply. Model inference stays in `onnxruntime-node`; a model's provider (graphics card or CPU) is measured once per computer, and the card is kept only when its saving over a typical job (500 runs) pays back its longer setup.

**Interface.** Coarse calls (a whole buffer or source range), typed arrays or file paths, work on a Rust thread pool returning a promise, errors as normal JavaScript errors (a panic never takes down the host). Kernels that work through many frames (`trackRegion`, `depthSequence`) take a `TaskControl`: `controlled({ signal, onProgress }, run)` ties an `AbortSignal` to it, so the kernel stops at its next frame and the call rejects with the signal's reason, and reads its progress four times a second. The particle generator and the remover work in short calls, checked between them.

**A port** keeps the old TypeScript as the test oracle in `test/helpers/` with a parity test, records a benchmark in the guide that uses it, and deletes the TypeScript implementation. No silent TypeScript fallback at runtime.

### 3.6 Platforms

Windows x64, macOS arm64 and x64, Linux x64 (glibc 2.31 or newer). Nothing Windows-only: the app is Avalonia, icons are the bundled Fluent UI System Icons, FFmpeg comes from `ffmpeg-static`, models from `onnxruntime-node` (DirectML, CoreML or CUDA, CPU fallback), the engine on each system's own GPU API, media paths stored relative with forward slashes. CI builds and tests on Windows x64, Ubuntu 22.04 and macOS arm64. Hardware encoding: each system tries its own encoders with a test encode (NVENC, Quick Sync, AMF on Windows; VideoToolbox on macOS; NVENC, Quick Sync, VAAPI on Linux, VAAPI on its device with the frames uploaded at the end of the graph). Fixes found per system are in [Cross-platform: required fixes](cross-platform.md).

## 4. Grading

### 4.1 Color spaces (`set_color_space`)

Asset `colorSpace`: `rec709`, `srgb`, `slog3-sgamut3cine`, `slog3-sgamut3`, `vlog-vgamut`, `applelog`, `clog3-cinemagamut`, `logc3-awg3`, `logc4-awg4`, `bmdfilm-gen5`, `hlg-rec2020`, `pq-rec2020` (`engine/library/color/spaces.ts`, each with its maker's source). HDR is set from the file's tags; for log, Claude judges from the picture and offers choices when unsure. Output through the ACES 1.x Rec.709 transform (soft highlight roll-off). Checked: every curve round-trips within 0.5%; the gray card lands within 2% on both renderers.

### 4.2 Secondary corrections (`grade_region`)

Adds, updates or removes a labeled correction limited to a mask, on a clip, a layer, every clip or the whole video. Grading inside a feathered mask shows no edge.

### 4.3 Scene grading (`grade_scene`, `match_color`)

`color_adjust`'s exposure and contrast cut nothing off: more exposure is a gain up to 60% of white with a shoulder from there, more contrast scales luma around the middle with a toe and a shoulder past 15% and 85% (`lutrgb` and `lutyuv` expressions, baked into the color table like the rest).

Matches each scene's shots to a hero clip or a still: an Oklab transfer, Reinhard and per-channel curves are fitted, and the one with the lowest held-out ΔE 2000 wins; hue changes are limited and skin is kept on the skin line. Graded test pairs come back under 2 ΔE 2000.

### 4.4 Film looks (`apply_look`)

Effects `halation`, `bloom`, `anamorphicFlare`, `filmGrain` (seeded, by stock), `gateWeave`, `printFilm`, `lensDistortion`, plus `letterbox`; sizes relative to the frame. Six look presets in `engine/library/looks` (data). Names describe a character, never a film stock. `chromaticAberration` with `radial: true` is a lens's fringing: `lenscorrection` on each RGB plane (red magnified most, green half, blue not), none in the center and growing toward the corners; without it the channels shift evenly.

### 4.5 Export a grade (`export_lut`)

A clip's grade as a 33- or 65-point `.cube` for Resolve, Premiere or a monitor; spatial effects are left out and named. Applied with `lut3d` it reproduces the render within ΔE 2000 0.96.

## 5. Selecting and tracking

### 5.1 Blend modes

`layers[].blend`: `normal`, `screen`, `add`, `multiply`, `overlay`, `softlight`, `lighten`, `darken`, `colordodge`, `difference`, and the linear-light `addlight` and `screenlight` (both values through display gamma 2.4, added or screened, and back: one `lut2` table per channel on FFmpeg, the same math on the engine), on both renderers; a black layer changes nothing in any of the four.

### 5.2 Any object (`select_object`, `track_object`)

From a point, box or name: SAM 2.1 tiny on keyframes, carried between them by Rust tracking, OWLv2 for names (its boxes for parts of one thing are joined into the whole). Where tracking loses the object (few points held, or the mask grows or shrinks three times), it has no mask there and is reported as not seen. The `object` mask kind uses it. Synthetic IoU 0.955, flicker 0.12%; a 10 s clip in 50 s. See [the objects guide](../guides/objects.md).

### 5.3 Sky (`replace_sky`)

skyseg finds the sky on keyframes, Rust tracking carries the matte and measures the camera's motion; the new sky moves with the camera, matched in brightness, with horizon haze and slight relighting. See [the sky guide](../guides/sky.md).

### 5.4 Points and surfaces (`track_points`, `pin_layer`, `pin_mask`, `replace_screen`)

Rust Lucas-Kanade with RANSAC (translation, similarity or perspective), stored in `project.tracks`; `pin_layer` turns a track into keyframes, `pin_mask` pins a shape mask to it in perspective (0.3 px on the synthetic camera move), `replace_screen` adds a corner-pinned insert, 1.5 px past the corners so no edge of the old screen shows. Worst synthetic corner error 0.28 px. A surface marked without a `margin` is tracked with the smallest of 0, 0.15, 0.35 and 0.6 that tracks surely: a blank or changing screen holds nothing inside its corners, its bezel does. `replace_screen` matches the insert to the shot on a frame of the edit: blurred to the sharpness of the scene around the screen, the shot's white balance on its whites and the ambient light on its blacks (`colorlevels`), and a faint diagonal glare screened over it with the same corners. An `occluder` (an object from `select_object`) stays in front: any media layer can be `behindObject`, drawn behind the object's matte rendered in timeline time. See [the tracking guide](../guides/tracking.md).

## 6. Atmosphere and light (`add_particles`, `add_light`)

Seeded Rust particle generator (rain, snow, dust, embers, sparks, confetti, bokeh, smoke, fog) drawn into an alpha video both renderers read as a layer; 2,000 particles at 1080p in 8.8 ms a frame. `add_light` adds light rays or a lens flare that follows a path or track. Layers take masks for holdouts. See [the atmosphere and light guide](../guides/atmosphere-and-light.md).

## 7. Depth, removal and time

### 7.1 Depth (`estimate_depth`, `set_focus`)

Depth Anything V2 Small on keyframes, aligned and carried between them in Rust; flicker 0.09% to 0.22% on project clips. The `depth` mask kind, `depthOfField` (with rack focus and focus that follows an object), `depthFog` and `parallax`. See [the depth guide](../guides/depth.md).

### 7.2 Object removal (`remove_object`)

A tracked object or a fixed box is filled from a clean plate built from other frames (locked-off and moving cameras), with LaMa where no frame shows the area. On a moving camera the pool of frames is as dense as the camera is fast (about 40 px of motion between them), and each pixel takes the median of the three pool frames that line up best with the frame on a ring around the hole. See [the removal guide](../guides/removal.md).

### 7.3 Smooth slow motion (`interpolate`)

RIFE 4.9 makes the frames slow motion and frame rate conversion need; `set_speed` and `speed_ramp` turn it on by themselves. See [the slow motion guide](../guides/slow-motion.md).

## 8. Claude's working loop

1. Look: `render_frame` at representative times, `render_scopes` for the grade.
2. Change one stage at a time (input, primary, secondaries, look).
3. Check: scopes for clipping and the skin line, `render_mask` at the first, middle and last frame and at fast motion, a contact sheet for flicker and drift.
4. `review_edit`, whose `grade` and `vfx` checks report highlight or shadow clipping the grade adds over 0.5% of the frame (areas flat at the picture's own ceiling or floor that held detail in the same frame without the grade, so clipping under a look's curve or tint is seen too), skin hue more than 10 degrees off the skin line, banding the grade brings out, matte flicker, track drift and sky slide (engine/tools/review/look.ts).
5. Offer taste decisions as choices (`offer_choices` with look variants).

## 9. Desktop app

Built: a click in the viewer marks a spot that goes to Claude for `select_object`, and the object Claude selected last shows as a blue outline on still frames (Object toggle); a Matte toggle shows the mask of the clip at the playhead or the clip picked on the timeline, white on black; picking a review finding shows the scopes of its frame under the Review list; look variants show as choice cards; the live viewer is drawn by the engine. The host draws the matte and the scopes (`render.matte`, `render.scopes`); the app traces the outline. UI rules from CLAUDE.md apply.

## 10. Testing

While building, run only the tests of the code that changed (the matching `test/<area>/` file, filtered with `-t`) and its engine parity cases. The whole suite (`npm test`, `FULL_RENDER=1` for every template) runs once after the checklist is done. Models are optional, downloaded on first use, and need a license that allows commercial use and shipping them with the app (MIT or Apache-2.0 so far).

### 10.1 The real-clip pass (instructions from the user, 2026-11-10)

- Go through this document and the project feature by feature, and test each on real clips, not synthetic ones.
- Clips are 2 seconds at most.
- One feature at a time: test it, see what should be improved or fixed, improve it, test it again on real clips, and only then move to the next.
- Never run the full test suite or the full parity test, in any form. Only the tests of what changed (a `-t` filter, or the one small file).
- Green screen and raw or log clips can be downloaded where the project's footage cannot exercise a feature (keying, camera log, other effects).
- When a part is done, write down here what was tested on real clips.

The clips are cut from the footage in `projects/*/media` to 960x540 (`test/.output/real/clips`, gitignored, as are the scripts next to them, one per feature: `01-grade.ts` to `18-app.ts`). Each script drives the tools through an `EditorSession` one call at a time, as the app's model does, and checks the pictures it gets.

### 10.2 Tested on real clips so far

| Part | Clips | What was run | Found and fixed |
|---|---|---|---|
| Primary grade, looks, shot matching, LUT export, scopes (4.3 to 4.5) | couch, selfie (the same person, two shots) | `color_adjust`, the six looks, `match_color`, `export_lut` applied back with `lut3d`, `render_scopes`, `analyze_color`, on both renderers | Nothing in the tools themselves; the three findings below came out of it |
| Exposure and contrast (4.3) | mountain, night, hedge, couch | Exposure up to +0.8, contrast up to 100, alone and under four looks | Both cut highlights and shadows off flat (contrast 15 crushed 4% of a daylight frame to black). Now a shoulder and a toe (section 4.3) |
| `review_edit` grade check (8) | mountain, night, hedge, couch | Modest and harsh grades under four looks | Clipping under a look went unseen (26% of the frame flat at 234). Now measured against the ungraded frame at the picture's own limits (section 8) |
| Color matrix (3.3) | hedge, couch (tagged BT.709), street (untagged 720p) | Frame against exported video as a player shows it, against the source, plain and graded, both renderers | The engine's frames and viewer showed BT.709 footage through BT.601 (greens 4 levels up); graded FFmpeg exports came out with the wrong matrix; exports had no color tags. Now one working matrix with conversion at both ends (section 3.3). Renderer agreement went from 38 dB to 57 dB plain, 32 dB to 45 dB graded |
| Masks and `grade_region` (3.2, 4.2) | chairs, couch, mountain, hedge, street | Every kind: person, face, key, luma, sky, depth, ellipse, polygon, keyframed shape, combine, invert; `render_mask`, the grade kept inside the matte, flicker | A mask view with a model matte failed on the engine and fell back to FFmpeg on every call (now a piece). A small person in a wide shot lost legs and arms (now looked at twice, section 3.2). A misnamed input field was dropped without a word (now named in the tool's answer) |
| Objects (5.2) | phone, chairs, street | `select_object` by point, box and name, `track_object`, the matte in a grade, flicker | A seated man by name came back as his left half (the detector's part boxes are now joined). A car lost behind passers-by left a mask stretched across the street (a lost object now has no mask and says "not seen") |
| Sky replacement (5.3) | mountain (a slow drift, mist over the hills), forest (a fast handheld pan) | `replace_sky` with a gradient and with a photo of a sky, both renderers, the land left alone, steadiness between frames, `review_edit` | The slide check sampled 10 frames a second, too far apart to follow a pan, and called drifting mist a problem. It now samples about 12 a second, judges the slide against how far the scenery moves, and names the likely cause. Measured on the pan: the new sky follows the middle of the frame and lags about 14% toward its sides (one flat picture cannot follow a pan's perspective); the finding says so |
| Points and surfaces (5.4) | phone (a green screen on a desk, fingers moving over it), flower as the insert | `track_points` on the screen's corners and on a point, `replace_screen`, `pin_layer`, `pin_mask`, the corners measured against the green itself | The track followed the fingers and the insert collapsed into a corner (190 px off): a blank screen has nothing inside to hold. The margin around a surface is now found when not given (4 px off, sureness 0.96). The insert was blurred 4.8 px because smooth wood read as a soft scene (sharpness is now the steepest edges, 2.4 px), and left green slivers along an edge (it now reaches 1.5 px past the corners) |
| Single frames against the export (3.4) | phone, pushups (25 fps), hedge (23.98), couch (24), in 24 and 30 fps edits, cut in at odd times, at 0.5x and 1.5x | Every `render_frame` on the engine against the export's frame at that time | For footage at another rate than the edit's, the engine's single frames and viewer showed the next source frame about every other time. A restart now keeps the whole decode's frame count (needs the file's rate: the asset's `fps`, set by probe) |
| Object removal (7.2) | phone (locked off: an empty patch of desk and the pen), chairs (the seated man, tracked), mountain (slow drift), forest (fast pan), hedge (handheld, close leaves) | `remove_object` with boxes and a tracked object; where the box held nothing special the fill is checked against the footage itself; the rest of the frame, steadiness, both renderers | On a moving camera the pool was 3 frames a second, hundreds of pixels apart on a pan, so the median mixed frames that no longer lined up. The pool now follows the camera's speed (about 40 px between pool frames), and the median takes the three frames that line up best on the ring around the hole. Fills now read the footage with its own matrix. Results: desk 30 dB to the truth and still, pan 33 to 40 dB, hillside 32 dB, the man gone with a fill steadier than the seats around him. Not solved: handheld close-up foliage (hedge, 16 dB): the camera track drifts several pixels over leaves at different depths, and no frame lines up there |
| Smooth slow motion (7.3) | hedge, street (untagged HD), phone, pushups, forest, each at 12 fps (every other frame dropped) in a 24 fps edit | `interpolate`; each made frame against the original frame that was dropped; the real frames against the edit without smooth motion | Works on all five: made frames 22 to 37 dB to the truth, against 19 to 23 dB for the repeated frame. Frames are now read with the footage's own matrix, so untagged HD keeps its colors (street 41 to 43 dB) |
| Blend modes (5.1) | smoke (white smoke shot on black) over couch | Every mode, and two at part opacity; each result against the mode's formula applied to the same two pictures, pixel by pixel, on both renderers | Color dodge was backwards on both renderers (FFmpeg's dodge brightens its second input by its first, and the picture went first): 42 levels off. Now the picture over one minus the layer. All twelve modes within 1.5 levels of their formula on both |
| Atmosphere and light (6) | night, street, mountain, chairs, couch, forest | Every particle preset (rain, heavy rain, snow kept to the sky, dust, embers behind a person, sparks, confetti, bokeh, smoke, fog); light rays from a bright sky; a flare on the brightest light, and one refused on a dark spot; both renderers, same seed same frame, the particles move | Nothing to fix: renderers within 52 to 59 dB, snow leaves the land untouched, the man stays in front of the embers |
| Depth (7.1) | hedge, chairs, forest, a still of chairs | `set_focus` on a point, a rack focus, focus following a tracked object, depth fog, parallax on a photo; sharpness kept per area against the footage | A rack focus left its last subject soft on both renderers (FFmpeg's gblur copies its blur into the vertical one once, so the commands changed only the horizontal blur); they now set both. A point on a person kept only part of her sharp: a person spans 0.1 to 0.3 of this depth, deeper than the default sharp zone, so a point (or rack step) on a person now takes the zone from her cutout, and a tracked object from its box. Results: her face and shirt kept whole (1.0), the far hedge 0.13; the rack ends with the man at 0.9; depth fog 57 levels on the far hills against 17 on the near trees; parallax moves near things more than far ones without gaps |
| 10-bit and ProRes (3.3) | mountain (a misty sky under a heavy grade), waterfall (a 10-bit source) | `render_video` at 8 bits, `bitDepth` 10 and `format` prores; formats and tags, the picture against the 8-bit export, banding down the graded sky, both renderers | The FFmpeg backend's graded 10-bit and ProRes exports came out magenta: FFmpeg 6.1's haldclut reads planar RGB in the wrong channel order, and deep renders fed it 12-bit planar RGB for the baked grade and for key and luma masks. They now feed it packed 16-bit RGB. Renderers agree at 46 and 41 dB (were 21 and 15); the sky's longest flat run is 13 px at 8 bits and 8 to 9 px at 10 bits on both (an 8-bit source has only its own levels); ProRes is 422 HQ, tagged BT.709 |
| Hardware encoding (3.6) | couch (16:9 with a grade and text), talk (9:16) | Exports on Quick Sync against x264, on both renderers; 10-bit | Nothing to fix: the card's encoder is used, the same picture as x264 (44 to 47 dB), the same size, length and BT.709 tags; 10-bit falls back to x264 High 10 |
| Camera log (4.1) | couch, waterfall, mountain, encoded into S-Log3 / S-Gamut3.Cine and LogC3 / AWG3 | No openly licensed log footage exists to download (Wikimedia Commons has none; Netflix's open camera originals are Sony F55 RAW, which FFmpeg cannot read), so real clips were encoded with the makers' published curves and gamut primaries, written out in the test apart from the editor's code, and stored as the cameras store them; `set_color_space`; contrast, saturation, mid-gray, skin, both renderers | Nothing to fix: contrast within 3 to 13% of the original, saturation within 10 to 14%, mid-gray within 4 to 8 levels, skin on the skin line, renderers at 50 to 52 dB |
| Green screen keying | a public-domain Voice of America clip (`Filming with the green screen`, Wikimedia Commons): a person in front of a green backdrop, curly hair over it, the room around it | `sample_color`, `chromaKey` onto a backdrop and to transparent on an overlay, `review_edit` | `review_edit` judged a key onto a backdrop with FFmpeg's colorkey, a different keyer from the one rendered, and reported 2.6% of the frame left in screen green that the render had keyed; it now judges the keyer in use (`excessKeyRange`). Results: the screen fully keyed, no green left in her hair (36% before), her jacket and the room untouched, renderers identical; what the review still names (0.8%, a warning) is a real mint-green roll above the backdrop |
| The app's matte and scopes views (9) | chairs, couch, through the real host process over JSON-RPC as the app calls it | `render.matte` (a person mask, a selected object, none), the blue outline the app traces from it (`MatteOutline.cs`, mirrored), `render.scopes` before and after a grade, past the end, after undo | Correct throughout (the viewer's matte is the tool's matte exactly; the outline goes round the man and nowhere else). Slow: the first matte took 28 s. Two causes, both fixed: the engine built all twenty shader pipelines at start, 11 s on this laptop's Intel GPU at every start, every export included (it now builds each on first use, all started on threads at once: it answers in 0.9 s, a cold first frame takes 6 s instead of 13); and the person model kept DirectML for a 1.4 ms a frame gain that costs 11 to 40 s to set up in every process (model providers now count setup time, section 3.5). First matte now 12 s cold, 4 s with the viewer's engine running, 0.1 s again |

All parts of sections 3 to 9 are now tested on real clips.

## 11. Packaging

Started 2026-11-14, after the checklist. Details in [ui/Packaging/README.md](../../ui/Packaging/README.md).

Done:

- **Who makes it:** Moses Henen, home at [github.com/dev-henen/videditbridge](https://github.com/dev-henen/videditbridge), in every package's metadata: the Windows executable's properties (`ui/VideditBridge.csproj`), the macOS bundle (`io.github.dev-henen.videditbridge`, the copyright), Linux AppStream metadata for software centers and Flathub (`io.github.dev_henen.videditbridge`, with the desktop file and icons renamed to match), the engine's `package.json`, and the app's About page.
- **Every model comes with the app** (about 1 GB, twelve models; the list is `engine/tools/bundled-models.ts`, their licenses in `ui/THIRD-PARTY-NOTICES.md`, all MIT or Apache-2.0). An installed app keeps them in `engine/models` and reads them in place (`bundledModelsDir`), so nothing downloads on first use. `scripts/bundle-models.ts` fills the folder; `test/repo/bundled-models.test.ts` fails when the engine loads a model that is not on the list. The models folder in the app cache stays for downloads that are not bundled (another Whisper size through the library).

- **Installers built on GitHub** (`.github/workflows/release.yml`, `scripts/package-app.ts`): a version tag builds a Windows setup (Inno Setup, per user), a macOS arm64 DMG (signed ad hoc) and a Linux AppImage, each with the engine on its own Node, FFmpeg, the native kernels, the render engine, the fonts and every model, and attaches them to a draft release. The staged Windows app was run from its folder: it started its own engine and created and opened a project.

Left:

- Prebuilt npm packages of `ave-native` per target (`@videditbridge/native-<target>`, which the loader already tries first) with `ave-render`; macOS x64 and glibc 2.31 builds.
- Signing: a Windows code signing certificate, and an Apple Developer ID to notarize the DMG.
- Intel macOS, MSIX, and Flatpak after the AppImage.
- The whole test suite, once, before the first installer (section 10).
