# The project document

An edit is one JSON document, a `Project`. It is validated by the zod schema in [src/core/schema.ts](../../src/core/schema.ts). `parseProject(json)` fills in defaults, and `projectJsonSchema()` returns the JSON Schema.

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
| `fit` | `cover` | `cover` crops, `contain` letterboxes, `stretch` distorts, `blur` letterboxes over a blurred copy (good for landscape footage in vertical video) |
| `effects` | `[]` | See [effects](../reference/effects.md) |
| `transition` | | Blend in from the previous clip. See [transitions](../reference/transitions.md) |
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
| `volume` | `0` | Overlays are muted by default |
| `effects` | `[]` | |

**`text`**

| Field | Default | |
|---|---|---|
| `text` | | `\n` for line breaks |
| `position` | center | With `align: "left"`/`"right"`, `x` is the left or right edge |
| `style.fontFamily` | `Arial` | Any installed font, or one from `fontsDir` |
| `style.fontSize` | `64` | Pixels at the output resolution |
| `style.color`, `outlineColor`, `outlineWidth`, `shadow`, `shadowColor` | white / black / 3 / 0 | |
| `style.background` | | Draws an opaque box behind the text |
| `style.bold`, `italic`, `uppercase`, `align`, `letterSpacing` | | |

**`shape`**: `shape: "rect"`, `size: { width, height }`, `color`, `opacity`.

## Audio

| Field | Default | |
|---|---|---|
| `assetId` | | An audio or video asset |
| `role` | `music` | `music`, `voiceover` or `sfx` |
| `start`, `in`, `duration` | `0`, `0`, rest of source | |
| `volume`, `fadeIn`, `fadeOut` | `1`, `0`, `0` | |
| `loop` | `false` | Repeats to the end of the video |
| `duck` | `true` for music | Lowers music while voice audio plays (sidechain compression) |

The final mix is: clip audio, voice-overs and media-layer audio, then ducked music, then un-ducked music and SFX, then a limiter.

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
