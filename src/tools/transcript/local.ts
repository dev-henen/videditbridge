import { homedir } from "node:os";
import path from "node:path";
import type { Transcript, Word } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { analyzeSamples, decodeAudio, snapWordsToSpeech } from "../audio/analyze.js";
import type { TranscriptionProvider } from "./providers.js";

export interface LocalWhisperOptions {
  /**
   * Hugging Face model id. It must be an ONNX Whisper export with word-timestamp alignment heads.
   * Default "onnx-community/whisper-base_timestamped" (multilingual, about 80 MB). Use
   * "onnx-community/whisper-tiny_timestamped" for speed or "onnx-community/whisper-small_timestamped" for accuracy.
   */
  model?: string;
  /** Where downloaded models are kept. Default $AVE_MODELS_DIR or ~/.cache/ai-video-editor/models. */
  cacheDir?: string;
  /** Called while the model downloads (0..1) on first use. */
  onDownload?: (progress: number) => void;
  ffmpegPath?: string;
}

type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;

const pipelines = new Map<string, Promise<AsrPipeline>>();

/**
 * Speech-to-text that runs on this machine: OpenAI's Whisper model executed with ONNX Runtime
 * through transformers.js. No API key and no upload; the model downloads once, then works offline.
 * Gives word-level timestamps, so captions, transcript search and filler removal all work.
 */
export class LocalWhisperTranscriber implements TranscriptionProvider {
  readonly name = "local-whisper";
  constructor(private readonly options: LocalWhisperOptions = {}) {}

  get model(): string {
    return this.options.model ?? "onnx-community/whisper-base_timestamped";
  }

  async transcribe(audioPath: string, opts: { language?: string; prompt?: string } = {}): Promise<Transcript> {
    const asr = await this.load();
    const samples = await decodeAudio(audioPath, { ffmpegPath: this.options.ffmpegPath });
    if (!samples.length) return { words: [] };
    const out = await asr(samples, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      task: "transcribe",
      ...(opts.language ? { language: opts.language } : {}),
    });
    const duration = samples.length / 16000;
    const words: Word[] = [];
    for (const c of out.chunks ?? []) {
      const text = c.text.trim();
      if (!text) continue;
      const start = round3(Math.max(0, c.timestamp[0]));
      const end = round3(Math.min(duration, c.timestamp[1] ?? start + 0.3));
      words.push({ text, start, end: Math.max(end, start + 0.02) });
    }
    // Whisper's word times are approximate; tighten them to where speech actually is.
    return { ...(opts.language ? { language: opts.language } : {}), words: snapWordsToSpeech(words, analyzeSamples(samples)) };
  }

  private load(): Promise<AsrPipeline> {
    let p = pipelines.get(this.model);
    if (!p) {
      p = (async () => {
        let tf: typeof import("@huggingface/transformers");
        try {
          tf = await import("@huggingface/transformers");
        } catch {
          throw new Error("Local transcription needs the optional package @huggingface/transformers (npm install @huggingface/transformers).");
        }
        tf.env.cacheDir = this.options.cacheDir ?? process.env.AVE_MODELS_DIR ?? path.join(homedir(), ".cache", "ai-video-editor", "models");
        const files = new Map<string, { loaded: number; total: number }>();
        const asr = await tf.pipeline("automatic-speech-recognition", this.model, {
          dtype: "q8",
          progress_callback: (e: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (e.status !== "progress" || !e.file || !this.options.onDownload) return;
            files.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 });
            const all = [...files.values()];
            const total = all.reduce((s, f) => s + f.total, 0);
            if (total) this.options.onDownload(all.reduce((s, f) => s + f.loaded, 0) / total);
          },
        });
        return asr as unknown as AsrPipeline;
      })();
      pipelines.set(this.model, p);
      p.catch(() => pipelines.delete(this.model));
    }
    return p;
  }
}
