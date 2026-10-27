import { formatTime, round3 } from "../../core/util.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import type { SoundClasses } from "./classify.js";

/**
 * Sound analysis without speech recognition: where people talk, where it is quiet,
 * where music or other sound plays, loud moments, and the musical beat.
 * Everything is computed from decoded PCM in plain TypeScript.
 */

export const ANALYSIS_RATE = 16000;
/** Analysis frame step: 10 ms. */
const HOP = 160;
const FRAME = 320;
const FPS = ANALYSIS_RATE / HOP;

export type SoundKind = "speech" | "music" | "sound" | "silence";

export interface SoundSegment {
  start: number;
  end: number;
  kind: SoundKind;
  /** Average level in dBFS. */
  level: number;
  /** 0..1, how sure the speech/music/sound label is (1 for silence). */
  confidence: number;
  /** Music with singing (or singing alone), when a sound model heard it. */
  vocals?: boolean;
  /** What a "sound" is (an AudioSet name such as "Dog" or "Siren"), when a sound model heard it. */
  sound?: string;
}

export interface LoudMoment {
  time: number;
  /** Peak level in dBFS. */
  level: number;
  /** How far above the surrounding sound, in dB. */
  jump: number;
}

export interface SoundMap {
  duration: number;
  /** Level of the background (10th percentile), dBFS. */
  noiseFloor: number;
  /** Level above which something counts as sound, dBFS. */
  threshold: number;
  segments: SoundSegment[];
  loudMoments: LoudMoment[];
  /** Level per second, dBFS, for a quick overview. */
  levels: number[];
  /** Seconds per kind. */
  totals: Record<SoundKind, number>;
}

export interface BeatAnalysis {
  /** Beats per minute, or undefined when there is no steady beat. */
  bpm?: number;
  /** 0..1, how steady and clear the beat is. */
  confidence: number;
  beats: number[];
  /** Every 4th beat, starting from the strongest phase (bar starts). */
  downbeats: number[];
}

export interface AnalyzeOptions {
  /** Silences shorter than this are bridged (part of the speech or sound around them). Default 0.3 s. */
  minSilence?: number;
  /** Sounds shorter than this are ignored unless loud moments. Default 0.12 s. */
  minSound?: number;
  /**
   * What a sound model heard (SoundClassifier.classify). With it, speech, music, singing and other
   * sounds are told apart by the model instead of by signal rules, and other sounds get names.
   */
  classes?: SoundClasses;
}

/** A model's verdict on a stretch of seconds [a, b). */
function heardIn(c: SoundClasses, a: number, b: number): { kind: SoundKind; confidence: number; vocals?: boolean; sound?: string } {
  const k0 = Math.max(0, Math.min(c.speech.length - 1, Math.floor(a / c.step)));
  const k1 = Math.max(k0 + 1, Math.min(c.speech.length, Math.ceil(b / c.step)));
  const avg = (x: Float32Array) => mean(x, k0, k1);
  const [speech, singing, music] = [avg(c.speech), avg(c.singing), avg(c.music)];
  let other = 0;
  let sound: string | undefined;
  for (let k = k0; k < k1; k++) if (c.other[k]! > other) [other, sound] = [c.other[k]!, c.otherLabel[k]];
  const sure = (p: number) => Math.round(clamp01(p + 0.2) * 100) / 100;
  // A voice matters most for editing, so it wins over music under it, unless it is sung.
  if (singing >= 0.3 && singing >= speech) return { kind: "music", confidence: sure(singing), vocals: true };
  if (speech >= 0.3) return { kind: "speech", confidence: sure(speech) };
  if (music >= 0.3 && music >= other) return { kind: "music", confidence: sure(music) };
  if (other >= 0.2) return { kind: "sound", confidence: sure(other), sound };
  return { kind: "sound", confidence: sure(Math.max(speech, music, other)) };
}

/** Decode the audio of a file to mono float samples at 16 kHz. Returns an empty array for files without audio. */
export async function decodeAudio(src: string, opts: FfmpegOptions & { start?: number; duration?: number } = {}): Promise<Float32Array> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(opts.start ? ["-ss", String(opts.start)] : []),
    ...(opts.duration ? ["-t", String(opts.duration)] : []),
    "-i",
    src,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(ANALYSIS_RATE),
    "-f",
    "f32le",
    "-",
  ];
  try {
    const res = await runFfmpegOrThrow(args, { ...opts, binaryStdout: true });
    const buf = res.stdoutBuffer ?? Buffer.alloc(0);
    // Copy into an aligned buffer: Node's pooled Buffers may start at an odd offset.
    const out = new Float32Array(Math.floor(buf.byteLength / 4));
    new Uint8Array(out.buffer).set(buf.subarray(0, out.length * 4));
    return out;
  } catch (e) {
    if (/does not contain any stream|Output file .* does not contain|matches no streams/i.test((e as Error).message)) return new Float32Array(0);
    throw e;
  }
}

const db = (power: number) => 10 * Math.log10(power + 1e-12);

function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return -120;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

interface FrameFeatures {
  /** Level per frame, dBFS. */
  level: Float32Array;
  /** Zero-crossing rate per frame, 0..1. */
  zcr: Float32Array;
  /** Spectral flux (onset strength) per frame. */
  flux: Float32Array;
  /** Spectral flatness per frame, 0 (tonal) .. 1 (noise). */
  flatness: Float32Array;
}

function frameFeatures(x: Float32Array): FrameFeatures {
  const n = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const level = new Float32Array(n);
  const zcr = new Float32Array(n);
  const flux = new Float32Array(n);
  const flatness = new Float32Array(n);
  const N = 512;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  let mag = new Float64Array(N / 2);
  for (let f = 0; f < n; f++) {
    const o = f * HOP;
    let e = 0;
    let z = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = x[o + i]!;
      e += v * v;
      if (i && (v >= 0) !== (x[o + i - 1]! >= 0)) z++;
    }
    level[f] = db(e / FRAME);
    zcr[f] = z / FRAME;
    // A centered 32 ms window for the spectrum.
    const c = o + FRAME / 2 - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = (x[c + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let logSum = 0;
    let linSum = 0;
    let fl = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
      mag[k] = Math.log1p(100 * m);
      const d = mag[k]! - prev[k]!;
      if (d > 0) fl += d;
      logSum += Math.log(m + 1e-9);
      linSum += m;
    }
    flux[f] = fl;
    flatness[f] = linSum > 1e-6 ? Math.exp(logSum / (N / 2 - 1)) / (linSum / (N / 2 - 1)) : 1;
    [prev, mag] = [mag, prev];
  }
  return { level, zcr, flux, flatness };
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const mean = (a: ArrayLike<number>, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]!;
  return to > from ? s / (to - from) : 0;
};

/**
 * Score how speech-like and music-like a stretch of active frames is (0..1 each).
 * Speech goes up and down with every syllable (4-8 times a second), so its level swings far
 * around its own 200 ms average, and it alternates voiced (low ZCR) and unvoiced (high ZCR)
 * sounds. Music is sustained and tonal; steady noise is sustained but spectrally flat.
 * Speech over music still swings, just less, so it scores as speech.
 */
function soundScores(ff: FrameFeatures, from: number, to: number): { speech: number; music: number; flatness: number; voiceUpFront: boolean } {
  const n = to - from;
  let modulation = 0;
  for (let i = from; i < to; i++) {
    const a = Math.max(from, i - 10);
    const b = Math.min(to, i + 11);
    modulation += (ff.level[i]! - mean(ff.level, a, b)) ** 2;
  }
  modulation = Math.sqrt(modulation / n);
  // A voice in front drops to near silence between syllables; a music bed never empties.
  const loud = percentile(ff.level.subarray(from, to), 0.95);
  let deep = 0;
  for (let i = from; i < to; i++) if (ff.level[i]! < loud - 15) deep++;
  const voiceUpFront = modulation >= 5 && deep / n >= 0.25;
  const zMean = mean(ff.zcr, from, to);
  let zVar = 0;
  for (let i = from; i < to; i++) zVar += (ff.zcr[i]! - zMean) ** 2;
  const zcrCv = Math.sqrt(zVar / n) / (zMean + 1e-3);
  const flat = mean(ff.flatness, from, to);
  const speech = clamp01(0.7 * clamp01((modulation - 1.6) / 2) + 0.3 * clamp01((zcrCv - 0.45) / 0.3));
  const music = clamp01(0.5 * clamp01((1.8 - modulation) / 1) + 0.5 * clamp01((0.35 - flat) / 0.3));
  return { speech, music, flatness: flat, voiceUpFront };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Beat strength (tempo ratio over about 6 s) from which a window counts as beat-driven music. Measured per window: speech up to 3.5, beat-driven music around 5-11. */
const BEAT_RATIO_MUSIC = 4;

/** Analyze decoded samples (16 kHz mono) into a sound map. */
export function analyzeSamples(samples: Float32Array, opts: AnalyzeOptions = {}): SoundMap {
  const minSilence = opts.minSilence ?? 0.3;
  const minSound = opts.minSound ?? 0.12;
  const duration = round3(samples.length / ANALYSIS_RATE);
  const ff = frameFeatures(samples);
  const n = ff.level.length;
  const onset = onsetEnvelope(ff);
  const totals: Record<SoundKind, number> = { speech: 0, music: 0, sound: 0, silence: 0 };
  if (!n) return { duration, noiseFloor: -120, threshold: -120, segments: duration ? [{ start: 0, end: duration, kind: "silence", level: -120, confidence: 1 }] : [], loudMoments: [], levels: [], totals: { ...totals, silence: duration } };

  // Smooth the level a little so single quiet frames inside words don't split them.
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) smooth[i] = mean(ff.level, Math.max(0, i - 2), Math.min(n, i + 3));
  // The quietest 10% is the background, unless the recording is loud throughout (a song, a
  // loud room): silence is never louder than -40 dB.
  const floor = Math.min(percentile(smooth, 0.1), -40);
  const peak = percentile(smooth, 0.97);
  // Activity must clear the background by a margin that grows with the recording's dynamic range.
  const threshold = Math.max(-62, floor + Math.max(8, 0.25 * (peak - floor)));
  const active = new Uint8Array(n);
  let on = false;
  for (let i = 0; i < n; i++) {
    on = on ? smooth[i]! > threshold - 4 : smooth[i]! > threshold;
    active[i] = on ? 1 : 0;
  }
  // Bridge short gaps, drop short blips.
  fillRuns(active, 0, Math.round(minSilence * FPS));
  fillRuns(active, 1, Math.round(minSound * FPS));

  // Label active stretches in ~1.5 s windows so speech over music or a song after talking are told apart.
  const kinds: SoundKind[] = new Array(n).fill("silence");
  const conf = new Float32Array(n).fill(1);
  // Model details per frame: "vocals", or the name of a sound.
  const detail: string[] = new Array(n).fill("");
  const W = Math.round(1.5 * FPS);
  for (let i = 0; i < n; ) {
    if (!active[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && active[j]) j++;
    // Short bursts (a bang, a clap, a door) are too brief to tell speech from music, but a model can name them.
    if (j - i < 0.5 * FPS) {
      const h = opts.classes && heardIn(opts.classes, i / FPS, j / FPS);
      kinds.fill("sound", i, j);
      conf.fill(h?.sound ? h.confidence : 0.5, i, j);
      if (h?.sound) detail.fill(h.sound, i, j);
      i = j;
      continue;
    }
    // Equal windows of about W frames, scored with context from the same run. The run's outer
    // 50 ms are left out: smoothing stretches runs into the silence around them, and those
    // frames swing like speech.
    const count = Math.max(1, Math.round((j - i) / W));
    const size = (j - i) / count;
    const [lo, hi] = [i + 5, j - 5];
    for (let w = 0; w < count; w++) {
      const start = i + Math.round(w * size);
      const end = i + Math.round((w + 1) * size);
      if (opts.classes) {
        const h = heardIn(opts.classes, start / FPS, end / FPS);
        kinds.fill(h.kind, start, end);
        conf.fill(h.confidence, start, end);
        detail.fill(h.vocals ? "vocals" : (h.sound ?? ""), start, end);
        continue;
      }
      const s = soundScores(ff, Math.max(lo, start - 40), Math.min(hi, end + 40));
      // Fades make music swing like speech at its edges, but it stays strongly tonal.
      const tonal = s.flatness < 0.12 && s.speech < 0.35;
      // Percussive music swings like speech too, but on a steady beat that speech never has.
      // Measured within this run of sound only, and only when it is long enough to show a beat.
      const mid = (start + end) >> 1;
      const [b0, b1] = [Math.max(i, mid - 3 * FPS), Math.min(j, mid + 3 * FPS)];
      const beat = b1 - b0 >= 3 * FPS ? tempo(onset, b0, b1).ratio : 0;
      const beatDriven = beat >= BEAT_RATIO_MUSIC && !s.voiceUpFront;
      const kind: SoundKind = beatDriven ? "music" : s.speech >= 0.5 && s.speech >= s.music ? "speech" : s.music >= 0.6 || tonal ? "music" : "sound";
      const c = beatDriven ? clamp01((beat - 1.5) / 3) : kind === "speech" ? s.speech : kind === "music" ? s.music : 1 - Math.max(s.speech, s.music);
      kinds.fill(kind, start, end);
      conf.fill(c, start, end);
    }
    i = j;
  }

  const segments: SoundSegment[] = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j < n && kinds[j] === kinds[i] && detail[j] === detail[i]) j++;
    let p = 0;
    for (let k = i; k < j; k++) p += 10 ** (ff.level[k]! / 10);
    const d = detail[i]!;
    segments.push({
      start: round3(i / FPS),
      end: round3(j === n ? duration : j / FPS),
      kind: kinds[i]!,
      level: Math.round(db(p / (j - i)) * 10) / 10,
      confidence: Math.round(mean(conf, i, j) * 100) / 100,
      ...(d === "vocals" ? { vocals: true } : d ? { sound: d } : {}),
    });
    i = j;
  }
  // Absorb very short labelled pieces into their neighbours (a 1-window "sound" inside speech).
  const merged = mergeShortSegments(segments, 1.0);
  for (const s of merged) totals[s.kind] = round3(totals[s.kind] + s.end - s.start);

  // Loud moments: peaks louder than the recording's usual loud parts and well above the second
  // before them (claps, bangs, laughs, shouts), not ordinary speech starting after a pause.
  const activeLevels = ff.level.filter((_, i) => active[i]);
  const usualLoud = activeLevels.length ? percentile(activeLevels, 0.95) : threshold;
  const loudMoments: LoudMoment[] = [];
  for (let i = 0; i < n; i++) {
    const v = ff.level[i]!;
    if (v < usualLoud + 3) continue;
    let isMax = true;
    for (let k = Math.max(0, i - 25); k < Math.min(n, i + 25) && isMax; k++) if (ff.level[k]! > v || (ff.level[k] === v && k < i)) isMax = false;
    if (!isMax) continue;
    const before = percentile(ff.level.subarray(Math.max(0, i - FPS), Math.max(1, i - 5)), 0.5);
    const jump = v - Math.max(before, floor);
    if (jump >= 10) loudMoments.push({ time: round3(i / FPS), level: Math.round(v * 10) / 10, jump: Math.round(jump * 10) / 10 });
  }
  loudMoments.sort((a, b) => b.jump - a.jump);

  const levels: number[] = [];
  for (let s = 0; s * FPS < n; s++) {
    let p = 0;
    const a = s * FPS;
    const b = Math.min(n, a + FPS);
    for (let k = a; k < b; k++) p += 10 ** (ff.level[k]! / 10);
    levels.push(Math.round(db(p / (b - a))));
  }
  return { duration, noiseFloor: Math.round(floor * 10) / 10, threshold: Math.round(threshold * 10) / 10, segments: merged, loudMoments: loudMoments.slice(0, 20).sort((a, b) => a.time - b.time), levels, totals };
}

/** Set runs of `value` shorter than `maxLen` frames (not touching the ends) to the opposite value. */
function fillRuns(a: Uint8Array, value: number, maxLen: number): void {
  for (let i = 0; i < a.length; ) {
    if (a[i] !== value) {
      i++;
      continue;
    }
    let j = i;
    while (j < a.length && a[j] === value) j++;
    if (j - i < maxLen && i > 0 && j < a.length) a.fill(1 - value, i, j);
    i = j;
  }
}

function mergeShortSegments(segments: SoundSegment[], minLen: number): SoundSegment[] {
  const out: SoundSegment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === s.kind && prev.vocals === s.vocals && prev.sound === s.sound) {
      prev.level = Math.round(Math.max(prev.level, s.level) * 10) / 10;
      prev.end = s.end;
      continue;
    }
    // A short non-silent label between two active segments joins the previous one.
    if (prev && s.kind !== "silence" && prev.kind !== "silence" && s.end - s.start < minLen) {
      prev.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/** Tempo and beat times, for cutting or adding effects on the beat. */
/** Onset strength per frame: spectral flux minus its local average, half-wave rectified. */
function onsetEnvelope(ff: FrameFeatures): Float32Array {
  const n = ff.flux.length;
  const onset = new Float32Array(n);
  const half = Math.round(0.25 * FPS);
  let run = 0;
  for (let i = 0; i < Math.min(n, half); i++) run += ff.flux[i]!;
  for (let i = 0; i < n; i++) {
    const a = i - half - 1;
    const b = i + half;
    if (b < n) run += ff.flux[b]!;
    if (a >= 0) run -= ff.flux[a]!;
    const avg = run / (Math.min(n - 1, b) - Math.max(0, a + 1) + 1);
    onset[i] = Math.max(0, ff.flux[i]! - avg);
  }
  return onset;
}

/**
 * Tempo by autocorrelation of the onset envelope over 60-200 BPM (weighted toward ~120 BPM) within
 * [from, to). `ratio` is how far the best tempo stands out from all others: measured on whole
 * files, speech 1.6-1.8, ambient music with a soft pulse about 2.3, pop with a clear beat above 10.
 */
function tempo(onset: Float32Array, from = 0, to = onset.length): { lag: number; ratio: number; scores: number[]; minLag: number } {
  const minLag = Math.round((60 / 200) * FPS);
  const maxLag = Math.round((60 / 60) * FPS);
  let best = 0;
  let bestLag = minLag;
  let total = 0;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = from + lag; i < to; i++) s += onset[i]! * onset[i - lag]!;
    s /= Math.max(1, to - from - lag);
    const bpm = (60 * FPS) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    scores.push(s);
    total += s;
    if (s * w > best) {
      best = s * w;
      bestLag = lag;
    }
  }
  return { lag: bestLag, ratio: scores[bestLag - minLag]! / (total / scores.length + 1e-9), scores, minLag };
}

export function detectBeats(samples: Float32Array, range?: { start: number; end: number }): BeatAnalysis {
  const ff = frameFeatures(samples);
  const n = ff.flux.length;
  if (n < FPS * 4) return { confidence: 0, beats: [], downbeats: [] };
  const onset = onsetEnvelope(ff);
  const { lag: bestLag, scores, minLag } = tempo(onset);
  const peakScore = scores[bestLag - minLag]!;
  const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
  // How far the best tempo stands out from all others. Measured: speech 1.6-1.8, ambient music
  // with a soft pulse about 2.3, pop with a clear beat above 10, a click track about 25.
  const ratio = peakScore / (avgScore + 1e-9);
  const confidence = clamp01((ratio - 2) / 4);
  // Refine the period to sub-frame precision with a parabola through the peak.
  const l = scores[bestLag - minLag - 1] ?? peakScore;
  const r = scores[bestLag - minLag + 1] ?? peakScore;
  const offset = (l - r) / (2 * (l - 2 * peakScore + r) || 1);
  const period = bestLag + (Math.abs(offset) < 1 ? offset : 0);
  // Phase: the grid offset that lands on the most onset energy.
  let bestPhase = 0;
  let bestSum = -1;
  for (let ph = 0; ph < Math.round(period); ph++) {
    let s = 0;
    for (let t = ph; t < n; t += period) s += onset[Math.round(t)] ?? 0;
    if (s > bestSum) {
      bestSum = s;
      bestPhase = ph;
    }
  }
  // Walk the grid, snapping each beat to the strongest onset nearby so tempo drift is followed.
  const beats: number[] = [];
  const tol = Math.max(1, Math.round(period * 0.12));
  for (let t = bestPhase; t < n; t += period) {
    const c = Math.round(t);
    let k = c;
    for (let d = -tol; d <= tol; d++) if ((onset[c + d] ?? -1) > (onset[k] ?? -1)) k = c + d;
    if (onset[k]! > 0) t = k;
    beats.push(round3(t / FPS));
  }
  // Bar starts: the beat phase (of 4) with the most onset energy.
  const barSums = [0, 1, 2, 3].map((p) => beats.filter((_, i) => i % 4 === p).reduce((s, b) => s + (onset[Math.round(b * FPS)] ?? 0), 0));
  const bar = barSums.indexOf(Math.max(...barSums));
  const inRange = (b: number) => !range || (b >= range.start && b <= range.end);
  const steady = ratio >= 2;
  return {
    bpm: steady ? Math.round(((60 * FPS) / period) * 10) / 10 : undefined,
    confidence: Math.round(confidence * 100) / 100,
    beats: steady ? beats.filter(inRange) : [],
    downbeats: steady ? beats.filter((b, i) => i % 4 === bar && inRange(b)) : [],
  };
}

/** A segment in words: "music with vocals -18 dB", "sound (dog) -30 dB (unsure)". */
export function segmentLabel(s: SoundSegment): string {
  if (s.kind === "silence") return "silence";
  const what = `${s.kind}${s.vocals ? " with vocals" : ""}${s.sound ? ` (${s.sound.toLowerCase()})` : ""}`;
  return `${what} ${s.level} dB${s.confidence < 0.6 ? " (unsure)" : ""}`;
}

/** Readable sound map: one line per segment plus totals and loud moments. */
export function formatSoundMap(map: SoundMap, opts: { offset?: number; maxLines?: number } = {}): string {
  const off = opts.offset ?? 0;
  const t = (s: number) => formatTime(s + off);
  const lines = [
    `Duration ${map.duration}s. Speech ${map.totals.speech}s, music ${map.totals.music}s, other sound ${map.totals.sound}s, silence ${map.totals.silence}s. Background ${map.noiseFloor} dB, sound starts at ${map.threshold} dB.`,
  ];
  const segs = map.segments;
  const max = opts.maxLines ?? 200;
  for (const s of segs.slice(0, max)) lines.push(`${t(s.start)}-${t(s.end)} ${segmentLabel(s)} [${s.start}-${s.end}s]`);
  if (segs.length > max) lines.push(`…${segs.length - max} more segments`);
  if (map.loudMoments.length) lines.push(`Loud moments: ${map.loudMoments.map((m) => `${round3(m.time + off)}s (+${m.jump} dB)`).join(", ")}`);
  return lines.join("\n");
}

/**
 * Tighten recognizer word timings with the sound map. Speech recognizers often stretch a word over
 * the pause after it or start it a little early, in silence. Each word is trimmed to the part of it
 * inside the sound it overlaps most; a word entirely in silence moves to the nearest edge of
 * sound within `maxShift` seconds. Word order is kept.
 */
export function snapWordsToSpeech<W extends { start: number; end: number }>(words: W[], map: SoundMap, opts: { maxShift?: number } = {}): W[] {
  const active = map.segments.filter((s) => s.kind !== "silence");
  if (!active.length) return words.map((w) => ({ ...w }));
  const maxShift = opts.maxShift ?? 1;
  const out = words.map((w) => {
    const len = w.end - w.start;
    let best: SoundSegment | undefined;
    let bestOverlap = 0;
    for (const s of active) {
      const o = Math.min(w.end, s.end) - Math.max(w.start, s.start);
      if (o > bestOverlap) [best, bestOverlap] = [s, o];
    }
    if (best) {
      if (bestOverlap >= len - 1e-6) return { ...w };
      const start = Math.max(w.start, best.start);
      return { ...w, start: round3(start), end: round3(Math.max(start + 0.05, Math.min(w.end, best.end))) };
    }
    // Entirely in silence: move to the closest edge of nearby sound, keeping (at most 0.6 s of) its length.
    let edge: { t: number; after: boolean } | undefined;
    for (const s of active) {
      if (s.start >= w.end && s.start - w.end <= maxShift && (!edge || s.start - w.end < Math.abs(edge.t - (edge.after ? w.end : w.start)))) edge = { t: s.start, after: true };
      if (s.end <= w.start && w.start - s.end <= maxShift && (!edge || w.start - s.end < Math.abs(edge.t - (edge.after ? w.end : w.start)))) edge = { t: s.end, after: false };
    }
    if (!edge) return { ...w };
    const d = Math.min(len, 0.6);
    return edge.after ? { ...w, start: round3(edge.t), end: round3(edge.t + d) } : { ...w, start: round3(edge.t - d), end: round3(edge.t) };
  });
  // Moving words can reorder neighbours by a hair; keep starts non-decreasing.
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.start < out[i - 1]!.start) {
      out[i]!.start = out[i - 1]!.start;
      out[i]!.end = Math.max(out[i]!.end, round3(out[i]!.start + 0.05));
    }
  }
  return out;
}

/** Source ranges that contain sound (speech, music or other), padded, for keeping when cutting silence. */
export function soundRanges(map: SoundMap, opts: { kinds?: SoundKind[]; padding?: number; minGap?: number } = {}): { start: number; end: number }[] {
  const kinds = new Set(opts.kinds ?? ["speech", "music", "sound"]);
  const pad = opts.padding ?? 0.15;
  const out: { start: number; end: number }[] = [];
  for (const s of map.segments) {
    if (!kinds.has(s.kind)) continue;
    const start = Math.max(0, s.start - pad);
    const end = Math.min(map.duration, s.end + pad);
    const prev = out[out.length - 1];
    if (prev && start - prev.end < (opts.minGap ?? 0)) prev.end = round3(end);
    else out.push({ start: round3(start), end: round3(end) });
  }
  return out;
}
