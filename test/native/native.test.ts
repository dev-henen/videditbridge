import { describe, expect, it } from "vitest";
import { analyzeSamples, decodeAudio, detectBeats, frameFeatures } from "../../engine/tools/audio/analyze.js";
import { native, nativeTarget } from "../../engine/tools/native/index.js";
import { frameFeatures as reference, type FrameFeatures } from "../helpers/audio-reference.js";
import { ffmpegAvailable, makeFixtures } from "../helpers/media.js";

const R = 16000;
const hasFfmpeg = await ffmpegAvailable();

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

const make = (seconds: number, fn: (t: number, i: number) => number) => Float32Array.from({ length: Math.round(seconds * R) }, (_, i) => fn(i / R, i));

/** Inputs that cover the kernel's edges: shorter than a frame, exact frame counts, silence, clipping, tones, noise, clicks. */
function synthetic(): [string, Float32Array][] {
  const r = rng(7);
  return [
    ["empty", new Float32Array(0)],
    ["shorter than a frame", make(0.01, () => 0.3)],
    ["exactly one frame", make(0.02, (t) => Math.sin(2 * Math.PI * 300 * t))],
    ["digital silence", make(2, () => 0)],
    ["clipped square", make(1.5, (t) => (Math.sin(2 * Math.PI * 50 * t) >= 0 ? 1 : -1))],
    ["tone sweep", make(4, (t) => 0.4 * Math.sin(2 * Math.PI * (100 + 900 * t) * t))],
    ["noise", make(3, () => 0.2 * r())],
    ["clicks", make(25, (t) => ((t + 0.2) % 0.6 < 0.03 ? 0.6 * Math.sin(2 * Math.PI * 2000 * t) : 0.002 * r()))],
  ];
}

/** Largest difference between two features, per field. */
function worst(a: FrameFeatures, b: FrameFeatures): Record<keyof FrameFeatures, number> {
  const d = (x: Float32Array, y: Float32Array) => x.reduce((m, v, i) => Math.max(m, Math.abs(v - y[i]!)), 0);
  return { level: d(a.level, b.level), zcr: d(a.zcr, b.zcr), flux: d(a.flux, b.flux), flatness: d(a.flatness, b.flatness) };
}

async function expectParity(name: string, x: Float32Array) {
  const [got, want] = [await frameFeatures(x), reference(x)];
  expect(got.level.length, name).toBe(want.level.length);
  const w = worst(got, want);
  // Same algorithm in f64, stored as f32: differences are rounding in log, exp and the FFT.
  expect(w.level, `${name} level`).toBeLessThan(1e-3);
  expect(w.zcr, `${name} zcr`).toBe(0);
  expect(w.flux, `${name} flux`).toBeLessThan(1e-3);
  expect(w.flatness, `${name} flatness`).toBeLessThan(1e-5);
  // And what users see is identical: the sound map and the beats built from either.
  expect(await analyzeSamples(x, { features: got }), `${name} sound map`).toEqual(await analyzeSamples(x, { features: want }));
  expect(await detectBeats(x, undefined, got), `${name} beats`).toEqual(await detectBeats(x, undefined, want));
}

describe("native kernels (ave-native)", () => {
  it("loads for this machine", () => {
    expect(native().version()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(nativeTarget("win32", "x64").file).toBe("ave-native.win32-x64-msvc.node");
    expect(nativeTarget("linux", "x64").pkg).toBe("@ai-video-editor/native-linux-x64-gnu");
    expect(nativeTarget("darwin", "arm64").file).toBe("ave-native.darwin-arm64.node");
  });

  it.each(synthetic())("frameFeatures matches the TypeScript reference: %s", async (name, x) => expectParity(name, x));

  it.skipIf(!hasFfmpeg)("frameFeatures matches the TypeScript reference on recorded media", async () => {
    const fx = await makeFixtures();
    for (const file of [fx.music, fx.talk]) await expectParity(file, await decodeAudio(file));
  });

  it("does not block the JavaScript thread", async () => {
    const x = make(120, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * t));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await frameFeatures(x);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});
