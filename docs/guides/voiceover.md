# Voice-over

Text-to-speech narration that comes with word timings, so voice-overs can be captioned like recorded speech. Code: [src/tools/voiceover](../../src/tools/voiceover).

## Providers

| Provider | Class | Word timings | Env var |
|---|---|---|---|
| OpenAI (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) | `OpenAITTS` | Estimated from text length | `OPENAI_API_KEY` |
| ElevenLabs | `ElevenLabsTTS` | Exact (character alignment) | `ELEVENLABS_API_KEY` |

```ts
const tts = new ElevenLabsTTS({ defaultVoiceId: "21m00Tcm4TlvDq8ikWAM" });
const vo = await tts.synthesize("Here are three tips…", "out/vo.mp3", { speed: 1.05 });
// vo.path, vo.duration, vo.transcript
```

`SpeechOptions` has `voice` (a voice name or id), `speed` and `instructions`. `instructions` only works with OpenAI `gpt-4o-mini-tts`, for example "warm, upbeat, slightly fast".

To use another engine, implement `TTSProvider`:

```ts
interface TTSProvider {
  readonly name: string;
  synthesize(text: string, outPath: string, opts?: SpeechOptions): Promise<{ path: string; duration: number; transcript: Transcript }>;
}
```

## Adding narration to an edit

```ts
p = addAsset(p, { type: "audio", id: "vo", src: vo.path, duration: vo.duration });
p = setTranscript(p, "vo", vo.transcript);                 // captions for the narration
p = addAudio(p, { assetId: "vo", role: "voiceover", start: 0.5 });
p = setCaptions(p, { style: "karaoke" });
```

Music with `duck` (the default for music) automatically drops under the voice-over.

With Claude, the `generate_voiceover` tool does all of this in one call when the session has a `tts` provider.

## Fitting visuals to narration

Templates with a `voiceover` slot (`video-essay`, `slides-voiceover`, `motivational-montage`, `kinetic-typography`) can size scenes to the narration with `durationFrom`. A useful workflow for Claude:

1. Synthesize the narration.
2. Use `search_transcript` to find when each section starts.
3. Set each scene's `seconds` to match.
