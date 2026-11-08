import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { trackObject } from "../../engine/tools/vision/objects.js";
import { enginePath, renderForAnalysis, renderFrame, runFfmpegOrThrow } from "../../engine/tools/index.js";
import { addAsset, addLayer } from "../../engine/core/index.js";
import { EditorSession, executeTool } from "../../engine/claude/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
/** SAM 2.1 runs through the optional transformers.js package (its model downloads on first use). */
const hasModels = await import("@huggingface/transformers").then(() => true, () => false);

// A textured object (160 x 120 of a 640 x 360 frame) moving along a known path over a textured background.
const [W, H, OW, OH, SECONDS] = [640, 360, 160, 120, 4];
const pathAt = (t: number) => ({ x: 60 + 90 * t, y: 120 + 60 * Math.sin(t * 1.5) });

describe.skipIf(!hasFfmpeg || !hasModels)("selecting and tracking objects", () => {
  const clip = path.join(OUT_DIR, "fixtures", "moving-object.mp4");
  beforeAll(async () => {
    if (existsSync(clip)) return;
    await runFfmpegOrThrow([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `cellauto=s=${W}x${H}:rule=110:r=30,format=gray,format=yuv420p,trim=duration=${SECONDS}`,
      "-f", "lavfi", "-i", `testsrc2=s=${OW}x${OH}:r=30:d=${SECONDS}`,
      "-filter_complex", "[0:v]setpts=PTS-STARTPTS,boxblur=1[bg];[1:v]setpts=PTS-STARTPTS[obj];[bg][obj]overlay=x='60+90*t':y='120+60*sin(t*1.5)':shortest=1,format=yuv420p",
      "-t", String(SECONDS), "-c:v", "libx264", "-crf", "16", clip,
    ]);
  });

  // About a minute alone; the full suite runs other model tests beside it.
  it("follows a moving object with IoU 0.85 and little flicker", { timeout: 240_000 }, async () => {
    const p0 = pathAt(0);
    const r = await trackObject(clip, { start: 0, end: SECONDS, fps: 30, time: 0, prompt: { box: { x0: p0.x / W, y0: p0.y / H, x1: (p0.x + OW) / W, y1: (p0.y + OH) / H } } });
    expect(r.masks.length).toBeGreaterThanOrEqual(SECONDS * 30 - 1);
    const [mw, mh] = [r.width, r.height];
    let worst = 1;
    let sum = 0;
    for (let f = 0; f < r.masks.length; f++) {
      const { x, y } = pathAt(f / 30);
      const [x0, y0, x1, y1] = [(x / W) * mw, (y / H) * mh, ((x + OW) / W) * mw, ((y + OH) / H) * mh];
      let inter = 0;
      let union = 0;
      for (let py = 0; py < mh; py++)
        for (let px = 0; px < mw; px++) {
          const truth = px + 0.5 >= x0 && px + 0.5 < x1 && py + 0.5 >= y0 && py + 0.5 < y1;
          const got = r.masks[f]![py * mw + px]! >= 128;
          if (truth && got) inter++;
          if (truth || got) union++;
        }
      const iou = inter / union;
      worst = Math.min(worst, iou);
      sum += iou;
    }
    expect(sum / r.masks.length, "mean IoU").toBeGreaterThanOrEqual(0.85);
    expect(worst, "worst frame IoU").toBeGreaterThanOrEqual(0.7);
    // Flicker: mean change between frames where the mask is clearly on or off in both.
    let change = 0;
    let count = 0;
    for (let f = 1; f < r.masks.length; f++)
      for (let q = 0; q < mw * mh; q += 2) {
        const [a, b] = [r.masks[f - 1]![q]!, r.masks[f]![q]!];
        if ((a > 230 && b > 230) || (a < 25 && b < 25)) {
          change += Math.abs(a - b);
          count++;
        }
      }
    expect(change / count / 255, "flicker").toBeLessThan(0.02);
  });

  it("selects, tracks and grades an object through the tools", async () => {
    const session = new EditorSession(undefined, { outputDir: path.join(OUT_DIR, "objects-session") });
    await executeTool(session, "new_project", { aspectRatio: "16:9" });
    await executeTool(session, "import_media", { src: clip, id: "shot" });
    await executeTool(session, "add_clip", { assetId: "shot", duration: 2 });
    const p0 = pathAt(0.5);
    const selected = await executeTool(session, "select_object", { time: 0.5, box: { x0: p0.x / W, y0: p0.y / H, x1: (p0.x + OW) / W, y1: (p0.y + OH) / H }, label: "card" });
    expect(selected.isError, selected.text).toBeFalsy();
    expect(Object.keys(session.project.objects)).toEqual(["card"]);
    expect(existsSync(selected.images![0]!.path)).toBe(true);
    const tracked = await executeTool(session, "track_object", { objectId: "card" });
    expect(tracked.isError, tracked.text).toBeFalsy();
    expect(tracked.text).toMatch(/frames, \d+ segmented/);
    const clipId = session.project.clips[0]!.id;
    const graded = await executeTool(session, "grade_region", { target: clipId, label: "card pop", mask: { kind: "object", object: "card" }, color: { saturation: 40 } });
    expect(graded.isError, graded.text).toBeFalsy();
    const view = await executeTool(session, "render_mask", { target: clipId, label: "card pop", time: 1 });
    expect(view.isError, view.text).toBeFalsy();
    const frame = await executeTool(session, "render_frame", { time: 1 });
    expect(frame.isError, frame.text).toBeFalsy();
    const wrong = await executeTool(session, "grade_region", { target: clipId, label: "nope", mask: { kind: "object", object: "missing" }, color: { saturation: 10 } });
    expect(wrong.isError).toBe(true);

    // A red layer over the whole frame, behind the card: the card stays in front, the rest turns red.
    let p = addAsset(session.project, { type: "color", id: "red", color: "#E02020" });
    p = addLayer(p, { type: "media", assetId: "red", start: 0, duration: 2, size: { width: 1, height: 1 }, behindObject: "card" });
    for (const t of [0.4, 1.4]) {
      const r = await renderForAnalysis(p, { ...session.renderOptions, framesAt: [t], probe: false });
      const [f, fw, fh] = [r.frames[0]!, r.width, r.height];
      const at = (x: number, y: number) => [0, 1, 2].map((c) => f.rgb[(Math.round((y / H) * fh) * fw + Math.round((x / W) * fw)) * 3 + c]!);
      const { x, y } = pathAt(t);
      const card = at(x + OW / 2, y + OH / 2);
      const away = at(x > W / 2 ? 40 : W - 40, 30);
      // The card's own picture (testsrc2 is not a flat red), and red away from it.
      expect(card[0]! - card[1]! < 150 || card[2]! > 60, `card at ${t}s: ${card}`).toBe(true);
      expect(away[0], `away at ${t}s`).toBeGreaterThan(180);
      expect(away[1], `away at ${t}s`).toBeLessThan(80);
    }
    // On the GPU engine (when built) the layer is drawn by the FFmpeg backend as a piece, with the same matte.
    if (enginePath()) {
      const png = path.join(OUT_DIR, "objects-session", "behind-object-engine.png");
      await renderFrame(p, 1.4, { ...session.renderOptions, output: png, backend: "engine" });
      const { stdoutBuffer } = await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binaryStdout: true });
      const [fw, fh] = [p.settings.width, p.settings.height];
      const at = (x: number, y: number) => [0, 1, 2].map((c) => stdoutBuffer![(Math.round((y / H) * fh) * fw + Math.round((x / W) * fw)) * 3 + c]!);
      const { x, y } = pathAt(1.4);
      const card = at(x + OW / 2, y + OH / 2);
      expect(card[0]! - card[1]! < 150 || card[2]! > 60, `engine card: ${card}`).toBe(true);
      expect(at(40, 30)[0]).toBeGreaterThan(180);
    }
  }, 240_000);
});
