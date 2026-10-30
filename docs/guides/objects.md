# Selecting and tracking objects

Select any object in a video (a phone, a car, a cup, a person, a sign), and the editor follows it through every clip of that video. Any effect or color correction can then be limited to it: a glow on one object, a grade on one car, a blur on everything else. Everything runs on this machine.

## With Claude

| Tool | Use |
|---|---|
| `select_object` | Select an object on one frame: a box around it, a point on it, or its name (`"the red car"`). Positions are fractions of the edit's frame at a timeline time, as in `render_frame`. Shows the selection in blue so it can be checked. `id` reselects an object; `remove: true` forgets one |
| `track_object` | Follow the object through the clips of its video. Reports, per clip, how many frames the model segmented, the confidence, and the timeline ranges where the object was unsure or not seen, with the mask drawn on the clip's start, least sure frame, middle and end |
| `grade_region`, `render_mask`, any effect | Use the object with `mask: { kind: "object", object: "<id>" }`, alone or combined with other masks |

A box is the most reliable prompt. A single point often selects only part of the object (a shirt for the person) because a point is ambiguous for every segmentation model. For a point alone, the editor picks the largest of the model's confident answers. A name is found by a detector once, at selection, and stored as a box, so renders never run the detector again.

```json
{ "tool": "select_object", "time": 2.5, "box": { "x0": 0.42, "y0": 0.3, "x1": 0.56, "y1": 0.7 }, "label": "phone" }
{ "tool": "track_object", "objectId": "phone" }
{ "tool": "grade_region", "target": "clip_1", "label": "phone pop", "mask": { "kind": "object", "object": "phone", "feather": 0.005 }, "color": { "saturation": 30, "exposure": 0.2 } }
```

In the project, objects live in `project.objects` by id: the asset, the source time of the frame they were selected on, and the prompt (box, point or name) in source frame fractions.

Object masks work on primary video clips of the object's video. On media layers, on whole-video effects, and on clips of other videos they fail with a message saying so; use a key or shape mask there.

## How it works

1. **Selection.** SAM 2.1 (hiera tiny) segments the frame from the box or point. For a name, OWLv2 finds the box first.
2. **Keyframes.** SAM's image encoder takes about 3.7 s a frame on the reference laptop, far too slow for every frame. So it runs on keyframes, every 1.5 s, outward from the selected frame. Each keyframe is prompted with the box the tracking predicts, and of SAM's three answers the one that overlaps the prediction most is kept, so a similar object nearby is not picked up. When no answer overlaps the prediction (occlusion, or the object left the frame), the prediction is kept and the confidence drops.
3. **Between keyframes.** The mask is carried by region tracking in Rust (`trackRegion` in `ave-native`): corners inside the mask (kept a few pixels from its edge, where they often lie on the background), pyramidal Lucas-Kanade with a forward-backward check, and a RANSAC fit of the motion. Each span is tracked forward from one keyframe and backward from the next, and the two are blended by distance, so drift cancels.
4. **Hard motion.** Where the forward and backward masks disagree in the middle of a span (IoU under 0.85: fast or non-rigid motion, a turning person), SAM segments a frame there and each half is solved again. Easy shots stay at one SAM call every 1.5 s; hard ones get more.
5. **Edges and time.** A guided filter (Rust) snaps the edges to the frame, so hair, fingers and cables survive SAM's 256 x 256 output, and light smoothing over time keeps edges from shimmering.

The mask video (FFV1, long side 480 px) and the track (box and confidence per frame) are cached per clip source range in the render cache, like person cutouts. Renders and `track_object` share them.

## Models

All are optional, downloaded once into the models folder, and Apache-2.0 licensed at their source.

| Model | Size | Use |
|---|---|---|
| [SAM 2.1 hiera tiny](https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX) (Meta, Apache-2.0) | 155 MB | Segmentation from a box or point |
| [OWLv2 base](https://huggingface.co/Xenova/owlv2-base-patch16-ensemble) (Google, Apache-2.0) | 155 MB (quantized) | Finding a named object |

**How they were chosen** (2026-10-28, on seven frames of the project footage: two phones, a seated man, a woman with earbuds, a candle, a flower, a lighthouse):

| Segmenter | Encoder per frame | Agreement with SAM 2.1 small, box prompts | Notes |
|---|---|---|---|
| SAM 2.1 tiny | 3.7 s | IoU 0.98 to 0.99 on all seven | Chosen |
| SAM 2.1 small | 4.7 s | (reference) | 20% slower, same masks |
| SlimSAM-77 | 3.9 s (3.6 s quantized) | 0.00: selects the background | Fails on box prompts through transformers.js |

DirectML on the laptop's Intel GPU was no faster (3.6 s). SAM 2.1 large was planned as the reference but its 889 MB download did not finish on the test connection, so agreement is measured against SAM 2.1 small and checked by eye.

| Detector | Per image | Found the named thing (box IoU against hand-placed boxes) |
|---|---|---|
| OWLv2 base, quantized | 12.3 s | 8 of 8 (0.63 to 0.92) |
| Grounding DINO tiny | | Fails inside the transformers.js detection pipeline |

## Measured

On the reference laptop (Intel i3-1005G1, 2 cores, 4 threads), at 30 frames a second:

| Clip | Time | Result |
|---|---|---|
| Synthetic: a textured card moving along a known path for 4 s (`test/vision/objects.integration.test.ts`) | 45 s | IoU 0.955 mean, 0.892 worst frame, against the exact path; flicker 0.12% |
| A phone on a desk under moving hands, 10 s | 50 s (165 ms a frame), 11 keyframes | Phone followed throughout; fingers over it stay out of the mask; flicker 0.01% |
| A woman turning quickly and leaving the frame, 1.8 s | 48 s, 7 keyframes | Followed through the turn; confidence drops as she leaves |

The design's budget is a 10 s clip at 30 fps in under 60 s. Easy shots meet it; fast, non-rigid motion costs more, because that is where SAM has to look again. Flicker is measured as the mean frame-to-frame change where the mask is clearly on or off in both frames (target under 2%).

## Limits

- Accuracy against hand-made mattes on real clips (cars, people, a phone, a cup), and the identity test with two similar objects crossing, wait for the test clips of the design's section 11.
- SAM's mask is 256 x 256 before refinement, so very thin parts (a bicycle's spokes) are partly lost even after the guided filter.
- An object hidden for longer than a keyframe span is kept at its predicted place with low confidence; `track_object` lists those ranges.
- Graphics follow rigid things through [point and surface tracking](tracking.md) (`track_points`, then `pin_layer`), not through an object's mask.
