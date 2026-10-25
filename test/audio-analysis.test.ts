import { describe, expect, it } from "vitest";
import { ANALYSIS_RATE, analyzeSamples, detectBeats, formatSoundMap, soundRanges } from "../src/tools/audio/analyze.js";

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
  const map = analyzeSamples(x);

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

  it("treats an empty or silent input as silence", () => {
    expect(analyzeSamples(new Float32Array(0)).segments).toEqual([]);
    const quiet = analyzeSamples(signal([silence(3)]));
    expect(quiet.segments.map((s) => s.kind)).toEqual(["silence"]);
  });
});

describe("beat detection", () => {
  it("finds the tempo and beats of a click track", () => {
    const bpm = 100;
    const period = 60 / bpm;
    const x = signal([{ seconds: 20, fn: (t) => ((t + 0.2) % period < 0.03 ? 0.6 * Math.sin(2 * Math.PI * 2000 * t) : 0) }]);
    const b = detectBeats(x);
    expect(b.bpm).toBeCloseTo(bpm, -1);
    expect(b.confidence).toBeGreaterThan(0.5);
    // Clicks start at 0.4 s (period - 0.2) and repeat every 0.6 s.
    for (const t of b.beats.slice(1, 10)) expect(Math.abs(((t - 0.4 + period / 2) % period) - period / 2)).toBeLessThan(0.03);
    expect(Math.abs(b.downbeats.length - b.beats.length / 4)).toBeLessThanOrEqual(1);
  });

  it("reports no beat for sound without rhythm", () => {
    const r = rng(5);
    const b = detectBeats(signal([{ seconds: 12, fn: () => 0.2 * r() }]));
    expect(b.bpm).toBeUndefined();
    expect(b.beats).toEqual([]);
  });
});
