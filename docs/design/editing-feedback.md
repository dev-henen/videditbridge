# Editing feedback: what a real edit asked for

Improvements found while making a 50 second Instagram dance video in the app (11 screen recordings of game footage, a song as the soundtrack, cut on the beat, then camera moves, effects, titles and a grade). Each item is something that cost time, gave a wrong result, or had to be done outside the tools. They are ordered by impact; the checklist is the done/left record.

## 1. Checklist

- [x] 1. **Renders fail loudly** (2.1): the glow crash fixed (`glowKeep` thresholds with `lutrgb`, the same picture within a level on real footage; test in `film.integration.test.ts`); a crashed ffmpeg is named as a crash (`ffmpegFailure`), and `render` then renders the clips and layers with effects alone to name the one it crashes in (`blameCrash`).
- [x] 2. **Render health check** (2.2): `checkRender` (`engine/tools/render/health.ts`) reads every `render_video` and `render_preview` back and reports frozen stretches, black stretches and a wrong length; a preview with problems is not kept as up to date; `review_edit` also reads the last exported video of the edit as it is.
- [x] 3. **Range previews build only the range** (2.3): `forRange` (`engine/tools/render/range.ts`) stands in black for clips before the range and leaves out what is after it, with every time where it was.
- [x] 4. **Invalid edits are rejected** (2.4): `commit` refuses an edit that adds project errors and leaves the project unchanged.
- [x] 5. **One convention for effect params** (2.5): easing was already one vocabulary; `list_effects` and `list_audio_effects` now show each param's range or choices and its default (`paramText`). Rescaling `glow`'s 0..100 threshold is left out: it would change saved projects.
- [x] 6. **`look_at_media`** (3.1): a grid of a source file (or a part) with source times on each frame, and motion per second (`engine/tools/render/look.ts`).
- [x] 7. **Body-aware framing** (3.2): where `reframe` finds no face, it frames on the person cutout model's main subject (`engine/tools/vision/people.ts`): the largest whole region toward the middle, only when the model is sure (median 0.95; real people measured 0.95 to 0.99, cars, buildings and stones 0.67 to 0.93). Faces still come first, so footage of real people frames as before. `certainty` lowers the bar for game and cartoon characters (the dance video's avatars measured 0.69 to 0.81). Left: on a game shot where the model joined a car and a dancer lying next to it into one region, the crop goes to the car.
- [x] 8. **`analyze_music`** (3.3): level per bar, sections in 4-bar phrases, the drop (the first jump into the loudest phrases), and the best window of a given length (`engine/tools/audio/structure.ts`). On the dance video's song it picks the window chosen by hand (33.52 s to 83.17 s, the drop 11.03 s in).
- [x] 9. **`assemble_to_music`** (3.4): a shot list in bars or beats laid on the song's beat grid in one undo step (`placeOnBeats`), the song as long as the shots, the shots muted; footage that runs out is refused.
- [x] 10. **Edits on many clips** (3.5): `update_clips` (a patch per clip, or one for several or all) and `add_effect` with `targets` or `'all-clips'`, keeping the effects there.
- [x] 11. **Beat-safe transitions** (3.6): `set_transition` `keepTiming` and transitions on `assemble_to_music` shots grow both clips by half the transition into their footage, so the transition centers on the cut and every cut stays (`keepCutTiming`).
- [x] 12. **Title presets and beat text** (3.7): six title styles (`engine/library/title-styles`, `docs/reference/title-styles.md`) for `add_text` `preset`, and `add_beat_text` for words on the beats.
- [x] 13. **Claude Code over MCP** (3.8): `docs/guides/mcp.md`, Editing from Claude Code: the command and the order of tools for a music video. The agent's prompt (`engine/host/agent.ts`) points at the new tools.

## 2. Correctness

### 2.1 Renders fail loudly

What happened: one shot combined `impactShake` with `anamorphicFlare`. At preview scale 0.5 and above, FFmpeg crashed (Windows access violation, exit code 0xC0000005). The GPU engine kept drawing the last good frame for the rest of the video and `render_video` answered "Rendered 49.65s video", so the export froze for 38 seconds without any error. Previews of the same range did fail, with an empty message.

Wanted:
- A piece that fails (non-zero exit, a crash, fewer frames than planned) fails the whole render.
- The error names the clip or layer and its effects, and keeps the last lines of FFmpeg's output. A crash with no output says it was a crash.
- The engine never repeats a frame to cover a missing one.
- The crash itself is found and fixed: the shake (a moving crop) followed by the flare (a blurred highlight pass) at sizes from 540x675 up.

### 2.2 Render health check

After every render (video, preview, piece), read the output cheaply (low resolution, every few frames) and report:
- frozen stretches: identical frames for longer than a second where the edit has motion;
- black or blank stretches the edit does not ask for;
- duration and frame count against the timeline.

The result goes in the tool's answer ("Warning: frames 11.0s to 49.6s are identical") and `review_edit` runs the same check on the last render.

### 2.3 Range previews build only the range

`render_preview` with `start`/`end` builds the full graph with every clip as an input and trims the output. That makes short previews slow and lets a problem far before the range fail it (a preview of 15.2 to 16.5 s failed because of a clip at 11 s). The graph for a range should take only the clips, layers and audio that overlap it, with their in points moved.

### 2.4 Invalid edits are rejected

`update_clip` saved effects with an unknown easing name or out-of-range values, and only mentioned it in "Problems to fix" after committing. Edit tools should validate effect params against the catalog before committing, refuse with each bad field and its allowed values, and leave the project unchanged.

### 2.5 One convention for effect params

Seen in one session: `glow` threshold is 0..100 while the looks use 0..1; `glitch` amount is 1..40, `trails` length 1..100, `zoomBlur` amount 1..100; motion easing is `ease-in-out` while other places use camelCase. Pick one easing vocabulary for every effect and animation, keep 0..1 for strengths and thresholds where possible, and show each param's range and default in `list_effects`.

## 3. Missing tools

### 3.1 `look_at_media`

Choosing shots needs seeing the sources, but `render_contact_sheet` shows the timeline only. The edit used plain FFmpeg to tile every source with timestamps. Wanted:
- `look_at_media(assetId, every?, start?, end?)`: a grid of frames with their source times, sized to read.
- A motion energy curve per asset (frame difference per second) in the same answer, to find where the dancing is strongest and where the camera holds still.

### 3.2 Body-aware framing

`reframe` points the crop at faces. Game avatars, dancers seen from behind and silhouettes have none, so every crop was set by eye from thumbnails, and one was wrong. Person or pose detection (a bundled model with a license that allows commercial use and bundling) should give the subject's box per frame, used by `reframe` for a fixed crop or a follow.

### 3.3 `analyze_music`

`detect_beats` gives tempo and beats. Finding the build-up, the drop and the chorus took a loudness measurement outside the tools. Wanted, for a music asset or audio clip:
- sections (intro, build, drop or chorus, breakdown, outro) on bar boundaries, with loudness and energy;
- the drop's time;
- `window: 50`: the best window of that length, starting and ending on phrase boundaries (4 or 8 bars), with the drop inside it.

### 3.4 `assemble_to_music`

A montage on the bar grid took 25 `add_clip` calls with durations worked out by hand, then `beat_sync` to fix rounding. Wanted:

```
assemble_to_music({
  music: "song", in: 33.52, bars: 18,
  shots: [{ assetId, in, bars: 1, focus?, effects? }, { assetId, in, beats: 2 }, ...],
  muteClips: true
})
```

It adds the music, places every shot so its cut lands on the beat grid, mutes clip sound, and checks that each shot's source range exists.

### 3.5 Edits on many clips

`update_clip` replaces the whole effects list, so keeping the punches from `beat_sync` meant reading the project file. `add_effect` exists for one clip. Wanted: `update_clips` (one patch or one per clip, in one undo step) and `add_effect` with `clipIds` or `"all-clips"`, merging into what is there.

### 3.6 Beat-safe transitions

A crossfade overlaps two clips, so the video gets shorter and every later cut moves off the beat; the edit used no transitions for that reason. Wanted: transitions that keep the timeline length (each clip extended by half the transition into its source), or `beat_sync` re-snapping cuts after transitions.

### 3.7 Title presets and beat text

Titles were styled by hand (font, outline, colored shadow). Wanted: a few named title presets (neon, glitch, bold outline), and text whose words pop in on the beats of a music clip.

### 3.8 Claude Code over MCP

The edit drove the app with `ave remote` and hand-escaped JSON, which broke on Windows paths and needs the project on every call. The repo's MCP server already does this better and is the path other AI apps use. Document using it from Claude Code for edits (`docs/guides/mcp.md`), and use it for this kind of session.
