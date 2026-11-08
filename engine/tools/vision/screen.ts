/**
 * Matching a screen insert to its shot (replace_screen, docs/design/cinematic-grade-and-vfx.md 5.4):
 * the blur that makes the insert as sharp as the scene around the screen, and the levels that give it
 * the shot's white balance and the ambient light that lifts a real screen's blacks. Measured on one
 * frame of the edit without the insert and the same frame with it.
 */

type Quad = [number, number][];

/** Inside test for a convex or simple quad (pixels). */
function inside(q: Quad, x: number, y: number): boolean {
  let n = 0;
  for (let i = 0; i < q.length; i++) {
    const [[x1, y1], [x2, y2]] = [q[i]!, q[(i + 1) % q.length]!];
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) n++;
  }
  return n % 2 === 1;
}

/** The quad scaled by `s` about its center. */
function scaled(q: Quad, s: number): Quad {
  const [cx, cy] = [q.reduce((n, p) => n + p[0], 0) / q.length, q.reduce((n, p) => n + p[1], 0) / q.length];
  return q.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);
}

const luma = (rgb: Buffer | Uint8Array, k: number) => 0.2126 * rgb[k * 3]! + 0.7152 * rgb[k * 3 + 1]! + 0.0722 * rgb[k * 3 + 2]!;

/**
 * How sharp a region of a gray picture is, independent of its contrast: the mean gradient over the
 * spread of the values. Undefined when the region is flat.
 */
export function sharpness(gray: Float32Array, w: number, h: number, region: (x: number, y: number) => boolean): number | undefined {
  let [grad, n, sum, sq] = [0, 0, 0, 0];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      if (!region(x, y) || !region(x + 1, y) || !region(x, y + 1)) continue;
      const v = gray[y * w + x]!;
      grad += Math.abs(gray[y * w + x + 1]! - v) + Math.abs(gray[(y + 1) * w + x]! - v);
      sum += v;
      sq += v * v;
      n++;
    }
  if (n < 50) return undefined;
  const spread = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
  return spread < 2 ? undefined : grad / n / spread;
}

/** A gray picture blurred with a Gaussian of `sigma` pixels (edges repeated). */
export function gaussian(gray: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return gray;
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const total = k.reduce((a, b) => a + b, 0);
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const [xx, yy] = horizontal ? [Math.min(w - 1, Math.max(0, x + i)), y] : [x, Math.min(h - 1, Math.max(0, y + i))];
          s += k[i + r]! * src[yy * w + xx]!;
        }
        out[y * w + x] = s / total;
      }
    return out;
  };
  return pass(pass(gray, true), false);
}

export interface ScreenMatch {
  /** Blur (gblur sigma, pixels of the insert as it shows) that brings the insert to the scene's sharpness; 0 when it is not sharper. */
  blur: number;
  /** Output levels per channel (0..1): blacks lifted by the ambient light, whites tinted by the shot's white balance (colorlevels' romin..bomax). */
  levels: { min: [number, number, number]; max: [number, number, number] };
}

const BLURS = [0, 0.3, 0.5, 0.8, 1.2, 1.7, 2.4, 3.2];

/**
 * Measure how the insert should change to sit in the shot. `plain` and `withInsert` are the same
 * frame (packed RGB, `w` x `h`) without and with the insert; `quad` is the surface there, in pixels.
 */
export function matchScreen(plain: Buffer | Uint8Array, withInsert: Buffer | Uint8Array, w: number, h: number, quad: Quad): ScreenMatch {
  // The scene: a ring around the surface; the insert: well inside it.
  const [outer, edge, inner] = [scaled(quad, 1.6), scaled(quad, 1.1), scaled(quad, 0.85)];
  const ring = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && inside(outer, x, y) && !inside(edge, x, y);
  // Work on the box around the outer quad only.
  const xs = outer.map((p) => p[0]);
  const ys = outer.map((p) => p[1]);
  const [x0, y0] = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys)))];
  const [x1, y1] = [Math.min(w, Math.ceil(Math.max(...xs))), Math.min(h, Math.ceil(Math.max(...ys)))];
  const [bw, bh] = [Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
  const crop = (rgb: Buffer | Uint8Array) => {
    const g = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) g[y * bw + x] = luma(rgb, (y + y0) * w + x + x0);
    return g;
  };
  const scene = sharpness(crop(plain), bw, bh, (x, y) => ring(x + x0, y + y0));
  const insertGray = crop(withInsert);
  const inInsert = (x: number, y: number) => inside(inner, x + x0, y + y0);
  let blur = 0;
  // Only when the insert is clearly sharper (15%): measurement noise alone must not soften it.
  if (scene !== undefined && (sharpness(insertGray, bw, bh, inInsert) ?? 0) > scene * 1.15) {
    // The least blur that brings the insert down to the scene's sharpness.
    blur = BLURS.find((s) => (sharpness(gaussian(insertGray, bw, bh, s), bw, bh, inInsert) ?? 0) <= scene) ?? BLURS.at(-1)!;
  }

  // White balance: the frame's average color against gray (gray world), carried half way, as a gain
  // on each channel's whites that never brightens (the largest stays 1).
  const mean = [0, 0, 0];
  for (let k = 0; k < w * h; k += 3) for (let c = 0; c < 3; c++) mean[c]! += plain[k * 3 + c]!;
  const avg = (mean[0]! + mean[1]! + mean[2]!) / 3 || 1;
  const gain = mean.map((m) => 1 + 0.5 * (m / avg - 1));
  const top = Math.max(...gain);
  const max = gain.map((g) => Math.round(Math.min(1, Math.max(0.85, g / top)) * 1000) / 1000) as [number, number, number];
  // Ambient light on the screen: the scene's dark end around it (5th percentile per channel), a
  // third of it on the screen's blacks, at most 0.08.
  const values: number[][] = [[], [], []];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ring(x, y)) for (let c = 0; c < 3; c++) values[c]!.push(plain[(y * w + x) * 3 + c]!);
  const min = values.map((v) => {
    if (!v.length) return 0;
    v.sort((a, b) => a - b);
    return Math.round(Math.min(0.08, (v[Math.floor(v.length * 0.05)]! / 255) / 3) * 1000) / 1000;
  }) as [number, number, number];
  return { blur, levels: { min, max } };
}

/** The levels as a colorlevels filter (a custom effect on the insert). */
export function levelsFilter(l: ScreenMatch["levels"]): string {
  const [r, g, b] = ["r", "g", "b"];
  return `colorlevels=${r}omin=${l.min[0]}:${g}omin=${l.min[1]}:${b}omin=${l.min[2]}:${r}omax=${l.max[0]}:${g}omax=${l.max[1]}:${b}omax=${l.max[2]}`;
}
