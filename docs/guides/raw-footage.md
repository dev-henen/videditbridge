# Editing raw footage

Tools for turning an unedited recording into a finished edit: find where people talk and where it is quiet, cut the dead air, split at shot changes, then add energy with effects at chosen moments, edits on the music's beat and sound effects. None of it needs a transcript or a speech service. Everything runs on FFmpeg and plain TypeScript.

## The sound map

`analyze_audio` decodes a file's audio and maps it into segments:

| Kind | What it means |
|---|---|
| `speech` | Someone talking, including talking over music |
| `music` | Sustained, tonal sound without speech |
| `sound` | Anything else: noise, bangs, claps, dense mixes. Short bursts are always `sound` |
| `silence` | Below the recording's background level plus a margin |

```
Sound map of raw (source time):
Duration 43.008s. Speech 19.46s, music 8s, other sound 0.33s, silence 15.218s. Background -63.8 dB, sound starts at -51.3 dB.
00:00.0-00:02.1 silence [0-2.11s]
00:02.1-00:03.0 speech -19.5 dB [2.11-2.96s]
...
00:22.0-00:30.0 music -16 dB [22-30s]
00:31.0-00:31.3 sound -16.1 dB (unsure) [30.98-31.31s]
```

It also returns a picture for Claude to look at: the waveform with a colored band underneath (green speech, blue music, orange other sound, dark silence), red marks at loud moments and white ticks at beats.

**How it works.** Each 10 ms frame gets a level, a zero-crossing rate and a spectrum. Silence is anything that does not clear the background (the quietest 10% of the recording, and never above -40 dB) by a margin. Short pauses are bridged, so words are not split into fragments. Speech is told apart by how its level swings with every syllable around its own 200 ms average, and by its alternation of voiced and unvoiced sounds. Music is steady and tonal, and noise is steady and spectrally flat.

**Limits.** This is signal analysis, not speech recognition. It does not know what is said or who says it. Singing in a dense song often shows as `sound`, and `(unsure)` marks labels with low confidence. For words, fillers and captions, use a transcript (see [Transcripts & captions](transcripts-and-captions.md)).

Without an `assetId`, `analyze_audio` maps the current timeline: each primary clip's source range, in timeline time. That is useful after cutting, to check what is left.

## Cutting

- **`remove_silences`** cuts gaps of at least `minSilence` seconds from the primary clips and keeps `padding` around each kept part, so words are not clipped. Each kept part becomes its own clip (jump cuts). `keep: ["speech"]` also removes music and noise between phrases. Layers, music and captions shift to stay in sync, exactly as with `cut_ranges`.
- **`detect_scenes`** finds hard cuts between shots by comparing frames at low resolution, so it is fast on long files. `split: true` splits the primary clips at every change, as long as both sides would be at least half a second long. The default threshold (0.3) finds clear cuts; 0.15 to 0.2 also finds gentle ones.
- **`assemble_from_source`** builds a new primary track from chosen source ranges. Together with the sound map, it picks the best moments of a long recording.

## Moments

Timed effects take moments in seconds from the start of their clip: `zoomPunch`, `impactShake`, `flashHits` and `vibrate` take a `times` list, and `smoothZoom` and `rackFocus` take a `start`. `add_moment_effect` takes timeline times instead. It finds the clip playing at each time, converts the time, and merges it with moments already on that clip, so moments can be added one at a time:

```json
{ "type": "zoomPunch", "times": [4.2, 9.8], "params": { "amount": 0.12 } }
```

Good moments come from the sound map (loud moments, the start of a sentence), a transcript (a key word) or the beat.

## Beat sync

`detect_beats` finds the tempo and beat times of music, either on an audio clip (timeline times, following its start, trim, speed and loop) or on an asset (source times). It reports no beat for speech and ambient sound. Measured on real audio: speech scores 1.6 to 1.8 on the beat-strength ratio, a soft ambient track about 2.3, and pop music above 10. A beat counts as steady from 2.

`beat_sync` uses the beats directly:

- `action: "cuts"` moves every cut between primary clips onto the nearest beat, by lengthening or shortening the clip before it. Clips stay at least `minClip` long and never run past the end of their source.
- An effect action (`zoomPunch`, `impactShake`, `flashHits`, `vibrate`) puts that effect on the beats.
- `every: 2` or `4`, or `downbeats: true` (bar starts), calms the pacing. `start` and `end` limit it to a window, such as only the chorus.
- `sound` adds a sound effect on the same beats.

## Sound effects

`add_sound_effect` places synthesized sounds at timeline times. `align: "end"` makes the sound finish at the time (for risers). Sounds are rendered once to WAV files in the session's output folder and added as `sfx` audio clips, which are not ducked. See the [sound effects reference](../reference/sound-effects.md).

Typical pairings:

| Moment | Sound | Visual |
|---|---|---|
| Transition or fast cut | `whoosh` (start 0.3 s before the cut), `swoosh` | `zoomBlur`, a slide or zoom transition |
| Big reveal or title | `riser` ending on the reveal, then `impact` | `flashHits`, `impactShake`, `smoothZoom` |
| Key word or punchline | `hit` | `zoomPunch` |
| Text or sticker appears | `pop`, `click` | a `pop` animation |
| Tension | `heartbeat` | `heartbeat`, `vignette` |

## Visual effects for raw footage

The effects catalog has looks that suit raw footage, all with defaults that work out of the box:

- **Lens:** `bokeh` (lights become soft discs, optionally around a sharp subject), `rackFocus`, `zoomBlur`, `motionBlur`.
- **Light:** `glow`, `bokehLights` (floating orbs), `lightLeak`, `flashHits`, `strobe`.
- **Camera:** `smoothZoom` (push in, crash zoom, pull out), `zoomPunch`, `heartbeat`, `handheld`, `vibrate`, `earthquake`, `impactShake`, `tilt`.
- **Style:** `trails`, `vhs`.

Use them where they mean something: a push-in while someone makes their point, a punch on the beat drop, handheld on footage shot from a tripod. Every effect is listed in the [effects reference](../reference/effects.md).
