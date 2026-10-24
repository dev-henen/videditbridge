import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transcript } from "../../core/schema.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import { fromWhisper, fromDeepgram } from "./parse.js";

/** Anything that turns an audio file into a word-timed transcript. */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audioPath: string, opts?: { language?: string; prompt?: string }): Promise<Transcript>;
}

export interface OpenAITranscriptionOptions {
  apiKey?: string;
  /** Must support word timestamps (`whisper-1`). */
  model?: string;
  baseUrl?: string;
}

/** OpenAI Whisper API (word-level timestamps). */
export class OpenAITranscriber implements TranscriptionProvider {
  readonly name = "openai";
  constructor(private readonly options: OpenAITranscriptionOptions = {}) {}

  async transcribe(audioPath: string, opts: { language?: string; prompt?: string } = {}): Promise<Transcript> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAI transcription needs an API key (OPENAI_API_KEY)");
    const form = new FormData();
    form.append("file", new Blob([await readFile(audioPath)]), path.basename(audioPath));
    form.append("model", this.options.model ?? "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (opts.language) form.append("language", opts.language);
    if (opts.prompt) form.append("prompt", opts.prompt);
    const res = await fetch(`${this.options.baseUrl ?? "https://api.openai.com/v1"}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI transcription failed (${res.status}): ${await res.text()}`);
    return fromWhisper(await res.json());
  }
}

/** Deepgram pre-recorded API (word timestamps, punctuation, diarization). */
export class DeepgramTranscriber implements TranscriptionProvider {
  readonly name = "deepgram";
  constructor(private readonly options: { apiKey?: string; model?: string; diarize?: boolean } = {}) {}

  async transcribe(audioPath: string, opts: { language?: string } = {}): Promise<Transcript> {
    const apiKey = this.options.apiKey ?? process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new Error("Deepgram transcription needs an API key (DEEPGRAM_API_KEY)");
    const params = new URLSearchParams({
      model: this.options.model ?? "nova-3",
      punctuate: "true",
      smart_format: "true",
      diarize: String(this.options.diarize ?? false),
      ...(opts.language ? { language: opts.language } : { detect_language: "true" }),
    });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/mpeg" },
      body: await readFile(audioPath),
    });
    if (!res.ok) throw new Error(`Deepgram transcription failed (${res.status}): ${await res.text()}`);
    return fromDeepgram(await res.json());
  }
}

/** Extract a compact mono MP3 suitable for speech-to-text APIs (well under upload limits). */
export async function extractAudio(src: string, outPath: string, opts: FfmpegOptions & { start?: number; duration?: number } = {}): Promise<string> {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (opts.start) args.push("-ss", String(opts.start));
  if (opts.duration) args.push("-t", String(opts.duration));
  args.push("-i", src, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", outPath);
  await runFfmpegOrThrow(args, opts);
  return outPath;
}

/** Transcribe any audio/video file: extracts audio with ffmpeg, then calls the provider. */
export async function transcribeMedia(
  src: string,
  provider: TranscriptionProvider,
  opts: FfmpegOptions & { language?: string; prompt?: string } = {},
): Promise<Transcript> {
  const dir = await mkdtemp(path.join(tmpdir(), "ave-stt-"));
  try {
    const audio = await extractAudio(src, path.join(dir, "audio.mp3"), opts);
    return await provider.transcribe(audio, opts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
