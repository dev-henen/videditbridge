import { beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { SoundClassifier } from "../../engine/tools/audio/classify.js";
import { ANALYSIS_RATE, analyzeSamples, decodeAudio, detectBeats, formatSoundMap, snapWordsToSpeech, soundRanges } from "../../engine/tools/audio/analyze.js";

const SR = ANALYSIS_RATE;

/** Deterministic noise so tests are stable. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}

/** Build a signal from parts laid end to end. */
function signal(parts: { seconds: number; fn: (t: number, i: number) => number }[], noise = 0.002): Float32Array {
  const total = parts.reduce((s, p) => s + p.seconds, 0);
  const out = new Float32Array(Math.round(total * SR));
  const r = rng(7);
  let o = 0;
  for (const p of parts) {
    const n = Math.round(p.seconds * SR);
    for (let i = 0; i < n; i++) out[o + i] = p.fn(i / SR, i) + noise * r();
    o += n;
  }
  return out;
}

const silence = (seconds: number) => ({ seconds, fn: () => 0 });
/**
 * Speech-like: a voiced buzz switched on and off in syllables of irregular length (like real
 * speech, which has no steady beat), with unvoiced hiss bursts between.
 */
const speechLike = (seconds: number, seed = 3) => {
  const r = rng(seed);
  const u = () => (r() + 1) / 2;
  // Syllables of 80-450 ms; after a random number of them, a pause of up to half a second.
  const syllables: { start: number; length: number }[] = [];
  for (let t = 0; t < seconds; ) {
    const length = 0.08 + 0.37 * u() ** 1.5;
    syllables.push({ start: t, length });
    t += length + 0.03 * u();
    if (u() < 0.3) t += 0.08 + 0.4 * u();
  }
  return {
    seconds,
    fn: (t: number) => {
      let k = syllables.length - 1;
      while (k > 0 && syllables[k]!.start > t) k--;
      const s = syllables[k]!;
      const syl = (t - s.start) / s.length;
      const voiced = syl < 0.75 ? Math.sin(Math.PI * (syl / 0.75)) * (0.6 + 0.4 * Math.abs(Math.sin(k * 2.1))) : 0;
      const hiss = syl >= 0.75 && syl < 1 ? 0.08 * r() : 0;
      const f0 = 140 + 20 * Math.sin(t * 3);
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      return 0.12 * voiced * v + hiss;
    },
  };
};
/** Music-like: a sustained harmonic tone with gentle swells (no close frequencies, which would beat). */
const musicLike = (seconds: number) => ({
  seconds,
  fn: (t: number) => {
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * 220 * h * t) / h;
    return 0.15 * v * (0.85 + 0.15 * Math.sin(t * 2));
  },
});

describe("sound map", () => {
  const x = signal([silence(1.5), speechLike(4), silence(1.5), musicLike(4), silence(1), { seconds: 0.15, fn: (t) => 0.9 * Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t * 20) }, silence(1)]);
  let map: Awaited<ReturnType<typeof analyzeSamples>>;
  beforeAll(async () => {
    map = await analyzeSamples(x);
  });

  it("finds speech, music and silence where they are", () => {
    const at = (t: number) => map.segments.find((s) => t >= s.start && t < s.end)?.kind;
    expect(at(0.5)).toBe("silence");
    expect(at(3)).toBe("speech");
    expect(at(6.2)).toBe("silence");
    expect(at(9)).toBe("music");
    expect(at(11.5)).toBe("silence");
    // Speech splits at its own longer pauses; together it spans 1.5-5.5 s.
    const speech = map.segments.filter((s) => s.kind === "speech");
    expect(speech[0]!.start).toBeCloseTo(1.5, 0);
    expect(speech[speech.length - 1]!.end).toBeCloseTo(5.5, 0);
  });

  it("reports a loud moment louder than the rest", () => {
    expect(map.loudMoments.map((m) => m.time)).toEqual([expect.closeTo(12, 0)]);
  });

  it("formats a readable map and padded ranges with sound", () => {
    expect(formatSoundMap(map)).toMatch(/speech .*dB/);
    const ranges = soundRanges(map, { kinds: ["speech"], padding: 0.2, minGap: 1 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBeCloseTo(1.3, 0);
    expect(ranges[0]!.end).toBeCloseTo(5.7, 0);
  });

  it("labels by what a sound model heard, naming other sounds", async () => {
    // Per second: talking at 1-5 s, a song at 7-10 s, a door at 12 s (the signal rules call it music and sound).
    const steps = Math.ceil(x.length / SR);
    const per = (f: (s: number) => number) => Float32Array.from({ length: steps }, (_, s) => f(s));
    const classes = {
      step: 1,
      speech: per((s) => (s >= 1 && s <= 5 ? 0.8 : 0.02)),
      singing: per((s) => (s >= 7 && s <= 10 ? 0.6 : 0.01)),
      music: per((s) => (s >= 7 && s <= 10 ? 0.7 : 0.05)),
      other: per((s) => (s === 12 ? 0.7 : 0.1)),
      otherLabel: Array.from({ length: steps }, (_, s) => (s === 12 ? "Door" : "Hum")),
    };
    const heard = await analyzeSamples(x, { classes });
    const at = (t: number) => heard.segments.find((s) => t >= s.start && t < s.end);
    expect(at(3)).toMatchObject({ kind: "speech" });
    expect(at(9)).toMatchObject({ kind: "music", vocals: true });
    expect(at(12.05)).toMatchObject({ kind: "sound", sound: "Door" });
    expect(at(12.05)!.confidence).toBeGreaterThanOrEqual(0.6);
    const text = formatSoundMap(heard);
    expect(text).toMatch(/music with vocals -\d/);
    expect(text).toMatch(/sound \(door\) -\d/);
  });

  it("treats an empty or silent input as silence", async () => {
    expect((await analyzeSamples(new Float32Array(0))).segments).toEqual([]);
    const quiet = await analyzeSamples(signal([silence(3)]));
    expect(quiet.segments.map((s) => s.kind)).toEqual(["silence"]);
  });
});

describe("snapping recognizer word times to speech", () => {
  const map = {
    duration: 10,
    noiseFloor: -60,
    threshold: -50,
    loudMoments: [],
    levels: [],
    totals: { speech: 4, music: 0, sound: 0, silence: 6 },
    segments: [
      { start: 0, end: 2, kind: "silence" as const, level: -60, confidence: 1 },
      { start: 2, end: 4, kind: "speech" as const, level: -20, confidence: 1 },
      { start: 4, end: 6, kind: "silence" as const, level: -60, confidence: 1 },
      { start: 6, end: 8, kind: "speech" as const, level: -20, confidence: 1 },
      { start: 8, end: 10, kind: "silence" as const, level: -60, confidence: 1 },
    ],
  };

  it("trims words stretched over a pause and moves words found in silence", () => {
    const out = snapWordsToSpeech(
      [
        { text: "inside", start: 2.5, end: 3 },
        { text: "stretched", start: 3.6, end: 5.5 },
        { text: "early", start: 5.5, end: 5.8 },
        { text: "far", start: 9.5, end: 9.8 },
      ],
      map,
    );
    expect(out[0]).toMatchObject({ start: 2.5, end: 3 });
    expect(out[1]).toMatchObject({ start: 3.6, end: 4 });
    expect(out[2]).toMatchObject({ start: 6, end: 6.3 });
    // More than a second from any speech: left alone.
    expect(out[3]).toMatchObject({ start: 9.5, end: 9.8 });
  });
});

describe("beat detection", () => {
  it("finds the tempo and beats of a click track", async () => {
    const bpm = 100;
    const period = 60 / bpm;
    const x = signal([{ seconds: 20, fn: (t) => ((t + 0.2) % period < 0.03 ? 0.6 * Math.sin(2 * Math.PI * 2000 * t) : 0) }]);
    const b = await detectBeats(x);
    expect(b.bpm).toBeCloseTo(bpm, -1);
    expect(b.confidence).toBeGreaterThan(0.5);
    // Clicks start at 0.4 s (period - 0.2) and repeat every 0.6 s.
    for (const t of b.beats.slice(1, 10)) expect(Math.abs(((t - 0.4 + period / 2) % period) - period / 2)).toBeLessThan(0.03);
    expect(Math.abs(b.downbeats.length - b.beats.length / 4)).toBeLessThanOrEqual(1);
  });

  it("reports no beat for sound without rhythm", async () => {
    const r = rng(5);
    const b = await detectBeats(signal([{ seconds: 12, fn: () => 0.2 * r() }]));
    expect(b.bpm).toBeUndefined();
    expect(b.beats).toEqual([]);
  });
});

// Real recordings live in the local sample projects (not in the repository) and the model downloads on first use.
const music = path.resolve("projects/earphone-tips/media/1167-close-up.mp3");
const talk = path.resolve("projects/cinematic-reel/media/20260317_010231.mp4");
const classifier = new SoundClassifier();
const modelReady = existsSync(music) && existsSync(talk) && (await classifier.tags(new Float32Array(SR)).then(() => true, () => false));

describe.skipIf(!modelReady)("sound model on real recordings", () => {
  it("hears a music track as music and a selfie video as speech, where the signal rules wavered", async () => {
    // Share of the sounding time given to each kind (a short noise between phrases may be "sound").
    const shares = async (file: string) => {
      const x = await decodeAudio(file, { duration: 15 });
      const { totals } = await analyzeSamples(x, { classes: await classifier.classify(x) });
      const sounding = totals.speech + totals.music + totals.sound;
      return { speech: totals.speech / sounding, music: totals.music / sounding };
    };
    expect((await shares(music)).music).toBe(1);
    expect((await shares(talk)).speech).toBeGreaterThan(0.9);
  }, 60_000);
});
