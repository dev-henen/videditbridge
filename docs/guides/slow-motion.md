# Slow motion & frame rates

When a clip shows more frames than its footage has (slowed down, in the slow part of a speed ramp, or 24 fps footage in a 60 fps edit), frames repeat and motion stutters. Smooth motion makes the frames in between with a model on this machine instead.

## With Claude

| Tool | Use |
|---|---|
| `set_speed`, `speed_ramp` | Slowing a video clip below its footage's frame rate turns smooth motion on by itself and says how many frames will be made; `smooth: false` keeps repeated frames |
| `interpolate` | Turn smooth motion on for clips (default: every video clip that shows frames its footage lacks, such as low frame rate footage) and prepare the frames now, with a report per clip and a frame to look at; `off: true` turns it off |
| `render_preview` | Check the motion: fast movement and edges where things cross |

```json
{ "tool": "set_speed", "target": "clip_3", "speed": 0.25 }
{ "tool": "interpolate", "clipIds": ["clip_3"] }
```

In the project, `clips[].interpolate: true` asks for it. Frames are made before rendering and cached per clip, keyed by the source and the exact source time of every frame the clip shows, so changing the speed, the trim or the project's frame rate makes them again. Final renders prepare missing frames; quick previews (on proxies) use them once prepared and repeat frames until then, since making them takes minutes.

## How it works

1. **Which frames.** For every frame the clip shows at the project's frame rate, the clip's time map (speed, ramp, reverse) gives its source time. Within a twentieth of a frame of a real frame, the real frame is used.
2. **The rest** is made by RIFE 4.9 from the two source frames around that time, at the fraction between them (0.25, 0.5, 0.75 for 4x slow motion; any fraction for ramps and rate changes). Only those frames are made, so a ramp's fast parts cost nothing.
3. **Guards.** Between identical frames (footage with repeated frames) nothing is made, and across a cut inside a clip (neighbors differing by over 40 levels on average) the nearer frame is held, so two shots are never blended.
4. **The picture.** The frames are written in source order at the project frame rate (long side up to 1920 px, at the render cache's quality) and read by the renderer in place of the source, turned round for a reversed clip. Sound, masks and effects are unchanged.

## Model

| Model | Size | License |
|---|---|---|
| [RIFE 4.9](https://huggingface.co/FuryTMP/RIFE_v4.9) (`rife_v4.9.onnx`, ONNX export of [Practical-RIFE](https://github.com/hzwer/Practical-RIFE) 4.9; input is both frames and the time as 7 channels) | 21 MB | MIT |

Downloaded once into the models folder (`interpolate/`). The first use measures the graphics card provider against the CPU and keeps the faster (DirectML on the reference laptop: 231 against 581 ms a run at 640 x 384).

Compared on six project clips at 960 x 544: every other frame of 1 s at 30 fps was dropped and made again from its neighbors, then scored against the real frame (mean PSNR over 15 frames):

| Clip | Repeat a frame | Blend (`framerate`) | `minterpolate` (mci, aobmc, bidir) | RIFE 4.9 |
|---|---|---|---|---|
| Forest, forward move | 19.3 dB | 20.9 | 31.6 | **34.5** |
| Night traffic | 37.2 | 40.3 | 42.1 | **42.7** |
| Hands on a desk | (repeated frames in the source) | 43.7 | 45.5 | **46.4** |
| Push-ups | | 26.5 | 27.2 | **30.3** |
| Jogger stretching | | 19.6 | 19.7 | **21.3** |
| Phone call, handheld | 28.4 | 31.8 | 34.4 | **35.9** |
| Mean | | 30.5 | 33.4 | **35.2** |

RIFE is better on every clip, most on large motion (the forest move, push-ups). `minterpolate` costs about 0.45 s a frame on the CPU at that size, RIFE 0.53 s with DirectML (3 s on the CPU). An ensemble export of RIFE 4.9 scored the same (35.2 dB) and was not faster; a midpoint-only export cannot make frames at 0.25 or 0.75.

## Measured

On the reference laptop.

| Check | Result |
|---|---|
| A box moving 8 px a frame, slowed 4x through `set_speed` and `interpolate` (`test/video/interpolate.integration.test.ts`) | Every output frame moves it 2 px, never repeated; it stays 80 px wide (no doubled edges). With smooth motion off, frames repeat (3 still, then a jump) |
| The same box at 15 fps in a 30 fps edit | A new frame between each pair: 8 px steps throughout |
| Push-ups (25 fps, 720p), 1 s slowed 4x | 105 of 121 frames made in 126 s; consecutive frames differ by 3.2 to 4.2 levels (no repeats); no tearing at the head, arms or gloves in a strip of 8 consecutive frames |
| The same clip in a 60 fps edit | 55 of 61 frames made in 62 s; consecutive frames differ by 4.1 to 6.7 levels, none repeated |

## Limits

- Making frames is slow: about a second a frame at 720p with a graphics card here, several without. Prepare them once the speed is settled.
- Motion blur in the footage stays: a slowed fast movement looks blurred rather than crisp.
- Very fast or crossing movement (spokes, splashing water, hands passing each other) can smear or warp. Check with `render_preview`.
- Masks and object removal follow the clip's source frames, so on made frames they come from the nearest real one.
- Frames are read with the footage's own YUV matrix (the asset's `colorMatrix`), so untagged HD keeps its colors.
- The last frames of a clip that runs to the end of its footage hold the final frame (there is nothing after it to move toward).
