/** A 3x3 row-major transform. */
export type Mat3 = number[];

export const applyMat = (m: Mat3, x: number, y: number): [number, number] => {
  const d = m[6]! * x + m[7]! * y + m[8]!;
  return [(m[0]! * x + m[1]! * y + m[2]!) / d, (m[3]! * x + m[4]! * y + m[5]!) / d];
};

export function invertMat(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

/** Smooth noise of several sizes: texture everywhere, so a tracker finds corners anywhere. Same as the Rust tracker's test scene. */
export function texture(x: number, y: number): number {
  let v = 0;
  for (const [k, f] of [
    [0.9, 0.031],
    [0.5, 0.067],
    [0.3, 0.13],
    [0.2, 0.21],
  ] as const)
    v += k * (Math.sin(x * f) * Math.cos(y * f * 1.3) + Math.sin(x * f * 0.7 + y * f * 1.1));
  return Math.min(255, Math.max(0, 128 + 40 * v));
}

/** A gray frame of the textured scene moved by `m` (scene point p shows at m p). */
export function texturedFrame(w: number, h: number, m: Mat3): Uint8Array {
  const inv = invertMat(m);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyMat(inv, x, y);
      out[y * w + x] = texture(sx, sy);
    }
  return out;
}

/** A surface turning, growing, sliding and tilting a little more each frame. */
export const cameraMove = (i: number, k = 1): Mat3 => {
  const [a, s] = [0.004 * i * k, 1 + 0.003 * i * k];
  return [s * Math.cos(a), -s * Math.sin(a), 1.5 * i * k, s * Math.sin(a), s * Math.cos(a), 0.8 * i * k, 0.00001 * i * k, 0.000005 * i * k, 1];
};
