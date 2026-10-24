# Transcripts & captions

Transcripts drive three things: **captions**, **speech search**, and **editing by transcript** (cutting fillers, pauses and tangents). Code is in [src/tools/transcript](../../src/tools/transcript) and [src/tools/captions](../../src/tools/captions).

## The transcript format

```ts
interface Transcript {
  language?: string;
  words: { text: string; start: number; end: number; confidence?: number; speaker?: string }[];
  estimated?: boolean; // word timings were interpolated (e.g. from SRT cues)
}
```

Times are in **source** seconds of the asset the transcript belongs to. Attach a transcript with `project.transcripts[assetId] = transcript` or `setTranscript(project, assetId, transcript)`.

## Getting a transcript

**Parse an existing one.** `parseTranscript(input, format?)` auto-detects the format:

| Format | Function | Notes |
|---|---|---|
| SRT | `fromSRT` | Word timings estimated within each cue |
| WebVTT | `fromVTT` | Same |
| OpenAI Whisper `verbose_json` | `fromWhisper` | Word timestamps; punctuation restored from segments. faster-whisper/whisper.cpp `segments[].words[]` also work |
| Deepgram | `fromDeepgram` | Punctuated words, speakers |
| AssemblyAI | `fromAssemblyAI` | Milliseconds converted, speakers |
| Plain text + duration | `fromPlainText` | Even spread, e.g. for a script |

**Transcribe media.**

```ts
import { transcribeMedia, OpenAITranscriber, DeepgramTranscriber } from "ai-video-editor";
const t = await transcribeMedia("talk.mp4", new OpenAITranscriber());   // extracts audio with FFmpeg first
```

To use another service, implement `TranscriptionProvider` (`transcribe(audioPath) → Transcript`).

## Analysis

| Function | Returns |
|---|---|
| `sentences(t)` | Sentences split on punctuation, speaker changes or long pauses |
| `formatTranscript(t)` | `[00:03.1–00:05.0] text` lines, compact for an AI to read |
| `searchTranscript(t, "phrase")` | Matches with times and surrounding context (case- and punctuation-insensitive) |
| `findFillers(t, list?)` | "um", "uh"… by default. `EXTENDED_FILLERS` adds "like", "you know", "basically"… |
| `findRepetitions(t)` | Stutters such as "I I think" or "we went we went" |
| `findSilences(t, { minDuration, mediaDuration })` | Gaps between words, plus leading and trailing silence |
| `transcriptStats(t)` | Words, WPM, filler count, speakers |

## Editing by transcript

```ts
import { cleanupSpeech, cutSourceRanges, assembleFromRanges, cutTimelineRanges } from "ai-video-editor";

// Tighten a talking head: fillers, stutters, pauses over 0.6s cut down to 0.2s
const { project, removed, removedDuration } = cleanupSpeech(p, "talk", {
  fillers: true, repetitions: true, maxPause: 0.6, keepPause: 0.2,
});

// Keep only chosen moments, in any order (highlight reels)
p = assembleFromRanges(p, "talk", [{ start: 42.1, end: 55.8 }, { start: 3.0, end: 9.4 }]);

// Remove ranges from the finished timeline; everything after shifts earlier
p = cutTimelineRanges(p, [{ start: 10, end: 12.5 }]);
```

`planCleanup(t, opts)` returns the ranges without applying them, so you can review them first. Filler cuts expand slightly into the surrounding silence so they don't clip neighboring words. Cuts shorter than `minCut` (0.12s) are skipped to avoid choppy edits.

Cutting splits primary clips and shifts every layer and audio clip that comes later, so overlays stay on their moments. Overlays and music that span a cut keep playing continuously and are shortened.

## Captions

Turn captions on with a style:

```ts
p = setCaptions(p, { style: "bold-pop", overrides: { highlightColor: "#00FF88", position: 0.65 } });
```

At render time, `timelineWords(project)` maps every clip's transcript words through its in-point, speed and position. Words cut out of the edit disappear, words in muted clips are skipped, and voice-over transcripts are included. `chunkWords` then groups words into on-screen phrases. A phrase breaks at sentence ends, at pauses over 0.6s, and when `maxWordsPerLine` / `maxCharsPerLine` / `maxLines` / `maxDuration` would be exceeded.

The [caption style reference](../reference/caption-styles.md) lists the presets and every field you can override. The five modes:

- **static**: the whole phrase
- **highlight**: the spoken word changes color (and scale, via `highlightScale`), the viral short-form look
- **karaoke**: color sweeps through each word as it's spoken
- **word**: one big word at a time
- **reveal**: words appear as they're spoken; the layout stays stable because unspoken words are invisible, not absent

For captions without a transcript, use manual segments in timeline time:

```ts
p = setCaptions(p, { style: "classic", segments: [{ text: "Welcome back", start: 0, end: 1.5 }] });
```

## Exporting subtitles

```ts
exportCaptions(project, "srt" | "vtt" | "ass");   // or: ave captions project.json out.srt
```

ASS export keeps the full styling and animation for players that support it.
