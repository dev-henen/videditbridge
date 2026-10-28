import { defaultModelsDir } from "../appdirs.js";
import path from "node:path";
import type { Transcript, Word } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { ANALYSIS_RATE, analyzeSamples, decodeAudio, snapWordsToSpeech, type SoundMap } from "../audio/analyze.js";
import type { TranscriptionProvider } from "./providers.js";

export interface LocalWhisperOptions {
  /**
   * Hugging Face model id. It must be an ONNX Whisper export with word-timestamp alignment heads.
   * Default: "onnx-community/whisper-base.en_timestamped" (English, about 80 MB) when the language is
   * English or not given, else "onnx-community/whisper-base_timestamped" (multilingual). Use a
   * "small" export for accuracy or "tiny" for speed.
   */
  model?: string;
  /** Where downloaded models are kept. Default $AVE_MODELS_DIR, else the models folder in the app cache (see appDir). */
  cacheDir?: string;
  /** Called while the model downloads (0..1) on first use. */
  onDownload?: (progress: number) => void;
  ffmpegPath?: string;
}

type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;

const pipelines = new Map<string, Promise<AsrPipeline>>();

/** Whisper hears at most 30 s at once; pieces stay under that, cut in silences. */
const MAX_PIECE = 25;
/** Speech is brought to this level (dBFS) before recognition, at most 30 dB louder. */
const SPEECH_LEVEL = -20;

/**
 * Pieces of at most MAX_PIECE seconds, cut in the middle of silences (or hard at MAX_PIECE when
 * someone talks without pausing). Letting the pipeline split 30 s windows itself dropped whole
 * sentences where the windows were merged.
 */
export function speechPieces(samples: Float32Array, map: SoundMap): [number, number][] {
  const duration = samples.length / ANALYSIS_RATE;
  const cuts = map.segments.filter((s) => s.kind === "silence" && s.end - s.start >= 0.3).map((s) => (s.start + s.end) / 2);
  const out: [number, number][] = [];
  let a = 0;
  while (duration - a > MAX_PIECE) {
    const options = cuts.filter((c) => c > a + 2 && c <= a + MAX_PIECE);
    const b = options.length ? options[options.length - 1]! : a + MAX_PIECE;
    out.push([a, b]);
    a = b;
  }
  out.push([a, duration]);
  return out;
}

/** Bring each stretch of sound to the same level, so quiet speech next to loud parts is still heard. */
export async function levelSpeech(piece: Float32Array, map?: SoundMap): Promise<Float32Array> {
  const out = piece.slice();
  for (const s of (map ?? (await analyzeSamples(piece))).segments) {
    if (s.kind === "silence") continue;
    const gain = Math.min(10 ** ((SPEECH_LEVEL - s.level) / 20), 30);
    for (let i = Math.round(s.start * ANALYSIS_RATE); i < Math.min(out.length, Math.round(s.end * ANALYSIS_RATE)); i++) out[i] = Math.max(-1, Math.min(1, out[i]! * gain));
  }
  return out;
}

/**
 * Speech-to-text that runs on this machine: OpenAI's Whisper model executed with ONNX Runtime
 * through transformers.js. No API key and no upload; the model downloads once, then works offline.
 * Gives word-level timestamps, so captions, transcript search and filler removal all work.
 */
export class LocalWhisperTranscriber implements TranscriptionProvider {
  readonly name = "local-whisper";
  constructor(private readonly options: LocalWhisperOptions = {}) {}

  /** The model used for a language (see LocalWhisperOptions.model). */
  modelFor(language?: string): string {
    if (this.options.model) return this.options.model;
    return !language || language === "en" ? "onnx-community/whisper-base.en_timestamped" : "onnx-community/whisper-base_timestamped";
  }

  get model(): string {
    return this.modelFor();
  }

  async transcribe(audioPath: string, opts: { language?: string; prompt?: string } = {}): Promise<Transcript> {
    const model = this.modelFor(opts.language);
    const asr = await this.load(model);
    const samples = await decodeAudio(audioPath, { ffmpegPath: this.options.ffmpegPath });
    if (!samples.length) return { words: [] };
    const map = await analyzeSamples(samples);
    // English-only models refuse a task or language.
    const english = /\.en(_|$)/.test(model);
    const words: Word[] = [];
    for (const [a, b] of speechPieces(samples, map)) {
      const piece = samples.subarray(Math.round(a * ANALYSIS_RATE), Math.round(b * ANALYSIS_RATE));
      const pieceMap = await analyzeSamples(piece);
      if (pieceMap.segments.every((s) => s.kind === "silence")) continue;
      const out = await asr(await levelSpeech(piece, pieceMap), {
        return_timestamps: "word",
        ...(english ? {} : { task: "transcribe", ...(opts.language ? { language: opts.language } : {}) }),
      });
      for (const c of out.chunks ?? []) {
        const text = c.text.trim();
        if (!text) continue;
        const start = round3(a + Math.max(0, c.timestamp[0]));
        const end = round3(Math.min(b, a + (c.timestamp[1] ?? c.timestamp[0] + 0.3)));
        words.push({ text, start, end: Math.max(end, start + 0.02) });
      }
    }
    // Whisper's word times are approximate; tighten them to where speech actually is.
    return { ...(opts.language ? { language: opts.language } : {}), words: snapWordsToSpeech(words, map) };
  }

  private load(model: string): Promise<AsrPipeline> {
    let p = pipelines.get(model);
    if (!p) {
      p = (async () => {
        let tf: typeof import("@huggingface/transformers");
        try {
          tf = await import("@huggingface/transformers");
        } catch {
          throw new Error("Local transcription needs the optional package @huggingface/transformers (npm install @huggingface/transformers).");
        }
        tf.env.cacheDir = this.options.cacheDir ?? defaultModelsDir();
        const files = new Map<string, { loaded: number; total: number }>();
        const asr = await tf.pipeline("automatic-speech-recognition", model, {
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
      pipelines.set(model, p);
      p.catch(() => pipelines.delete(model));
    }
    return p;
  }
}
