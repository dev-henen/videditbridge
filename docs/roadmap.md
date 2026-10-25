# Roadmap: suggested improvements

As of 2026-10-25. These come from editing real projects end to end with the current tools (a cinematic reel from a selfie clip, and a narrated tech-tips video from stock footage). Each item is something that had to be done by hand, guessed, or checked by eye.

The biggest gap is that the editor does not know where people and objects are in the frame. Adding local face and person detection would improve retouching, background blur, reframing, graphics placement and quality checks at once.

## Priorities

| # | Item | Why it matters | Size |
|---|---|---|---|
| 1 | [Subject and face detection](#1-subject-and-face-detection) | Positions are guessed today; five features depend on it | Large |
| 2 | [Keyframes](#2-keyframes) | Nothing can move or change over time except preset animations | Large |
| 3 | [Automatic quality check](#3-automatic-quality-check-review_edit) | Every problem so far was caught by looking at frames | Medium |
| 4 | [Faster rendering](#4-faster-rendering) | A 62 s video takes about 4.5 minutes, and every change re-renders all of it | Medium |
| 5 | [Direct editing in the desktop app](#5-direct-editing-in-the-desktop-app) | The app is a chat box and a preview; nothing can be dragged or adjusted | Large |

For a quick first win, start with #3: it catches what a viewer notices first.

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

## 2. Keyframes

Layers and effects are fixed for their whole duration, apart from entrance and exit animations. Add keyframes, with easing, for:

- layer position, scale, rotation and opacity (a label that slides with a product)
- effect settings (a blur that ramps up, a grade that shifts)
- clip speed (speed ramps: fast, then slow motion)

With tracking data from #1, keyframes can be generated so graphics follow an object.

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

## 4. Faster rendering

The whole project is rendered as one FFmpeg graph every time. Improvements, in order of payoff:

1. **Segment cache.** Render each clip with its effects once and reuse it until that clip changes.
2. **Proxy media.** Use small copies of the source footage for previews and frames.
3. **Hardware encoding.** Use the graphics card's encoder (NVENC, Quick Sync, AMF) when one is present.
4. **Parallel chunks.** Split long exports into pieces rendered at the same time, then join them.

## 5. Direct editing in the desktop app

The app is a chat box plus a preview. Add:

- a timeline where clips, layers and audio can be dragged, trimmed and reordered
- a voice picker that plays the previews from `preview_voice`
- panels with sliders for color (`color_adjust`) and effect settings
- a list of sound effects and transitions to audition

Everything still goes through the same tools, so Claude and manual edits share undo history.

## Smaller tools to add

| Tool | What it does | Why |
|---|---|---|
| `fix_transcript` | Find and replace words ("cloud" to "Claude"), plus a vocabulary hint for names | Names were fixed by editing word positions by hand |
| `match_color` | Match one shot's color to a reference shot | Shots were matched by measuring and guessing per shot |
| J and L cuts | Audio starts before, or runs past, a picture cut | Standard for talking-head edits; not possible now |
| Stabilize, denoise, freeze, reverse | Basic footage repair and speed tricks | Common needs with phone footage |
| `make_thumbnail` | A still with a big title, for YouTube | The sample videos all need one |
| Icon library and font management | Feature icons; fonts beyond those installed on Windows | The samples use icons; text is limited to system fonts |
| Script markup for narration | `[pause]` and emphasis in the text given to `generate_voiceover` | Pacing can only be changed by rewriting sentences |
| More voice languages | The non-English Kokoro voices | Only English voices are listed |
| Media cleanup | Remove unused assets and duplicate files in `media/` | Duplicate imports needed manual cleanup |

## Improvements to what exists

- **Templates.** None of the 33 templates use the newer pieces yet: section cards, sound effects tied to transitions, local narration, retake removal, beat sync.
- **Saving.** A crash lost an import before autosave ran. Save right after each change, and write the file in a way that a crash cannot leave it half written.
- **Sound map.** Sung vocals come out as "sound (unsure)". A small local speech, music and singing classifier would beat the current hand-tuned rules.
- **Speech recognition.** The base Whisper model mishears names and skips some quiet speech; the larger model skipped a whole section in testing. Worth comparing other local models.
- **Version control.** A large amount of recent work is uncommitted. Commit it in logical pieces.

## Suggested order

1. Commit the current work.
2. `review_edit` and `fix_transcript`: small, and they improve every edit right away.
3. Faster rendering (segment cache first): every later step is tested by rendering.
4. Subject and face detection.
5. Keyframes, then tracking on top of detection.
6. Direct editing in the desktop app.
7. Templates updated to use everything above.
