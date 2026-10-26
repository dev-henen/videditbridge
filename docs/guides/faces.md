# Faces & reframing

The editor finds faces on this machine with OpenCV's YuNet model (MIT license, 230 KB), run by ONNX Runtime (the optional `onnxruntime-node` package, which also comes with `@huggingface/transformers`). The model downloads once to `~/.cache/ai-video-editor/models/yunet` (or `$AVE_MODELS_DIR`) and then works offline, with no account or key. Code is in [src/tools/vision](../../src/tools/vision).

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
| `reframe` | Sets each cover-fit clip's `focus` so the main face stays in frame, for 16:9 footage in a 9:16 video and the like. It keeps the face's whole path in frame when the crop is wide enough, and otherwise centers its usual spot |
| `retouch` | `beauty.region: "face"` and `backgroundBlur.subject: "face"` place the ellipses from the detected face |
| `review_edit` | Reports text and captions over a face, found in the frames it renders without text |

Video is sampled twice a second by default (`fps`), streamed through one FFmpeg process at the model's 640 px input, and faces in successive frames are linked into tracks, one per person. Results are cached per file version, range and rate, so asking again is instant. A 4 second 1080p clip takes about 2 seconds.

## In code

```ts
import { FaceDetector, trackFaces, detectClipFaces, sourceToFrame, focusOn } from "ai-video-editor";

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

- The crop, retouch ellipse and blur ellipse are fixed for a clip. Following a moving face needs keyframes (roadmap #2).
- Zooms and shakes from effects are not followed when mapping faces into the frame.
- Faces smaller than about 10 pixels at the model's 640 px input (a person far away in 4K) can be missed, and faces seen from behind or mostly out of frame are not found.
- The person around a face is an estimate; a real cutout (segmentation) is still to come.
- Phone video stored sideways is read upright: `probe` now reports its upright size. Projects that imported such a clip earlier keep the old size until the clip is imported again.
