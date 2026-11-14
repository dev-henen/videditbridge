# Sky masks and replacement

The editor finds the sky on every frame of a video clip. A grade or any effect can then be limited to it, and the sky can be replaced with a photo, a video of clouds or a gradient that moves with the camera, picks up the scene's haze and lights the scenery a little. Everything runs on this machine.

## With Claude

| Tool | Use |
|---|---|
| `replace_sky` | Replace the sky in some or all primary video clips with an image or video asset (`assetId`) or a gradient (`colors`). Measures the camera's motion and the old sky's brightness, sets up the `skyReplace` effect, and shows a frame of each clip. `follow` sets how much the new sky moves with the camera (default 1), `match` how far its brightness comes toward the old sky's (default 0.5); `haze`, `relight` and `blur` fine-tune it; `remove: true` takes it out |
| `grade_region`, `render_mask`, any effect | Use the sky with `mask: { kind: "sky" }`, alone or combined with a key (a deeper blue only where the sky is) |

```json
{ "tool": "replace_sky", "assetId": "sunset_clouds", "focus": { "x": 0.5, "y": 0.7 } }
{ "tool": "replace_sky", "clipIds": ["clip_2"], "colors": ["#2B2F7A", "#F29A5C"], "relight": 0.2 }
{ "tool": "grade_region", "target": "clip_1", "label": "deeper sky", "mask": { "kind": "sky" }, "color": { "saturation": 15, "temperature": -8 } }
```

Pick a new sky whose light suits the scene: a sunset over midday shadows looks wrong unless the clip is also graded warmer. The clip's own grade applies to the new sky too, because the replacement runs first among its effects.

## The skyReplace effect

`replace_sky` writes a `skyReplace` effect at the start of each clip's effects, labeled `sky`:

| Param | |
|---|---|
| `asset` or `colors` | The new sky: an image or video asset (held or looped for the clip), or a vertical gradient from top to bottom |
| `focus` | Which part of the new sky picture shows when it is cropped to the frame |
| `motion` | Keyframes of the camera's motion since the clip started: how the frame's middle moved (`x`, `y` in frame fractions), `scale` and `angle` (degrees). Measured by `replace_sky` |
| `cover` | How much larger than the frame the new sky is drawn, so its edges never show as it moves (set from the motion) |
| `gain` | Brightness of the new sky, matched to the old sky's |
| `blur` | Softening to the scene's sharpness, in pixels at 1080p (default 0.6) |
| `haze`, `hazeColor`, `hazeHeight` | A soft band of haze over the new sky along the skyline. Its color is the new sky's lowest part, paler, since the air between the camera and the skyline scatters light |
| `relight`, `lightColor` | A slight tint of the scenery toward the new sky's color (default 0.12, under ΔE 3) |
| `edge`, `feather` | The new sky grows a pixel over the scenery's outline (covering the old sky that edge pixels still hold) and gets a soft edge |

## How it works

1. **Finding the sky.** skyseg (below) runs on keyframes, one per second of footage, on frames stretched to 320 x 320. Between keyframes the matte is carried by the Rust region tracker following the scenery: forward from one keyframe and backward from the next, blended by distance. Where a pan brings new sky into view, only the direction that saw it counts, and where neither did, the nearer keyframe's matte is kept. This carrying runs on half-size frames, since the next step restores the detail.
2. **Edges and time.** A guided filter (Rust) snaps the matte's edges to each frame at 768 px on the long side, then light smoothing over time keeps them from shimmering. The matte (FFV1) and its track (JSON) are cached per clip range in the render cache, like person cutouts, so renders and `replace_sky` share them.
3. **The camera's motion.** In the same pass, the tracker follows a band of distant scenery just under the sky (similarity: shift, zoom and turn) at full mask size, chained from keyframe to keyframe. A distant skyline moves like the sky does when the camera pans or tilts. `replace_sky` maps it into the edit's frame through the clip's fit, smooths it with a centered 7-frame average and keeps only the keyframes needed within half a pixel.
4. **The graphics card.** On the reference laptop a DirectML session for skyseg takes 22 s to create and then runs a frame in 0.58 s, against 0.7 s and 1.1 s on the CPU. So the CPU starts at once, and for jobs of 40 model frames or more the graphics card's session is created in the background and takes over when ready.
5. **Compositing.** The new sky is cropped to cover the frame (times `cover`), adjusted in brightness and softened, then zoomed, turned and moved by the motion keyframes each frame. Haze is laid over it with a weight made by spreading the scenery upward: wide sideways and short upward, so it follows the skyline and does not glow around tall things like towers. The scenery is relit, and the new sky goes in through the sky matte, grown by a pixel and feathered.

## Model

| Model | Size | License |
|---|---|---|
| [skyseg](https://huggingface.co/JianyuanWang/skyseg) (U-2-Net trained for sky, from [Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing)) | 176 MB | MIT |

Optional, downloaded once into the models folder on first use, run with ONNX Runtime.

**How it was chosen** (2026-10-30, on nine frames of the project footage: a lighthouse against a dusk sky, a lighthouse with buildings, cars and people under a blue sky with clouds, a drone shot with a thin band of sky, a foggy mountain, branches against a hazy sky, the sea under the sky, two night skylines, and palm trees under a canopy at dusk). Times are per 640-pixel frame on the reference laptop's CPU.

| Candidate | License | Per frame | Result |
|---|---|---|---|
| skyseg | MIT | 1.3 s | Chosen. Keeps railings, branches and distant ridges; tells the sea from the sky; finds night skies |
| UperNet ConvNeXt-tiny (ADE20K) | MIT | 4.8 s | Soft, blobby edges; partly takes a faint far ridge for sky |
| DETR ResNet-50 panoptic (COCO) | Apache-2.0 | 9.4 s | Blobby outlines (branches become blobs); misses the fog band; better than skyseg on the dusk canopy shot |
| CLIPSeg ("the sky", quantized) | Apache-2.0 | 0.7 s | Too coarse for an edge |
| OWLv2 box for "the sky", then SAM 2.1 tiny | Apache-2.0 | 16.7 s | Sharp where it works, but finds nothing in the sea and dusk shots |

MaskFormer (CC BY-NC) and SegFormer (NVIDIA source code license, non-commercial) were not considered, because their licenses do not allow commercial use, and the app is free for commercial use and ships its models.

## Measured

On the reference laptop (Intel i3-1005G1, 2 cores, 4 threads):

| Check | Result |
|---|---|
| A generated scene with a wavy skyline, with its exact matte (`test/render/sky.integration.test.ts`) | No old sky along the edge; the new sky covers at most 2 rows of the scenery's outline; the scenery's tint stays under ΔE 3 by default; haze lifts the sky by 15.6 (luma) along the skyline and by 0 high up; a picture as the new sky moves with the camera to the pixel |
| A generated pan (30 px a second right, 20 down) over a skyline, 3 s at 640 x 360 (`test/vision/sky.integration.test.ts`) | Worst frame IoU 0.998 against the true sky, worst edge 1.3 px, camera motion 0.33 px off after 3 s (the design asks for under 2 px per 5 s); 90 frames in 15 s |
| A handheld walk past a lighthouse, 4 s at 1280 x 720 | 25 s with the model on the CPU (5 model frames 6.4 s, tracking 7 s, warps 3.5 s, guided filter 1.6 s); the new sky follows a 334 px pan with an 8% zoom and 4.5 degrees of turn |
| A pan and tilt over a forest with hazy mountains, 4 s | 31 s; follows an 821 px pan; see the limits for the hazy ridge |

## Limits

- On a fast pan the new sky follows the middle of the frame and lags toward its sides (about 14% on a real handheld pan): one flat picture cannot follow a pan's perspective. `review_edit` samples about 12 frames a second, judges the slide against how far the scenery moves, and says when a pan is the cause; mist drifting over hills reads as a slow slide too.
- Where haze blends the far ridge into the sky, the model may keep a pale band of old sky above the ridge, or patches of it on some frames. Check those frames with `render_mask` and cover them with a key mask combined into the sky mask if needed.
- Fine structures against the sky (a lattice tower, power lines, thin twigs) keep some old sky between their parts.
- The camera's motion comes from distant scenery. With nothing distant in view (a close-up against the sky), set `follow` to 0 or a little more.
- Layer effects and whole-video effects cannot use the sky mask; it exists for primary video clips only.
