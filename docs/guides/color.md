# Color correction & grading

All color work goes through one engine ([engine/library/effects/color.ts](../../engine/library/effects/color.ts)) that compiles Lightroom-style controls into FFmpeg filters.

## The controls

Most sliders run from -100 to 100, where 0 means unchanged.

| Group | Control | Range | What it does |
|---|---|---|---|
| Light | `exposure` | -3..3 stops | Camera-style exposure |
| | `brightness` | ±100 | Overall brightness |
| | `contrast` | ±100 | Contrast |
| | `highlights` | ±100 | Recover (−) or boost (+) bright areas |
| | `shadows` | ±100 | Lift (+) or deepen (−) dark areas |
| | `whites` | ±100 | White point |
| | `blacks` | ±100 | Black point (− crushes, + lifts) |
| | `brilliance` | ±100 | Evens out the image: brighter shadows, gentler highlights |
| Color | `temperature` | ±100 | − cooler / + warmer |
| | `tint` | ±100 | − green / + magenta |
| | `hue` | ±180° | Rotate every hue |
| | `saturation` | ±100 | −100 = black and white |
| | `vibrance` | ±100 | Saturates muted colors more, protects skin |
| | `hsl` | per color | `hue`, `saturation`, `luminance` for red, orange, yellow, green, aqua, blue, purple, magenta |
| Grading | `curves` | points 0..1 | Tone curve graphs: `master`, `red`, `green`, `blue`, or a `preset` |
| | `wheels` | hue 0..360, amount 0..100 | Tint `shadows`, `midtones` and `highlights` separately |
| Finish | `fade` | 0..100 | Matte film look |
| | `clarity` | ±100 | Local contrast (+ crisp, − soft) |
| | `sharpen` | 0..100 | Edge sharpening |
| | `vignette` | ±100 | Darken (+) or lighten (−) edges |
| | `grain` | 0..100 | Film grain |
| | `autoCorrect` | true/false | Automatic levels and white balance |

Filters always run in a fixed order:

1. auto-correct
2. exposure
3. white balance
4. tone (highlights, shadows, whites, blacks, brilliance)
5. brightness, contrast and saturation
6. vibrance
7. hue
8. HSL
9. wheels
10. curves
11. fade
12. clarity
13. sharpen
14. vignette
15. grain

So setting values in a different order gives the same result.

## Using it

**As one effect** (recommended, one per clip or for the whole video):

```json
{ "type": "color", "params": {
    "exposure": 0.2, "contrast": 15, "highlights": -30, "shadows": 20,
    "temperature": 10, "vibrance": 25,
    "hsl": { "blue": { "saturation": 20 }, "green": { "saturation": -15 } },
    "wheels": { "shadows": { "hue": 200, "amount": 20 }, "highlights": { "hue": 35, "amount": 15 } },
    "curves": { "master": [[0, 0.03], [0.25, 0.22], [0.75, 0.8], [1, 0.97]] },
    "vignette": 20 } }
```

**As individual effects:** `exposure`, `brightness`, `contrast`, `highlights`, `shadows`, `whites`, `blacks`, `brilliance`, `saturation`, `vibrance`, `hue`, `whiteBalance`, `hsl`, `curves`, `colorWheels`, `fade`, `clarity` and `autoCorrect` (plus `sharpen`, `vignette` and `grain`). Single-value effects take `{ "value": n }`.

**Quick looks:** the grade presets `cinematic`, `tealOrange`, `warm`, `cool`, `vintage`, `noir`, `vibrant`, `faded`, `moody`, `bright`, `sunset`, `matrix` and `crossProcess`, or a `.cube` file with `lut`.

## With Claude

| Tool | Use |
|---|---|
| `color_adjust` | Set or tweak controls on `"global"`, `"all-clips"`, a clip id or a media layer id. Settings merge with what's there; `reset` clears controls (`["hsl"]` or `["all"]`) |
| `get_color` | Read the current settings |
| `analyze_color` | Measure brightness, shadow and highlight levels, contrast range, saturation and color cast at a time, with suggestions. Letterbox bars are ignored |
| `render_scopes` | Histogram, luma waveform, RGB parade and vectorscope as an image Claude can look at |
| `grade_region` | A secondary correction: color settings inside a mask (HSL key, luma range, shape, faces or the person), by label. The same label updates it; `remove: true` deletes it |
| `render_mask` | The frame with a mask as white on black, or as a red tint over the picture, to check a selection before and after grading |

A colorist's loop for Claude:

1. `analyze_color` and `render_scopes` to see where the image stands.
2. **Correct**: exposure, white balance and contrast until the image looks neutral and the scopes are balanced.
3. **Grade**: curves, wheels and HSL for the look (for example teal shadows with warm highlights, or muted greens).
4. **Secondaries**: `render_mask` to build a clean selection (check the start, middle and end of the clip), then `grade_region` (a deeper sky, lifted faces, cooler shadows).
5. **Finish**: clarity, vignette and grain.
6. `render_frame` and `analyze_color` again to confirm the result, and do the same on a couple of different shots.

A new `color` effect is inserted *before* stylize effects such as `letterbox`, so the grade never tints the black bars. Secondaries go after the whole-frame `color` effect and earlier secondaries, also before stylizing. `color_adjust` and `get_color` only touch the whole-frame grade, never a secondary.

### Secondary corrections

```json
{ "target": "clip_1", "label": "deeper sky",
  "mask": { "kind": "key", "hue": [190, 240], "saturation": [0.15, 1], "softness": 0.2,
            "combine": [{ "kind": "shape", "op": "intersect", "shape": { "type": "rect", "x": 0.5, "y": 0.25, "width": 1, "height": 0.5 } }] },
  "color": { "saturation": 15, "temperature": -10 } }
```

- **Key**: hue is measured on the color circle, so a range can cross red (`[340, 20]`). Pixels with almost no color never pass a hue test, since their hue is noise. `softness` widens each range's falloff (up to 45 degrees of hue and 0.25 of saturation and luma).
- **Combine** a key with a shape to keep the sky but not blue clothes, or subtract `face` from a luma key to keep skin out of a highlight change.
- **Feather** of 0.01 (1% of the frame height) or more keeps the edge invisible; `grow` closes small holes before feathering; `smooth` (frames) stops a key from flickering on noisy footage, as does `denoise`.
- Masks work on any effect, not only color: a `blur` outside a shape, `sharpen` on faces, a `glow` on one object. See [the project document](project-format.md) for the full mask format.

## Notes

- `exposure` works in floating point. The engine clips back to the normal range right after it, so later filters never see values brighter than white.
- Color balance runs without "preserve lightness". On bright, saturated colors that mode produced broken pixels when combined with other controls.
