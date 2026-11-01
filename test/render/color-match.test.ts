import { describe, expect, it } from "vitest";
import {
  SKIN_LINE,
  deltaE2000,
  getEffect,
  oklabToRgb,
  rgbToLab,
  rgbToOklab,
  transferRgb,
  vectorscopeHue,
  type ColorTransfer,
  type Vec3,
} from "../../engine/library/effects/index.js";
import { distributionDeltaE, fitTransfer, matchShot } from "../../engine/tools/render/color-transfer.js";
import { runFfmpegOrThrow } from "../../engine/tools/render/ffmpeg.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OUT_DIR } from "../helpers/media.js";

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** A picture with a sky, foliage, a warm wall, deep shadows, highlights and a face (w x h, row by row). */
function scene(w = 120, h = 80, frame = 0): { colors: Vec3[]; skin: Vec3[] } {
  const colors: Vec3[] = [];
  const skin: Vec3[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [u, v] = [(x + frame * 3) / w, y / h];
      const n = 0.06 * Math.sin(x * 0.7 + y * 1.3) * Math.cos(x * 0.3 - y * 0.9);
      let c: Vec3;
      if (v < 0.35) c = [0.35 + 0.2 * v, 0.55 + 0.2 * v, 0.85 - 0.1 * u];
      else if (v < 0.7 && u % 1 < 0.45) c = [0.18 + n, 0.38 + 0.2 * v + n, 0.12 + n];
      else if (v < 0.7) c = [0.72 + n, 0.5 + 0.3 * (u % 1) + n, 0.32 + n];
      else c = [0.05 + 0.5 * (u % 1) * (1 - v), 0.05 + 0.45 * (u % 1) * (1 - v), 0.06 + 0.4 * (u % 1) * (1 - v)];
      if (Math.hypot(x - w * 0.62, (y - h * 0.55) * 1.3) < h * 0.14) {
        c = [0.78 + n, 0.56 + n, 0.45 + n];
        skin.push(c);
      }
      colors.push(c.map((k) => Math.min(1, Math.max(0, k))) as Vec3);
    }
  return { colors, skin };
}

/** A known grade: exposure down (stops), white balance warmer, saturation down. */
function grade([r, g, b]: Vec3, { stops = -0.6, warm = 0.12, desaturate = 0.3 } = {}): Vec3 {
  const k = 2 ** stops;
  let [lr, lg, lb] = [lin(r) * k * (1 + warm), lin(g) * k, lin(b) * k * (1 - warm)];
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  [lr, lg, lb] = [lr + desaturate * (y - lr), lg + desaturate * (y - lg), lb + desaturate * (y - lb)];
  return [gam(lr), gam(lg), gam(lb)];
}

const meanDeltaE = (a: Vec3[], b: Vec3[]) => a.reduce((s, c, k) => s + deltaE2000(rgbToLab(c), rgbToLab(b[k]!)), 0) / a.length;

describe("color science", () => {
  it("round-trips Oklab and gives the published Oklab of white and red", () => {
    for (const c of [[0.2, 0.5, 0.9], [1, 1, 1], [0.03, 0.01, 0.2], [0.8, 0.56, 0.45]] as Vec3[]) {
      oklabToRgb(rgbToOklab(c)).forEach((v, k) => expect(v).toBeCloseTo(c[k]!, 5));
    }
    rgbToOklab([1, 1, 1]).forEach((v, k) => expect(v).toBeCloseTo([1, 0, 0][k]!, 4));
    rgbToOklab([1, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo([0.62796, 0.22486, 0.12585][k]!, 4));
  });

  it("matches the CIEDE2000 reference pairs of Sharma, Wu and Dalal", () => {
    const pairs: [Vec3, Vec3, number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
      [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    ];
    for (const [a, b, d] of pairs) expect(deltaE2000(a, b)).toBeCloseTo(d, 3);
  });

  it("puts typical skin near the vectorscope skin line", () => {
    expect(Math.abs(vectorscopeHue([0.78, 0.56, 0.45]) - SKIN_LINE)).toBeLessThan(6);
  });
});

describe("shot matching", () => {
  const original = [0, 1, 2].map((f) => scene(120, 80, f));
  const reference = original.flatMap((f) => f.colors);

  it("undoes a known grade to under 2 ΔE 2000 (design 4.3)", () => {
    for (const g of [{}, { stops: -1, warm: 0, desaturate: 0 }, { stops: 0.3, warm: -0.15, desaturate: 0.4 }]) {
      const shot = { frames: original.map((f) => f.colors.map((c) => grade(c, g))), skin: original[1]!.skin.map((c) => grade(c, g)) };
      const m = matchShot(shot, reference);
      expect(m.scores[m.method]!).toBeLessThan(m.scores.unchanged);
      const apply = (c: Vec3) => (m.params.transfer ? transferRgb(m.params.transfer, c) : c);
      const before = meanDeltaE(shot.frames[1]!, original[1]!.colors);
      const after = meanDeltaE(shot.frames[1]!.map(apply), original[1]!.colors);
      expect(m.method).not.toBe("curves");
      expect(before).toBeGreaterThan(4);
      expect(after).toBeLessThan(2);
      // Skin stays on the skin line.
      const skin = shot.skin.map(apply);
      const mean = [0, 1, 2].map((k) => skin.reduce((s, c) => s + c[k]!, 0) / skin.length) as Vec3;
      expect(Math.abs(vectorscopeHue(mean) - SKIN_LINE)).toBeLessThan(5);
    }
  });

  it("turns hues at most 15 degrees unless allowed more", () => {
    // A shot whose colors sit a quarter turn away from the reference's.
    const shot = reference.map(([r, g, b]) => [g, b, r] as Vec3);
    const turn = (t: ColorTransfer) => {
      const turns = shot
        .map(rgbToOklab)
        .filter((p) => Math.hypot(p[1], p[2]) > 0.04)
        .map((p) => {
          const q = rgbToOklab(transferRgb(t, oklabToRgb(p)));
          const d = ((Math.atan2(q[2], q[1]) - Math.atan2(p[2], p[1])) * 180) / Math.PI;
          return Math.abs(((d + 540) % 360) - 180);
        })
        .sort((a, b) => a - b);
      return turns[Math.floor(turns.length * 0.9)]!;
    };
    const held = fitTransfer(shot, reference);
    expect(held.limited).toBe(true);
    expect(turn(held.transfer)).toBeLessThan(15.5);
    expect(fitTransfer(shot, reference, 180).limited).toBe(false);
  });

  it("scores pictures by their colors, not their layout", () => {
    const a = original[0]!.colors;
    expect(distributionDeltaE(a, [...a].reverse())).toBeLessThan(0.01);
    expect(distributionDeltaE(a, a.map((c) => grade(c)))).toBeGreaterThan(3);
  });

  it("renders the same colors through FFmpeg as the numbers say", async () => {
    const shot = { frames: original.map((f) => f.colors.map((c) => grade(c))), skin: original[1]!.skin.map((c) => grade(c)) };
    const m = matchShot(shot, reference);
    const filter = getEffect("colorMatch")!.toFilter(m.params, { width: 64, height: 64, fps: 1, duration: 1 });
    expect(filter).toContain("haldclut");
    // A 16x16 strip of test colors through the effect.
    const tests: Vec3[] = Array.from({ length: 256 }, (_, k) => [((k * 37) % 256) / 255, ((k * 91) % 256) / 255, ((k * 53) % 256) / 255]);
    const input = path.join(OUT_DIR, "color-match-strip.rgb");
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(input, Buffer.from(tests.flatMap((c) => c.map((v) => Math.round(v * 255)))));
    const res = await runFfmpegOrThrow(
      ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "16x16", "-i", input, "-filter_complex", `[0:v]format=yuv444p,${filter.replace(/format=yuv420p$/, "format=rgb24")}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
      { binaryStdout: true },
    );
    const out = res.stdoutBuffer!;
    const rendered = tests.map((_, k) => [out[3 * k]! / 255, out[3 * k + 1]! / 255, out[3 * k + 2]! / 255] as Vec3);
    const expected = tests.map((c) => transferRgb(m.params.transfer!, c));
    // A 64-level table, interpolated, and 8-bit RGB to YUV to RGB on the way in.
    expect(meanDeltaE(rendered, expected)).toBeLessThan(1.5);
  });
});
