import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { LocalWhisperTranscriber } from "../transcript/local.js";
import { fromPlainText } from "../transcript/parse.js";
import type { SpeechOptions, TTSProvider, VoiceoverResult } from "./providers.js";

export interface LocalVoiceOptions {
  /** Hugging Face model id of a Kokoro ONNX export. */
  model?: string;
  /** Default voice, e.g. "af_heart" (American female), "am_michael" (American male), "bf_emma" (British female), "bm_george" (British male). */
  voice?: string;
  /** Where downloaded models are kept. Default $AVE_MODELS_DIR or ~/.cache/ai-video-editor/models. */
  cacheDir?: string;
  /** Measure word timings with the local Whisper model (default true); otherwise they are estimated. */
  alignWords?: boolean;
  /** Called while the model downloads (0..1) on first use. */
  onDownload?: (progress: number) => void;
  ffmpegPath?: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  accent: "American" | "British";
  gender: "female" | "male";
  /** Overall quality grade published with Kokoro v1.0 (A best, F worst). */
  grade: string;
}

/** Kokoro v1.0 English voices, best first within each group. Grades are the model's published ones. */
export const VOICES: VoiceInfo[] = (
  [
    ["af_heart", "Heart", "A"], ["af_bella", "Bella", "A-"], ["af_nicole", "Nicole", "B-"], ["af_aoede", "Aoede", "C+"], ["af_kore", "Kore", "C+"],
    ["af_sarah", "Sarah", "C+"], ["af_alloy", "Alloy", "C"], ["af_nova", "Nova", "C"], ["af_sky", "Sky", "C-"], ["af_jessica", "Jessica", "D"], ["af_river", "River", "D"],
    ["am_michael", "Michael", "C+"], ["am_fenrir", "Fenrir", "C+"], ["am_puck", "Puck", "C+"], ["am_echo", "Echo", "D"], ["am_eric", "Eric", "D"],
    ["am_liam", "Liam", "D"], ["am_onyx", "Onyx", "D"], ["am_adam", "Adam", "F+"],
    ["bf_emma", "Emma", "B-"], ["bf_isabella", "Isabella", "C"], ["bf_alice", "Alice", "D"], ["bf_lily", "Lily", "D"],
    ["bm_fable", "Fable", "C"], ["bm_george", "George", "C"], ["bm_lewis", "Lewis", "D+"], ["bm_daniel", "Daniel", "D"],
  ] as const
).map(([id, name, grade]) => ({ id, name, grade, accent: id[0] === "a" ? "American" : "British", gender: id[1] === "f" ? "female" : "male" }));

/** Voice ids of the local voice model. */
export const LOCAL_VOICES = VOICES.map((v) => v.id);

/** Voices graded C+ or better: the ones worth using for narration. */
export const RECOMMENDED_VOICES = VOICES.filter((v) => /^[AB]|^C\+/.test(v.grade)).map((v) => v.id);

interface Kokoro {
  generate(text: string, opts: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

const models = new Map<string, Promise<Kokoro>>();

/**
 * Text-to-speech that runs on this machine: the Kokoro-82M neural voice model, executed with ONNX
 * Runtime through kokoro-js. No API key and no upload; the model (about 90 MB) downloads once,
 * then works offline. Long scripts are spoken sentence by sentence and joined with short pauses.
 */
export class LocalTTS implements TTSProvider {
  readonly name = "local-kokoro";
  constructor(private readonly options: LocalVoiceOptions = {}) {}

  get model(): string {
    return this.options.model ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
  }

  async synthesize(text: string, outPath: string, opts: SpeechOptions = {}): Promise<VoiceoverResult> {
    const tts = await this.load();
    const voice = opts.voice ?? this.options.voice ?? "af_heart";
    if (!LOCAL_VOICES.includes(voice)) throw new Error(`Unknown voice "${voice}". Voices: ${LOCAL_VOICES.join(", ")}`);
    const parts = splitSentences(text);
    const chunks: Float32Array[] = [];
    let rate = 24000;
    for (const [i, part] of parts.entries()) {
      const audio = await tts.generate(part, { voice, speed: opts.speed ?? 1 });
      rate = audio.sampling_rate;
      chunks.push(trimSilence(audio.audio, rate));
      // A breath between sentences.
      if (i < parts.length - 1) chunks.push(new Float32Array(Math.round(rate * 0.32)));
    }
    const samples = concat(chunks);
    await writeFile(outPath, wav(samples, rate));
    const duration = round3(samples.length / rate);
    const transcript =
      this.options.alignWords === false
        ? fromPlainText(text, duration)
        : await new LocalWhisperTranscriber({ ffmpegPath: this.options.ffmpegPath }).transcribe(outPath, { language: "en" });
    return { path: outPath, duration, transcript };
  }

  private load(): Promise<Kokoro> {
    let p = models.get(this.model);
    if (!p) {
      p = (async () => {
        let kokoro: typeof import("kokoro-js");
        try {
          kokoro = await import("kokoro-js");
        } catch {
          throw new Error("Local voice-over needs the optional package kokoro-js (npm install kokoro-js).");
        }
        const tf = await import("@huggingface/transformers");
        tf.env.cacheDir = this.options.cacheDir ?? process.env.AVE_MODELS_DIR ?? path.join(homedir(), ".cache", "ai-video-editor", "models");
        const files = new Map<string, { loaded: number; total: number }>();
        const tts = await kokoro.KokoroTTS.from_pretrained(this.model, {
          dtype: "q8",
          device: "cpu",
          progress_callback: (e: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (e.status !== "progress" || !e.file || !this.options.onDownload) return;
            files.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 });
            const all = [...files.values()];
            const total = all.reduce((s, f) => s + f.total, 0);
            if (total) this.options.onDownload(all.reduce((s, f) => s + f.loaded, 0) / total);
          },
        } as Parameters<typeof kokoro.KokoroTTS.from_pretrained>[1]);
        return tts as unknown as Kokoro;
      })();
      models.set(this.model, p);
      p.catch(() => models.delete(this.model));
    }
    return p;
  }
}

/** Sentences (keeping their punctuation), merging very short ones so the voice keeps its flow. */
export function splitSentences(text: string): string[] {
  const raw = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [];
  const out: string[] = [];
  for (const s of raw.map((x) => x.trim()).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (prev && prev.split(" ").length < 4) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }
  return out;
}

/** Remove the model's leading and trailing near-silence so pauses are under our control. */
function trimSilence(x: Float32Array, rate: number): Float32Array {
  const thr = 0.004;
  let a = 0;
  let b = x.length;
  while (a < b && Math.abs(x[a]!) < thr) a++;
  while (b > a && Math.abs(x[b - 1]!) < thr) b--;
  const pad = Math.round(rate * 0.03);
  return x.subarray(Math.max(0, a - pad), Math.min(x.length, b + pad));
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 16-bit mono PCM WAV. */
function wav(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return buf;
}
