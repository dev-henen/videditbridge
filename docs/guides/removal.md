# Removing objects

Take something out of a shot and fill in what was behind it: a person walking through, a car, a sign, a cable, a logo or a watermark. Everything runs on this machine.

## With Claude

| Tool | Use |
|---|---|
| `remove_object` | Remove a tracked object (`objectId` from `select_object`, followed through every frame; tracked first if it is not yet) or a fixed area (`box` in fractions of the edit's frame at `time`, `shape` `rect` or `ellipse`) from the clips of its video, or from `clipIds`. Shows the clip before and after at the frame with the most removed, and reports per clip whether the camera moved and how much of the area came from real frames. `grow` and `feather` adjust the edge; calling again adds to the clip's removal; `remove: true` takes one object out of it, or everything |
| `select_object`, `track_object` | Select and follow the object first, to check its mask (see [Selecting & tracking objects](objects.md)) |
| `render_preview` | Check the result moving: generated areas on moving shots are where flaws show |

```json
{ "tool": "select_object", "time": 3.2, "box": { "x0": 0.61, "y0": 0.34, "x1": 0.72, "y1": 0.9 }, "label": "walker" }
{ "tool": "remove_object", "objectId": "walker" }
{ "tool": "remove_object", "box": { "x0": 0.86, "y0": 0.04, "x1": 0.98, "y1": 0.12 }, "time": 1, "clipIds": ["clip_1", "clip_2"] }
```

A box is for things that stay put in the frame (a logo, a date stamp, a dust spot on the lens, a sign on a tripod shot). Anything that moves in the frame needs a tracked object. Draw boxes a little larger than the thing; `grow` (default 0.008 of the frame's short side) also takes soft edges, motion blur and contact shadows.

## The effect

`remove_object` writes a `removeObject` effect at the start of the clip's effects, labeled `remove`, so the clip's grade applies to the fill as well:

| Param | Meaning |
|---|---|
| `objects` | Tracked objects to remove, by id (`project.objects`) |
| `regions` | Fixed areas, `{ shape, x0, y0, x1, y1 }` in fractions of the source frame (the tool converts from the edit's frame through the clip's fit) |
| `grow` | Grow the area by this fraction of the frame's short side (default 0.008) |
| `feather` | Soft edge beyond that (default 0.006) |

It works on primary video and photo clips. The fill is prepared before rendering and cached per clip source range in the render cache, like person cutouts; renders only lay it over the picture.

## How it works

1. **The camera.** The background is tracked (a homography per frame, Rust `trackRegion` on 960 px gray frames, away from the object) from the clip's first frame. If the frame's corners stay within a pixel on 9 frames in 10, the shot is locked off.
2. **A pool of real frames.** Frames spread over the clip (3 a second on a still camera; on a moving one as many as keep about 40 px of motion between them, up to 192; within 320 MB) are kept with their object masks. To fill a frame, the Rust `Remover` moves every pool frame onto it with the camera's motion and takes, for each pixel of the hole, what the pool frames show there, wherever the object is not.
   - **Locked off:** the pixels are copied exactly and the fill is the median of every pool frame that sees them, so it is the same from frame to frame and survives a shadow or a passer-by in one of them.
   - **Moving:** the median of the 3 pool frames that line up best with the frame on a ring around the hole (then nearest in time), each matched in exposure there. The camera's track drifts a few pixels over fine texture, and frames that no longer line up made a dark smear on a real pan. Close handheld foliage (leaves at many depths) is still the hardest case: no frame lines up there.
3. **What no frame shows** (an object that never moves on a still shot, a photo, the middle of a slow zoom) goes to LaMa. It runs on a crop around the gap, 2.5 times its size, on the frame as filled so far, so it continues the surroundings. Each result becomes a layer: later frames take from it, moved with the camera, as they take from real frames, and the next model run treats it as known. An object that never moves on a locked-off shot costs one model run, and what was painted stays put. Leftovers thinner than 3 pixels (along edges) are filled by push-pull interpolation instead.
4. **The edge.** The fill covers the mask grown by `grow`, then fades out over `feather`, onto the frame's own pixels.

The fill (FFV1 with transparency, long side up to 1920 px) and its track (camera, area and shares per frame) are cached per clip source range, keyed by the source, the range, the objects' prompts and the settings.

## Model

| Model | Size | License |
|---|---|---|
| [LaMa](https://huggingface.co/Carve/LaMa-ONNX) (`lama_fp32.onnx`, ONNX export of [big-lama](https://github.com/advimman/lama), fixed 512 x 512 input) | 208 MB | Apache-2.0 |

Downloaded once into the models folder (`inpaint/`) the first time something has to be painted. Compared on seven project frames (desk, night bridge, mountains, waterfall, two faces, stadium seats) with an object-sized ellipse cut out, scored by how close the fill comes to what was there:

| Candidate | License | Size | Per frame | PSNR in the hole (7 frames) | Result |
|---|---|---|---|---|---|
| LaMa (big-lama) | Apache-2.0 | 208 MB | 7.7 s | 13.2, 10.9, 35.8, 12.4, 22.7, 19.1, 22.3 dB | Chosen. Better on 6 of 7, and plausible everywhere: wood grain, seats, skin |
| MI-GAN (pipeline v2) | MIT | 28 MB | 1.7 s | 9.3, 11.1, 34.7, 10.3, 19.2, 15.2, 16.2 dB | Invents structure: text on a phone screen, red debris among seats, a smeared eye |

On the reference laptop DirectML fails on LaMa's Fourier layers, so the provider check keeps the CPU (the choice is saved next to the model).

## Measured

On the reference laptop.

| Check | Result |
|---|---|
| Locked-off generated shot, a box moving across a textured scene, lossless (`test/vision/removal.integration.test.ts`) | Every frame rebuilt from real frames, exactly (mean error 0.000 levels), flicker 0 |
| A sign fixed in the frame while the camera pans 2.7 px a frame sideways and 0.4 down | Detected as a moving camera; the middle frames rebuilt from real frames only; mean error 0.43 levels, flicker 0.23% a frame (the design asks for under 4%); 120 ms a frame at 640 x 360 |
| A box that never moves on a locked-off shot, with a model stand-in | One model run for 60 frames; the painted area identical on every frame |
| LaMa on a 90 x 90 hole in that texture | Fills with the texture around it: mean error 8.1 levels from the hidden texture, against 41.4 for the box |
| Through `remove_object` and a render (`test/render/removal.integration.test.ts`): the panning sign | 35.8 levels from the clean plate before, 3.7 after (the render's own encode) |
| A sign on a photo | Painted once, held for the clip: frame to frame it changes no more than the rest of the picture |
| Project footage: a pen on a locked-off desk (`14101-phone-hands-desk`, 4 s at 720p) | Detected as locked off; gone, the wood grain continues through; one model run for 100 frames; about 40 s in all, most of it loading and running the model |
| Project footage: a plain area of real moving shots "removed" (the original is the truth), 4 s at 1080p | Forest (a strong forward move): 100% from real frames, 7.1 levels, flicker 3.5% a frame, 240 ms a frame. Fog over mountains (a slow move): 10% from real frames, 9.4 levels, flicker 0.9%. Waterfall (a slow zoom): 25% from real frames, 36.7 levels where water had to be painted, flicker 3.2% |

## Limits

- Large objects on moving shots, and anything only the model fills, can wobble or look painted: the model paints texture, not the real thing (it cannot know what a car hid). Check those with `render_preview` and keep the area small.
- Parallax: the camera's motion is one homography for the whole background, so on a shot moving forward through near and far things (trees in front of hills) the fill can be slightly off where depth changes fast.
- Moving things behind the object (water, leaves in wind, a crowd) come back as they were in other frames, not as they move now.
- Shadows and reflections of the object stay unless the mask covers them; grow the area or remove a box over them too.
- Speed: decoding is done three times (camera, pool, fill), which matters for 10-bit AV1 and VP9 sources; loading the model takes about 20 s once per session, and each run 8 to 13 s on the CPU of the reference laptop.
