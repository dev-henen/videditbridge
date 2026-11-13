# Faces, cutouts & reframing

The editor finds faces on this machine with OpenCV's YuNet model (MIT license, 230 KB), run by ONNX Runtime (the optional `onnxruntime-node` package, which also comes with `@huggingface/transformers`). The model downloads once to `yunet` in the models folder (or `$AVE_MODELS_DIR`; see [Where downloads go](getting-started.md#where-downloads-go)) and then works offline, with no account or key. Code is in [engine/tools/vision](../../engine/tools/vision).

## Choosing the model

Three detectors were compared on twelve frames from real projects (close selfies, a person far away in a stadium, phone video, hands-only shots), on a 2-core laptop CPU:

| Model | Faces found | False detections | Time per frame | Size |
|---|---|---|---|---|
| YuNet (2023) | 9 of 9 | 0 | 16 ms | 230 KB |
| UltraFace RFB-320 | 9 of 9 | 1 (in ivy leaves) | 13 ms | 1.2 MB |
| YOLOS-tiny (people, not faces) | all people | 1 | 3,100 ms | 9.7 MB |

YuNet was as accurate as UltraFace without its false detection, gives five landmarks (eyes, nose, mouth corners), and is the smallest. YOLOS was far too slow for video, so the person around a face is estimated from the face for now.

## What it does

| Tool | What it does |
|---|---|
| `detect_faces` | For each clip: when each person is on screen (timeline times), where the face sits in the edit's frame after the clip's crop, how far it moves, and whether the crop cuts it off. For an asset: the same in source time and source frame |
| `reframe` | Sets each cover-fit clip's `focus` so the main face stays in frame, for 16:9 footage in a 9:16 video and the like. It keeps the face's whole path in frame when the crop is wide enough, and otherwise centers its usual spot. With `follow`, the crop pans with the person instead (focus keyframes, smoothed and reduced to a few moves) |
| `follow_face` | Makes a layer (a name label, a callout, an arrow) follow the main face: position keyframes above, below, beside or on it, kept inside the frame, fading out when the person leaves the shot |
| `retouch` | `beauty.region: "faces"` retouches only the faces, following every face frame by frame (see below). `beauty.region: "face"` places a fixed retouch ellipse on the detected face. `backgroundBlur.subject: "person"` and `replaceBackground` follow the person's outline on every frame (see below) |
| `review_edit` | Reports text and captions over a face, found in the frames it renders without text |

Video is sampled twice a second by default (`fps`), streamed through one FFmpeg process at the model's 640 px input, and faces in successive frames are linked into tracks, one per person. Results are cached per file version, range and rate, so asking again is instant. A 4 second 1080p clip takes about 2 seconds.

## Person cutout

`backgroundBlur` with `cutout: true` and `backgroundReplace` cut the person out of every frame instead of using a fixed ellipse, so the edge follows them as they move, including hands and whatever they hold. The cutout comes from PaddleSeg's PP-HumanSeg (Apache 2.0, 6 MB, from the OpenCV model zoo), also run locally and downloaded once.

Three person-segmentation models were compared on the same frames:

| Model | Time per frame | Edges |
|---|---|---|
| PP-HumanSeg (chosen) | 11 ms | Clean around hands, phones and seats |
| MediaPipe selfie segmentation | 4 ms | Blocky around hands; a stray patch on a stadium roof |
| MODNet | 790 ms | Finest hair, but too slow for every frame, and it dropped a hand |

How it works:

1. Before rendering, each video clip whose effects use the cutout gets a mask video: one frame per output frame of its source range, smoothed over time so the edge does not flicker, stored as small lossless gray video in the render cache's `masks` folder (or the system temp folder). It takes about 25 ms per frame on a laptop, once.
2. The renderer feeds the mask through the same speed, frame rate and crop as the picture, so they line up, and gives it to the effects (`EffectContext.personMask`).
3. The effect blurs or paints the background, then lays the person back on top, using the mask as transparency with a softened edge. `backgroundReplace` pulls the edge in a few pixels first, so the old scene does not show around the person.

On media layers and global effects there is no cutout, and the effects use their ellipse instead. Cached clips are keyed on their compiled FFmpeg graph, so a new mask (for example after trimming) or a change in how an effect is built renders the clip again.

## Face masks

`beauty` with `followFace: true` (the `retouch` tool's `region: "faces"`) retouches only the faces, wherever they move. It works like the cutout: before rendering, each video clip that asks for it gets a mask video with a soft ellipse, 1.5 times the face box, over every face. Faces are found 10 times a second and the ellipses glide between those samples. A face missed for more than 0.6 s (a turn of the head) holds its place rather than sliding across. The masks are stored next to the cutouts (`face-*.mkv`) and reach the effect as `EffectContext.faceMask`. On media layers and global effects, the effect falls back to its `region` ellipse, or the whole frame.

## In code

```ts
import { FaceDetector, trackFaces, detectClipFaces, sourceToFrame, focusOn } from "videditbridge";

const detector = new FaceDetector();
const { width, height, frames } = await detector.detectFile("talk.mp4", { start: 0, end: 10, fps: 2 });
const people = trackFaces(frames); // [{ start, end, box, extent, frames }]

// Faces in a clip, mapped through its fit and crop into the edit's frame, with timeline times.
const { tracks } = await detectClipFaces(project, "clip_1", detector, { baseDir });

// Keep a face in a 9:16 crop of 16:9 footage.
const focus = focusOn(people[0].extent, { width, height }, { width: 1080, height: 1920 });
```

`detectRgb(rgb, width, height)` finds faces in a raw RGB frame, for frames you already have in memory.

## Limits

- The crop follows a face with `reframe` `follow`, and retouch follows faces with `region: "faces"`, but the blur ellipses are fixed for a clip (use the person cutout for blur).
- Zooms and shakes from effects are not followed when mapping faces into the frame.
- Faces smaller than about 10 pixels at the model's 640 px input (a person far away in 4K) can be missed, and faces seen from behind or mostly out of frame are not found.
- The ellipse from `personRegion` is an estimate from the face; use the cutout when the person moves.
- The cutout is for people. Hair edges and fast motion are softer than with a green screen, and objects people are not holding count as background.
- Phone video stored sideways is read upright: `probe` now reports its upright size. Projects that imported such a clip earlier keep the old size until the clip is imported again.
