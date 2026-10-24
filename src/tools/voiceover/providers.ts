import { writeFile } from "node:fs/promises";
import type { Transcript, Word } from "../../core/schema.js";
import { fromPlainText } from "../transcript/parse.js";
import { probe, type FfmpegOptions } from "../render/ffmpeg.js";
import { round3 } from "../../core/util.js";

export interface VoiceoverResult {
  /** Path of the written audio file. */
  path: string;
  duration: number;
  /** Word timings — exact when the provider returns alignment, otherwise estimated. */
  transcript: Transcript;
}

export interface SpeechOptions {
  voice?: string;
  /** Provider-specific speaking speed (1 = normal). */
  speed?: number;
  /** Delivery instructions, e.g. "excited, fast-paced" (OpenAI gpt-4o-mini-tts). */
  instructions?: string;
}

/** Text-to-speech provider. Implement this to plug in any TTS engine. */
export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, outPath: string, opts?: SpeechOptions): Promise<VoiceoverResult>;
}

/** OpenAI TTS (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`). Word timings are estimated. */
export class OpenAITTS implements TTSProvider {
  readonly name = "openai";
  constructor(private readonly options: { apiKey?: string; model?: string; baseUrl?: string } & FfmpegOptions = {}) {}

  async synthesize(text: string, outPath: string, opts: SpeechOptions = {}): Promise<VoiceoverResult> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI TTS needs an API key (OPENAI_API_KEY)");
    const res = await fetch(`${this.options.baseUrl ?? "https://api.openai.com/v1"}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.options.model ?? "gpt-4o-mini-tts",
        voice: opts.voice ?? "alloy",
        input: text,
        response_format: "mp3",
        ...(opts.speed ? { speed: opts.speed } : {}),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS failed (${res.status}): ${await res.text()}`);
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    const duration = (await probe(outPath, this.options)).duration ?? 0;
    return { path: outPath, duration, transcript: fromPlainText(text, duration) };
  }
}

/** ElevenLabs TTS with character-level alignment → exact word timings for captions. */
export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";
  constructor(private readonly options: { apiKey?: string; model?: string; defaultVoiceId?: string } = {}) {}

  async synthesize(text: string, outPath: string, opts: SpeechOptions = {}): Promise<VoiceoverResult> {
    const apiKey = this.options.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ElevenLabs TTS needs an API key (ELEVENLABS_API_KEY)");
    const voiceId = opts.voice ?? this.options.defaultVoiceId ?? "21m00Tcm4TlvDq8ikWAM";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: this.options.model ?? "eleven_multilingual_v2",
        ...(opts.speed ? { voice_settings: { speed: opts.speed } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as {
      audio_base64: string;
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    };
    await writeFile(outPath, Buffer.from(data.audio_base64, "base64"));
    const words = data.alignment ? alignmentToWords(data.alignment) : [];
    const duration = words.length ? words[words.length - 1]!.end : 0;
    return {
      path: outPath,
      duration,
      transcript: words.length ? { words } : fromPlainText(text, duration),
    };
  }
}

/** Convert per-character alignment into words. */
export function alignmentToWords(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): Word[] {
  const words: Word[] = [];
  let cur: Word | null = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    const s = a.character_start_times_seconds[i]!;
    const e = a.character_end_times_seconds[i]!;
    if (!cur) cur = { text: ch, start: round3(s), end: round3(e) };
    else {
      cur.text += ch;
      cur.end = round3(e);
    }
  });
  if (cur) words.push(cur);
  return words;
}
