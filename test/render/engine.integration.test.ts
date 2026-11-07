import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, addLayer, computeTimeline, createProject, cutTimelineRanges, setTransition, type Project } from "../../engine/core/index.js";
import { engineBridged, enginePath, engineUnsupported, planProject, render, renderFrame, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { deltaE2000, rgbToLab } from "../../engine/library/effects/color-match.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";
import { sampleInputs } from "../helpers/inputs.js";
import { TEMPLATES, applyTemplate } from "../../engine/library/index.js";
import { probe } from "../../engine/tools/index.js";

const hasFfmpeg = await ffmpegAvailable();
const W = 480;
const H = 270;
const FPS = 15;
/** No test edit is longer than this, so the file runs quickly. */
const MAX_SECONDS = 2;

/** Every frame of a video as packed RGB, optionally through a filter first. */
async function frames(file: string, filter?: string): Promise<Buffer[]> {
  const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, ...(filter ? ["-vf", filter] : []), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
  const size = W * H * 3;
  return Array.from({ length: Math.floor(stdoutBuffer!.length / size) }, (_, i) => stdoutBuffer!.subarray(i * size, (i + 1) * size));
}

/** How strong the noise in a video is: the deviation of its luma from a blurred copy, in levels. */
async function noiseLevel(file: string): Promise<number> {
  const gray = async (filter: string) =>
    (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { binaryStdout: true })).stdoutBuffer!;
  const [sharp, soft] = [await gray("format=gray"), await gray("format=gray,boxblur=2")];
  let sum = 0;
  for (let i = 0; i < sharp.length; i++) sum += (sharp[i]! - soft[i]!) ** 2;
  return Math.sqrt(sum / sharp.length);
}

/** Mean ΔE 2000 between two frames, on every 4th pixel. */
function meanDeltaE(a: Buffer, b: Buffer): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 12) {
    const lab = (f: Buffer) => rgbToLab([f[i]! / 255, f[i + 1]! / 255, f[i + 2]! / 255]);
    sum += deltaE2000(lab(a), lab(b));
    n++;
  }
  return sum / n;
}

/**
 * Render on both backends, losslessly, and compare frame by frame (through `filter` when given,
 * e.g. a blur over random noise). Frames are `size` pixels (the render size).
 */
async function compare(
  name: string,
  p: Project,
  opts: { scale?: number; filter?: string; skip?: (frame: number) => boolean } = {},
): Promise<{ mean: number; worst: number; frames: number; repeatedByFfmpeg: number; skipped: number }> {
  expect(engineUnsupported(p)).toEqual([]);
  expect(computeTimeline(p).duration, "test edits stay short").toBeLessThanOrEqual(MAX_SECONDS + 1e-6);
  p.export = { ...p.export, crf: 0, preset: "ultrafast" };
  const dir = path.join(OUT_DIR, "engine");
  const [ff, gpu] = [path.join(dir, `${name}-ffmpeg.mp4`), path.join(dir, `${name}-engine.mp4`)];
  await render(p, { output: ff, backend: "ffmpeg", hardware: false, scale: opts.scale });
  await render(p, { output: gpu, backend: "engine", hardware: false, scale: opts.scale });
  // Compared at a fixed size, so every project uses the same frame buffers.
  const fit = `scale=${W}:${H}${opts.filter ? `,${opts.filter}` : ""}`;
  const [a, b] = [await frames(ff, fit), await frames(gpu, fit)];
  expect(b.length).toBe(a.length);
  // Some FFmpeg chains drop a clip's last frame and the backend repeats the one before (tpad);
  // the engine shows the real frame there, so those frames are left out (and counted).
  const repeated = (i: number) => i > 0 && a[i]!.equals(a[i - 1]!) && !b[i]!.equals(b[i - 1]!);
  const skipped = a.map((_, i) => i).filter((i) => opts.skip?.(i)).length;
  const kept = a.map((_, i) => i).filter((i) => !repeated(i) && !opts.skip?.(i));
  const scores = kept.map((i) => meanDeltaE(a[i]!, b[i]!));
  const result = { mean: scores.reduce((x, y) => x + y, 0) / scores.length, worst: Math.max(...scores), frames: a.length, repeatedByFfmpeg: a.length - kept.length - skipped, skipped };
  if (process.env.PARITY_LOG) console.log(`parity ${name}: mean ${result.mean.toFixed(3)}, worst ${result.worst.toFixed(3)}`);
  return result;
}

describe.skipIf(!hasFfmpeg || !enginePath())("GPU render engine parity with the FFmpeg backend", () => {
  let fx: Fixtures;
  beforeAll(async () => {
    fx = await makeFixtures();
  });

  const base = () => {
    let p = createProject({ settings: { width: W, height: H, fps: FPS } });
    p = addAsset(p, { id: "talk", type: "video", src: fx.talk, width: 1280, height: 720, duration: 4, hasAudio: true });
    p = addAsset(p, { id: "tall", type: "video", src: fx.silentVertical, width: 720, height: 1280, duration: 3, hasAudio: false });
    p = addAsset(p, { id: "pic", type: "image", src: fx.image, width: 640, height: 480 });
    p = addAsset(p, { id: "blue", type: "color", color: "#2050C0" });
    return p;
  };

  it("clips: cover, contain, speed, fades and transitions", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 0.6, fadeIn: 0.3 });
    p = addClip(p, { id: "b", assetId: "tall", duration: 0.6, fit: "contain", speed: 1.5 });
    p = addClip(p, { id: "c", assetId: "pic", duration: 0.6, focus: { x: 0.2, y: 0.8 } });
    p = addClip(p, { id: "d", assetId: "blue", duration: 0.5, fadeOut: 0.3 });
    p = setTransition(p, "b", { type: "fade", duration: 0.2 });
    p = setTransition(p, "c", { type: "fadeblack", duration: 0.2 });
    const r = await compare("clips", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  it("layers: opacity, fades, blend modes and text", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 2 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0.2, duration: 1.4, position: { x: 0.3, y: 0.4 }, size: { width: 0.4 }, opacity: 0.7, animationIn: { type: "fade", duration: 0.4 } });
    p = addLayer(p, { type: "media", assetId: "blue", start: 0.8, duration: 1, position: { x: 0.75, y: 0.5 }, size: { width: 0.4, height: 0.6 }, blend: "multiply" });
    p = addLayer(p, { type: "media", assetId: "tall", start: 0.4, duration: 1.4, position: { x: 0.6, y: 0.7 }, size: { width: 0.3, height: 0.4 }, fit: "contain", blend: "screen" });
    p = addLayer(p, { type: "text", text: "Engine", start: 0, duration: 2, position: { x: 0.5, y: 0.85 } });
    const r = await compare("layers", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  // One render per effect on the same footage, so a mismatch names its effect.
  const EFFECTS: [string, Record<string, unknown>?][] = [
    ["vibrant"], ["cinematic"], ["tealOrange"], ["warm"], ["moody"], ["faded"], ["bright"],
    ["adjust", { brightness: 0.05, contrast: 1.2, saturation: 1.3, gamma: 1.1 }],
    ["color", { exposure: 0.4, contrast: 20, temperature: -30, vibrance: 25 }],
    ["vignette", { strength: 0.6 }], ["letterbox"], ["chromaticAberration", { amount: 8 }], ["flash", { duration: 0.4 }],
    ["zoom", { scale: 1.4, x: 0.3, y: 0.6 }], ["kenBurns", { zoomFrom: 1, zoomTo: 1.3, pan: "left" }], ["punchIn", { interval: 0.5, scale: 1.2 }], ["pulse", { bpm: 120 }],
    ["blur", { amount: 6 }],
  ];
  for (const [type, params] of EFFECTS) {
    it(`effect ${type}`, async () => {
      let p = base();
      p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 1.4, effects: [{ type, ...(params ? { params } : {}) }] });
      const r = await compare(`effect-${type}`, p);
      expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
      expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
    }, 60_000);
  }

  // Transitions between moving footage and a still: one of each kind of xfade formula.
  const TRANSITION_TYPES = ["wiperight", "wipedown", "slideleft", "slideup", "smoothleft", "circleopen", "circleclose", "horzopen", "diagtl", "zoomin", "circlecrop", "rectcrop", "coverleft", "revealright", "fadegrays", "circlereveal", "pixelize", "hblur",
    "dissolve", "radial", "distance", "squeezeh", "squeezev", "hlslice", "hrslice", "vuslice", "vdslice", "hlwind", "hrwind"];
  for (const type of TRANSITION_TYPES) {
    it(`transition ${type}`, async () => {
      let p = base();
      // zoomin spreads the outgoing clip's center pixel over the whole frame halfway through, and
      // the test pattern's center sits on a sharp color edge, where 4:2:0 chroma (FFmpeg) and full
      // chroma (the engine) differ by a lot: zoom out of a smooth picture instead.
      p = addAsset(p, { id: "ramp", type: "gradient", colors: ["#203060", "#C08040"], direction: "diagonal" });
      p = addClip(p, { id: "a", assetId: type === "zoomin" ? "ramp" : "talk", duration: 1.2 });
      p = addClip(p, { id: "b", assetId: "pic", duration: 1.2 });
      p = setTransition(p, "b", { type, duration: 0.8, ...(type === "circlereveal" ? { origin: { x: 0.3, y: 0.6 } } : {}) });
      const r = await compare(`transition-${type}`, p);
      expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
      expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
    }, 60_000);
  }

  it("fit blur: the picture over a blurred, darkened copy", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "tall", duration: 1, fit: "blur" });
    p = addClip(p, { id: "b", assetId: "pic", duration: 1, fit: "blur", effects: [{ type: "warm" }] });
    const r = await compare("fit-blur", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 60_000);

  it("layers: slides, position and opacity keyframes", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 2 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0.2, duration: 1.6, position: { x: 0.3, y: 0.5 }, size: { width: 0.35 }, animationIn: { type: "slide-up", duration: 0.4 }, animationOut: { type: "slide-right", duration: 0.3, easing: "ease-in" } });
    p = addLayer(p, {
      type: "media",
      assetId: "blue",
      start: 0.3,
      duration: 1.5,
      size: { width: 0.2, height: 0.2 },
      keyframes: {
        position: [{ time: 0, value: { x: 0.2, y: 0.2 }, easing: "linear" }, { time: 1.2, value: { x: 0.8, y: 0.7 }, easing: "ease-in-out" }],
        opacity: [{ time: 0, value: 0.2, easing: "linear" }, { time: 0.8, value: 1, easing: "ease-out" }],
      },
    });
    const r = await compare("layer-motion", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 60_000);

  // Noise is random in both renderers, so these compare pictures blurred over the noise, and
  // how strong the noise is, rather than pixels.
  for (const [type, params] of [["grain", { amount: 20 }], ["glitch", { amount: 12 }]] as const) {
    it(`effect ${type}: same picture under the noise, same noise strength`, async () => {
      let p = base();
      p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 1, effects: [{ type, params }] });
      p.export = { ...p.export, crf: 0, preset: "ultrafast" };
      const dir = path.join(OUT_DIR, "engine");
      const [ff, gpu] = [path.join(dir, `noise-${type}-ffmpeg.mp4`), path.join(dir, `noise-${type}-engine.mp4`)];
      await render(p, { output: ff, backend: "ffmpeg", hardware: false });
      await render(p, { output: gpu, backend: "engine", hardware: false });
      const [a, b] = [await frames(ff, "boxblur=4"), await frames(gpu, "boxblur=4")];
      const scores = a.map((f, i) => meanDeltaE(f, b[i]!));
      expect(scores.reduce((x, y) => x + y, 0) / scores.length).toBeLessThan(1.5);
      const [na, nb] = [await noiseLevel(ff), await noiseLevel(gpu)];
      expect(nb / na, `noise ${na} (FFmpeg) against ${nb} (engine)`).toBeGreaterThan(0.8);
      expect(nb / na, `noise ${na} (FFmpeg) against ${nb} (engine)`).toBeLessThan(1.25);
    }, 60_000);
  }

  it("effects on media layers, with their transparency", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 2 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0, duration: 2, position: { x: 0.3, y: 0.5 }, size: { width: 0.4 }, effects: [{ type: "kenBurns", params: { zoomTo: 1.4 } }, { type: "warm" }] });
    p = addLayer(p, { type: "media", assetId: "tall", start: 0.3, duration: 1.5, position: { x: 0.75, y: 0.5 }, size: { width: 0.3, height: 0.6 }, fit: "contain", effects: [{ type: "blur", params: { amount: 5 } }] });
    const r = await compare("layer-effects", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 60_000);

  it("rounded corners on media layers", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 1.5 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0.1, duration: 1.3, position: { x: 0.3, y: 0.45 }, size: { width: 0.4 }, cornerRadius: 40, opacity: 0.9, animationIn: { type: "fade", duration: 0.3 } });
    p = addLayer(p, { type: "media", assetId: "tall", start: 0.3, duration: 1, position: { x: 0.75, y: 0.5 }, size: { width: 0.25, height: 0.5 }, fit: "contain", cornerRadius: 300, blend: "screen" });
    expect(engineBridged(p)).toEqual([]);
    const r = await compare("corners", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 60_000);

  it("single frames: anywhere in the edit, in any order, like FFmpeg's", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 0.8 });
    p = addClip(p, { id: "b", assetId: "pic", duration: 0.8, effects: [{ type: "kenBurns", params: { zoomTo: 1.3 } }] });
    p = addClip(p, { id: "c", assetId: "talk", in: 1, duration: 0.6, speed: 1.5 });
    p = setTransition(p, "b", { type: "fade", duration: 0.2 });
    p = addLayer(p, { type: "media", assetId: "tall", start: 0.2, duration: 1.6, position: { x: 0.8, y: 0.5 }, size: { width: 0.2, height: 0.5 }, fit: "contain" });
    p = addLayer(p, { type: "text", text: "Frames", start: 0.4, duration: 1.6, position: { x: 0.5, y: 0.85 } });
    const dir = path.join(OUT_DIR, "engine");
    // The engine's export, losslessly: a frame on its own must be the same picture.
    const exported = path.join(dir, "frames-export.mp4");
    await render({ ...p, export: { ...p.export, crf: 0, preset: "ultrafast" } }, { output: exported, backend: "engine", hardware: false });
    const all = await frames(exported);
    // Jumps forward and back (decoders start again at the frame), then a neighbor (they read on).
    for (const time of [1.2, 0.2, 1.7, 0.9, 1.0, 0.5]) {
      const [ff, gpu] = [path.join(dir, `frame-${time}-ffmpeg.png`), path.join(dir, `frame-${time}-engine.png`)];
      await renderFrame(p, time, { output: ff, backend: "ffmpeg" });
      await renderFrame(p, time, { output: gpu, backend: "engine" });
      const [a, b] = [(await frames(ff))[0]!, (await frames(gpu))[0]!];
      const n = Math.ceil(time * FPS - 1e-6);
      expect(meanDeltaE(all[n]!, b), `frame at ${time} s against the engine's export`).toBeLessThan(0.1);
      // Near FFmpeg's (export parity has its own tests; this edit shrinks the test pattern 9x into
      // a layer and zooms over a fractal, where the two resamplers differ a little).
      expect(meanDeltaE(a, b), `frame at ${time} s against FFmpeg's`).toBeLessThan(1.5);
    }
  }, 120_000);

  it("whole-video effects run on the joined picture", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 1.2 });
    p = addClip(p, { id: "b", assetId: "pic", duration: 1.2 });
    p = setTransition(p, "b", { type: "fade", duration: 0.4 });
    p.effects = [{ type: "cinematic" }, { type: "vignette" }];
    const r = await compare("global", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 60_000);

  // The templates' test projects (the subset the render test uses, or every template with
  // FULL_RENDER=1), with captions, at half size. Noise (grain, glitch) is compared blurred.
  const SUBSET = ["viral-talking-head", "listicle-countdown", "documentary", "real-estate-tour", "announcement", "wedding-memories", "reaction-split"];
  const transcript = {
    words: "This is a sample sentence for captions. And here is another one to read.".split(" ").map((text, i) => ({ text, start: 0.1 + i * 0.12, end: 0.1 + i * 0.12 + 0.1 })),
  };
  for (const t of TEMPLATES.filter((t) => process.env.FULL_RENDER === "1" || SUBSET.includes(t.id))) {
    it(`template ${t.id}`, async () => {
      const inputs = sampleInputs(t, { video: fx.talk, image: fx.image, audio: fx.music, videoDuration: 2, audioDuration: 2, transcript }, 2);
      // Only the first 2 seconds: templates with fixed parts (intros, cards) run longer.
      // A cut can leave the head of a clip whose transition began before it, a little past the
      // limit: cut again until it fits.
      let project = (await applyTemplate(t, inputs, { probe: (src) => probe(src) })).project;
      for (let i = 0, length = computeTimeline(project).duration; length > MAX_SECONDS && i < 5; i++, length = computeTimeline(project).duration) {
        project = cutTimelineRanges(project, [{ start: MAX_SECONDS - 0.1 * i, end: length }]);
      }
      const noisy = /"type":"(grain|glitch)"/.test(JSON.stringify(project));
      // zoomin fills the frame with one sample of the outgoing clip halfway through. On these test
      // pictures (a fractal still, the test pattern) neighboring pixels differ a lot in color, where
      // 4:2:0 chroma (FFmpeg) and full chroma (the engine) disagree pixel by pixel; magnified to the
      // whole frame that is not a measure of the frame. Those frames are left out (and counted);
      // zoomin itself is checked on a smooth picture above.
      const plan = planProject(project, { output: "x.mp4", ffmpeg: "ffmpeg", scale: 0.5 }).plan!;
      const zoomins = plan.clips.filter((c) => c.transition?.kind === "zoomin").map((c) => [c.first, c.first + Math.ceil(c.transition!.duration * plan.fps)] as const);
      const skip = (i: number) => zoomins.some(([a, b]) => i >= a && i <= b);
      const r = await compare(`template-${t.id}`, project, { scale: 0.5, filter: noisy ? "boxblur=4" : undefined, skip });
      expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
      expect(r.worst, JSON.stringify(r)).toBeLessThan(noisy ? 3 : 2);
    }, 180_000);
  }

  // What the engine does not draw itself comes from the FFmpeg backend as pieces (engineGaps), so
  // these match the backend closely: only the engine's own fades, transitions and blends differ.
  it("pieces: clip effects the engine does not draw come from the backend", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 0.5, effects: [{ type: "denoise" }, { type: "warm" }] });
    p = addClip(p, { id: "b", assetId: "talk", in: 1, duration: 0.5, effects: [{ type: "glow" }, { type: "sharpen" }], fadeIn: 0.2 });
    p = addClip(p, { id: "c", assetId: "pic", duration: 0.5, effects: [{ type: "halation" }, { type: "lensDistortion" }] });
    p = addClip(p, { id: "d", assetId: "talk", in: 2, duration: 0.5, effects: [{ type: "blur", params: { amount: 8 }, mask: { kind: "shape", shape: { type: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.6 } } as never }] });
    p = setTransition(p, "b", { type: "fade", duration: 0.2 });
    p = setTransition(p, "c", { type: "wiperight", duration: 0.2 });
    expect(engineBridged(p).map((l) => l.split(":")[0])).toEqual(['clip "a"', 'clip "b"', 'clip "c"', 'clip "d"']);
    const r = await compare("pieces-clips", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  it("pieces: whole-video effects and transitions the engine does not draw, under the engine's layers", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 1 });
    p = addClip(p, { id: "b", assetId: "pic", duration: 1 });
    p = setTransition(p, "b", { type: "fade", duration: 0.4 });
    p.effects = [{ type: "glow" }];
    p = addLayer(p, { type: "media", assetId: "tall", start: 0.2, duration: 1.4, position: { x: 0.7, y: 0.5 }, size: { width: 0.25, height: 0.5 }, blend: "screen" });
    expect(engineBridged(p)).toEqual(["base picture: whole-video effects: effect glow"]);
    const r = await compare("pieces-base", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  it("pieces: layers with rounded corners, shadows, keyframes and masks", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", duration: 2 });
    // Below a masked layer: in the base piece with it.
    p = addLayer(p, { id: "round", type: "media", assetId: "pic", start: 0.1, duration: 1.6, position: { x: 0.3, y: 0.4 }, size: { width: 0.35 }, cornerRadius: 30, shadow: 12 });
    p = addLayer(p, { id: "keyed", type: "media", assetId: "blue", start: 0.3, duration: 1.2, position: { x: 0.5, y: 0.5 }, size: { width: 0.5, height: 0.5 }, blend: "multiply", mask: { kind: "luma", luma: [0.5, 1] } as never });
    // Above it: layer pieces and an ordinary layer on the engine.
    p = addLayer(p, {
      id: "spin",
      type: "media",
      assetId: "pic",
      start: 0.2,
      duration: 1.5,
      position: { x: 0.75, y: 0.35 },
      size: { width: 0.25 },
      opacity: 0.8,
      animationIn: { type: "fade", duration: 0.3 },
      keyframes: { rotation: [{ time: 0, value: 0, easing: "linear" }, { time: 1.5, value: 90, easing: "linear" }], scale: [{ time: 0, value: 1, easing: "linear" }, { time: 1.5, value: 0.6, easing: "ease-out" }] },
    });
    p = addLayer(p, { id: "tilt", type: "media", assetId: "tall", start: 0.5, duration: 1.2, position: { x: 0.25, y: 0.75 }, size: { width: 0.2, height: 0.35 }, rotateY: 35, blend: "screen" });
    p = addLayer(p, { id: "plain", type: "media", assetId: "pic", start: 0, duration: 2, position: { x: 0.85, y: 0.8 }, size: { width: 0.2 } });
    p = addLayer(p, { type: "text", text: "Pieces", start: 0, duration: 2, position: { x: 0.5, y: 0.9 } });
    expect(engineBridged(p)).toEqual(['base picture: layer "keyed": mask', 'layer "spin": scale keyframes, rotation keyframes', 'layer "tilt": 3D rotation']);
    const r = await compare("pieces-layers", p);
    expect(r.mean, JSON.stringify(r)).toBeLessThan(1);
    expect(r.worst, JSON.stringify(r)).toBeLessThan(2);
  }, 120_000);

  it("pieces: single frames anywhere in the edit match the engine's export", async () => {
    let p = base();
    p = addClip(p, { id: "a", assetId: "talk", in: 0.5, duration: 0.8, effects: [{ type: "sharpen" }] });
    p = addClip(p, { id: "b", assetId: "talk", in: 1.5, duration: 0.8 });
    p = setTransition(p, "b", { type: "fade", duration: 0.2 });
    p = addLayer(p, { type: "media", assetId: "pic", start: 0.3, duration: 1.2, position: { x: 0.7, y: 0.4 }, size: { width: 0.3 }, shadow: 10 });
    const dir = path.join(OUT_DIR, "engine");
    const exported = path.join(dir, "pieces-frames-export.mp4");
    await render({ ...p, export: { ...p.export, crf: 0, preset: "ultrafast" } }, { output: exported, backend: "engine", hardware: false });
    const all = await frames(exported);
    for (const time of [1.2, 0.2, 0.9, 1.0, 0.5]) {
      const gpu = path.join(dir, `pieces-frame-${time}-engine.png`);
      await renderFrame(p, time, { output: gpu, backend: "engine" });
      const n = Math.ceil(time * FPS - 1e-6);
      expect(meanDeltaE(all[n]!, (await frames(gpu))[0]!), `frame at ${time} s against the engine's export`).toBeLessThan(0.1);
    }
  }, 120_000);
});
