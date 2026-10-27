import { describe, expect, it } from "vitest";
import { ANALYSIS_RATE } from "../src/tools/audio/analyze.js";
import { levelSpeech, speechPieces } from "../src/tools/transcript/local.js";

const R = ANALYSIS_RATE;
/** Tone bursts (as stand-ins for phrases) of `on` seconds with `off` seconds of quiet between, at `amp`. */
function talk(seconds: number, on = 3, off = 0.6, amp = 0.3): Float32Array {
  const x = new Float32Array(seconds * R);
  for (let i = 0; i < x.length; i++) {
    const t = i / R;
    x[i] = t % (on + off) < on ? amp * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0.001 * Math.sin(i);
  }
  return x;
}

describe("local transcription pieces", () => {
  it("cuts long audio into pieces under 30 s, in its pauses", () => {
    const x = talk(70);
    const pieces = speechPieces(x);
    expect(pieces[0]![0]).toBe(0);
    expect(pieces.at(-1)![1]).toBeCloseTo(70, 1);
    for (const [a, b] of pieces) expect(b - a).toBeLessThanOrEqual(25);
    // Every cut falls in a pause (the last 0.6 s of each 3.6 s cycle).
    for (const [, b] of pieces.slice(0, -1)) expect(b % 3.6).toBeGreaterThan(3);
  });

  it("brings a quiet passage up to the level of the rest", () => {
    const quiet = talk(8, 3, 0.6, 0.01);
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(levelSpeech(quiet))).toBeGreaterThan(10 * peak(quiet));
  });
});
