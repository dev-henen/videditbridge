import { describe, expect, it } from "vitest";
import { computeTimeline, parseProject, sourceToTimeline, speedMap, splitClip, timelineToSource, type Keyframe } from "../src/core/index.js";
import { effectStates, isPerFrame } from "../src/library/index.js";
import { compileProject } from "../src/tools/index.js";
import { EditorSession, executeTool } from "../src/claude/index.js";

const k = (time: number, value: number, easing: Keyframe<number>["easing"] = "linear"): Keyframe<number> => ({ time, value, easing });

const ramped = (keys: Keyframe<number>[], extra: Record<string, unknown> = {}) =>
  parseProject({
    settings: { width: 320, height: 180, fps: 25 },
    assets: [{ type: "video", id: "v", src: "v.mp4", duration: 20, hasAudio: true, width: 320, height: 180 }],
    clips: [{ id: "a", assetId: "v", in: 2, duration: 4, keyframes: { speed: keys }, ...extra }, { id: "b", assetId: "v", in: 10, duration: 1 }],
  });

describe("speed ramps", () => {
  it("integrates the speed curve into timeline time, both ways", () => {
    // Speed falls linearly from 1 to 0.5 over 2 s of footage: the integral of 1/(1-u/4) is -4 ln(1-u/4).
    const m = speedMap({ id: "x", keyframes: { speed: [k(0, 1), k(2, 0.5)] } } as never, 2)!;
    expect(m.duration).toBeCloseTo(-4 * Math.log(0.5), 3);
    expect(m.toTimeline(1)).toBeCloseTo(-4 * Math.log(0.75), 3);
    for (const t of [0.3, 1.1, 2.5]) expect(m.toTimeline(m.toSource(t))).toBeCloseTo(t, 4);
    // Past the end it continues at the last speed.
    expect(m.toTimeline(3)).toBeCloseTo(m.duration + 2, 3);
    expect(speedMap({ id: "x", keyframes: { speed: [k(0, 2)] } } as never, 4)!.duration).toBeCloseTo(2, 4);
  });

  it("sets the clip's length and maps source to timeline through the ramp", () => {
    const p = ramped([k(0, 2), k(1, 2), k(2, 0.5), k(3, 0.5), k(4, 1)]);
    const tl = computeTimeline(p);
    const [a, b] = tl.clips;
    // 1 s at 2x (0.5 s), a ramp down, 1 s at 0.5x (2 s), a ramp up.
    expect(a!.duration).toBeGreaterThan(4);
    expect(b!.start).toBeCloseTo(a!.end, 3);
    expect(sourceToTimeline(a!, 3)).toBeCloseTo(0.5, 3);
    expect(sourceToTimeline(a!, 5) - sourceToTimeline(a!, 4)).toBeCloseTo(2, 3);
    expect(timelineToSource(a!, sourceToTimeline(a!, 4.2))).toBeCloseTo(4.2, 4);
    expect(tl.clips.find((c) => c.clip.id === "b")!.speedMap).toBeUndefined();
  });

  it("splits a ramped clip without changing how it plays", () => {
    const p = ramped([k(0, 2), k(2, 0.5, "ease-in-out"), k(4, 1)], { keyframes: { speed: [k(0, 2), k(2, 0.5, "ease-in-out"), k(4, 1)], focus: [{ time: 0, value: { x: 0, y: 0.5 }, easing: "linear" }, { time: 5, value: { x: 1, y: 0.5 }, easing: "linear" }] } });
    const before = computeTimeline(p);
    const at = before.clips[0]!.start + before.clips[0]!.duration * 0.4;
    const { project, newClipId } = splitClip(p, "a", at);
    const after = computeTimeline(project);
    expect(after.primaryDuration).toBeCloseTo(before.primaryDuration, 2);
    const second = project.clips.find((c) => c.id === newClipId)!;
    // The second piece starts at the speed and crop the whole clip had at the split.
    const splitSource = timelineToSource(before.clips[0]!, at) - 2;
    const speedThen = before.clips[0]!.speedMap!.speedAt(splitSource);
    expect(second.keyframes!.speed![0]!.value).toBeCloseTo(speedThen, 2);
    expect(second.keyframes!.focus![0]!.value.x).toBeCloseTo(at / 5, 2);
    expect(second.keyframes!.speed!.every((x) => x.time >= 0)).toBe(true);
  });

  it("retimes picture with setpts and sound with tempo commands", () => {
    const p = ramped([k(0, 1), k(2, 0.4), k(4, 1)]);
    const plain = compileProject(p, { output: "o.mp4" });
    expect(plain.filterGraph).toMatch(/setpts='\(if\(lt\(T,/);
    const cmd = plain.files.find((f) => f.name === "ramp0.cmd")!;
    // Below 0.5x, two atempo filters each take the square root.
    expect(plain.filterGraph).toMatch(/asendcmd=f=ramp0\.cmd,atempo@ramp0a=tempo=[\d.]+,atempo@ramp0b=tempo=/);
    expect(cmd.content.split("\n")[0]).toMatch(/^0 \[enter\] atempo@ramp0a tempo [\d.]+, atempo@ramp0b tempo [\d.]+;$/);
    const rb = compileProject(p, { output: "o.mp4", rubberband: true });
    expect(rb.filterGraph).toMatch(/asendcmd=f=ramp0\.cmd,rubberband@ramp0=tempo=/);
    expect(rb.files.find((f) => f.name === "ramp0.cmd")!.content).toMatch(/rubberband@ramp0 tempo 0\.4/);
  });

  it("speed_ramp reports the new timing, and set_speed replaces the ramp", async () => {
    const s = new EditorSession(ramped([k(0, 1)]));
    const r = await executeTool(s, "speed_ramp", { clipId: "a", keyframes: [{ time: 0, speed: 2 }, { time: 2, speed: 0.5 }, { time: 4, speed: 1 }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/2x at 00:00\.0, 0\.5x at/);
    expect((await executeTool(s, "speed_ramp", { clipId: "a", keyframes: [{ time: 9, speed: 2 }] })).text).toMatch(/past the clip's footage/);
    await executeTool(s, "set_speed", { target: "a", speed: 1.5 });
    expect(s.project.clips[0]!.keyframes).toBeUndefined();
    expect(computeTimeline(s.project).clips[0]!.duration).toBeCloseTo(4 / 1.5, 2);
  });
});

describe("effect settings over time", () => {
  it("moves numbers through in-between states and switches other settings", () => {
    const states = effectStates({ type: "blur", params: { amount: 0 }, keyframes: [{ time: 1, params: { amount: 0 }, easing: "linear" }, { time: 3, params: { amount: 40 }, easing: "linear" }] });
    expect(states.map((s) => s.time)).toEqual([1, 1.4, 1.8, 2.2, 2.6, 3]);
    expect(states.map((s) => s.params.amount)).toEqual([0, 8, 16, 24, 32, 40]);
    // Nested settings (color wheels) move too.
    const color = effectStates({ type: "color", keyframes: [{ time: 0, params: { wheels: { shadows: { hue: 200, amount: 0 } } }, easing: "linear" }, { time: 2, params: { wheels: { shadows: { hue: 200, amount: 50 } } }, easing: "linear" }] });
    expect((color[1]!.params.wheels as { shadows: { amount: number } }).shadows.amount).toBe(10);
    // A setting with nothing numeric changing is a straight cross-fade between two looks.
    expect(effectStates({ type: "lut", params: { file: "a.cube" }, keyframes: [{ time: 0, params: {}, easing: "linear" }, { time: 1, params: { file: "b.cube" }, easing: "ease-out" }] })).toHaveLength(2);
    expect(isPerFrame({ type: "blur", keyframes: [{ time: 0, params: {}, easing: "linear" }] })).toBe(false);
  });

  it("renders a ramp as blended copies of the effect", () => {
    const p = parseProject({
      settings: { width: 320, height: 180, fps: 25 },
      assets: [{ type: "video", id: "v", src: "v.mp4", duration: 20 }],
      clips: [{ id: "a", assetId: "v", duration: 4, effects: [{ type: "blur", keyframes: [{ time: 1, params: { amount: 0 } }, { time: 3, params: { amount: 30 } }] }] }],
    });
    const g = compileProject(p, { output: "o.mp4" }).filterGraph;
    expect(g).toMatch(/split=6/);
    expect(g.match(/maskedmerge/g)).toHaveLength(5);
    expect(g).toMatch(/geq=lum='255\*clip\(\(T-1\)\/0\.4,0,1\)'/);
  });

  it("animate_effect takes timeline times and checks the settings", async () => {
    const s = new EditorSession(
      parseProject({
        assets: [{ type: "video", id: "v", src: "v.mp4", duration: 20 }],
        clips: [{ id: "x", assetId: "v", duration: 2 }, { id: "a", assetId: "v", in: 5, duration: 4, effects: [{ type: "blur", params: { amount: 5 } }] }],
      }),
    );
    const r = await executeTool(s, "animate_effect", { target: "a", type: "blur", keyframes: [{ time: 2.5, params: { amount: 0 } }, { time: 5, params: { amount: 30 }, easing: "ease-in" }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(s.project.clips[1]!.effects[0]!.keyframes!.map((x) => x.time)).toEqual([0.5, 3]);
    expect((await executeTool(s, "animate_effect", { target: "a", type: "blur", keyframes: [{ time: 3, params: { sigma: 3 } }] })).text).toMatch(/blur has no setting sigma\. Its settings: amount/);
    expect((await executeTool(s, "animate_effect", { target: "a", type: "vignette", keyframes: [{ time: 3, params: {} }] })).text).toMatch(/has no vignette effect/);
    await executeTool(s, "animate_effect", { target: "a", type: "blur", keyframes: null });
    expect(s.project.clips[1]!.effects[0]!.keyframes).toBeUndefined();
  });
});
