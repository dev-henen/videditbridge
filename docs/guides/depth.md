# Depth

The editor estimates how far everything is from the camera on every frame of a video or photo clip. With that, it can blur what is out of focus like a fast lens and pull focus from one subject to another. It can also grade the background apart from the subject, lay haze over distant things, and move a camera through a still photo. Everything runs on this machine.

## With Claude

| Tool | Use |
|---|---|
| `estimate_depth` | Estimate the depth of a clip (cached for later) and show a frame next to its depth, near white and far black. `points` and `boxes` read the distance of things, for focus or a mask |
| `set_focus` | Depth of field: focus on a `point`, a `box`, a `distance` or a tracked `object` (which the focus then follows), or `rack` the focus between subjects over time. `blur` sets the strength, `range` how deep the sharp zone is; `remove: true` takes it out |
| `grade_region`, `render_mask`, any effect | `mask: { kind: "depth", distance: [a, b] }` selects a range of distance (with `softness`), e.g. `[0.6, 1]` for the background |
| `add_effect` with `depthFog` | Haze, fog or mist that thickens with distance |
| `add_effect` with `parallax` | A 2.5D camera move through a photo: the picture is cut into depth layers that move apart, near ones more |

```json
{ "tool": "estimate_depth", "clipId": "clip_1", "points": [{ "x": 0.52, "y": 0.34 }] }
{ "tool": "set_focus", "clipId": "clip_1", "point": { "x": 0.52, "y": 0.34 }, "blur": 30 }
{ "tool": "set_focus", "clipId": "clip_2", "rack": [{ "time": 4.2, "point": { "x": 0.3, "y": 0.6 } }, { "time": 6, "point": { "x": 0.7, "y": 0.4 } }] }
{ "tool": "grade_region", "target": "clip_1", "label": "darker background", "mask": { "kind": "depth", "distance": [0.6, 1] }, "color": { "exposure": -0.6 } }
{ "tool": "add_effect", "target": "clip_3", "type": "parallax", "params": { "x": 0.04, "zoom": 0.1 } }
```

Distance runs from 0 to 1 within a clip: the first moment's nearest things sit at about 0.1 and its farthest at about 0.9, so things that come nearer or go farther later still fit. It is relative depth, not meters: compare distances within a clip, not across clips.

## The effects

| Effect | Params |
|---|---|
| `depthOfField` | `focus` (distance in focus), `focusPath` (focus over time, eased between points), `range` (depth of the sharp zone, default 0.1), `blur` (pixels at 1080p for the most out-of-focus parts, default 25) |
| `depthFog` | `color`, `density` (fog over the farthest things, default 0.6), `start` (distance where it begins, default 0.25), `falloff` (how fast it thickens, default 3) |
| `parallax` | `x`, `y` (how far the camera moves over the clip, frame fractions), `zoom` (push in or pull out), `layers` (default 8) |

## How it works

1. **Keyframes.** Depth Anything V2 Small looks at a keyframe twice a second, at 364 pixels on the short side. Its output is relative inverse depth, with its own unknown scale and offset on every frame, so taken frame by frame it flickers.
2. **One scale** (Rust, `depthSequence`). Each keyframe is fitted to the one before it, moved to where the camera is now. The fit is a least-squares scale and shift that starts from a robust guess (matched interquartile ranges and medians, or spreads where most of the frame is one flat surface). It then twice leaves out the pixels that disagree most (things that moved), so they do not pull the fit.
3. **Between keyframes.** The camera's motion over the chunk is tracked on the whole picture (Rust `trackRegion`, affine). Depth is carried from the keyframes on both sides along it and blended by distance; what neither side saw keeps the nearer keyframe's depth.
4. **Edges and time.** A float guided filter snaps depth edges to each frame, and a light blend with the previous frame (moved with the camera) settles what is left. The result is stored per clip range as a 16-bit gray video (FFV1) in the render cache, with a small track file (keyframes, near and far distances).
5. **Depth of field.** The picture is cut into 6 soft depth bands, each blurred according to how far it is from the focus. A band's color is a normalized blur of that band alone: premultiplied by its matte, blurred, divided by the blurred matte, in 16 bits. So a sharp subject never smears into the blurred background behind it, and the background fills in behind the subject's edge. Bands go on far to near. Each covers its own blurred matte (so blurred foreground spills over what is behind it, as through a real lens) and, sharply, itself and everything nearer (so no gap opens where a blurred band ends). A rack focus sends each band's blur filters new strengths ten times a second.
6. **Parallax.** Each depth layer shows itself and everything behind it. The holes nearer things leave are filled with a wide normalized blur of what is farther, in 16 bits and with a small floor on the weight, so a fill far from anything falls back to a plain blur instead of noise. The layers then move and scale apart over the clip. Neighbors cross-fade over half a layer, so smooth depth (a receding floor) softens slightly instead of tearing.

## Model

| Model | Size | License |
|---|---|---|
| [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) (ONNX export of [depth-anything/Depth-Anything-V2-Small-hf](https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf)) | 99 MB | Apache-2.0 |

Optional, downloaded once into the models folder on first use, run with ONNX Runtime. The Base, Large and Giant weights of Depth Anything V2 are CC-BY-NC-4.0 and must not be used.

**How it was chosen** (2026-11-02, on eight frames of the project footage: a flower against paving, a forest view with branches, a foggy mountain, a woman on a couch holding a phone, hands on a desk with a phone, glasses and a pen, a lighthouse with cars and people, a city street at night, a candle). Times are per frame on the reference laptop's CPU; flicker is the mean change between consecutive frames of a still shot after fitting each to the first by scale and shift, as a share of the depth range.

| Candidate | License | Size | Per frame | Flicker (candle, flower) | Result |
|---|---|---|---|---|---|
| Depth Anything V2 Small (364 px) | Apache-2.0 | 99 MB | 1.5 s | 1.5%, 3.3% | Chosen. By far the cleanest edges: petals, twigs, a pen and glasses on a desk, a walking person in the dark |
| Depth Anything V1 Small (364 px) | Apache-2.0 | 99 MB | 1.3 s | 1.5%, 2.4% | Right ordering, but soft, blobby edges |
| DPT-Hybrid MiDaS (384 px) | MIT | 533 MB | 2.9 s | 4.3%, 2.9% | Blurry and bleeding edges; 5 times the size and twice as slow |

DepthPro was not considered: its license (Apple's research license) does not allow use in this MIT-licensed library. On the reference laptop's integrated graphics, DirectML runs the chosen model in 1.7 s a frame against 1.2 s on the CPU, so the provider check (see the faces guide) keeps the CPU there.

## Measured

On the reference laptop (Intel i3-1005G1, 2 cores, 4 threads):

| Check | Result |
|---|---|
| Three project clips, 3 s each at 30 fps (a candle, a lighthouse with people, a woman on a couch) | 16 s each (7 keyframes); flicker in static areas 0.09%, 0.15% and 0.22% a frame (the design asks for under 3%) |
| A generated pan with a model stand-in that returns the true depth on a new random scale every keyframe (`test/vision/depth.integration.test.ts`) | Every frame on one scale (the box always nearer than the wall), flicker 0.06% a frame |
| Focus on a sharp box in front of a textured wall, exact depth (`test/render/depth.integration.test.ts`) | Box texture kept; wall texture down to under 40%; beside the box, beyond 2 px, the wall keeps its own colors (no red from the box, no dark ring) |
| A rack focus from the box to the wall over 1.6 s | Box texture falls 73, 71, 72, 71, 64, 56, 45, 36, 26, 19, 15 ... 12 and the wall's rises 8 ... 26, with no jumps between bands |
| A depth mask on the far part; depth fog | The wall darkens and the box is unchanged (within 2 levels); fog lifts the wall and leaves the box |
| Parallax, x 0.06 | The near box moves 34 px and the wall at distance 0.85 moves 8 px |
| Rendering at 960 x 540 | Depth of field about 70 ms a frame; parallax with 8 layers about 240 ms a frame |

## Limits

- Depth is relative and per clip; the scale can drift slowly over a long clip with large changes of scene.
- Moving subjects between keyframes follow the camera's motion, not their own, so a fast-moving person's depth edge can lag by up to a quarter of a second before the guided filter pulls it to the frame's edge.
- Parallax fills what nearer layers uncover with a blur of what is around it, not real detail: keep moves small, and check near subjects' edges at the end of the move. Object removal (the design's section 7.2) will bring inpainting for larger moves.
- Depth of field on transparent edges (hair, fine branches) follows the depth map's edges, which are softer than the picture's.
- Checks on the design's test clips (halo width on real people, rack focus in motion) wait for the test clips of section 11.
