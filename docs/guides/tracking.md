# Tracking points and surfaces

Mark a point or a flat surface in a video, and the editor follows it through every clip of that video. Graphics can then ride along with it (a label on a moving car, an arrow on a product), and a new picture can be put on a screen, a sign or a wall so it stays on the surface as the camera moves. Everything runs on this machine, in Rust, with no model to download.

To follow the shape of an object (a person, a car) for masks and grades, use [object selection](objects.md) instead. Tracking points is for rigid things where position, size, turn and perspective are enough, and it is faster and more precise for them.

## With Claude

| Tool | Use |
|---|---|
| `track_points` | Mark the four corners of a surface (top-left, top-right, bottom-right, bottom-left), or a point with the square around it, on a frame where it is clearly visible. Positions are fractions of the edit's frame at a timeline time, as in `render_frame`. Reports per clip how sure the tracking is and the unsure ranges, and shows the corners in blue on four frames. `id` marks a track again; `remove: true` forgets one |
| `pin_layer` | Attach any layer (text, shape, graphic, media overlay) to a track. The layer keeps its offset from the tracked thing as it is at its first tracked moment; it gets position, scale and rotation keyframes |
| `pin_mask` | Pin a shape mask (an ellipse, rectangle or polygon of `grade_region` or any masked effect, found by its label) to a track, so the area moves, grows and turns in perspective with the surface: a grade on a sign, a blur over a plate. The shape keeps its place on the tracked thing as it is at the first tracked moment |
| `replace_screen` | Put an image, video, color or gradient on a surface track, corner-pinned on every frame. By default it covers the clip the surface was marked in, cropped to the surface's shape |

```json
{ "tool": "track_points", "time": 1.2, "corners": { "tl": { "x": 0.41, "y": 0.28 }, "tr": { "x": 0.6, "y": 0.3 }, "br": { "x": 0.59, "y": 0.66 }, "bl": { "x": 0.4, "y": 0.64 } }, "margin": 0.15, "label": "phone" }
{ "tool": "replace_screen", "trackId": "phone", "assetId": "app_demo", "effects": [{ "type": "blur", "params": { "amount": 0.5 } }] }

{ "tool": "track_points", "time": 3, "point": { "x": 0.52, "y": 0.47 }, "radius": 0.06, "label": "car" }
{ "tool": "pin_layer", "layerId": "text_3", "trackId": "car" }
```

**Choosing what to track.** Rigid things with texture or edges track well: a phone with its bezel, a monitor, a sign, a poster, a car door. Plain areas, reflections, water and things that bend track badly. A screen that shows moving content is a poor target by itself, because its picture moves differently from the device; `margin` (for example 0.15) adds the bezel around it to the tracked area, and the outlier rejection ignores the content. For a point, `radius` sets the tracked square: make it cover the thing that moves with the point, not the background behind it.

**Motion.** Corners default to `perspective` (a flat surface seen at any angle). A point defaults to `similarity` (position, size and turn). `translation` follows position only, which suits a label that should stay level.

## In the project

Tracks live in `project.tracks` by id: the asset, the source time of the frame they were marked on, the corners or the point (in source frame fractions), `radius`, `margin` and `motion`. The tracking result is cached per clip source range in the render cache folder (`tracks/`), so pinning more layers to the same track does not track again.

`pin_layer` and `replace_screen` write ordinary keyframes onto the layer, so renders never run the tracker. A corner-pinned layer has `keyframes.corners`: where its four corners land over time, in frame fractions. `pin_mask` writes the shape's `corners` the same way: where the frame's corners go over time, so the renderer draws the shape once and carries it with `perspective`.

```json
{ "type": "media", "id": "screen_1", "assetId": "app_demo", "start": 0, "duration": 4, "size": { "width": 0.19, "height": 0.36 },
  "keyframes": { "corners": [
    { "time": 0, "value": { "tl": { "x": 0.41, "y": 0.28 }, "tr": { "x": 0.6, "y": 0.3 }, "br": { "x": 0.59, "y": 0.66 }, "bl": { "x": 0.4, "y": 0.64 } }, "easing": "linear" },
    { "time": 4, "value": { "tl": { "x": 0.38, "y": 0.27 }, "tr": { "x": 0.57, "y": 0.31 }, "br": { "x": 0.56, "y": 0.67 }, "bl": { "x": 0.37, "y": 0.63 } }, "easing": "linear" }
  ] } }
```

Since the keyframes are fixed when the tool runs, moving or trimming the clip under the layer afterwards leaves them where they were; run `pin_layer`, `pin_mask` or `replace_screen` again after such a change.

## How it works

1. **Tracking.** The Rust region tracker (`trackRegion` in `ave-native`) runs on gray frames 960 px on the long side. It finds Shi-Tomasi corners inside the marked area (kept a few pixels from its edge), follows them with pyramidal Lucas-Kanade and a forward-backward check, and fits the motion model to the survivors with RANSAC, so points on things passing in front are ignored. When too few points survive, it finds new ones inside the area where it now is. Each frame's transform is measured from the marked frame, not chained frame to frame.
2. **Both ways.** It runs forward from the marked frame to the end of the clip's footage and backward to its start, so the surface can be marked on its clearest frame, wherever that is.
3. **Smoothing.** A centered [1 2 1] filter on each corner takes out sub-pixel jitter without adding lag.
4. **Sureness.** Each frame's sureness comes from how many points agree with the fit and how closely; frames below 0.4 are reported as unsure, and frames where no fit was found as lost (the last good position is held).
5. **Into the edit.** Corners are mapped from the source picture into the edit's frame through the clip's fit and crop focus at each moment, without rounding. Effects that move the picture (zooms, shakes) are not followed.
6. **Corner pin.** The renderer stretches the layer to the frame, pads it with 4 clear pixels, and sends its corners where the keyframes say with FFmpeg's `perspective` filter (`sense=destination`, evaluated per frame). The padded corners are placed by the same perspective, so the picture lands exactly on the keyframed corners and its edges stay clean.

## Measured

On the reference laptop (Intel i3-1005G1, 2 cores, 4 threads):

| Check | Result |
|---|---|
| Synthetic surface turning, growing, sliding and tilting, 13 frames, marked in the middle (`test/vision/points.test.ts`) | Corner error under 0.5 px on every frame, forward and backward |
| The same motion as a 2 s H.264 clip, through `track_points` and `replace_screen` (`test/vision/points.integration.test.ts`) | Worst corner error 0.28 px over 59 frames, from 9 corner keyframes; the rendered insert sits inside the moved surface |
| A layer pinned to a point (similarity) on that clip | Within 1.8 px of the true motion; the rest is the similarity model missing the slight perspective |
| A 10 s 1080p pan over a static texture | 0.25 px off after 10 s (the design asks for under 2 px per 5 s); 14.5 s to track (48 ms a frame, about 5 ms of it decoding) |

The tracker was 83 ms a frame before two changes in the Rust kernel that do not change its output: Lucas-Kanade samples the template window and its gradients once per pyramid level instead of on every iteration, and the pyramid and gradients are built row-parallel.

## Limits

- Drift on real phone and monitor clips, and re-detection after motion blur on a fast pan, wait for the test clips of the design's section 11.
- The insert does not yet get a matched blur, glare or color match by itself; add a light `blur` and a grade with `effects`, and check with `render_frame`.
- Things passing in front of the surface (a finger on a screen) are covered by the insert. Holding them out with an object mask is not built yet.
- Layers do not follow the shape of a non-rigid object; tracking points fits one transform to the whole area.
