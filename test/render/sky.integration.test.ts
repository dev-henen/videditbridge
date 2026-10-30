import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addAsset, addClip, createProject, type Project } from "../../engine/core/index.js";
import { renderForAnalysis, runFfmpegOrThrow, skyMaskFile } from "../../engine/tools/index.js";
import { OUT_DIR, ffmpegAvailable } from "../helpers/media.js";

const hasFfmpeg = await ffmpegAvailable();
const [W, H] = [640, 360];
/** The scenery's top edge: a wavy horizon, so the edge runs at every angle. */
const horizon = (x: number) => 190 + 25 * Math.sin(x / 45);
const HORIZON = `(190+25*sin(X/45))`;

/** CIE76 distance between two RGB colors (sRGB, D65), enough for "is this visibly tinted". */
function deltaE(a: number[], b: number[]): number {
  const lab = (c: number[]) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * bl, (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883].map(f) as [number, number, number];
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}

describe.skipIf(!hasFfmpeg)("sky replacement", () => {
  const dir = path.join(OUT_DIR, "sky-effect");
  const clip = path.join(dir, "scene.mp4");
  const cacheDir = path.join(dir, "cache");
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    if (!existsSync(clip))
      // A pale blue sky over green textured scenery.
      await runFfmpegOrThrow([
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=30:d=1,geq=r='if(lt(Y,${HORIZON}),150+Y*0.2,40+25*sin(X/3)*sin(Y/4))':g='if(lt(Y,${HORIZON}),190+Y*0.1,110+30*sin(X/5+Y/7))':b='if(lt(Y,${HORIZON}),235,40+15*sin(X/4))'`,
        "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", clip,
      ]);
    // The exact sky matte, where the renderer looks for it, so no model is needed here.
    const m = await skyMaskFile(path.join(cacheDir, "masks"), clip, { start: 0, end: 1 }, 30);
    await mkdir(path.dirname(m.file), { recursive: true });
    if (!m.exists)
      await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=30:d=1,format=gray,geq=lum='255*lt(Y,${HORIZON})'`, "-c:v", "ffv1", m.file]);
  });

  const project = (params: Record<string, unknown>): Project => {
    let p = createProject({ settings: { width: W, height: H, fps: 30 } });
    p = addAsset(p, { type: "video", id: "scene", src: clip, width: W, height: H, duration: 1, hasAudio: false });
    p = addClip(p, { assetId: "scene", duration: 1 });
    p.clips[0]!.effects = [{ type: "skyReplace", params: { colors: ["#E05020", "#F0A060"], ...params } }];
    return p;
  };
  const frame = async (p: Project) => (await renderForAnalysis(p, { framesAt: [0.5], probe: false, cacheDir })).frames[0]!;
  const px = (f: { rgb: Buffer }, x: number, y: number) => [0, 1, 2].map((c) => f.rgb[(Math.round(y) * W + Math.round(x)) * 3 + c]!);

  it("puts the new sky in the sky only, with no halo of the old one along the edge", async () => {
    // A white new sky: far brighter than the scenery (luma under 120), and luma is stored at full resolution.
    const f = await frame(project({ haze: 0, relight: 0, blur: 0, colors: ["#FFFFFF", "#F4F4F4"] }));
    const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(lum(px(f, 320, 20)), "new sky").toBeGreaterThan(230);
    // Down every column across the edge: no pale blue (the old sky) anywhere near it.
    let covered = 0;
    for (let x = 8; x < W - 8; x += 7) {
      const e = horizon(x);
      for (let y = Math.floor(e) - 6; y <= Math.ceil(e) + 6; y++) {
        const [r, g, b] = px(f, x, y);
        // The old sky is pale blue: blue about 50 above red (blends of the new sky and the scenery are not).
        expect(b! > 200 && b! - r! > 30, `old sky at (${x}, ${y})`).toBe(false);
      }
      // Rows of scenery (from the first row under the edge) the new sky covers.
      const first = Math.ceil(e);
      for (let y = first; y <= first + 8; y++) if (lum(px(f, x, y)) > 180) covered = Math.max(covered, y - first + 1);
    }
    console.error(`new sky covers ${covered} rows of the scenery's outline`);
    // The edge grows a pixel over the outline to hide the old sky's fringe, and the feather adds at most one more.
    expect(covered, "rows of scenery covered").toBeLessThanOrEqual(2);
  });

  it("tints the scenery less than ΔE 3 by default, and hazes the sky just above it", async () => {
    const plain = (await renderForAnalysis({ ...project({}), clips: [{ ...project({}).clips[0]!, effects: [] }] }, { framesAt: [0.5], probe: false, cacheDir })).frames[0]!;
    const f = await frame(project({}));
    let sum = 0;
    let n = 0;
    for (let x = 20; x < W; x += 37)
      for (let y = 300; y < H - 5; y += 13) {
        sum += deltaE(px(plain, x, y), px(f, x, y));
        n++;
      }
    expect(sum / n, "mean scenery ΔE").toBeLessThan(3);
    // Haze: the pale haze color lightens the sky along the horizon, and not high up (compared with haze off).
    const noHaze = await frame(project({ haze: 0 }));
    const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    const lift = (rowOf: (x: number) => number) => {
      let s = 0;
      let k = 0;
      for (let x = 10; x < W - 10; x += 9) {
        s += lum(px(f, x, rowOf(x))) - lum(px(noHaze, x, rowOf(x)));
        k++;
      }
      return s / k;
    };
    const near = lift((x) => horizon(x) - 6);
    const high = lift(() => 10);
    console.error(`haze lifts the sky by ${near.toFixed(1)} near the horizon, ${high.toFixed(1)} high up`);
    expect(near, "haze near the horizon").toBeGreaterThan(8);
    expect(Math.abs(high), "no haze high up").toBeLessThan(2);
  });

  it("shows a picture as the new sky, moving with the camera", async () => {
    // A black picture with a white band across its middle (rows 170 to 190 of 360).
    const plate = path.join(dir, "band.png");
    if (!existsSync(plate)) await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=black:s=${W}x${H},drawbox=x=0:y=170:w=${W}:h=20:color=white:t=fill`, "-frames:v", "1", plate]);
    const withPlate = (params: Record<string, unknown>) => {
      const p = project({ asset: "band", haze: 0, relight: 0, blur: 0, cover: 1.5, ...params });
      return addAsset(p, { type: "image", id: "band", src: plate, width: W, height: H });
    };
    // Where the band's middle is, down a column where the sky reaches low (the horizon is at 215 px there).
    const bandAt = (f: { rgb: Buffer }) => {
      const rows = Array.from({ length: 214 }, (_, y) => y).filter((y) => px(f, 70, y)[0]! > 128);
      return rows.length ? (rows[0]! + rows[rows.length - 1]!) / 2 : -1;
    };
    // Drawn 1.5 times larger around the middle: the band's middle stays at 180.
    const still = bandAt(await frame(withPlate({})));
    expect(Math.abs(still - 180), "band in the still sky").toBeLessThanOrEqual(1.5);
    // The scenery drifts down 5% of the frame by 0.5 s: the sky follows by 18 px.
    const moved = bandAt(await frame(withPlate({ motion: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 0, y: 0.1 }] })));
    expect(Math.abs(moved - still - 18), "band moved with the camera").toBeLessThanOrEqual(1.5);
  });
});
