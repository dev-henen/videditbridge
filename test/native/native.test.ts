import { describe, expect, it } from "vitest";
import { analyzeSamples, decodeAudio, detectBeats, frameFeatures } from "../../engine/tools/audio/analyze.js";
import { native, nativeTarget, type ParticleSpec } from "../../engine/tools/native/index.js";
import { PARTICLE_PRESETS, ParticleSettingsSchema, getParticlePreset, resolveParticles, type EmitterSpec } from "../../engine/library/particles/index.js";
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

  it("tracks a sliding region, warps a mask along, and snaps edges", async () => {
    const [w, h, n] = [96, 64, 6];
    // A textured patch moving 2 px right and 1 px down per frame over a flat background.
    const tex = (x: number, y: number) => 128 + 60 * Math.sin(x * 0.7) * Math.cos(y * 0.9) + 30 * Math.sin((x + y) * 0.31);
    const frames = new Uint8Array(w * h * n);
    for (let f = 0; f < n; f++)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const [u, v] = [x - 2 * f, y - f];
          frames[f * w * h + y * w + x] = u >= 20 && u < 60 && v >= 15 && v < 45 ? tex(u, v) : 40;
        }
    const region = new Uint8Array(w * h);
    for (let y = 15; y < 45; y++) for (let x = 20; x < 60; x++) region[y * w + x] = 1;
    const r = await native().trackRegion(frames, w, h, n, region, { model: "translation" });
    expect(r.matrices.length).toBe(9 * n);
    for (let f = 1; f < n; f++) {
      expect(r.matrices[f * 9 + 2]).toBeCloseTo(2 * f, 0);
      expect(r.matrices[f * 9 + 5]).toBeCloseTo(f, 0);
    }
    const mask = Uint8Array.from(region, (v) => v * 255);
    const warped = await native().warpMasks(mask, w, h, r.matrices);
    expect(warped[(n - 1) * w * h + (15 + n - 1) * w + 20 + 2 * (n - 1)]).toBeGreaterThan(200);
    const snapped = await native().guidedFilter(frames.subarray(0, w * h), mask, w, h, 3, 1e-3);
    expect(snapped.length).toBe(w * h);
    await expect(native().trackRegion(frames, w, h, n + 1, region)).rejects.toThrow(/count frames/);
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

describe("particle generator (ave-native)", () => {
  const spec = (preset: string, seed = 1, timeScale?: number[]): ParticleSpec => {
    const { systems, preroll } = resolveParticles(getParticlePreset(preset)!, ParticleSettingsSchema.parse({ seed }));
    return { width: 160, height: 90, fps: 30, seed, preroll, systems, timeScale };
  };
  const draw = async (s: ParticleSpec, batches: number[]) => {
    const r = new (native().ParticleRenderer)(s);
    const parts: Uint8Array[] = [];
    for (const n of batches) parts.push(await r.frames(n));
    return Buffer.concat(parts);
  };

  it("draws the same frames for the same seed, in any batches", async () => {
    for (const preset of PARTICLE_PRESETS.map((p) => p.id)) {
      const whole = await draw(spec(preset), [6]);
      expect(whole.length).toBe(6 * 160 * 90 * 4);
      expect(whole.equals(await draw(spec(preset), [1, 2, 3])), `${preset} in batches`).toBe(true);
      // Something is drawn on every frame.
      for (let f = 0; f < 6; f++) expect(whole.subarray(f * 57600, (f + 1) * 57600).some((v, i) => i % 4 === 3 && v > 0), `${preset} frame ${f}`).toBe(true);
    }
    expect((await draw(spec("snow", 1), [3])).equals(await draw(spec("snow", 2), [3]))).toBe(false);
  });

  it("rejects a malformed spec with a clear error", () => {
    const bad = spec("snow");
    bad.systems = [{ emitter: { ...(bad.systems[0] as { emitter: EmitterSpec }).emitter, life: [1] as unknown as [number, number] } }];
    expect(() => new (native().ParticleRenderer)(bad)).toThrow(/life needs 2 numbers/);
  });
});
