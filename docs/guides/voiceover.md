# Voice-over

Text-to-speech narration that comes with word timings, so voice-overs can be captioned like recorded speech. It runs on your machine: no account, no key, nothing sent anywhere. Code: [engine/tools/voiceover](../../engine/tools/voiceover).

## The local voice (default)

`LocalTTS` runs the open-weight Kokoro-82M voice model on this machine with ONNX Runtime (through the `kokoro-js` package). The model downloads once (about 90 MB) to the models folder (or `$AVE_MODELS_DIR`), then works offline. On a laptop CPU, a 7 s line took about 9 s to generate.

Long scripts are spoken sentence by sentence and joined with short breaths. Word timings come from transcribing the result with the local Whisper model, so they match the audio rather than being estimated.

```ts
const tts = new LocalTTS();
const vo = await tts.synthesize("Here are three tips…", "out/vo.wav", { voice: "af_heart", speed: 1.05 });
// vo.path, vo.duration, vo.transcript
```

## Voices

27 English voices: `af_*` / `am_*` are American female and male, `bf_*` / `bm_*` British. `VOICES` lists each with the quality grade published with the model; `RECOMMENDED_VOICES` are the ones graded C+ or better:

| Voice | Accent | Grade |
|---|---|---|
| `af_heart` (default) | American female | A |
| `af_bella` | American female | A- |
| `af_nicole` | American female | B- |
| `bf_emma` | British female | B- |
| `af_aoede`, `af_kore`, `af_sarah` | American female | C+ |
| `am_michael`, `am_fenrir`, `am_puck` | American male | C+ |

## Voice tools for Claude

| Tool | What it does |
|---|---|
| `list_voices` | The voices with accent, gender and grade (`all: true` adds the weaker ones) |
| `preview_voice` | Speaks a sample line in up to six voices and saves each as a WAV file to compare, without changing the project |
| `set_voice` | Sets the project's narration voice and speed |
| `generate_voiceover` | Speaks a script and adds it as a voice-over at a timeline time, with word timings |
| `revoice` | Re-generates narration already in the project with a new voice, speed or wording, keeping it in place (`all: true` for every narration) |

Each narration remembers its script, voice and speed in `project.metadata.narration`, which is what lets `revoice` change one of them and keep the rest.

Write narration the way people talk, in short sentences. Numbers come back from the transcriber as digits ("sixty percent" becomes "60 %"), so search for nearby words when you time graphics to a phrase.

## Adding narration to an edit

```ts
p = addAsset(p, { type: "audio", id: "vo", src: vo.path, duration: vo.duration });
p = setTranscript(p, "vo", vo.transcript);                 // captions for the narration
p = addAudio(p, { assetId: "vo", role: "voiceover", start: 0.5 });
p = setCaptions(p, { style: "karaoke" });
```

Music with `duck` (the default for music) automatically drops under the voice-over.

With Claude, the `generate_voiceover` tool does all of this in one call.

## Fitting visuals to narration

Templates with a `voiceover` slot (`video-essay`, `slides-voiceover`, `motivational-montage`, `kinetic-typography`) can size scenes to the narration with `durationFrom`. A useful workflow for Claude:

1. Synthesize the narration.
2. Use `search_transcript` to find when each section starts.
3. Set each scene's `seconds` to match.

## Another engine

To use another engine, implement `TTSProvider` and pass it as a session's `tts`:

```ts
interface TTSProvider {
  readonly name: string;
  synthesize(text: string, outPath: string, opts?: SpeechOptions): Promise<{ path: string; duration: number; transcript: Transcript }>;
}
```

**Optional external services.** For anyone who prefers a hosted voice, the library also includes `OpenAITTS` and `ElevenLabsTTS`. They need your own key (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`), send the script to that company, and are never used unless you pass one in. `SpeechOptions.instructions` ("warm, upbeat") only works with OpenAI's `gpt-4o-mini-tts`.
