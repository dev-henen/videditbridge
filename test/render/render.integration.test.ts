import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIO_EFFECTS, EFFECTS, TEMPLATES, applyTemplate } from "../../engine/library/index.js";
import { probe, render, renderContactSheet, renderFrame, runFfmpeg, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { computeTimeline, parseProject, timelineToSource, validateProject, type Transcript } from "../../engine/core/index.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "../helpers/media.js";
import { sampleInputs } from "../helpers/inputs.js";

const hasFfmpeg = await ffmpegAvailable();
/** The local voice needs the optional kokoro-js package (its model downloads on first use). */
const hasLocalVoice = await import("kokoro-js").then(() => true, () => false);
const FULL = process.env.FULL_RENDER === "1";
/** A representative template per category; FULL_RENDER=1 renders all of them. */
const SUBSET = ["viral-talking-head", "listicle-countdown", "documentary", "real-estate-tour", "announcement", "wedding-memories", "reaction-split"];

const transcript: Transcript = {
  words: "This is a sample sentence for captions. And here is another one to read."
    .split(" ")
    .map((text, i) => ({ text, start: 0.2 + i * 0.25, end: 0.2 + i * 0.25 + 0.22 })),
};

describe.skipIf(!hasFfmpeg)("rendering with ffmpeg", () => {
  let fx: Fixtures;
  const out = (name: string) => path.join(OUT_DIR, name);

  beforeAll(async () => {
    fx = await makeFixtures();
  });

  const templates = TEMPLATES.filter((t) => FULL || SUBSET.includes(t.id));
  it.each(templates.map((t) => [t.id]))("renders template %s", async (id) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    const inputs = sampleInputs(t, { video: fx.talk, image: fx.image, audio: fx.music, videoDuration: 4, audioDuration: 8, transcript }, 2);
    const { project } = await applyTemplate(t, inputs, { probe: (src) => probe(src) });
    expect(validateProject(project).issues.filter((i) => i.level === "error")).toEqual([]);
    const file = out(`template-${id}.mp4`);
    const r = await render(project, { output: file, preset: "ultrafast", scale: 0.5 });
    const info = await probe(file);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.duration!).toBeCloseTo(r.duration, 0);
    await renderContactSheet(project, { output: out(`template-${id}.png`), columns: 4, rows: 2, thumbWidth: 200 });
  });

  it("renders frames and contact sheets through Claude tools", async () => {
    const session = new EditorSession(undefined, { outputDir: out("session") });
    await executeTool(session, "new_project", { aspectRatio: "16:9" });
    const imported = await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    expect(imported.text).toContain("with audio");
    await executeTool(session, "import_media", { src: fx.image, id: "photo" });
    await executeTool(session, "add_clip", { assetId: "talk", duration: 3 });
    await executeTool(session, "add_clip", { assetId: "photo", duration: 2, transition: { type: "circleopen", duration: 0.5 }, effects: [{ type: "kenBurns" }] });
    await executeTool(session, "add_component", { component: "lower-third", start: 0.5, duration: 2.5, params: { name: "Test Person", title: "Integration" } });
    await executeTool(session, "set_transcript", { assetId: "talk", content: { words: transcript.words } });
    await executeTool(session, "set_captions", { style: "karaoke" });

    const frame = await executeTool(session, "render_frame", { time: 1.5 });
    expect(frame.isError, frame.text).toBeFalsy();
    expect(existsSync(frame.images![0]!.path)).toBe(true);

    const sheet = await executeTool(session, "render_contact_sheet", { columns: 3, rows: 2 });
    expect(sheet.isError, sheet.text).toBeFalsy();
    expect(session.renders.map((r) => r.kind)).toEqual(["frame", "contact-sheet"]);

    const preview = await executeTool(session, "render_preview", { scale: 0.25 });
    expect(preview.isError, preview.text).toBeFalsy();
    expect((await probe(session.renders[2]!.path)).duration).toBeCloseTo(4.5, 0);

    // An unchanged edit reuses its preview, also in a new session (the app reopened); a change renders again.
    const reopened = new EditorSession(session.project, { outputDir: session.options.outputDir });
    const again = await executeTool(reopened, "render_preview", { scale: 0.25 });
    expect(again.text).toMatch(/up to date/);
    expect(reopened.renders[0]!.path).toBe(session.renders[2]!.path);
    await executeTool(reopened, "color_adjust", { settings: { exposure: 0.2 } });
    const changed = await executeTool(reopened, "render_preview", { scale: 0.25 });
    expect(changed.text).toMatch(/Preview rendered/);
    expect(reopened.renders[1]!.path).not.toBe(session.renders[2]!.path);
  });

  it("measures color, ignores letterbox bars, and renders scopes", async () => {
    const session = new EditorSession(undefined, { outputDir: out("color") });
    await executeTool(session, "new_project", { aspectRatio: "16:9" });
    await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    await executeTool(session, "add_clip", { assetId: "talk" });
    const before = await executeTool(session, "analyze_color", { time: 1 });
    expect(before.isError, before.text).toBeFalsy();
    const plain = before.data as { luma: number; saturation: number };

    await executeTool(session, "add_effect", { target: "global", type: "letterbox", params: { ratio: 2.39 } });
    const boxed = (await executeTool(session, "analyze_color", { time: 1 })).data as { luma: number };
    expect(Math.abs(boxed.luma - plain.luma)).toBeLessThan(0.08); // bars excluded from the measurement

    await executeTool(session, "color_adjust", { settings: { saturation: -100 } });
    const grey = (await executeTool(session, "analyze_color", { time: 1 })).data as { saturation: number };
    expect(grey.saturation).toBeLessThan(plain.saturation / 3);

    const scopes = await executeTool(session, "render_scopes", { time: 1 });
    expect(scopes.isError, scopes.text).toBeFalsy();
    expect((await probe(scopes.images![0]!.path)).width).toBeGreaterThan(1000);
  });

  it("renders retouch, audio effects, speed and volume through Claude tools", async () => {
    const session = new EditorSession(undefined, { outputDir: out("retouch") });
    await executeTool(session, "new_project", { aspectRatio: "16:9" });
    await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    await executeTool(session, "import_media", { src: fx.music, id: "music" });
    await executeTool(session, "add_clip", { assetId: "talk", duration: 3 });
    const clipId = session.project.clips[0]!.id;
    const call = async (name: string, input: unknown) => {
      const r = await executeTool(session, name, input);
      expect(r.isError, r.text).toBeFalsy();
      return r;
    };

    await call("retouch", { target: clipId, beauty: { smooth: 70, region: { x: 0.5, y: 0.4, width: 0.3, height: 0.5 } }, backgroundBlur: { amount: 40 } });
    await call("add_media_overlay", { assetId: "talk", start: 0.5, duration: 2, size: { width: 0.4 }, position: { x: 0.75, y: 0.3 }, volume: 0.5 });
    const layerId = session.project.layers[0]!.id;
    await call("retouch", { target: layerId, beauty: {} });
    await call("retouch", { target: "global", beauty: { smooth: 30 } });
    await call("set_speed", { target: clipId, speed: 1.5 });
    expect(computeTimeline(session.project).primaryDuration).toBe(2);

    // Every audio effect in one chain proves each filter string is accepted by ffmpeg.
    for (const e of AUDIO_EFFECTS) await call("add_audio_effect", { target: clipId, type: e.id });
    await call("enhance_audio", { target: layerId, removeHum: 60, normalize: -16 });
    await call("add_audio", { assetId: "music", role: "music", duration: 2 });
    const audioId = session.project.audio[0]!.id;
    await call("set_speed", { target: audioId, speed: 2 });
    expect(session.project.audio[0]!.duration).toBe(1);
    await call("add_audio_effect", { target: audioId, type: "reverb", params: { room: "hall" } });
    await call("set_volume", { target: audioId, db: -6 });
    await call("set_volume", { target: "master", volume: 0.8 });
    await call("add_audio_effect", { target: "master", type: "normalize" });
    expect(validateProject(session.project).ok).toBe(true);

    const frame = await call("render_frame", { time: 1 });
    expect(existsSync(frame.images![0]!.path)).toBe(true);
    const r = await render(session.project, { output: out("retouch.mp4"), preset: "ultrafast", scale: 0.5 });
    const info = await probe(r.output);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeCloseTo(2, 0);
  });

  it("edits raw footage by its sound: silences, shots, beats, moments and sound effects", async () => {
    // 12 s: two shots (cut at 6 s); sound at 0.5-2.5, 5-7.5 and 10-11.5 s, silence between.
    const raw = out("raw-sound.mp4");
    const click = out("click-120.wav");
    const tone = "0.3*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*5*t))*(between(t,0.5,2.5)+between(t,5,7.5)+between(t,10,11.5))";
    await runFfmpegOrThrow([
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=6",
      "-f", "lavfi", "-i", "mandelbrot=s=320x180:r=30",
      "-f", "lavfi", "-i", `aevalsrc=exprs='${tone}':s=48000:d=12`,
      "-filter_complex", "[1:v]trim=duration=6,setpts=PTS-STARTPTS,format=yuv420p[m];[0:v][m]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", raw,
    ]);
    await runFfmpegOrThrow(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc=exprs='0.6*sin(2*PI*1500*t)*lt(mod(t,0.5),0.03)':s=48000:d=12", click]);

    const session = new EditorSession(undefined, { outputDir: out("raw-edit") });
    const call = async (name: string, input: unknown) => {
      const r = await executeTool(session, name, input);
      expect(r.isError, r.text).toBeFalsy();
      return r;
    };
    await call("new_project", { aspectRatio: "16:9" });
    await call("import_media", { src: raw, id: "raw" });
    await call("add_clip", { assetId: "raw" });

    const map = await call("analyze_audio", { assetId: "raw" });
    expect(map.text).toMatch(/silence/);
    expect(existsSync(map.images![0]!.path)).toBe(true);

    await call("remove_silences", { minSilence: 0.5, padding: 0.1 });
    const afterCut = computeTimeline(session.project).duration;
    expect(afterCut).toBeGreaterThan(6);
    expect(afterCut).toBeLessThan(7.5);

    const scenes = await call("detect_scenes", { assetId: "raw", split: true });
    expect(scenes.text).toMatch(/6s/);
    expect(session.project.clips.length).toBe(4);

    await call("import_media", { src: click, id: "click" });
    await call("add_audio", { assetId: "click", role: "music", duck: false });
    const music = session.project.audio[0]!.id;
    const beats = await call("detect_beats", { source: music });
    expect(beats.text).toMatch(/120(\.\d)? BPM/);
    await call("beat_sync", { source: music, action: "cuts" });
    for (const c of computeTimeline(session.project).clips.slice(1)) {
      // Every cut lands on a beat (the start of the next clip, plus the transition overlap: none here).
      expect(Math.abs(((c.start + 0.25) % 0.5) - 0.25)).toBeLessThan(0.03);
    }
    await call("beat_sync", { source: music, action: "zoomPunch", every: 2, sound: "hit" });
    await call("add_moment_effect", { type: "impactShake", times: [1] });
    await call("add_sound_effect", { type: "whoosh", times: [2], align: "end" });
    expect(session.project.audio.filter((a) => a.role === "sfx").length).toBeGreaterThan(3);
    expect(validateProject(session.project).ok).toBe(true);

    const r = await render(session.project, { output: out("raw-edit.mp4"), preset: "ultrafast", scale: 0.5 });
    const info = await probe(r.output);
    expect(info.hasAudio).toBe(true);
    expect(info.duration!).toBeCloseTo(computeTimeline(session.project).duration, 0);
  });

  it("renders review-style graphics: circle reveal, shapes, rounded overlays, keying and components", async () => {
    const session = new EditorSession(undefined, { outputDir: out("review-graphics") });
    const call = async (name: string, input: unknown) => {
      const r = await executeTool(session, name, input);
      expect(r.isError, r.text).toBeFalsy();
      return r;
    };
    await call("new_project", { aspectRatio: "16:9" });
    await call("import_media", { src: fx.talk, id: "talk" });
    await call("import_media", { src: fx.image, id: "photo" });
    await call("add_clip", { assetId: "talk", duration: 2 });
    await call("add_clip", { assetId: "photo", duration: 2 });
    await call("set_transition", { clipId: session.project.clips[1]!.id, type: "circlereveal", duration: 0.6, origin: { x: 0.3, y: 0.6 }, sound: true });
    expect(session.project.audio.some((a) => a.label === `transition:${session.project.clips[1]!.id}`)).toBe(true);
    await call("add_media_overlay", { assetId: "photo", start: 0.2, duration: 1.5, size: { width: 0.3 }, position: { x: 0.75, y: 0.4 }, cornerRadius: 30, shadow: 16, effects: [{ type: "chromaKey", params: { color: "#00FF00", replace: "transparent" } }] });
    await call("add_shape", { start: 0, duration: 2, shape: "roundedRect", position: { x: 0.3, y: 0.3 }, size: { width: 0.2, height: 0.12 }, fill: false, strokeWidth: 6, radius: 24 });
    await call("add_shape", { start: 0, duration: 2, shape: "ellipse", position: { x: 0.1, y: 0.15 }, size: { width: 0.06, height: 0.1 }, color: "#FFFFFF", shadow: 6 });
    for (const [component, params] of [
      ["section-card", { title: "What's new", originX: 0.4, originY: 0.6 }],
      ["feature-callout", { text: "ANC", x: 0.7, y: 0.3 }],
      ["highlight-box", { x: 0.5, y: 0.5, label: "Here" }],
      ["step-badge", { number: 1 }],
    ] as const)
      await call("add_component", { component, start: 1, duration: 1.5, params });
    const frame = await call("render_frame", { time: 2.0, scale: 0.5 });
    expect(existsSync(frame.images![0]!.path)).toBe(true);
    const r = await render(session.project, { output: out("review-graphics.mp4"), preset: "ultrafast", scale: 0.5 });
    expect((await probe(r.output)).duration).toBeCloseTo(computeTimeline(session.project).duration, 0);
  });

  it.skipIf(!hasLocalVoice)("narrates with the local voice, then re-voices it in place", async () => {
    const session = new EditorSession(undefined, { outputDir: out("voice") });
    const call = async (name: string, input: unknown) => {
      const r = await executeTool(session, name, input);
      expect(r.isError, r.text).toBeFalsy();
      return r;
    };
    await call("new_project", { aspectRatio: "16:9" });
    await call("set_voice", { voice: "af_bella" });
    await call("generate_voiceover", { text: "Here are three quick tips.", start: 1 });
    const vo = session.project.audio[0]!;
    expect(session.project.metadata.narration).toMatchObject({ [vo.assetId]: { text: "Here are three quick tips.", voice: "af_bella" } });
    // Word timings are measured from the audio.
    expect(session.project.transcripts[vo.assetId]!.words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ""))).toEqual(["here", "are", "three", "quick", "tips"]);
    const before = (session.project.assets.find((a) => a.id === vo.assetId) as { src: string }).src;
    await call("revoice", { target: vo.id, voice: "am_michael", text: "Here are four quick tips." });
    expect(session.project.audio[0]!.start).toBe(1);
    expect((session.project.assets.find((a) => a.id === vo.assetId) as { src: string }).src).not.toBe(before);
    expect(session.project.transcripts[vo.assetId]!.words.some((w) => /four/i.test(w.text))).toBe(true);
    const preview = await call("preview_voice", { voices: ["af_heart", "bf_emma"], text: "Testing one two." });
    expect(preview.text.match(/\.wav/g)).toHaveLength(2);
  }, 600_000);

  it("renders every visual effect", async () => {
    // One short clip per effect in a single render: a failing filter graph names the effect's filters.
    const effects = EFFECTS.filter((e) => e.id !== "lut");
    const session = new EditorSession(undefined, { outputDir: out("all-effects") });
    await executeTool(session, "new_project", { aspectRatio: "9:16" });
    await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    for (const e of effects) await executeTool(session, "add_clip", { assetId: "talk", duration: 0.4, effects: [{ type: e.id }] });
    const r = await render(session.project, { output: out("all-effects.mp4"), preset: "ultrafast", scale: 0.25 });
    expect((await probe(r.output)).duration).toBeCloseTo(effects.length * 0.4, 0);
  });

  it("bakes heavy color chains and zooms between pixels, matching the plain filters", async () => {
    const still = (effects: unknown[]) =>
      parseProject({ settings: { width: 640, height: 360, fps: 30 }, assets: [{ type: "image", id: "img", src: fx.image }], clips: [{ id: "a", assetId: "img", in: 0, duration: 2, effects }] });
    const frame = async (name: string, effects: unknown[]) => {
      const file = out(`${name}.png`);
      await renderFrame(still(effects), 1, { output: file });
      return file;
    };
    const psnr = async (a: string, b: string) => {
      const r = await runFfmpeg(["-hide_banner", "-i", a, "-i", b, "-filter_complex", "[0:v]format=yuv444p[x];[1:v]format=yuv444p[y];[x][y]psnr", "-f", "null", "-"]);
      return Number(/average:([\d.]+)/.exec(r.stderr)![1]);
    };
    const plain = await frame("bake-plain", []);

    const grade = { temperature: 40, vibrance: 30, contrast: 15, hsl: { orange: { saturation: -20 } } };
    const p = still([{ type: "color", params: grade }]);
    const { compileProject } = await import("../../engine/tools/index.js");
    expect(compileProject(p, { output: "x.mp4" }).filterGraph).toContain("haldclut");
    const { colorFilter } = await import("../../engine/library/effects/color.js");
    const direct = out("bake-direct.png");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-i", plain, "-vf", `format=yuv420p,${colorFilter(grade)}`, direct]);
    expect(await psnr(await frame("bake-baked", [{ type: "color", params: grade }]), direct)).toBeGreaterThan(38);

    // A steady 1.5x zoom on the middle is a center crop.
    const crop = out("zoom-crop.png");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-i", plain, "-vf", "crop=iw/1.5:ih/1.5,scale=640:360", crop]);
    expect(await psnr(await frame("zoom-persp", [{ type: "kenBurns", params: { zoomFrom: 1.5, zoomTo: 1.5 } }]), crop)).toBeGreaterThan(30);
  });

  it("keys a green screen onto a backdrop, with the shadows on the screen", async () => {
    // A red box on a green screen with a darker green shadow strip, and a blue backdrop.
    const screen = out("key-screen.mp4");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x00C500:s=320x180:r=30:d=2", "-vf", "drawbox=x=120:y=50:w=80:h=80:color=0xD02020:t=fill,drawbox=x=0:y=150:w=320:h=30:color=0x006200:t=fill", "-pix_fmt", "yuv420p", screen]);
    const backdrop = out("key-backdrop.png");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x3060E0:s=640x360", "-frames:v", "1", backdrop]);
    const p = parseProject({
      settings: { width: 320, height: 180, fps: 30 },
      assets: [
        { type: "video", id: "v", src: screen, duration: 2, hasAudio: false, width: 320, height: 180 },
        { type: "image", id: "bd", src: backdrop, width: 640, height: 360 },
      ],
      clips: [{ id: "a", assetId: "v", in: 0, duration: 2, effects: [{ type: "chromaKey", params: { color: "#00C500", similarity: 0.2, backdrop: "bd", shadows: 1 } }] }],
    });
    const file = out("key-backdrop-frame.png");
    await renderFrame(p, 1, { output: file });
    const px = (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { binaryStdout: true })).stdoutBuffer!;
    const at = (x: number, y: number) => [...px.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    const near = (a: number[], b: number[], tol: number) => a.every((v, k) => Math.abs(v - b[k]!) <= tol);
    expect(near(at(160, 90), [0xd0, 0x20, 0x20], 24), `subject ${at(160, 90)}`).toBe(true);
    expect(near(at(30, 30), [0x30, 0x60, 0xe0], 24), `backdrop ${at(30, 30)}`).toBe(true);
    // The shadow strip is keyed too, and darkens the backdrop by the screen's darkening (0x62 of 0xC5).
    const shadow = at(30, 165);
    expect(near(shadow, [0x30, 0x60, 0xe0].map((v) => v * (0x62 / 0xc5)), 24), `shadow ${shadow}`).toBe(true);
  });

  it("previews big footage from proxies made in the background", async () => {
    const cacheDir = out("proxy-cache");
    await rm(cacheDir, { recursive: true, force: true });
    const big = out("big.mp4");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=30:duration=2", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-shortest", big]);
    const project = parseProject({ settings: { width: 1280, height: 720, fps: 30 }, assets: [{ type: "video", id: "v", src: big }], clips: [{ id: "a", assetId: "v", in: 0, duration: 2 }] });
    const { planProxies, probeAssets, proxiesIdle, withProxies } = await import("../../engine/tools/index.js");
    const p = await probeAssets(project);

    // The first preview starts the proxy and uses the original.
    const first = out("proxy-first.png");
    await renderFrame(p, 1, { output: first, scale: 0.5, cacheDir, proxies: true });
    await proxiesIdle();
    const [job] = [...(await planProxies(p, { cacheDir })).values()];
    expect(job!.exists).toBe(true);
    const info = await probe(job!.file);
    expect([info.width, info.height]).toEqual([1280, 720]);
    expect(info.duration).toBeCloseTo(2, 1);
    expect(info.hasAudio).toBe(true);

    // Later previews read the proxy, and show the same frame.
    expect((await withProxies(p, { cacheDir })).assets[0]).toMatchObject({ src: job!.file });
    const second = out("proxy-second.png");
    await renderFrame(p, 1, { output: second, scale: 0.5, cacheDir, proxies: true });
    const diff = await runFfmpeg(["-hide_banner", "-i", first, "-i", second, "-filter_complex", "psnr", "-f", "null", "-"]);
    expect(Number(/average:([\d.]+)/.exec(diff.stderr)![1])).toBeGreaterThan(30);
  });

  it("reviews an edit for what a viewer would notice", async () => {
    const base = ["-y", "-hide_banner", "-loglevel", "error"];
    // 1 s black, 2.5 s frozen gray, then motion; a tone for 2 s, then silence.
    const flawed = out("review-flawed.mp4");
    await runFfmpegOrThrow([
      ...base,
      "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=1",
      "-f", "lavfi", "-i", "color=c=0x808080:s=640x360:r=30:d=2.5",
      "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2.5",
      "-f", "lavfi", "-i", "sine=f=300:d=2,volume=0.3,apad=whole_dur=6",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "6", flawed,
    ]);
    // A green screen, a third of it a darker green that a tight key misses.
    const screen = out("review-screen.png");
    await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "color=c=0x00FF00:s=300x200,drawbox=x=0:y=0:w=100:h=200:color=0x2E9B2E:t=fill", "-frames:v", "1", screen]);

    const s = new EditorSession(undefined, { outputDir: out("review-session") });
    const run = async (name: string, input: unknown) => {
      const r = await executeTool(s, name, input);
      expect(r.isError, `${name}: ${r.text}`).toBeFalsy();
      return r;
    };
    await run("new_project", { aspectRatio: "9:16" });
    await run("import_media", { src: flawed, id: "flawed" });
    await run("import_media", { src: screen, id: "screen" });
    await run("add_clip", { assetId: "flawed" });
    await run("set_transcript", { assetId: "flawed", content: { words: [{ text: "first", start: 0.3, end: 1.2 }, { text: "late", start: 4, end: 4.5 }, { text: "words", start: 4.6, end: 5.2 }] } });
    await run("set_captions", { style: "bold-pop" });
    await run("add_text", { text: "Pale title", start: 1.5, duration: 1.5, position: { x: 0.5, y: 0.4 }, style: { color: "#9A9A9A", outlineWidth: 0, fontSize: 80 } });
    await run("add_media_overlay", { assetId: "screen", start: 0, duration: 6, position: { x: 0.5, y: 0.15 }, size: { width: 0.5 }, effects: [{ type: "chromaKey", params: { similarity: 0.1 } }] });

    const edits = s.history.length;
    const r = await run("review_edit", {});
    expect(s.history.length).toBe(edits); // read-only
    const issues = (r.data as { issues: { check: string; severity: string; message: string; start: number }[] }).issues;
    const has = (check: string, re: RegExp) => issues.some((i) => i.check === check && re.test(i.message));
    expect(has("frames", /Black picture from 00:00.0 to 00:01.0/), r.text).toBe(true);
    expect(has("frames", /frozen/), r.text).toBe(true);
    expect(has("text", /"Pale title" is hard to read/), r.text).toBe(true);
    expect(has("speech", /Captions show "late words".*nothing is heard/), r.text).toBe(true);
    expect(has("audio", /Loudness is .* below the -14 LUFS target/), r.text).toBe(true);
    expect(has("key", /chroma key on overlay_/), r.text).toBe(true);
    expect((r.data as { loudness: { integrated: number } }).loudness.integrated).toBeLessThan(-16);

    // Only the asked-for checks run.
    const audioOnly = await run("review_edit", { checks: ["audio"] });
    expect((audioOnly.data as { issues: { check: string }[] }).issues.every((i) => i.check === "audio")).toBe(true);
  });

  it("caches clips and keeps every cut on its frame", async () => {
    // A source whose brightness is its frame number, at 23.976 fps like much stock footage.
    const ramp = out("cache-ramp.mp4");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24000/1001:d=9,format=gray,geq=lum='16+N'", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", ramp]);
    const project = parseProject({
      settings: { width: 320, height: 180, fps: 30 },
      assets: [{ type: "video", id: "ramp", src: ramp }],
      clips: [
        { id: "a", assetId: "ramp", in: 0, duration: 2.3 },
        { id: "b", assetId: "ramp", in: 6, duration: 2, effects: [{ type: "kenBurns" }] },
        { id: "c", assetId: "ramp", in: 0.5, duration: 2.042 },
        { id: "d", assetId: "ramp", in: 6, duration: 1.5 },
      ],
      // Glow's blend used to drop a frame per clip when run on each clip.
      effects: [{ type: "glow" }],
    });
    const brightness = async (file: string) =>
      [...((await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "crop=40:40:140:70,scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-"], { binaryStdout: true })).stdoutBuffer ?? [])];
    const cuts = (l: number[]) => l.map((v, i) => (i && Math.abs(v - l[i - 1]!) > 25 ? i : -1)).filter((i) => i > 0);
    const expected = computeTimeline(project).clips.slice(1).map((c) => Math.ceil(c.start * 30 - 1e-6));
    expect(expected).toEqual([69, 129, 191]);

    const cacheDir = out("cache-dir");
    await rm(cacheDir, { recursive: true, force: true });
    const opts = { preset: "ultrafast", extraOutputArgs: ["-qp", "0"] };
    await render(project, { output: out("cache-plain.mp4"), ...opts });
    expect(cuts(await brightness(out("cache-plain.mp4")))).toEqual(expected);

    await render(project, { output: out("cache-cold.mp4"), cacheDir, ...opts });
    const entries = (await readdir(cacheDir)).filter((f) => f.endsWith(".mkv"));
    expect(entries).toHaveLength(4);
    const cold = await brightness(out("cache-cold.mp4"));
    expect(cuts(cold)).toEqual(expected);

    // A second render reuses every entry and gives the same picture.
    await render(project, { output: out("cache-warm.mp4"), cacheDir, ...opts });
    expect((await readdir(cacheDir)).filter((f) => f.endsWith(".mkv")).sort()).toEqual(entries.sort());
    expect(await brightness(out("cache-warm.mp4"))).toEqual(cold);

    // Editing one clip renders only that clip again; a frame render uses the cache without adding to it.
    const edited = { ...project, clips: project.clips.map((c) => (c.id === "c" ? { ...c, effects: [{ type: "vignette" }] } : c)) };
    await renderFrame(edited, 5, { output: out("cache-frame.png"), cacheDir });
    expect((await readdir(cacheDir)).filter((f) => f.endsWith(".mkv"))).toHaveLength(4);
    await render(edited, { output: out("cache-edit.mp4"), cacheDir, ...opts });
    expect((await readdir(cacheDir)).filter((f) => f.endsWith(".mkv"))).toHaveLength(5);
    expect(cuts(await brightness(out("cache-edit.mp4")))).toEqual(expected);
  });

  it("moves layers and pans crops along their keyframes", async () => {
    const gray = async (file: string, w: number) => {
      const raw = (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { binaryStdout: true })).stdoutBuffer!;
      const h = raw.length / w;
      return { at: (x: number, y: number) => raw[y * w + x]!, mean: () => raw.reduce((n, v) => n + v, 0) / raw.length, h };
    };
    // Where the white square's center is: the middle of its bright columns on row y.
    const centerX = (g: Awaited<ReturnType<typeof gray>>, w: number, y: number) => {
      const xs = Array.from({ length: w }, (_, x) => x).filter((x) => g.at(x, y) > 128);
      return (xs[0]! + xs[xs.length - 1]!) / 2 / w;
    };
    const square = path.join(OUT_DIR, "kf-square.png");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=40x40", "-frames:v", "1", square]);
    const move = [{ time: 0, value: { x: 0.2, y: 0.5 }, easing: "linear" }, { time: 2, value: { x: 0.8, y: 0.5 }, easing: "linear" }];
    const project = parseProject({
      settings: { width: 320, height: 180, fps: 30 },
      assets: [{ type: "color", id: "black", color: "#000000" }, { type: "image", id: "sq", src: square }],
      clips: [{ id: "c", assetId: "black", duration: 2 }],
      layers: [
        { type: "shape", id: "ass", start: 0, duration: 2, size: { width: 0.1, height: 0.15 }, color: "#FFFFFF", keyframes: { position: move.map((k) => ({ ...k, value: { ...k.value, y: 0.25 } })) } },
        { type: "media", id: "ov", assetId: "sq", start: 0, duration: 2, size: { width: 0.1 }, keyframes: { position: move.map((k) => ({ ...k, value: { ...k.value, y: 0.75 } })) } },
      ],
    });
    for (const t of [0.5, 1.5]) {
      const file = out(`kf-${t}.png`);
      await renderFrame(project, t, { output: file });
      const g = await gray(file, 320);
      const expected = 0.2 + 0.6 * (t / 2);
      // Text and shapes (libass) and media overlays (FFmpeg) follow the same path.
      expect(centerX(g, 320, 45)).toBeCloseTo(expected, 1);
      expect(centerX(g, 320, 135)).toBeCloseTo(expected, 1);
    }

    // A crop that pans from the dark left of a gradient to its bright right.
    const ramp = path.join(OUT_DIR, "kf-ramp.png");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x180,geq=lum='X*255/639':cb=128:cr=128", "-frames:v", "1", ramp]);
    const pan = parseProject({
      settings: { width: 180, height: 320, fps: 30 },
      assets: [{ type: "image", id: "ramp", src: ramp }],
      clips: [{ id: "c", assetId: "ramp", duration: 2, keyframes: { focus: [{ time: 0, value: { x: 0, y: 0.5 } }, { time: 2, value: { x: 1, y: 0.5 }, easing: "linear" }] } }],
    });
    const means: number[] = [];
    for (const t of [0.1, 1, 1.9]) {
      const file = out(`kf-pan-${t}.png`);
      await renderFrame(pan, t, { output: file });
      means.push((await gray(file, 180)).mean());
    }
    expect(means[0]).toBeLessThan(60);
    expect(means[1]).toBeGreaterThan(100);
    expect(means[2]).toBeGreaterThan(200);
  });

  it("plays speed ramps frame-accurately with continuous sound, and ramps effects", async () => {
    // Brightness = frame number at 25 fps, with a tone throughout.
    const src = out("ramp-src.mp4");
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=9,format=gray,geq=lum='16+N'", "-f", "lavfi", "-i", "sine=f=440:d=9", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    const project = parseProject({
      settings: { width: 160, height: 90, fps: 25 },
      assets: [{ type: "video", id: "r", src }],
      clips: [
        {
          id: "c",
          assetId: "r",
          in: 1,
          duration: 6,
          keyframes: { speed: [{ time: 0, value: 1 }, { time: 2, value: 0.4 }, { time: 4, value: 0.4, easing: "linear" }, { time: 5, value: 2.5 }] },
          effects: [{ type: "blur", params: { amount: 0 }, keyframes: [{ time: 6, params: { amount: 0 } }, { time: 9, params: { amount: 40 } }] }],
        },
      ],
    });
    const tc = computeTimeline(project).clips[0]!;
    const file = out("ramp-out.mp4");
    await render(project, { output: file, preset: "ultrafast", extraOutputArgs: ["-qp", "0"] });
    const lumas = async (f: string, vf = "scale=1:1:flags=area,format=gray") =>
      [...((await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", f, "-vf", vf, "-f", "rawvideo", "-"], { binaryStdout: true })).stdoutBuffer ?? [])];
    const source = await lumas(src);
    const frameOf = (v: number) => source.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(source[best]! - v) ? i : best), 0);
    const got = (await lumas(file)).slice(0, Math.round(6 * 25)); // before the blur sets in
    expect(got.length).toBe(150);
    const errors = got.map((v, n) => frameOf(v) - Math.floor(timelineToSource(tc, n / 25) * 25 + 1e-6));
    expect(Math.max(...errors.map(Math.abs))).toBeLessThanOrEqual(2);
    // The sound runs to the end of the slowed clip: no silence padded on.
    const { stderr } = await runFfmpeg(["-hide_banner", "-i", file, "-vn", "-af", "silencedetect=n=-40dB:d=0.15", "-f", "null", "-"]);
    expect(stderr).not.toMatch(/silence_start/);
    expect(tc.duration).toBeGreaterThan(9);

    // An effect ramp: a blur that builds up over the clip, measured as edge energy on a test pattern.
    const blurred = parseProject({
      settings: { width: 320, height: 180, fps: 25 },
      assets: [{ type: "video", id: "t", src: fx.talk }],
      clips: [{ id: "c", assetId: "t", duration: 3, effects: [{ type: "blur", params: { amount: 0 }, keyframes: [{ time: 0.5, params: { amount: 0 } }, { time: 2.5, params: { amount: 30 } }] }] }],
    });
    const edges = async (t: number) => {
      const f = out(`ramp-blur-${t}.png`);
      await renderFrame(blurred, t, { output: f });
      const px = await lumas(f, "format=gray");
      return px.slice(1).reduce((n, v, i) => n + Math.abs(v - px[i]!), 0);
    };
    const [early, middle, late] = [await edges(0.2), await edges(1.5), await edges(2.8)];
    expect(middle).toBeLessThan(early * 0.8);
    expect(late).toBeLessThan(middle * 0.8);
  });

  it("draws custom SVG graphics, turns them in 3D, and runs effects Claude defines", async () => {
    const session = new EditorSession(undefined, { outputDir: out("graphics") });
    const call = async (name: string, input: Record<string, unknown>) => {
      const r = await executeTool(session, name, input);
      expect(r.isError, r.text).toBeFalsy();
      return r;
    };
    await call("new_project", { aspectRatio: "16:9" });
    await call("import_media", { src: fx.talk, id: "talk" });
    await call("add_clip", { assetId: "talk", duration: 3 });
    // A still card with a drop shadow, and an animated bar that grows.
    const card = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><defs><filter id="s"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-opacity="0.5"/></filter></defs>
      <rect x="20" y="20" width="360" height="160" rx="24" fill="#FF0000" filter="url(#s)"/><text x="200" y="115" font-family="Arial" font-size="48" text-anchor="middle" fill="#fff">Hello</text></svg>`;
    await call("create_graphic", { svg: card, start: 0, duration: 3, width: 0.4 });
    const bar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 40"><rect width="{{ 400*easeOut(seg(t,0,1)) }}" height="40" fill="#2B6CFF"/></svg>`;
    await call("create_graphic", { svg: bar, start: 0, duration: 3, width: 0.5, position: { x: 0.5, y: 0.85 }, rotateX: 20 });
    const layers = session.project.layers;
    const animated = session.project.assets.find((a) => a.id === (layers[1] as { assetId: string }).assetId)!;
    expect(animated.type).toBe("video");
    await call("animate_layer", { layerId: layers[0]!.id, rotateY: [{ time: 0, value: -30 }, { time: 3, value: 30 }] });
    expect((await executeTool(session, "add_effect", { target: "global", type: "custom", params: { filter: "movie=x.mp4" } })).isError).toBe(true);
    await call("create_effect", { name: "warm glitch", filter: "rgbashift=rh=4:bh=-4,colorbalance=rm=0.1" });
    await call("add_effect", { target: "global", type: "custom", params: { name: "warm glitch" } });
    const frame = out("graphics-frame.png");
    await renderFrame(session.project, 1.5, { output: frame });
    // The card's middle (at the frame's center, behind the white text's gap) is red.
    const px = (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", frame, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { binaryStdout: true })).stdoutBuffer!;
    const w = session.project.settings.width;
    const at = (x: number, y: number) => [...px.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
    const red = at(Math.round(w * 0.5) - Math.round(w * 0.15), Math.round(session.project.settings.height * 0.5));
    expect(red[0]).toBeGreaterThan(150);
    expect(red[2]).toBeLessThan(90);
    const r = await render(session.project, { output: out("graphics.mp4"), preset: "ultrafast", scale: 0.5 });
    expect((await probe(r.output)).duration).toBeCloseTo(3, 0);
  });

  it("renders a still frame and a range directly", async () => {
    const session = new EditorSession();
    await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    await executeTool(session, "add_clip", { assetId: "talk" });
    const png = await renderFrame(session.project, 2, { output: out("direct-frame.png"), scale: 0.25 });
    expect((await probe(png)).isImage).toBe(true);
    const r = await render(session.project, { output: out("range.mp4"), range: { start: 1, end: 2.5 }, preset: "ultrafast", scale: 0.25 });
    expect((await probe(r.output)).duration).toBeCloseTo(1.5, 0);
  });

});
