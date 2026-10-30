import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runFfmpegOrThrow } from "../../engine/tools/index.js";
import { trackSky } from "../../engine/tools/vision/sky.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
/** The sky model runs through the optional onnxruntime-node package (its model downloads on first use). */
const hasOrt = await import("onnxruntime-node" as string).then(() => true, () => false);

// A tall scene (pale sky over textured green ground with a wavy skyline), seen through a 640 x 360
// window that pans right 30 px and down 20 px a second: the scenery moves left and up by that much.
const [SW, SH, W, H, SECONDS] = [960, 720, 640, 360, 3];
const skyline = (x: number) => 330 + 30 * Math.sin(x / 50);
const windowAt = (t: number) => ({ x: 100 + 30 * t, y: 100 + 20 * t });

describe.skipIf(!hasFfmpeg || !hasOrt)("finding the sky", () => {
  const dir = path.join(OUT_DIR, "sky-pan");
  const clip = path.join(dir, "pan.mp4");
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    if (existsSync(clip)) return;
    const still = path.join(dir, "scene.png");
    await runFfmpegOrThrow([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `nullsrc=s=${SW}x${SH},geq=r='if(lt(Y,330+30*sin(X/50)),150+Y*0.1,40+25*sin(X/3)*sin(Y/4))':g='if(lt(Y,330+30*sin(X/50)),190+Y*0.05,110+30*sin(X/5+Y/7))':b='if(lt(Y,330+30*sin(X/50)),235,40+15*sin(X/4))'`,
      "-frames:v", "1", still,
    ]);
    await runFfmpegOrThrow([
      "-y", "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-framerate", "30", "-i", still,
      "-vf", `crop=${W}:${H}:x='100+30*t':y='100+20*t',format=yuv420p`,
      "-t", String(SECONDS), "-c:v", "libx264", "-crf", "12", clip,
    ]);
  });

  it("finds the sky to the pixel and measures the camera's pan", async () => {
    const raw = path.join(dir, "mask.gray");
    const t0 = performance.now();
    const track = await trackSky(clip, raw, { start: 0, end: SECONDS, fps: 30 });
    const seconds = (performance.now() - t0) / 1000;
    const masks = readFileSync(raw);
    const [w, h] = [track.width, track.height];
    expect([w, h]).toEqual([W, H]);
    expect(track.share.length).toBe(SECONDS * 30);
    let worstIou = 1;
    let worstEdge = 0;
    for (let f = 0; f < track.share.length; f += 7) {
      const win = windowAt(f / 30);
      let [inter, union] = [0, 0];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const truth = y + win.y < skyline(x + win.x);
          const got = masks[f * w * h + y * w + x]! >= 128;
          if (truth && got) inter++;
          if (truth || got) union++;
        }
      worstIou = Math.min(worstIou, inter / union);
      // The edge, down every 8th column.
      for (let x = 4; x < w; x += 8) {
        let edge = h;
        for (let y = 0; y < h; y++)
          if (masks[f * w * h + y * w + x]! < 128) {
            edge = y;
            break;
          }
        worstEdge = Math.max(worstEdge, Math.abs(edge - (skyline(x + win.x) - win.y)));
      }
    }
    // The pan: where the scenery has gone by the end, against the window's true motion.
    const end = track.motion.length - 1;
    const [, , tx, , , ty] = track.motion[end]!;
    const truth = { x: -(windowAt(end / 30).x - windowAt(0).x), y: -(windowAt(end / 30).y - windowAt(0).y) };
    const drift = Math.hypot(tx! - truth.x, ty! - truth.y);
    console.error(`sky: ${track.share.length} frames in ${seconds.toFixed(1)} s, worst IoU ${worstIou.toFixed(3)}, worst edge ${worstEdge.toFixed(1)} px, pan drift ${drift.toFixed(2)} px over ${SECONDS} s`);
    expect(worstIou, "worst frame IoU").toBeGreaterThan(0.98);
    expect(worstEdge, "worst edge error, px").toBeLessThanOrEqual(2);
    expect(drift, "pan drift, px").toBeLessThan(1.5);
    expect(track.colors.sky).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("replaces the sky through the tool, moving the new sky with the pan", async () => {
    const s = new EditorSession(undefined, { outputDir: path.join(dir, "session") });
    await executeTool(s, "new_project", { aspectRatio: "16:9" });
    await executeTool(s, "set_project_settings", { width: W, height: H, fps: 30 });
    await executeTool(s, "import_media", { src: clip, id: "pan" });
    await executeTool(s, "add_clip", { assetId: "pan" });
    const r = await executeTool(s, "replace_sky", { colors: ["#E05020", "#F0A060"] });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.images?.length).toBe(1);
    const fx = s.project.clips[0]!.effects[0]!;
    expect(fx.type).toBe("skyReplace");
    const motion = (fx.params as { motion: { time: number; x: number; y: number }[] }).motion;
    const last = motion[motion.length - 1]!;
    // The scenery's pan, in frame fractions: about -90/640 across and -60/360 down after 3 s.
    expect(last.x * W).toBeCloseTo(-30 * last.time, 0);
    expect(last.y * H).toBeCloseTo(-20 * last.time, 0);
    expect((fx.params as { cover: number }).cover).toBeGreaterThan(1.3);
    // Remove takes it out again.
    await executeTool(s, "replace_sky", { remove: true });
    expect(s.project.clips[0]!.effects.some((e) => e.type === "skyReplace")).toBe(false);
  });
});
