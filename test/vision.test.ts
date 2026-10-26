import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FACE_INPUT, FaceDetector, decodeYunet, faceRegion, focusOn, parseProbeOutput, personRegion, sourceToFrame, trackFaces, type Face, type FaceFrame } from "../src/tools/index.js";

/** YuNet outputs with one confident face at a grid cell of the coarsest scale. */
function outputs(cells: { stride: number; row: number; col: number; w: number; h: number; score?: number }[]) {
  const out: Record<string, Float32Array> = {};
  for (const s of [8, 16, 32]) {
    const n = (FACE_INPUT / s) ** 2;
    out[`cls_${s}`] = new Float32Array(n);
    out[`obj_${s}`] = new Float32Array(n);
    out[`bbox_${s}`] = new Float32Array(n * 4);
    out[`kps_${s}`] = new Float32Array(n * 10);
  }
  for (const c of cells) {
    const i = c.row * (FACE_INPUT / c.stride) + c.col;
    out[`cls_${c.stride}`]![i] = c.score ?? 0.9;
    out[`obj_${c.stride}`]![i] = c.score ?? 0.9;
    // Center at the cell's corner (offset 0), size as given in pixels.
    out[`bbox_${c.stride}`]!.set([0, 0, Math.log(c.w / c.stride), Math.log(c.h / c.stride)], i * 4);
  }
  return out;
}

const face = (x0: number, y0: number, x1: number, y1: number): Face => ({ x0, y0, x1, y1, score: 0.9, landmarks: [] });

describe("face detection output", () => {
  it("decodes boxes into fractions of the picture inside the padded input", () => {
    // A 640x360 picture at the top left of the 640 square; face centered at (320, 192), 64x96 px.
    const faces = decodeYunet(outputs([{ stride: 32, row: 6, col: 10, w: 64, h: 96 }]), { width: 640, height: 360 });
    expect(faces).toHaveLength(1);
    expect(faces[0]).toMatchObject({ x0: 0.45, x1: 0.55, y0: 0.4, y1: 0.667, score: 0.9 });
    expect(faces[0]!.landmarks).toHaveLength(5);
  });

  it("keeps the best of overlapping boxes and drops weak ones", () => {
    const faces = decodeYunet(
      outputs([
        { stride: 32, row: 6, col: 10, w: 64, h: 96, score: 0.95 },
        { stride: 16, row: 12, col: 20, w: 60, h: 90, score: 0.8 }, // same face, other scale
        { stride: 8, row: 10, col: 10, w: 20, h: 20, score: 0.3 }, // too weak
      ]),
      { width: 640, height: 640 },
    );
    expect(faces.map((f) => f.score)).toEqual([0.95]);
  });
});

const round = (v: number) => Math.round(v * 1000) / 1000;

describe("following faces", () => {
  it("links faces frame to frame into one track per person and drops one-frame noise", () => {
    const frames: FaceFrame[] = [0, 0.5, 1, 1.5, 2].map((time, k) => ({
      time,
      faces: [
        face(0.1 + k * 0.02, 0.2, 0.2 + k * 0.02, 0.4), // walks right
        face(0.7, 0.3, 0.8, 0.5), // stands still
        ...(k === 2 ? [face(0.45, 0.8, 0.47, 0.82)] : []), // a false detection
      ],
    }));
    const tracks = trackFaces(frames);
    expect(tracks).toHaveLength(2);
    const walker = tracks.find((t) => t.box.x0 < 0.5)!;
    expect(walker.frames).toHaveLength(5);
    expect(walker.start).toBe(0);
    expect(walker.end).toBe(2);
    expect(walker.extent.x0).toBeCloseTo(0.1);
    expect(walker.extent.x1).toBeCloseTo(0.28);
    expect(walker.box.x0).toBeCloseTo(0.14);
  });

  it("starts a new track after a long gap", () => {
    const frames: FaceFrame[] = [{ time: 0, faces: [face(0.4, 0.4, 0.5, 0.5)] }, { time: 0.5, faces: [face(0.4, 0.4, 0.5, 0.5)] }, { time: 5, faces: [face(0.4, 0.4, 0.5, 0.5)] }, { time: 5.5, faces: [face(0.4, 0.4, 0.5, 0.5)] }];
    expect(trackFaces(frames).map((t) => [t.start, t.end])).toEqual([[0, 0.5], [5, 5.5]]);
  });
});

describe("faces in the edit's frame", () => {
  const src = { width: 1920, height: 1080 };
  const vertical = { width: 1080, height: 1920 };

  it("maps through cover crops, focus and letterboxing", () => {
    // 16:9 into 9:16 cover: the visible part is the middle 31.6% of the source width.
    const centered = sourceToFrame({ x0: 0.45, y0: 0.4, x1: 0.55, y1: 0.6 }, src, vertical, "cover");
    expect(centered!.x0).toBeCloseTo(0.5 - 0.05 / 0.3164, 2);
    expect(centered!.y0).toBeCloseTo(0.4);
    expect(sourceToFrame({ x0: 0.05, y0: 0.4, x1: 0.1, y1: 0.6 }, src, vertical, "cover")).toBeUndefined();
    const left = sourceToFrame({ x0: 0.05, y0: 0.4, x1: 0.1, y1: 0.6 }, src, vertical, "cover", { x: 0, y: 0.5 });
    expect(left!.x0).toBeCloseTo(0.05 / 0.3164, 2);
    const boxed = sourceToFrame({ x0: 0, y0: 0, x1: 1, y1: 1 }, src, vertical, "contain")!;
    expect(boxed.x0).toBe(0);
    expect(boxed.y1 - boxed.y0).toBeCloseTo(0.3164, 3);
  });

  it("chooses a focus that centers a face where the crop allows", () => {
    expect(focusOn({ x0: 0.25, y0: 0.4, x1: 0.35, y1: 0.6 }, src, vertical)).toEqual({ x: round((0.3 * (1 / 0.31640625) - 0.5) / (1 / 0.31640625 - 1)), y: 0.5 });
    expect(focusOn({ x0: 0, y0: 0.4, x1: 0.05, y1: 0.6 }, src, vertical).x).toBe(0);
    expect(focusOn({ x0: 0.9, y0: 0.4, x1: 1, y1: 0.6 }, src, vertical).x).toBe(1);
    // Same shape: nothing to crop, so the focus does not matter.
    expect(focusOn({ x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, src, src)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("builds ellipses for a face and for the person below it", () => {
    const f = { x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.4 };
    expect(faceRegion(f)).toEqual({ x: 0.5, y: 0.3, width: 0.3, height: 0.3 });
    const p = personRegion(f);
    expect(p.x).toBe(0.5);
    expect(p.width).toBeCloseTo(0.68);
    expect(p.y - p.height / 2).toBeLessThan(0.2); // covers the top of the head
    expect(p.y + p.height / 2).toBeGreaterThan(1); // and down to the bottom of the frame
  });
});

describe("probing phone video", () => {
  it("reports the upright size of video stored sideways", () => {
    const stderr = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:00:56.76, start: 0.000000, bitrate: 28230 kb/s
  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 27961 kb/s, 40.58 fps, 29.98 tbr, 90k tbn (default)
      Side data:
      displaymatrix: rotation of 90.00 degrees
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 256 kb/s (default)`;
    expect(parseProbeOutput(stderr)).toMatchObject({ width: 1080, height: 1920, hasVideo: true, hasAudio: true });
    expect(parseProbeOutput(stderr.replace("rotation of 90.00", "rotation of -180.00"))).toMatchObject({ width: 1920, height: 1080 });
  });
});

// Real footage lives in the local sample projects (not in the repository) and the model downloads on first use.
const footage = path.resolve("projects/earphone-tips/media/779-earbuds-jog-prep.mp4");
const detector = new FaceDetector();
const ready = existsSync(footage) && (await detector.detectRgb(new Uint8Array(64 * 64 * 3), 64, 64).then(() => true, () => false));

describe.skipIf(!ready)("face detection on real footage", () => {
  it("finds and follows the person in a clip", async () => {
    const r = await detector.detectFile(footage, { start: 0, end: 4, fps: 2 });
    expect(r).toMatchObject({ width: 1920, height: 1080 });
    expect(r.frames).toHaveLength(8);
    expect(r.frames.filter((f) => f.faces.length === 1).length).toBeGreaterThanOrEqual(7);
    const [track] = trackFaces(r.frames);
    expect(track!.box.x0).toBeGreaterThan(0.2);
    expect(track!.box.x1).toBeLessThan(0.45);
  });
});
