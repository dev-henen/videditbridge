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
| `match_color` | Match clips to one reference clip (see [Matching shots](#matching-shots)) |
| `grade_scene` | Match each scene's shots to its hero shot, or to a reference still (an imported image), several scenes in one call |

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
- **Objects**: select one with `select_object` (a box, a point or a name), check it with `track_object`, then grade it with mask `{ "kind": "object", "object": "<id>" }`. See [Selecting & tracking objects](objects.md).
- **The sky**: mask `{ "kind": "sky" }` follows the sky found by a model on every frame, so a sky can be deepened without catching blue clothing or water. To put in a new sky, use `replace_sky`. See [Sky masks & replacement](sky.md).
- Masks work on any effect, not only color: a `blur` outside a shape, `sharpen` on faces, a `glow` on one object. See [the project document](project-format.md) for the full mask format.

### Matching shots

Shots from different cameras, or from the same camera under different light, cut together badly. `match_color` and `grade_scene` make them look like a reference: a hero shot of the scene (grade it first with `color_adjust`), or a still such as a frame from a film the user names.

```json
{ "scenes": [
    { "reference": "clip_hero_kitchen", "clips": ["clip_2", "clip_3"] },
    { "reference": "still_blade_runner", "clips": ["clip_7", "clip_8"] } ],
  "strength": 0.85 }
```

How a shot is matched ([engine/tools/render/color-transfer.ts](../../engine/tools/render/color-transfer.ts)):

1. Three frames of the shot (at a sixth, half and five sixths of it) and of the hero shot are rendered as they come out of their clips: without the whole-video grade and without an earlier match.
2. Three methods are fitted from the colors of two of the shot's frames:
   - **transfer**: in Oklab, lightness moved quantile by quantile onto the reference's, and the color plane (a, b) moved by the linear Monge-Kantorovich map between the two color spreads, which carries cast, saturation and the direction of the spread together;
   - **reinhard**: each Oklab channel's mean and spread moved onto the reference's;
   - **curves**: per-channel RGB curves through matched percentiles (the method `match_color` used before).
3. Each is scored on the held-out middle frame: the ΔE 2000 between CIELAB quantiles of the matched frame and of the reference (a measure of the colors, not the layout, so different shots compare). The lowest wins.
4. Plausibility: the chroma part is eased off until the colorful pixels turn at most `maxHueShift` degrees (15 by default, 90% of them), and saturation scales stay between 0.4x and 2.5x.
5. Skin: faces found by face detection are sampled (inside the face, not hair). When the match leaves the average skin color more than 5 degrees off the vectorscope skin line (123 degrees), a hue turn limited to skin hues brings it back inside. Curves cannot do this, so they only win when they leave skin on the line.

The result is a `colorMatch` effect at the end of the clip, holding the fitted numbers. A transfer renders as a lookup table built once per render (`geq` on a Hald identity image, through `bakeColor`), so it costs the same as any baked grade. Running a match again replaces it. The report gives each shot's ΔE to the reference before and after, and each method's score: under 2 is a close match, over 6 a clear mismatch.

Measured: a test scene darkened, warmed and desaturated by known amounts comes back within 1 to 1.9 ΔE 2000 of the original, pixel by pixel; through the renderer, a regraded shot of the same footage went from 21.6 to 1.4 ΔE against its hero shot (`test/render/color-match.test.ts`, `test/render/color-match.integration.test.ts`).

## Camera log and HDR

Footage shot in a camera's log profile looks flat and gray until it is converted; HDR footage looks washed out on an ordinary display. Tell the editor what it is, and it renders as the camera's maker defines it:

```ts
project = setAssetColorSpace(project, "a001", "slog3-sgamut3cine");
```

Claude does this with `set_color_space`. HDR files tagged as HLG or PQ are set when they are probed; log footage is usually tagged as ordinary video, so Claude looks at it first (a flat picture with no deep blacks or bright whites) and, when the camera is unknown, offers the likeliest choices.

| `colorSpace` | Footage |
|---|---|
| `rec709`, `srgb` | Ordinary video and pictures (the default; used as they are) |
| `slog3-sgamut3cine`, `slog3-sgamut3` | Sony S-Log3 |
| `vlog-vgamut` | Panasonic V-Log |
| `applelog` | iPhone Apple Log |
| `logc3-awg3`, `logc4-awg4` | ARRI LogC3 (EI 800), LogC4 |
| `clog3-cinemagamut` | Canon Log 3 / Cinema Gamut |
| `bmdfilm-gen5` | Blackmagic Film, Generation 5 |
| `hlg-rec2020`, `pq-rec2020` | HDR (HLG, PQ / HDR10) |

Each space's curve and gamut come from its maker's published formulas (`engine/library/color/spaces.ts`, with the source of each). The footage goes to ACES and out through the ACES output transform for Rec.709, a filmic curve that rolls highlights off instead of clipping them; 18% gray lands at about 39% of the range. The conversion comes first: the color panel's primaries then grade on scene light inside it, and everything else works on the converted picture (below). Both renderers apply the same 65-point table, written once per space into the app's cache folder; the GPU engine decodes such footage at 10 bits.

**Grading log footage.** For footage in a color space, the color panel's primaries (exposure, temperature, tint, contrast, saturation and the shadow, midtone and highlight wheels) grade in ACEScct, on scene light, between the camera transform and the output transform, as colorists grade camera footage: exposure moves real stops, white balance acts before the tone curve, and contrast pivots on 18% gray. The rest of the panel (curves, HSL, fade, vignette and so on) and the secondaries from `grade_region` work on the finished Rec.709 picture. The GPU engine runs the grade as a shader; the FFmpeg backend applies the same math as a table.

**Precision.** Strong grades of log footage can show steps in 8-bit video. Exports of such footage are dithered (fine grain instead of steps), and `export.bitDepth: 10` writes 10-bit video (H.264 High 10 or HEVC Main 10), which keeps smooth skies and gradients smooth through heavy grades. DJI D-Log M is not offered: DJI has not published its formula.

## Notes

- `exposure` works in floating point. The engine clips back to the normal range right after it, so later filters never see values brighter than white.
- Color balance runs without "preserve lightness". On bright, saturated colors that mode produced broken pixels when combined with other controls.
