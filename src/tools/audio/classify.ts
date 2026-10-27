import { readFile } from "node:fs/promises";
import { ensureModelFile, loadOrt, modelsDir, type Ort, type OrtSession } from "../vision/faces.js";
import { ANALYSIS_RATE } from "./analyze.js";

/**
 * Sound classification that runs on this machine: CED-tiny (Apache 2.0, 6.7 MB), trained on AudioSet's
 * 527 kinds of sound, executed with ONNX Runtime. Chosen over YAMNet, which confused animals and was
 * less sure of singing, and over AST, which is 14 times bigger. About 15 ms per second of audio.
 */
export const SOUND_MODEL = {
  url: "https://huggingface.co/mispeech/ced-tiny/resolve/main/model.onnx",
  file: "ced-tiny.onnx",
};
/** The model's label names (AudioSet order), from its config. */
const SOUND_LABELS = { url: "https://huggingface.co/mispeech/ced-tiny/resolve/main/config.json", file: "config.json", minBytes: 10_000 };

/** AudioSet label indexes: talking (with shouts and whispers), singing, and music. */
const SPEECH = range(0, 15);
const SINGING = [...range(27, 37), 254, 255];
const MUSIC = range(137, 282);
/** Labels about the room or recording rather than a sound (silence, inside, echo, field recording). */
const GENERIC = [500, ...range(506, 512), 526];
const NOT_OTHER = new Set([...SPEECH, ...SINGING, ...MUSIC, ...GENERIC]);

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** What a model heard, per step of `step` seconds. */
export interface SoundClasses {
  step: number;
  speech: Float32Array;
  singing: Float32Array;
  music: Float32Array;
  /** The likeliest other sound (not speech, singing or music) and its probability. */
  other: Float32Array;
  otherLabel: string[];
}

export interface SoundClassifierOptions {
  /** Where the model is kept. Default $AVE_MODELS_DIR or ~/.cache/ai-video-editor/models. */
  modelsDir?: string;
  /** Called while the model downloads on first use (0..1). */
  onDownload?: (progress: number) => void;
}

/** Windows the model hears at once, and how far apart they start. */
const WINDOW = 2;
const STEP = 1;

const sessions = new Map<string, Promise<{ ort: Ort; session: OrtSession; labels: string[] }>>();

/** Tells speech, singing, music and other sounds apart (and names the other sounds). */
export class SoundClassifier {
  constructor(private readonly options: SoundClassifierOptions = {}) {}

  private load() {
    const key = modelsDir(this.options);
    let s = sessions.get(key);
    if (!s) {
      s = (async () => {
        const ort = await loadOrt("Sound classification");
        const file = await ensureModelFile(this.options, "ced-tiny", SOUND_MODEL);
        const config = JSON.parse(await readFile(await ensureModelFile(this.options, "ced-tiny", SOUND_LABELS), "utf8")) as { id2label: Record<string, string> };
        const labels = Object.entries(config.id2label).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => v);
        return { ort, labels, session: await ort.InferenceSession.create(file, { logSeverityLevel: 3 }) };
      })();
      sessions.set(key, s);
      s.catch(() => sessions.delete(key));
    }
    return s;
  }

  /** AudioSet probabilities (527) for a stretch of 16 kHz mono samples. */
  async tags(samples: Float32Array): Promise<{ labels: string[]; scores: Float32Array }> {
    const { ort, session, labels } = await this.load();
    const out = await session.run({ waveform: new ort.Tensor("float32", samples, [1, samples.length]) });
    return { labels, scores: Float32Array.from(out.logits!.data) };
  }

  /**
   * Speech, singing, music and other-sound probabilities per second of 16 kHz mono samples. Each
   * second is the average of the 2 s windows that cover it.
   */
  async classify(samples: Float32Array): Promise<SoundClasses> {
    const steps = Math.max(1, Math.ceil(samples.length / (STEP * ANALYSIS_RATE)));
    const sum = { speech: new Float32Array(steps), singing: new Float32Array(steps), music: new Float32Array(steps) };
    const count = new Float32Array(steps);
    const other = new Float32Array(steps);
    const otherLabel: string[] = new Array(steps).fill("");
    const win = WINDOW * ANALYSIS_RATE;
    for (let at = 0; at === 0 || at + win / 2 < samples.length; at += STEP * ANALYSIS_RATE) {
      const w = samples.subarray(at, Math.min(samples.length, at + win));
      // Too short for the model to hear anything (the last half second of a file).
      if (w.length < ANALYSIS_RATE / 4) break;
      const { labels, scores } = await this.tags(w);
      const best = (idx: number[]) => Math.max(...idx.map((i) => scores[i]!));
      let o = 0;
      let oi = -1;
      for (let i = 0; i < scores.length; i++) {
        if (NOT_OTHER.has(i)) continue;
        if (scores[i]! > o) [o, oi] = [scores[i]!, i];
      }
      const [s0, s1] = [Math.floor(at / (STEP * ANALYSIS_RATE)), Math.min(steps, Math.ceil((at + w.length) / (STEP * ANALYSIS_RATE)))];
      const [sp, si, mu] = [best(SPEECH), best(SINGING), best(MUSIC)];
      for (let k = s0; k < s1; k++) {
        sum.speech[k] = sum.speech[k]! + sp;
        sum.singing[k] = sum.singing[k]! + si;
        sum.music[k] = sum.music[k]! + mu;
        count[k] = count[k]! + 1;
        // The other sound keeps its strongest window, so a short bark is not averaged away.
        if (o > other[k]!) [other[k], otherLabel[k]] = [o, labels[oi]!];
      }
    }
    for (let k = 0; k < steps; k++) {
      const c = count[k] || 1;
      for (const x of [sum.speech, sum.singing, sum.music]) x[k] = x[k]! / c;
    }
    return { step: STEP, ...sum, other, otherLabel };
  }
}
