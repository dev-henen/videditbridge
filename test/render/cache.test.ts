import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseProject } from "../../engine/core/index.js";
import { isPerFrame, perClipGlobalEffects } from "../../engine/library/index.js";
import { SEGMENT_CODEC, compileProject, hardwareCandidates, hardwareEncoderArgs, hardwareTestArgs, planSegments, pruneCache, wantsHardware } from "../../engine/tools/index.js";

const project = (over: Record<string, unknown> = {}) =>
  parseProject({
    settings: { width: 640, height: 360, fps: 30 },
    assets: [{ type: "video", id: "v", src: "v.mp4", duration: 20, hasAudio: true }],
    clips: [
      { id: "a", assetId: "v", in: 0, duration: 2.3 },
      { id: "b", assetId: "v", in: 5, duration: 2, effects: [{ type: "kenBurns" }] },
    ],
    effects: [{ type: "color", params: { contrast: 20 } }, { type: "glow" }, { type: "shake" }, { type: "vignette" }],
    ...over,
  });

describe("per-frame effects", () => {
  it("knows which effects work frame by frame", () => {
    expect(isPerFrame({ type: "glow" })).toBe(true);
    expect(isPerFrame({ type: "cinematic" })).toBe(true);
    expect(isPerFrame({ type: "color", params: { contrast: 10 } })).toBe(true);
    // Auto correct smooths over neighboring frames.
    expect(isPerFrame({ type: "color", params: { autoCorrect: true } })).toBe(false);
    expect(isPerFrame({ type: "kenBurns" })).toBe(false);
    expect(isPerFrame({ type: "nope" })).toBe(false);
  });

  it("takes only the leading per-frame global effects", () => {
    expect(perClipGlobalEffects(project().effects).map((e) => e.type)).toEqual(["color", "glow"]);
  });
});

describe("compiling with the render cache", () => {
  it("gives each clip exactly its frames on the timeline", () => {
    const g = compileProject(project(), { output: "o.mp4" }).filterGraph;
    // 0-2.3 s holds frames 0..68; 2.3-4.3 s holds frames 69..128.
    expect(g.match(/trim=end_frame=\d+/g)).toEqual(["trim=end_frame=69", "trim=end_frame=60"]);
  });

  it("runs per-frame global effects on each clip and the rest on the joined video", () => {
    const joined = compileProject(project(), { output: "o.mp4" }).filterGraph;
    expect(joined.match(/\[graded\d+\]/)).toBeTruthy();
    const c = compileProject(project(), { output: "o.mp4", segments: { a: "/cache/a.mkv" } });
    // Clip a comes from the cache; b is rendered with the per-frame global effects added.
    expect(c.args).toContain("/cache/a.mkv");
    const lines = c.filterGraph.split(";\n");
    expect(lines.filter((l) => l.includes("vignette=") || l.includes("blend=all_mode=screen")).length).toBeGreaterThan(0);
    const joinedFx = lines.find((l) => /\[graded\d+\]$/.test(l))!;
    // Only shake (and what follows it) stays on the joined video.
    expect(joinedFx).toMatch(/crop=/);
    expect(joinedFx).not.toMatch(/blend=all_mode=screen/);
  });

  it("compiles one clip for the cache with its natural frames", () => {
    const one = project({ clips: [{ id: "b", assetId: "v", in: 5, duration: 2, muted: true, effects: [{ type: "kenBurns" }] }] });
    const c = compileProject(one, { output: "seg.mkv", segment: true });
    expect(c.args).toEqual(expect.arrayContaining([...SEGMENT_CODEC, "-fps_mode", "passthrough"]));
    expect(c.args).not.toContain("-an");
    expect(c.filterGraph).not.toMatch(/trim=end_frame/);
    expect(c.filterGraph).toMatch(/blend=all_mode=screen/); // glow baked in
    expect(c.filterGraph).not.toMatch(/\[graded/); // shake is not
  });

  it("encodes on the graphics card when asked", () => {
    const c = compileProject(project(), { output: "o.mp4", hardwareEncoder: "qsv" });
    expect(c.args).toEqual(expect.arrayContaining(hardwareEncoderArgs("qsv", 20)));
    expect(c.args).not.toContain("libx264");
    expect(wantsHardware("libx264", "medium")).toBe(true);
    expect(wantsHardware("libx264", "ultrafast")).toBe(false);
    expect(wantsHardware("libx265", "medium")).toBe(false);
  });

  it("tries each system's own encoders, and runs VAAPI on its device", () => {
    expect(hardwareCandidates("darwin")).toEqual(["videotoolbox"]);
    expect(hardwareCandidates("linux")).toEqual(["nvenc", "qsv", "vaapi"]);
    expect(hardwareCandidates("win32")).toEqual(["nvenc", "qsv", "amf"]);
    // VideoToolbox: constant quality runs the other way (crf 20 is about 66).
    const vt = hardwareEncoderArgs("videotoolbox", 20);
    expect(vt).toEqual(expect.arrayContaining(["-c:v", "h264_videotoolbox", "-q:v", "66"]));
    // VAAPI: the device opened before the inputs, the frames uploaded at the end of the graph.
    const c = compileProject(project(), { output: "o.mp4", hardwareEncoder: "vaapi" });
    const device = c.args.indexOf("-init_hw_device");
    expect(device).toBeGreaterThan(-1);
    expect(device).toBeLessThan(c.args.indexOf("-filter_complex_script"));
    expect(c.args).toEqual(expect.arrayContaining(["-c:v", "h264_vaapi", "-rc_mode", "CQP"]));
    expect(c.filterGraph).toMatch(/format=nv12,hwupload\[[^\]]+\]$/);
    expect(hardwareTestArgs("vaapi")).toEqual(expect.arrayContaining(["-vf", "format=nv12,hwupload"]));
    // 10-bit and ProRes exports encode in software, without the device.
    const ten = compileProject({ ...project(), export: { ...project().export, bitDepth: 10 } }, { output: "o.mp4", hardwareEncoder: "vaapi" });
    expect(ten.args).not.toContain("-init_hw_device");
    expect(ten.filterGraph).not.toMatch(/hwupload/);
    expect(ten.args).toContain("libx264");
    // Single frames never upload.
    expect(compileProject(project(), { output: "f.png", frameAt: 0.5, hardwareEncoder: "vaapi" }).filterGraph).not.toMatch(/hwupload/);
  });
});

describe("render cache files", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
  const tmp = async () => {
    const d = await mkdtemp(path.join(tmpdir(), "ave-cache-"));
    dirs.push(d);
    return d;
  };

  it("keys a clip by what shapes its picture, not by where it sits", async () => {
    const cacheDir = await tmp();
    const files = async (p: ReturnType<typeof project>) => (await planSegments(p, { cacheDir })).map((x) => path.basename(x.file));
    const [a, b] = await files(project());
    expect(a).not.toBe(b);
    // Moving clip b later (a longer clip before it) keeps its entry.
    expect((await files(project({ clips: [{ id: "a", assetId: "v", in: 0, duration: 4 }, project().clips[1]] })))[1]).toBe(b);
    // Changing its effect, the preview scale or a per-frame global effect gives a new one.
    expect((await files(project({ clips: [project().clips[0], { ...project().clips[1], effects: [] }] })))[1]).not.toBe(b);
    expect(path.basename((await planSegments(project(), { cacheDir, scale: 0.5 }))[1]!.file)).not.toBe(b);
    expect((await files(project({ effects: [{ type: "glow" }] })))[1]).not.toBe(b);
    // Global effects that stay on the joined video do not matter.
    expect((await files(project({ effects: [{ type: "color", params: { contrast: 20 } }, { type: "glow" }, { type: "vignette" }] })))[1]).not.toBe(b);
    expect((await files(project({ effects: [{ type: "color", params: { contrast: 20 } }, { type: "glow" }, { type: "flashHits" }] })))[1]).toBe(b);
  });

  it("prunes the least recently used entries over the size limit", async () => {
    const cacheDir = await tmp();
    const names = ["a", "b", "c"].map((c) => `${c.repeat(32)}.mkv`);
    for (const [i, n] of names.entries()) {
      await writeFile(path.join(cacheDir, n), Buffer.alloc(1000));
      const t = new Date(Date.now() - (3 - i) * 60_000); // a oldest, c newest
      await utimes(path.join(cacheDir, n), t, t);
    }
    const stale = path.join(cacheDir, `${"d".repeat(32)}.123-x.part.mkv`);
    await writeFile(stale, "x");
    const old = new Date(Date.now() - 2 * 3600_000);
    await utimes(stale, old, old);
    await pruneCache(cacheDir, 2500);
    expect((await readdir(cacheDir)).sort()).toEqual([names[1], names[2]]);
  });
});
