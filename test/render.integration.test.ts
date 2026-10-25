import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIO_EFFECTS, EFFECTS, TEMPLATES, applyTemplate } from "../src/library/index.js";
import { probe, render, renderContactSheet, renderFrame, runFfmpegOrThrow, startPreviewServer } from "../src/tools/index.js";
import { EditorSession, executeTool } from "../src/claude/index.js";
import { computeTimeline, validateProject, type Transcript } from "../src/core/index.js";
import { OUT_DIR, ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media.js";
import { sampleInputs } from "./helpers/inputs.js";

const hasFfmpeg = await ffmpegAvailable();
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

  it("renders a still frame and a range directly", async () => {
    const session = new EditorSession();
    await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    await executeTool(session, "add_clip", { assetId: "talk" });
    const png = await renderFrame(session.project, 2, { output: out("direct-frame.png"), scale: 0.25 });
    expect((await probe(png)).isImage).toBe(true);
    const r = await render(session.project, { output: out("range.mp4"), range: { start: 1, end: 2.5 }, preset: "ultrafast", scale: 0.25 });
    expect((await probe(r.output)).duration).toBeCloseTo(1.5, 0);
  });

  it("serves a live preview that updates on edits", async () => {
    const session = new EditorSession(undefined, { outputDir: out("preview-server") });
    await executeTool(session, "import_media", { src: fx.talk, id: "talk" });
    await executeTool(session, "add_clip", { assetId: "talk" });
    const server = await startPreviewServer(session, { port: 0, autoContactSheet: false });
    try {
      const page = await fetch(server.url);
      expect(await page.text()).toContain("Video Edit Preview");

      const state = (await (await fetch(`${server.url}/api/state`)).json()) as { duration: number; clips: unknown[]; revision: number };
      expect(state.duration).toBe(4);
      expect(state.clips).toHaveLength(1);

      // SSE: first message is the current state; an edit pushes a new one.
      const ctrl = new AbortController();
      const res = await fetch(`${server.url}/events`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const nextState = async () => {
        while (!buf.includes("\n\n")) buf += decoder.decode((await reader.read()).value);
        const [msg, ...rest] = buf.split("\n\n");
        buf = rest.join("\n\n");
        return JSON.parse(msg!.split("data: ")[1]!) as { revision: number; layers: unknown[] };
      };
      const first = await nextState();
      await executeTool(session, "add_text", { text: "Live!", start: 0, duration: 2 });
      // Activity updates ("Adding text…") are pushed too, at the same revision; skip to the edit.
      let second = await nextState();
      for (let n = 0; second.revision === first.revision && n < 10; n++) second = await nextState();
      expect(second.revision).toBe(first.revision + 1);
      expect(second.layers).toHaveLength(1);
      ctrl.abort();

      const frame = await fetch(`${server.url}/api/frame?t=1`);
      expect(frame.headers.get("content-type")).toBe("image/png");
      expect((await frame.arrayBuffer()).byteLength).toBeGreaterThan(1000);

      await fetch(`${server.url}/api/undo`, { method: "POST" });
      expect(session.project.layers).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
