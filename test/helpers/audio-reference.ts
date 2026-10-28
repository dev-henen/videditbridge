/**
 * The TypeScript frame features kernel as it was before the move to Rust (native/ave-native),
 * kept only as the test oracle for parity (see docs/design/cinematic-grade-and-vfx.md, section 3.5).
 */

const HOP = 160;
const FRAME = 320;
const db = (power: number) => 10 * Math.log10(power + 1e-12);

export interface FrameFeatures {
  /** Level per frame, dBFS. */
  level: Float32Array;
  /** Zero-crossing rate per frame, 0..1. */
  zcr: Float32Array;
  /** Spectral flux (onset strength) per frame. */
  flux: Float32Array;
  /** Spectral flatness per frame, 0 (tonal) .. 1 (noise). */
  flatness: Float32Array;
}

export function frameFeatures(x: Float32Array): FrameFeatures {
  const n = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const level = new Float32Array(n);
  const zcr = new Float32Array(n);
  const flux = new Float32Array(n);
  const flatness = new Float32Array(n);
  const N = 512;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  let mag = new Float64Array(N / 2);
  for (let f = 0; f < n; f++) {
    const o = f * HOP;
    let e = 0;
    let z = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = x[o + i]!;
      e += v * v;
      if (i && (v >= 0) !== (x[o + i - 1]! >= 0)) z++;
    }
    level[f] = db(e / FRAME);
    zcr[f] = z / FRAME;
    // A centered 32 ms window for the spectrum.
    const c = o + FRAME / 2 - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = (x[c + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let logSum = 0;
    let linSum = 0;
    let fl = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
      mag[k] = Math.log1p(100 * m);
      const d = mag[k]! - prev[k]!;
      if (d > 0) fl += d;
      logSum += Math.log(m + 1e-9);
      linSum += m;
    }
    flux[f] = fl;
    flatness[f] = linSum > 1e-6 ? Math.exp(logSum / (N / 2 - 1)) / (linSum / (N / 2 - 1)) : 1;
    [prev, mag] = [mag, prev];
  }
  return { level, zcr, flux, flatness };
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
