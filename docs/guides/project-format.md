# The project document

An edit is one JSON document, a `Project`. It is validated by the zod schema in [engine/core/schema.ts](../../engine/core/schema.ts). `parseProject(json)` fills in defaults, and `projectJsonSchema()` returns the JSON Schema.

**Conventions**

- Times are in seconds.
- `x`, `y` and sizes are fractions of the frame: `x: 0` is the left edge, `y: 1` is the bottom, and positions are centers.
- Colors are `#RRGGBB` or `#RRGGBBAA`.
- Relative `src` paths resolve against `baseDir`: the project file's folder in the CLI, the session's `baseDir` in code, or the current directory.

```jsonc
{
  "version": 1,
  "name": "My video",
  "settings": { "width": 1080, "height": 1920, "fps": 30, "backgroundColor": "#000000" },
  "assets": [],
  "clips": [],
  "layers": [],
  "audio": [],
  "effects": [],
  "audioEffects": [],
  "captions": { "style": "bold-pop" },
  "transcripts": {},
  "export": { "videoCodec": "libx264", "crf": 20, "preset": "medium", "audioCodec": "aac", "audioBitrate": "192k" },
  "metadata": {}
}
```

## Assets

The media an edit uses. Clips, layers and audio refer to assets by `id`.

| type | Fields | Notes |
|---|---|---|
| `video` | `src`, `duration?`, `width?`, `height?`, `hasAudio?` | Missing metadata is probed before a render |
| `audio` | `src`, `duration?` | |
| `image` | `src`, `width?`, `height?` | Needs a `duration` wherever it is used |
| `color` | `color` | Solid background |
| `gradient` | `colors` (2-8), `direction` (`vertical`/`horizontal`/`diagonal`) | |

## Clips: the primary track

`clips` play back-to-back in array order. They set the length of the video.

| Field | Default | Meaning |
|---|---|---|
| `assetId` | | Source asset |
| `in` | `0` | Start offset into the source |
| `duration` | rest of source | Source seconds used. Required for images, colors and gradients |
| `speed` | `1` | 0.25-4. The timeline length is `duration / speed`. Audio is pitch-preserved |
| `volume`, `muted` | `1`, `false` | |
| `audioEffects` | `[]` | See [audio effects](../reference/audio-effects.md) |
| `fit` | `cover` | `cover` crops, `contain` letterboxes, `stretch` distorts, `blur` letterboxes over a blurred copy (good for landscape footage in vertical video) |
| `effects` | `[]` | See [effects](../reference/effects.md) |
| `transition` | | Blend in from the previous clip: `{ type, duration, origin? }`, where `origin` sets where shape transitions such as `circlereveal` start. See [transitions](../reference/transitions.md) |
| `fadeIn`, `fadeOut` | | Fade from or to black, with audio |

**Timing with transitions.** A transition of length *d* overlaps a clip with the one before it by *d*, so the video gets *d* seconds shorter. If clip A is 4s and clip B is 3s with a 1s fade, A runs 0-4, B runs 3-6, and the total is 6s. Transitions are clamped so they never exceed the shorter neighbor. `computeTimeline(project)` returns the exact timeline position of every clip.

## Layers

Layers are drawn on top of the primary track in array order (later entries are on top). Text and shapes always draw above media layers. Every layer has `id`, `start`, `duration`, and optional `animationIn` and `animationOut` (see [animations](../reference/animations.md)).

**`media`**: picture-in-picture, b-roll, logos.

| Field | Default | |
|---|---|---|
| `assetId`, `in` | `0` | |
| `position` | center | |
| `size` | `{ width: 1 }` | `width` is a fraction of the frame width. Add `height` to fill a box using `fit`. Without `height`, the source aspect ratio is kept |
| `opacity` | `1` | |
| `blend` | `"normal"` | How the layer mixes with the picture under it: `screen`, `add`, `multiply`, `overlay`, `softlight`, `lighten`, `darken`, `colordodge`, `difference`. `screen` and `add` make black disappear (fire, sparks, light leaks shot on black). The blend runs in RGB inside the layer's area and alpha only; pixels outside the layer are unchanged |
| `cornerRadius`, `shadow` | `0`, `0` | Rounded corners and a soft drop shadow, in output pixels (phone screens, screenshots, picture-in-picture) |
| `volume` | `0` | Overlays are muted by default |
| `effects`, `audioEffects` | `[]` | |

**`text`**

| Field | Default | |
|---|---|---|
| `text` | | `\n` for line breaks |
| `position` | center | With `align: "left"`/`"right"`, `x` is the left or right edge |
| `style.fontFamily` | `Arimo` | A bundled font (the same on every system), any installed font, or one from `fontsDir` |
| `style.fontSize` | `64` | Pixels at the output resolution |
| `style.color`, `outlineColor`, `outlineWidth`, `shadow`, `shadowColor` | white / black / 3 / 0 | |
| `style.background` | | Draws an opaque box behind the text |
| `style.bold`, `italic`, `uppercase`, `align`, `letterSpacing` | | |

**`shape`**: `shape` (`rect`, `roundedRect` or `ellipse`), `size: { width, height }`, `color`, `opacity`, `radius` (corner radius in pixels), `fill` (`false` draws only the outline), `strokeWidth`, `strokeColor`, `shadow` (pixels).

### Keyframes

Any layer can change over time with `keyframes`. Each property is a list of `{ time, value, easing }`, where `time` counts seconds from the layer's start, so the keyframes move with the layer. `easing` (`linear`, `ease-in`, `ease-out`, `ease-in-out`, the default) shapes the move into that keyframe from the previous one. Before the first keyframe a property holds its first value, and after the last its last.

| Property | Value | |
|---|---|---|
| `position` | `{ x, y }` | Replaces `position` while set |
| `scale` | number | Multiplies the layer's size (text: its font size) |
| `rotation` | degrees | Clockwise |
| `opacity` | 0..1 | Multiplies the layer's opacity |

```json
{ "type": "text", "id": "label", "text": "NEW", "start": 2, "duration": 3,
  "keyframes": {
    "position": [{ "time": 0, "value": { "x": 0.2, "y": 0.3 } }, { "time": 2, "value": { "x": 0.7, "y": 0.3 } }],
    "scale": [{ "time": 0, "value": 0.8 }, { "time": 0.5, "value": 1, "easing": "ease-out" }]
  } }
```

Entrance and exit animations still play, where the layer is at those moments. Text and shapes are drawn by libass, which can only move in a straight line within one subtitle event, so a keyframed text or shape layer is written as one short event per frame. Media overlays use FFmpeg expressions: overlay position, `rotate`, `geq` for opacity, and a per-frame `scale`.

Clips take `keyframes.focus`, the crop focus over time for `fit: "cover"`, so a 9:16 crop of 16:9 footage can pan with a person (times from the clip's start on the timeline). `reframe` with `follow` makes these from the detected face.

**Speed ramps.** `keyframes.speed` on a video clip changes its speed over time (fast, then slow motion, then back), replacing `speed` while set. Its times are seconds of **footage** from the clip's in point, because timeline time itself depends on the speed. The timeline length is the integral of 1/speed over the footage, tabulated every 10 ms (`speedMap`); `sourceToTimeline` and `timelineToSource` go through it, so captions, cuts, splits, beat sync and face tracking follow the ramp. The picture is retimed with a `setpts` expression and the sound with a tempo that changes every 0.1 s (pitch kept): `rubberband` when the FFmpeg build has it, otherwise `atempo`, which comes out about 2% short over a strong ramp. Splitting a ramped clip slices its keyframes so it plays the same.

```json
{ "id": "jump", "assetId": "skate", "in": 12, "duration": 4,
  "keyframes": { "speed": [{ "time": 0, "value": 2 }, { "time": 1.5, "value": 2 }, { "time": 2, "value": 0.4 }, { "time": 3, "value": 0.4 }, { "time": 3.4, "value": 1 }] } }
```

**Effect settings over time.** Any effect takes `keyframes: [{ time, params, easing }]`: each keyframe sets some of its settings at a time from the start of the clip or layer (timeline seconds for global effects). The renderer runs one copy of the effect per state, adding in-between states where numbers change (six copies at most, so a blur ramps through real amounts), and blends one into the next with tiny time-varying masks. A ramped effect depends on time, so the render cache does not bake it into cached clips as a global effect.

```json
{ "type": "blur", "params": { "amount": 0 }, "keyframes": [{ "time": 3, "params": { "amount": 0 } }, { "time": 4, "params": { "amount": 30 }, "easing": "ease-in" }] }
```

**Effects on part of the frame.** Any effect takes a `mask`, and then runs only where the mask selects; `label` names it (secondary color corrections made with `grade_region` are `color` effects with a mask and a label). The matte is cut from the picture as it reaches the effect.

| `kind` | Selects |
|---|---|
| `key` | An HSL qualifier: `hue` range in degrees (clockwise, so `[340, 20]` is reds), `saturation` and `luma` ranges in 0..1, with `softness` |
| `luma` | A brightness range only, e.g. `[0.7, 1]` for highlights |
| `shape` | A fixed `ellipse` or `rect` (`shape: { type, x, y, width, height }` in frame fractions) |
| `face` | Soft ellipses following every face (primary video clips only) |
| `person` | The person's cutout (primary video clips only) |
| `object` | A tracked object from `project.objects`, by `object: "<id>"` (primary clips of its video only; see [objects](objects.md)) |

Every mask also takes `invert`, `feather` (edge softness as a fraction of frame height, default 0.01), `grow` (+ grows, - shrinks, fraction of frame height), `smooth` (average the matte over this many frames), `denoise` (median on key and luma mattes) and `combine`: more masks merged in order with `op` `add`, `intersect` or `subtract`.

```json
{ "type": "color", "label": "deeper sky", "params": { "saturation": 15, "temperature": -10 },
  "mask": { "kind": "key", "hue": [190, 240], "saturation": [0.15, 1], "combine": [{ "kind": "shape", "op": "intersect", "shape": { "type": "rect", "x": 0.5, "y": 0.25, "width": 1, "height": 0.5 } }] } }
```

Key and luma mattes are a per-pixel function of color, so they are baked into a lookup table once and applied at full size each frame. A mask with `smooth` depends on time, so the render cache does not bake it into cached clips as a global effect.

## Audio

| Field | Default | |
|---|---|---|
| `assetId` | | An audio or video asset |
| `role` | `music` | `music`, `voiceover` or `sfx` |
| `start`, `in`, `duration` | `0`, `0`, rest of source | `duration` is in timeline seconds |
| `speed` | `1` | 0.25-4, pitch-preserved. Without a `duration`, the clip lasts `(source length - in) / speed` |
| `volume`, `fadeIn`, `fadeOut` | `1`, `0`, `0` | |
| `audioEffects` | `[]` | See [audio effects](../reference/audio-effects.md) |
| `loop` | `false` | Repeats to the end of the video |
| `duck` | `true` for music | Lowers music while voice audio plays (sidechain compression) |

Each source runs speed, then its `audioEffects`, then volume and fades. The final mix is: clip audio, voice-overs and media-layer audio, then ducked music, then un-ducked music and SFX, then the top-level `audioEffects` (the master chain), then a limiter.

## Transcripts and captions

`transcripts` maps asset ids to word-timed transcripts in source time:

```json
"transcripts": { "talk": { "words": [{ "text": "Hello", "start": 3.1, "end": 3.4 }] } }
```

`captions` turns subtitles on:

```json
"captions": { "enabled": true, "style": "karaoke", "overrides": { "position": 0.8 } }
```

At render time, captions are rebuilt by mapping each clip's transcript words through its trim, speed and position. This is why captions stay correct after any edit. Words from muted clips are skipped. Voice-over audio clips with transcripts are captioned too. To caption without transcripts, set `captions.segments` to `[{ text, start, end }]` in timeline time. See [Transcripts & captions](transcripts-and-captions.md).

## Global effects

`effects` at the top level apply to the whole composed primary track, before overlays and text. Use them for color grades, letterbox and grain.

## Validation

`validateProject(json)` returns `{ ok, issues }`. It checks:

- schema errors
- duplicate ids and unknown references
- clips that run past the end of their source
- unknown effects, transitions, animations and caption styles
- invalid effect parameters
- layers outside the video
- transitions that get clamped
- captions enabled with no transcript

Errors block rendering; warnings are advisory.
