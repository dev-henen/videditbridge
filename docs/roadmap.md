# Roadmap: suggested improvements

As of 2026-10-25. These come from editing real projects end to end with the current tools (a cinematic reel from a selfie clip, and a narrated tech-tips video from stock footage). Each item is something that had to be done by hand, guessed, or checked by eye.

The biggest gap is that the editor does not know where people and objects are in the frame. Adding local face and person detection would improve retouching, background blur, reframing, graphics placement and quality checks at once.

## Priorities

| # | Item | Why it matters | Size |
|---|---|---|---|
| 1 | [Subject and face detection](#1-subject-and-face-detection) | Positions are guessed today; five features depend on it | Done |
| 2 | [Keyframes](#2-keyframes) | Nothing can move or change over time except preset animations | Done |
| 3 | [Automatic quality check](#3-automatic-quality-check-review_edit) | Every problem so far was caught by looking at frames | Done (text over faces came with #1) |
| 4 | [Faster rendering](#4-faster-rendering) | A 62 s video takes several minutes, and every change re-renders all of it | Done, except parallel chunks (not worth it on most machines) |
| 5 | [An AI-first desktop app](#5-an-ai-first-desktop-app) | People can only type; they cannot point at things or pick between options | Done |


## 1. Subject and face detection

Add a local face and person detector, plus person cutout (segmentation), run like the local transcription and voice: an open model, downloaded once, no account or key.

Today these positions are guessed from frames:

- the face region for skin retouch (`beauty`)
- the subject ellipse for background blur (`backgroundBlur`, `bokeh`)
- where titles and feature callouts go
- whether text covers a face (two titles in the earphone video did, and had to be moved)

| Feature | Today | With detection |
|---|---|---|
| Skin retouch | Whole frame, or a hand-placed face ellipse | Faces only, following them |
| Background blur | A fixed ellipse; the subject can leave it | A real cutout; the background blurs or is replaced |
| Reframing 16:9 to 9:16 | A fixed crop point per clip (`focus`) | The crop follows the person |
| Text and callouts | Placed by eye | Placed in empty space, never over a face |
| Tracking | Not possible | Graphics follow a moving object (with keyframes, #2) |

Open question: which model is fast and accurate enough on a laptop CPU. Compare two or three before building.

**Status** (2026-10-26): face detection and tracking are done with YuNet, chosen over UltraFace and YOLOS-tiny (see [Faces & reframing](guides/faces.md)). `detect_faces`, `reframe`, `retouch` with `"face"`, and the text-over-face check in `review_edit` use it. The person cutout is done too, with PP-HumanSeg chosen over MediaPipe and MODNet: `backgroundBlur` with `cutout` and the new `backgroundReplace` follow the person's outline on every frame. **Done** (2026-10-27): the crop follows the person with `reframe` `follow` (keyframes, #2), and `retouch` with `region: "faces"` retouches only the faces, following every face frame by frame through a face mask video (see [Face masks](guides/faces.md#face-masks)).

## 2. Keyframes

Layers and effects are fixed for their whole duration, apart from entrance and exit animations. Add keyframes, with easing, for:

- layer position, scale, rotation and opacity (a label that slides with a product)
- effect settings (a blur that ramps up, a grade that shifts)
- clip speed (speed ramps: fast, then slow motion)

With tracking data from #1, keyframes can be generated so graphics follow an object.

**Status** (2026-10-26): layer keyframes (position, scale, rotation, opacity, with easing) and crop keyframes are done, with `animate_layer`, `follow_face` (a label that follows a person) and `reframe` `follow` (a crop that pans with them). See [Keyframes](guides/project-format.md#keyframes). Effect settings over time (`animate_effect`) and speed ramps (`speed_ramp`, with sound kept in pitch and captions, cuts and tracking following the ramp) are done too.

## 3. Automatic quality check (`review_edit`)

A read-only tool that renders sample frames and audio and reports problems with timeline times:

- text that is hard to read against what is behind it
- text or graphics over a face (needs #1)
- content inside platform safe zones (Reels and TikTok cover the bottom and right side)
- black, frozen or repeated frames
- words cut off at an edit, and captions out of sync with speech
- loudness away from the target, clipping, music too loud under the voice
- a green-screen key that left green behind

Each of these was a real problem in this session, found only by looking: an unreadable title, a gray keyed screen, clipped words, doubled caption words, a render at -24.9 LUFS.

**Status: done** (2026-10-26). `review_edit` covers every item above, including text over a face (added with #1). It also reports text that runs off the frame or collides with captions, repeated footage, and speech the transcript skipped. See [Reviewing an edit](guides/rendering-and-preview.md#reviewing-an-edit).

## 4. Faster rendering

The whole project is rendered as one FFmpeg graph every time. Improvements, in order of payoff:

1. **Segment cache.** Render each clip with its effects once and reuse it until that clip changes. **Done** (2026-10-26): a re-render of an unchanged edit is about 5 times faster. See [Render cache](guides/rendering-and-preview.md#render-cache).
2. **Proxy media.** Use small copies of the source footage for previews and frames. **Done** (2026-10-27): videos over 1920 px get a 1280 px proxy in the cache folder, made in the background, and previews, frames and contact sheets read it (final renders never do). A preview frame of 4K footage went from 2.8 s to 0.64 s.
3. **Hardware encoding.** Use the graphics card's encoder (NVENC, Quick Sync, AMF) when one is present. **Done**: about 3.6 times faster encoding with Quick Sync.
4. **Parallel chunks.** Split long exports into pieces rendered at the same time, then join them. Measured first: on a 2-core laptop, rendering three clips at once was only 1.2 times faster than one after another, because FFmpeg's filters already use every core. Worth it only on machines with many cores. **Not done**: a range render processes everything before its start, so chunks would need input seeking with every timed effect shifted, a large change for little gain here.

Found on the way: the fps filter rounded every clip up a frame, so on a long edit the cuts drifted a few frames from captions, overlays and sound. Clips now get exactly their frames.

Cold renders: **done** (2026-10-27). Zooms (Ken Burns and the other zoom effects) now run through `perspective`, which samples between pixels, instead of `zoompan` on a 2x upscale: 22.5 to 15.9 ms per 1080p frame at the same quality. Heavy chains of per-pixel color filters are baked into one lookup table (`haldclut`), which costs a flat 28 ms instead of, for example, 42 ms for `colorbalance` plus `vibrance`.

## 5. An AI-first desktop app

The app is for people who edit by asking Claude, not a manual editor: it does not try to be CapCut or Premiere, so it gets no drag-and-trim timeline or panels of sliders. What it needs is ways to talk about the video without describing everything in words:

- **Point at things.** Pick a clip, layer or sound on the timeline, and the next request is about it ("slow this down", "move this title off her face"). **Done** (2026-10-26): a blue chip by the request box shows what is picked.
- **Point at a spot in the frame.** Click the viewer to say "here" (where a title goes, which person to follow). **Done**: a blue marker shows the spot and a pill above the request box says it is included.
- **Choose between options.** When Claude offers choices (voices from `preview_voice`, music, a few title styles), show them as cards that play or preview, and send the pick back. **Done**: `offer_choices` puts them on cards in the Claude tab, with play buttons for audio and thumbnails for images.
- **Fix what the review finds.** Show `review_edit` problems in the app, each with a button that asks Claude to fix it. **Done**: the Review tab lists them with their times (and the project validation problems that used to have their own tab); clicking one goes there, and Fix asks Claude.

Everything still goes through the same tools, so all changes share one undo history.

## Smaller tools to add

| Tool | What it does | Why |
|---|---|---|
| `fix_transcript` (done) | Find and replace words ("cloud" to "Claude"), plus a vocabulary hint for names | Names were fixed by editing word positions by hand |
| `match_color` (done) | Match one shot's color to a reference shot | Shots were matched by measuring and guessing per shot |
| J and L cuts (done) | Audio starts before, or runs past, a picture cut | Standard for talking-head edits; not possible now |
| Stabilize, denoise, freeze, reverse (done) | Basic footage repair and speed tricks | Common needs with phone footage |
| `make_thumbnail` (done) | A still with a big title, for YouTube | The sample videos all need one |
| Icon library and font management (done) | Feature icons; fonts beyond those installed on Windows | The samples use icons; text is limited to system fonts |
| Script markup for narration (done) | `[pause]` and emphasis in the text given to `generate_voiceover` | Pacing can only be changed by rewriting sentences |
| More voice languages (done) | The non-English Kokoro voices | Only English voices are listed |
| Media cleanup (done) | Remove unused assets and duplicate files in `media/` | Duplicate imports needed manual cleanup |

**Status of the done tools** (2026-10-26):

- `match_color` measures red, green and blue levels of both shots and adds a `curves` effect at the end of each target clip. On a darkened, warmed copy of a shot, it brought the channel difference from 8 to 13% down to under 1%.
- `split_edit` makes J cuts (`audioLead` on a clip) and L cuts (`audioTail`). The neighbor's sound is muted under the overlap with a 30 ms crossfade, and captions follow the sound. Checked with two tones: the overlap carries only the incoming clip's tone.
- New effects `stabilize` (FFmpeg `deshake` plus a small zoom, since this FFmpeg build has no vidstab) and `denoise` (video; the audio `denoise` already existed). A clip field `reverse` plays a clip backwards, and the `freeze_frame` tool holds a frame for some seconds, keeping the clip's look.
- `make_thumbnail` renders a 1280x720 JPEG from a frame of the edit (without its own titles and captions), with punchier color and a big wrapped title on the side away from any faces.
- Narration markup: `[pause]`, `[pause 1.5]`, `[breath]`, `[slow]...[/slow]`, `[fast]...[/fast]` and `*word*`. A 1.5 s pause measured 1.59 s between the words, against 0.52 s without it.
- Voices in Spanish, French, Hindi, Italian and Brazilian Portuguese: the Spanish, French, Italian and Portuguese samples came back word for word through Whisper. They need the optional `espeak-ng` package, which is GPL-3.0, so it is not a dependency of this MIT library (`npm install espeak-ng` enables them). Japanese and Chinese voices need a different phonemizer and are not included.
- Icons: `search_icons` and `add_icon` use the Lucide icon font (about 1,600 line icons, ISC license), downloaded once into the fonts folder. Icons draw like text (sharp at any size, any color, the usual animations), optionally on a round or rounded badge, and a misspelled name gets close suggestions.
- Fonts: `install_font` adds a Google Fonts family (open licensed) as TTF files to a fonts folder (`~/.cache/ai-video-editor/fonts`, or the session's `fontsDir`) that every render, preview and app frame now uses. `list_fonts` lists the system's families and the added ones, read from the font files themselves.
- `clean_up_media` merges assets that are the same file content and removes unused ones (`deleteFiles` also deletes unused files in `media/`). Importing a file whose content is already in `media/` reuses that copy, and `import_media` does not add the same file twice.

## Improvements to what exists

- **Templates.** Done (2026-10-26): templates now declare `automation` that `apply_template` runs. 27 of the 33 use it (the rest are single text cards or have nothing to automate): talking-footage templates transcribe and remove retakes, fillers and pauses; essays, slide lessons, list videos, recipes and property tours narrate each item with the local voice and fit the scene to the line; montages cut on the beat; moving transitions get their sound. Video essays open each chapter with a section card. See [Templates](guides/templates.md#automation).
- **Saving.** Done (2026-10-26): the app saves right after every change (there was a 300 ms wait). Each save is flushed to disk under a unique temporary name before it replaces `project.json`, saves to one project run in order, the previous save is kept as `project.json.bak`, and opening a damaged project falls back to it. The host also waits for pending saves before it exits.
- **Sound map.** Done (2026-10-27): a local sound model (CED-tiny, chosen over YAMNet and AST) labels speech, music and "music with vocals", and names other sounds ("sound (siren)"). The hand-tuned rules remain as the fallback. See [Sound maps](guides/raw-footage.md).
- **Speech recognition.** Done (2026-10-27): the skipped sections came from the pipeline merging 30 s windows. Audio is now cut in its pauses and leveled before recognition, and English uses `whisper-base.en`. On a test with quiet speech and speech over music, word errors fell from 45 to 69% to 1.9%.
- **Version control.** Done: the recent work is committed.

## Next: cinematic grading and CGI effects

The plan for movie-level color grading (log footage, secondary corrections, film looks, scene matching) and common CGI effects (blend modes, any-object masks and tracking, sky and screen replacement, atmospherics, depth, object removal, smooth slow motion), including a GPU render engine with OpenColorIO and ACES, is in [Cinematic grading and CGI effects](design/cinematic-grade-and-vfx.md).

## Suggested order

1. Commit the current work. (Done.)
2. `review_edit` and `fix_transcript`: small, and they improve every edit right away. (Done.)
3. Faster rendering (segment cache first): every later step is tested by rendering. (Segment cache and hardware encoding done.)
4. Subject and face detection. (Done.)
5. Keyframes, then tracking on top of detection. (Done.)
6. The AI-first desktop app: pointing at things and spots, fixing review findings, choosing between Claude's options. (Done.)
7. Templates updated to use everything above. (Done.)
