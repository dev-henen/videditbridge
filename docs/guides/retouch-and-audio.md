# Retouch & audio

Tools for making people look and sound good: skin retouching, portrait-style background blur, voice cleanup, audio effects, speed and volume. Everything here is stored in the project document and rendered by FFmpeg, so it stays editable and undoable.

## Retouching people

Two effects in the `retouch` category do the work. Apply them with the `retouch` tool or as ordinary effects on a clip, a media layer or `"global"`.

**`beauty`** smooths skin with an edge-preserving (bilateral) filter, so pores and blemishes soften while eyes, hair, teeth and outlines stay sharp. The smoothed image is blended back over the original, so some natural texture survives even at full strength. `brighten` lifts and evens skin tones, and `warmth` adds a healthier tone.

```json
{ "type": "beauty", "params": { "smooth": 50, "brighten": 15, "warmth": 10 } }
```

Without a `region` the whole frame is retouched. That is usually fine for talking heads, but it also softens textured backgrounds. To limit it to the face, give a `region`, an ellipse in frame fractions:

```json
{ "type": "beauty", "params": { "smooth": 60, "region": { "x": 0.5, "y": 0.35, "width": 0.3, "height": 0.4 } } }
```

**`backgroundBlur`** is portrait mode: it keeps an ellipse around the subject sharp and blurs everything else, with a feathered edge.

```json
{ "type": "backgroundBlur", "params": { "amount": 30, "subject": { "x": 0.5, "y": 0.45, "width": 0.55, "height": 0.8 }, "feather": 0.35 } }
```

With the `retouch` tool, `region: "face"` and `subject: "face"` place the ellipses for you from the faces found in each clip (see [Faces & reframing](faces.md)): the face ellipse covers everywhere the main face goes during the clip, and the subject ellipse is estimated from the face down to the shoulders and the bottom of the frame. You can also give the ellipse yourself. Either way it stays fixed for the clip, so check with `render_frame`, and split the clip if the person moves a lot. `dim` darkens the background as well, which helps text and captions stand out.

The `retouch` tool merges settings into what is already on the target, so `retouch({ target, beauty: { smooth: 30 } })` changes only the smoothing. Pass `false` to remove an effect, and `region: null` to go back to the whole frame. Target `"all-clips"` to retouch every clip at once.

## Cleaning up voice

`enhance_audio` builds a speech cleanup chain on a clip, an audio clip (such as a voice-over), a media layer, `"all-clips"` or `"master"`, in this order:

1. `dehum` (when `removeHum` is 50 or 60): notches out mains hum and its harmonics.
2. `denoise`: spectral noise reduction for steady noise such as hiss, fans and room tone.
3. `enhanceVoice`: rumble cut, less boxiness, more presence, de-essing, compression and a leveler that evens out loud and quiet words without lifting the noise in pauses.
4. `normalize` (when `normalize` is set): loudness normalization to a LUFS target.

Calling it again replaces the previous cleanup on that target and leaves other audio effects alone.

**Noise floor.** `denoise` removes noise up to its `noiseFloor` (default -35 dB). If noise is still audible, raise it toward -25. If quiet speech sounds swallowed and the noise was faint to begin with, lower it toward -50. `amount` sets how much is removed: 50 is about 20 dB.

For noise between phrases that `denoise` does not fully remove, add a `gate`. It lowers everything below its threshold, which silences pauses.

## Audio effects

Audio effects work like visual effects: an ordered list on a clip (`audioEffects`), an audio clip, a media layer, or the whole mix (`project.audioEffects`, the master). Each source runs speed, then its audio effects, then volume and fades. The master chain runs on the final mix, just before the limiter.

```json
"audioEffects": [{ "type": "denoise", "params": { "amount": 40 } }, { "type": "reverb", "params": { "room": "hall", "mix": 0.2 } }]
```

| Category | Effects |
|---|---|
| cleanup | `denoise`, `dehum`, `declick`, `rumbleCut`, `gate` |
| voice | `enhanceVoice`, `deEsser`, `pitch` (chipmunk or deep voice, speed unchanged) |
| dynamics | `compressor`, `normalize` |
| eq | `eq` (bass, mid, treble), `bassBoost`, `lowpass`, `highpass` |
| volume | `gain` (dB), `stereoWiden` |
| creative | `reverb`, `echo`, `telephone`, `radio`, `megaphone`, `underwater`, `robot`, `whisper`, `lofi`, `chorus`, `flanger`, `phaser`, `tremolo`, `vibrato` |

Every parameter is listed in the [audio effects reference](../reference/audio-effects.md). With Claude, use `list_audio_effects`, `add_audio_effect` and `remove_audio_effect`. Register your own with `registerAudioEffect`.

## Speed

`set_speed` changes a primary clip or an audio clip from 0.25 (quarter speed) to 4. Audio keeps its pitch. The clip still covers the same source range, so it gets shorter or longer on the timeline, later clips move, and captions follow. For an audio clip with an explicit `duration`, the duration is adjusted to keep the same source range.

## Volume

`set_volume` sets the level of a primary clip, an audio clip, a media layer or the whole mix (`"master"`). Give `volume` as a multiplier (1 = original, 0.5 is about -6 dB, up to 4) or `db` relative to the original. Master volume is stored as a `gain` effect in the master chain. Music is still ducked under speech automatically, and a limiter on the final mix prevents clipping.
