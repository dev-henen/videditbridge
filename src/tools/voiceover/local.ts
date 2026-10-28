import { writeFile } from "node:fs/promises";
import { defaultModelsDir } from "../appdirs.js";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { LocalWhisperTranscriber } from "../transcript/local.js";
import { fromPlainText } from "../transcript/parse.js";
import type { SpeechOptions, TTSProvider, VoiceoverResult } from "./providers.js";

/** espeak-ng tie-marked phoneme pairs Kokoro has single symbols for (as its own pipeline, misaki, maps them). */
const TIED: [string, string][] = [
  ["a͡ɪ", "I"], ["a͡ʊ", "W"], ["d͡z", "ʣ"], ["d͡ʒ", "ʤ"], ["e͡ɪ", "A"], ["o͡ʊ", "O"], ["ə͡ʊ", "Q"], ["s͡s", "S"], ["t͡s", "ʦ"], ["t͡ʃ", "ʧ"], ["ɔ͡ɪ", "Y"],
];

/**
 * Phonemes of a sentence in a language other than English, from espeak-ng (as Kokoro was trained),
 * with the clause punctuation put back so the voice keeps its phrasing. Needs the optional
 * espeak-ng package (GPL-3.0), which is not installed with this library.
 */
async function phonemize(text: string, language: string): Promise<string> {
  type ESpeak = (o: { arguments: string[] }) => Promise<{ FS: { readFile(p: string, o: { encoding: "utf8" }): string } }>;
  let espeak: ESpeak;
  try {
    // A variable specifier keeps bundlers and the type checker from requiring the optional package.
    const name = "espeak-ng";
    espeak = ((await import(name)) as { default: ESpeak }).default;
  } catch {
    throw new Error("Voices in languages other than English need the optional espeak-ng package (GPL-3.0): npm install espeak-ng");
  }
  const run = await espeak({ arguments: ["--phonout", "out", "-q", "--ipa=1", "-v", language, text.replace(/\s+/g, " ")] });
  const clauses = run.FS.readFile("out", { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
  const punct = text.match(/[,.;:!?…¿¡—]+/g) ?? [];
  const joined = clauses.map((c, k) => `${c}${(punct[k] ?? "").replace(/[¿¡]/g, "")}`).join(" ");
  return TIED.reduce((s, [from, to]) => s.split(from).join(to), joined).replace(/͡/g, "");
}

export interface LocalVoiceOptions {
  /** Hugging Face model id of a Kokoro ONNX export. */
  model?: string;
  /** Default voice, e.g. "af_heart" (American female), "am_michael" (American male), "bf_emma" (British female), "bm_george" (British male). */
  voice?: string;
  /** Where downloaded models are kept. Default $AVE_MODELS_DIR, else the models folder in the app cache (see appDir). */
  cacheDir?: string;
  /** Measure word timings with the local Whisper model (default true); otherwise they are estimated. */
  alignWords?: boolean;
  /** Called while the model downloads (0..1) on first use. */
  onDownload?: (progress: number) => void;
  ffmpegPath?: string;
}

/** Languages of the local voices: the first letter of a voice id. */
const LANGUAGES = {
  a: { accent: "American", language: "English", code: "en", espeak: "en-us" },
  b: { accent: "British", language: "English", code: "en", espeak: "en-gb" },
  e: { accent: "Spanish", language: "Spanish", code: "es", espeak: "es" },
  f: { accent: "French", language: "French", code: "fr", espeak: "fr-fr" },
  h: { accent: "Hindi", language: "Hindi", code: "hi", espeak: "hi" },
  i: { accent: "Italian", language: "Italian", code: "it", espeak: "it" },
  p: { accent: "Brazilian Portuguese", language: "Portuguese", code: "pt", espeak: "pt-br" },
} as const;

export interface VoiceInfo {
  id: string;
  name: string;
  /** Accent or language as people say it ("American", "British", "French"...). */
  accent: string;
  /** Language name, e.g. "English", "Spanish". */
  language: string;
  /** ISO 639-1 code of what it speaks, e.g. "en", "fr". */
  languageCode: string;
  gender: "female" | "male";
  /** Overall quality grade published with Kokoro v1.0 (A best, F worst; "?" when none was published). */
  grade: string;
}

/** Kokoro v1.0 voices, best first within each group. Grades are the model's published ones. */
export const VOICES: VoiceInfo[] = (
  [
    ["af_heart", "Heart", "A"], ["af_bella", "Bella", "A-"], ["af_nicole", "Nicole", "B-"], ["af_aoede", "Aoede", "C+"], ["af_kore", "Kore", "C+"],
    ["af_sarah", "Sarah", "C+"], ["af_alloy", "Alloy", "C"], ["af_nova", "Nova", "C"], ["af_sky", "Sky", "C-"], ["af_jessica", "Jessica", "D"], ["af_river", "River", "D"],
    ["am_michael", "Michael", "C+"], ["am_fenrir", "Fenrir", "C+"], ["am_puck", "Puck", "C+"], ["am_echo", "Echo", "D"], ["am_eric", "Eric", "D"],
    ["am_liam", "Liam", "D"], ["am_onyx", "Onyx", "D"], ["am_adam", "Adam", "F+"],
    ["bf_emma", "Emma", "B-"], ["bf_isabella", "Isabella", "C"], ["bf_alice", "Alice", "D"], ["bf_lily", "Lily", "D"],
    ["bm_fable", "Fable", "C"], ["bm_george", "George", "C"], ["bm_lewis", "Lewis", "D+"], ["bm_daniel", "Daniel", "D"],
    ["ef_dora", "Dora", "?"], ["em_alex", "Alex", "?"],
    ["ff_siwis", "Siwis", "B-"],
    ["hf_alpha", "Alpha", "C"], ["hf_beta", "Beta", "C"], ["hm_omega", "Omega", "C"], ["hm_psi", "Psi", "C"],
    ["if_sara", "Sara", "C"], ["im_nicola", "Nicola", "C"],
    ["pf_dora", "Dora", "?"], ["pm_alex", "Alex", "?"],
  ] as const
).map(([id, name, grade]) => {
  const lang = LANGUAGES[id[0] as keyof typeof LANGUAGES];
  return { id, name, grade, accent: lang.accent, language: lang.language, languageCode: lang.code, gender: id[1] === "f" ? "female" : "male" };
});

/** Voice ids of the local voice model. */
export const LOCAL_VOICES = VOICES.map((v) => v.id);

/**
 * The voices worth using for narration: English ones graded C+ or better, and for every other
 * language its best voices (the only ones there are).
 */
export const RECOMMENDED_VOICES = VOICES.filter((v) => (v.languageCode === "en" ? /^[AB]|^C\+/.test(v.grade) : true)).map((v) => v.id);

/** One part of a narration script: words to speak (at a speed factor) or a silence. */
export type ScriptPart = { text: string; speed: number } | { pause: number };

/**
 * Read the narration markup:
 *   [pause]            a 0.6 s pause; [pause 1.5] or [pause 1.5s] any length
 *   [breath]           a short 0.25 s breath
 *   [slow]...[/slow]   slower (0.85x); [fast]...[/fast] faster (1.15x)
 *   *word*             emphasis: set apart by short pauses and said a little slower
 * Everything else is spoken as written.
 */
export function parseScript(script: string): ScriptPart[] {
  const parts: ScriptPart[] = [];
  let speed = 1;
  const push = (text: string, k = 1) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && "text" in last && last.speed === speed * k) last.text = `${last.text} ${t}`;
    else parts.push({ text: t, speed: speed * k });
  };
  const pause = (s: number) => {
    const last = parts[parts.length - 1];
    if (last && "pause" in last) last.pause = Math.max(last.pause, s);
    else parts.push({ pause: s });
  };
  const token = /\[(pause)(?:\s+(\d+(?:\.\d+)?)\s*s?)?\]|\[(breath)\]|\[(\/?)(slow|fast)\]|\*([^*\n]+)\*/gi;
  let at = 0;
  for (const m of script.matchAll(token)) {
    push(script.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[1]) pause(m[2] ? Math.min(10, Number(m[2])) : 0.6);
    else if (m[3]) pause(0.25);
    else if (m[5]) speed = m[4] ? 1 : m[5].toLowerCase() === "slow" ? 0.85 : 1.15;
    else if (m[6]) {
      pause(0.1);
      push(m[6], 0.9);
      pause(0.1);
    }
  }
  push(script.slice(at));
  return parts;
}

/** The words of a script without its markup (what a listener hears). */
export function scriptText(script: string): string {
  return parseScript(script)
    .flatMap((p) => ("text" in p ? [p.text] : []))
    .join(" ");
}

interface Kokoro {
  generate(text: string, opts: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  generate_from_ids(ids: unknown, opts: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  tokenizer(text: string, opts: { truncation: boolean }): { input_ids: unknown };
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
    const lang = LANGUAGES[voice[0] as keyof typeof LANGUAGES];
    const rate = 24000;
    const chunks: Float32Array[] = [];
    const silence = (s: number) => chunks.push(new Float32Array(Math.round(rate * s)));
    const say = async (sentence: string, speed: number) => {
      // English goes through kokoro-js's own phonemizer; other languages through espeak-ng, as the model was trained.
      const audio =
        lang.code === "en"
          ? await tts.generate(sentence, { voice, speed })
          : await tts.generate_from_ids(tts.tokenizer(await phonemize(sentence, lang.espeak), { truncation: true }).input_ids, { voice, speed });
      chunks.push(trimSilence(audio.audio, audio.sampling_rate));
    };
    const parts = parseScript(text);
    for (const [k, part] of parts.entries()) {
      if ("pause" in part) {
        silence(part.pause);
        continue;
      }
      const sentences = splitSentences(part.text);
      for (const [i, sentence] of sentences.entries()) {
        await say(sentence, (opts.speed ?? 1) * part.speed);
        // A breath between sentences; a tiny gap where the pace changes mid-sentence.
        if (i < sentences.length - 1) silence(0.32);
        else if (k < parts.length - 1 && "text" in parts[k + 1]!) silence(/[.!?…]["')\]]*$/.test(sentence) ? 0.32 : 0.06);
      }
    }
    const samples = concat(chunks);
    await writeFile(outPath, wav(samples, rate));
    const duration = round3(samples.length / rate);
    const transcript =
      this.options.alignWords === false
        ? fromPlainText(scriptText(text), duration)
        : await new LocalWhisperTranscriber({ ffmpegPath: this.options.ffmpegPath }).transcribe(outPath, { language: lang.code });
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
        tf.env.cacheDir = this.options.cacheDir ?? defaultModelsDir();
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
