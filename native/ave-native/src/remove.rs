//! Object removal (section 7.2 of docs/design/cinematic-grade-and-vfx.md). The area under an
//! object is filled with what other frames of the clip show there: a pool of frames spread over the
//! clip, each moved by the camera's motion onto the frame being filled. Where the camera is locked
//! off, the pixels are copied exactly and the fill is the median of every pool frame that sees
//! them, so it is the same from frame to frame. Where the camera moves, the fill is the median of
//! the few pool frames nearest in time (least parallax and light change), and each pool frame's
//! exposure is matched on a ring around the hole.
//!
//! What no frame ever shows is left for an inpainting model, run from JavaScript on a few frames.
//! Its result comes back as a layer (`add_layer`), which later frames take from in the same way, so
//! generated detail stays put instead of being invented anew each frame. Thin leftovers (a pixel or
//! two along an edge) are filled here by push-pull interpolation instead.

use crate::depth::mul;
use crate::track::{apply, invert, Mat3};
use rayon::prelude::*;

#[derive(Clone, Debug)]
pub struct RemoveOptions {
    /// The mask is grown by this many pixels (covers soft edges, motion blur, a contact shadow).
    pub grow: f32,
    /// Width of the soft edge beyond the grown mask, pixels.
    pub feather: f32,
    /// Width of the ring around the hole where exposure is matched, pixels.
    pub ring: f32,
    /// The camera does not move: the median of the whole pool, without exposure matching.
    pub locked: bool,
    /// Pool frames nearest in time that a moving camera's median takes.
    pub nearest: usize,
    /// Leftovers no farther than this from a filled pixel are interpolated, pixels; thicker ones are left for the model.
    pub thin: f32,
}

impl Default for RemoveOptions {
    fn default() -> Self {
        RemoveOptions { grow: 6.0, feather: 4.0, ring: 12.0, locked: false, nearest: 3, thin: 3.0 }
    }
}

/// A frame fills can take from: its pixels and where they may be used.
struct Source {
    index: usize,
    rgb: Vec<u8>,
    /// 1 where the frame shows the background (away from the object), or, for a layer, where it was generated.
    valid: Vec<u8>,
}

/// One filled frame.
pub struct Fill {
    /// Straight-alpha RGBA, w x h x 4: the fill inside the hole, fading out over the feather; clear elsewhere.
    pub rgba: Vec<u8>,
    /// 1 where nothing could fill the hole (only leftovers thicker than `thin`; `rgba` holds the frame's own pixels there).
    pub residual: Vec<u8>,
    /// Pixels in the hole; filled from real frames, from layers, and interpolated; and left over.
    pub hole: u32,
    pub real: u32,
    pub layered: u32,
    pub interpolated: u32,
    pub left: u32,
}

/// Squared Euclidean distance transform in one dimension (Felzenszwalb and Huttenlocher, 2012).
fn edt_1d(f: &[f64], out: &mut [f64]) {
    let n = f.len();
    let mut v = vec![0usize; n];
    let mut z = vec![0f64; n + 1];
    let mut k = 0usize;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    let cross = |q: usize, p: usize| ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64));
    for q in 1..n {
        let mut s = cross(q, v[k]);
        // z[0] is minus infinity, so k never goes below 0.
        while s <= z[k] {
            k -= 1;
            s = cross(q, v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let d = q as f64 - v[k] as f64;
        *o = d * d + f[v[k]];
    }
}

/// Distance in pixels from each pixel to the nearest `inside` one (0 on them; infinity when there are none).
pub fn distance(inside: &[bool], w: usize, h: usize) -> Vec<f32> {
    const FAR: f64 = 1e12;
    if !inside.iter().any(|&b| b) {
        return vec![f32::INFINITY; w * h];
    }
    // Columns, then rows.
    let cols: Vec<Vec<f64>> = (0..w)
        .into_par_iter()
        .map(|x| {
            let f: Vec<f64> = (0..h).map(|y| if inside[y * w + x] { 0.0 } else { FAR }).collect();
            let mut o = vec![0.0; h];
            edt_1d(&f, &mut o);
            o
        })
        .collect();
    (0..h)
        .into_par_iter()
        .flat_map_iter(|y| {
            let f: Vec<f64> = (0..w).map(|x| cols[x][y]).collect();
            let mut o = vec![0.0; w];
            edt_1d(&f, &mut o);
            o.into_iter().map(|d| if d >= FAR * 0.5 { f32::INFINITY } else { d.sqrt() as f32 })
        })
        .collect()
}

/// Like `distance`, worked out only within `margin` pixels of the `inside` ones' bounding box
/// (infinity beyond it, where every distance is over `margin` anyway): a mask is usually a small
/// part of the frame.
pub fn distance_near(inside: &[bool], w: usize, h: usize, margin: f32) -> Vec<f32> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (k, _) in inside.iter().enumerate().filter(|(_, &b)| b) {
        let (x, y) = (k % w, k / w);
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let mut out = vec![f32::INFINITY; w * h];
    if x0 > x1 {
        return out;
    }
    let m = margin.ceil() as usize + 1;
    let (bx0, by0, bx1, by1) = (x0.saturating_sub(m), y0.saturating_sub(m), (x1 + m).min(w - 1), (y1 + m).min(h - 1));
    let (bw, bh) = (bx1 - bx0 + 1, by1 - by0 + 1);
    let crop: Vec<bool> = (0..bw * bh).map(|b| inside[(by0 + b / bw) * w + bx0 + b % bw]).collect();
    for (b, d) in distance(&crop, bw, bh).into_iter().enumerate() {
        out[(by0 + b / bw) * w + bx0 + b % bw] = d;
    }
    out
}

/// Bilinear RGB at (x, y), or None outside the frame.
fn sample(rgb: &[u8], w: usize, h: usize, x: f64, y: f64) -> Option<[f32; 3]> {
    if x < 0.0 || y < 0.0 || x > (w - 1) as f64 || y > (h - 1) as f64 {
        return None;
    }
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
    let mut c = [0f32; 3];
    for (ch, v) in c.iter_mut().enumerate() {
        let at = |xx: usize, yy: usize| rgb[(yy * w + xx) * 3 + ch] as f32;
        *v = (at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx) * (1.0 - fy) + (at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx) * fy;
    }
    Some(c)
}

/// Whether the pixel nearest (x, y) is valid.
fn valid_at(valid: &[u8], w: usize, h: usize, x: f64, y: f64) -> bool {
    let (xi, yi) = (x.round(), y.round());
    xi >= 0.0 && yi >= 0.0 && (xi as usize) < w && (yi as usize) < h && valid[yi as usize * w + xi as usize] > 0
}

fn luma(c: &[f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// The candidate with the median luma (a real pixel, not a mix of several).
fn median(c: &mut [([f32; 3], usize)]) -> [f32; 3] {
    c.sort_by(|a, b| luma(&a.0).total_cmp(&luma(&b.0)));
    c[(c.len() - 1) / 2].0
}

/// Fill `unknown` pixels of an RGB float image from the known ones around them: averaged down a
/// pyramid until everything is known, then brought back up (push-pull). Smooth and cheap; for thin gaps.
pub fn push_pull(rgb: &mut [[f32; 3]], unknown: &[bool], w: usize, h: usize) {
    if w == 0 || h == 0 || !unknown.iter().any(|&u| u) || unknown.iter().all(|&u| u) {
        return;
    }
    // Weighted colors at each level: (sum of color * weight, weight), weight 1 where known.
    let mut levels: Vec<(Vec<[f32; 4]>, usize, usize)> = vec![(
        (0..w * h).map(|i| if unknown[i] { [0.0; 4] } else { [rgb[i][0], rgb[i][1], rgb[i][2], 1.0] }).collect(),
        w,
        h,
    )];
    while levels.last().map_or(false, |(l, lw, lh)| (*lw > 1 || *lh > 1) && l.iter().any(|p| p[3] < 1e-6)) {
        let (l, lw, lh) = levels.last().unwrap();
        let (nw, nh) = ((lw + 1) / 2, (lh + 1) / 2);
        let mut n = vec![[0f32; 4]; nw * nh];
        for y in 0..*lh {
            for x in 0..*lw {
                let p = l[y * lw + x];
                let q = &mut n[(y / 2) * nw + x / 2];
                for c in 0..4 {
                    q[c] += p[c];
                }
            }
        }
        // Clamp the weight at 1 so known pixels are not over-trusted on the way up.
        for q in n.iter_mut() {
            if q[3] > 1.0 {
                let k = 1.0 / q[3];
                for c in 0..4 {
                    q[c] *= k;
                }
            }
        }
        levels.push((n, nw, nh));
    }
    for li in (0..levels.len() - 1).rev() {
        let (coarse, cw, _) = (levels[li + 1].0.clone(), levels[li + 1].1, levels[li + 1].2);
        let (fine, fw, fh) = &mut levels[li];
        for y in 0..*fh {
            for x in 0..*fw {
                let p = &mut fine[y * *fw + x];
                let up = coarse[(y / 2) * cw + x / 2];
                if up[3] <= 1e-6 {
                    continue;
                }
                let a = 1.0 - p[3].min(1.0);
                for c in 0..3 {
                    p[c] += a * up[c] / up[3];
                }
                p[3] += a;
            }
        }
    }
    let top = &levels[0].0;
    for i in 0..w * h {
        if unknown[i] && top[i][3] > 1e-6 {
            for c in 0..3 {
                rgb[i][c] = top[i][c] / top[i][3];
            }
        }
    }
}

/// Fills holes frame by frame from a pool of frames and generated layers (see the module notes).
pub struct Remover {
    w: usize,
    h: usize,
    /// Per frame of the clip: the 3x3 transform from frame 0's pixels to that frame's.
    motion: Vec<Mat3>,
    pool: Vec<Source>,
    layers: Vec<Source>,
    opts: RemoveOptions,
}

impl Remover {
    pub fn new(w: usize, h: usize, motion: &[f64], opts: RemoveOptions) -> Self {
        let motion = motion.chunks_exact(9).map(|m| m.try_into().unwrap()).collect();
        Remover { w, h, motion, pool: vec![], layers: vec![], opts }
    }

    fn reach(&self) -> f32 {
        self.opts.grow + self.opts.feather
    }

    /// Frame `index` of the clip joins the pool. `mask` (0..255) is the object on it: pixels within
    /// the grown and feathered mask are never taken from it.
    pub fn add_frame(&mut self, index: usize, rgb: Vec<u8>, mask: &[u8]) {
        let inside: Vec<bool> = mask.iter().map(|&m| m >= 128).collect();
        // One more pixel than the hole reaches, so bilinear samples never touch the object.
        let reach = self.reach() + 1.0;
        let valid = distance_near(&inside, self.w, self.h, reach).into_iter().map(|d| (d > reach) as u8).collect();
        self.pool.push(Source { index, rgb, valid });
    }

    /// Pixels generated on frame `index` (its filled picture, and 1 where they were generated) become a layer later fills take from.
    pub fn add_layer(&mut self, index: usize, rgb: Vec<u8>, generated: Vec<u8>) {
        self.layers.push(Source { index, rgb, valid: generated });
    }

    /// The transform from frame `i`'s pixels to frame `j`'s.
    fn between(&self, i: usize, j: usize) -> Mat3 {
        let at = |k: usize| self.motion.get(k).copied().unwrap_or(crate::track::IDENTITY);
        mul(&at(j), &invert(&at(i)).unwrap_or(crate::track::IDENTITY))
    }

    /// Fill frame `index` (its `rgb` and object `mask`, 0..255).
    pub fn fill(&self, index: usize, rgb: &[u8], mask: &[u8]) -> Fill {
        let (w, h) = (self.w, self.h);
        let area = w * h;
        let inside: Vec<bool> = mask.iter().map(|&m| m >= 128).collect();
        let reach = self.reach();
        let d = distance_near(&inside, w, h, reach + self.opts.ring + 1.0);
        let hole: Vec<bool> = d.iter().map(|&v| v <= reach).collect();
        let count = hole.iter().filter(|&&b| b).count() as u32;
        let mut out = Fill { rgba: vec![0; area * 4], residual: vec![0; area], hole: count, real: 0, layered: 0, interpolated: 0, left: 0 };
        if count == 0 {
            return out;
        }
        // The hole's bounding box, grown by the ring.
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
        for k in 0..area {
            if hole[k] {
                let (x, y) = (k % w, k / w);
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
        let pad = self.opts.ring.ceil() as usize + 1;
        let (bx0, by0, bx1, by1) = (x0.saturating_sub(pad), y0.saturating_sub(pad), (x1 + pad).min(w - 1), (y1 + pad).min(h - 1));

        // Each pool frame: where it maps from this frame, and its exposure against this frame's ring.
        let maps: Vec<Mat3> = self.pool.iter().map(|s| self.between(index, s.index)).collect();
        let ring: Vec<usize> = (by0..=by1)
            .flat_map(|y| (bx0..=bx1).map(move |x| y * w + x))
            .filter(|&k| d[k] > reach && d[k] <= reach + self.opts.ring)
            .collect();
        let gains: Vec<[f32; 3]> = self
            .pool
            .par_iter()
            .zip(&maps)
            .map(|(s, m)| {
                if self.opts.locked {
                    return [1.0; 3];
                }
                let (mut a, mut b, mut n) = ([0f64; 3], [0f64; 3], 0usize);
                for &k in &ring {
                    let (x, y) = apply(m, (k % w) as f64, (k / w) as f64);
                    if !valid_at(&s.valid, w, h, x, y) {
                        continue;
                    }
                    if let Some(c) = sample(&s.rgb, w, h, x, y) {
                        for ch in 0..3 {
                            a[ch] += rgb[k * 3 + ch] as f64;
                            b[ch] += c[ch] as f64;
                        }
                        n += 1;
                    }
                }
                if n < 32 {
                    return [1.0; 3];
                }
                [0, 1, 2].map(|ch| ((a[ch] + n as f64) / (b[ch] + n as f64)).clamp(0.7, 1.4) as f32)
            })
            .collect();
        // Pool frames for a moving camera's median: those that line up best with this frame on the
        // ring around the hole first (then by distance in time). A camera track drifts a few pixels
        // over a clip of fine texture (leaves, grass), and the median of frames that are off by that
        // much is a smear; the ring shows which ones still line up where the hole is.
        let mut order: Vec<usize> = (0..self.pool.len()).collect();
        order.sort_by_key(|&j| (self.pool[j].index as i64 - index as i64).abs());
        if !self.opts.locked && ring.len() >= 32 {
            let stride = (ring.len() / 1500).max(1);
            let errors: Vec<f32> = self
                .pool
                .par_iter()
                .zip(&maps)
                .zip(&gains)
                .map(|((s, m), g)| {
                    let (mut e, mut n) = (0f32, 0usize);
                    for &k in ring.iter().step_by(stride) {
                        let (x, y) = apply(m, (k % w) as f64, (k / w) as f64);
                        if !valid_at(&s.valid, w, h, x, y) {
                            continue;
                        }
                        if let Some(c) = sample(&s.rgb, w, h, x, y) {
                            e += (0..3).map(|ch| (c[ch] * g[ch] - rgb[k * 3 + ch] as f32).abs()).sum::<f32>() / 3.0;
                            n += 1;
                        }
                    }
                    // A frame that sees little of the ring says little about how it lines up.
                    if n * 3 < ring.len().div_ceil(stride) { f32::INFINITY } else { e / n as f32 }
                })
                .collect();
            if errors.iter().any(|e| e.is_finite()) {
                let rank: Vec<usize> = order.clone();
                order.sort_by(|&a, &b| errors[a].total_cmp(&errors[b]).then(rank.iter().position(|&x| x == a).cmp(&rank.iter().position(|&x| x == b))));
            }
        }
        let mut layer_order: Vec<usize> = (0..self.layers.len()).collect();
        layer_order.sort_by_key(|&j| (self.layers[j].index as i64 - index as i64).abs());
        let layer_maps: Vec<Mat3> = self.layers.iter().map(|s| self.between(index, s.index)).collect();

        // 0 = not filled, 1 = from real frames, 2 = from a layer.
        let rows: Vec<(usize, Vec<([f32; 3], u8)>)> = (y0..=y1)
            .into_par_iter()
            .map(|y| {
                let mut cands: Vec<([f32; 3], usize)> = Vec::with_capacity(self.pool.len());
                let row = (x0..=x1)
                    .map(|x| {
                        let k = y * w + x;
                        if !hole[k] {
                            return ([0.0; 3], 0u8);
                        }
                        cands.clear();
                        for &j in &order {
                            let s = &self.pool[j];
                            let (sx, sy) = apply(&maps[j], x as f64, y as f64);
                            if !valid_at(&s.valid, w, h, sx, sy) {
                                continue;
                            }
                            if let Some(c) = sample(&s.rgb, w, h, sx, sy) {
                                let g = gains[j];
                                cands.push(([c[0] * g[0], c[1] * g[1], c[2] * g[2]], j));
                                if !self.opts.locked && cands.len() >= self.opts.nearest {
                                    break;
                                }
                            }
                        }
                        if !cands.is_empty() {
                            return (median(&mut cands), 1);
                        }
                        for &j in &layer_order {
                            let s = &self.layers[j];
                            let (sx, sy) = apply(&layer_maps[j], x as f64, y as f64);
                            if valid_at(&s.valid, w, h, sx, sy) {
                                if let Some(c) = sample(&s.rgb, w, h, sx, sy) {
                                    return (c, 2);
                                }
                            }
                        }
                        ([0.0; 3], 0)
                    })
                    .collect();
                (y, row)
            })
            .collect();

        // The box's picture: the frame outside the hole, the fill inside; and what is left.
        let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
        let mut pic: Vec<[f32; 3]> = vec![[0.0; 3]; bw * bh];
        let mut unknown = vec![false; bw * bh];
        for (y, row) in &rows {
            for (i, (c, how)) in row.iter().enumerate() {
                let (k, b) = (y * w + x0 + i, (y - y0) * bw + i);
                pic[b] = if hole[k] { *c } else { [0, 1, 2].map(|ch| rgb[k * 3 + ch] as f32) };
                match how {
                    1 => out.real += 1,
                    2 => out.layered += 1,
                    _ if hole[k] => unknown[b] = true,
                    _ => {}
                }
            }
        }
        // Thin leftovers are interpolated; thick ones go back for the model.
        if unknown.iter().any(|&u| u) {
            let known: Vec<bool> = unknown.iter().map(|&u| !u).collect();
            let far = distance(&known, bw, bh);
            let thick = unknown.iter().zip(&far).any(|(&u, &f)| u && f > self.opts.thin);
            if thick {
                for b in 0..bw * bh {
                    if unknown[b] {
                        let k = (y0 + b / bw) * w + x0 + b % bw;
                        out.residual[k] = 1;
                        out.left += 1;
                        pic[b] = [0, 1, 2].map(|ch| rgb[k * 3 + ch] as f32);
                    }
                }
            } else {
                out.interpolated = unknown.iter().filter(|&&u| u).count() as u32;
                push_pull(&mut pic, &unknown, bw, bh);
            }
        }
        let feather = self.opts.feather.max(1e-3);
        for y in y0..=y1 {
            for x in x0..=x1 {
                let k = y * w + x;
                if !hole[k] {
                    continue;
                }
                let c = pic[(y - y0) * bw + x - x0];
                let a = if d[k] <= self.opts.grow { 1.0 } else { ((reach - d[k]) / feather).clamp(0.0, 1.0) };
                for ch in 0..3 {
                    out.rgba[k * 4 + ch] = c[ch].round().clamp(0.0, 255.0) as u8;
                }
                out.rgba[k * 4 + 3] = (a * 255.0).round() as u8;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured background (smooth noise of several sizes, in color) seen through transform `m`
    /// (from the background's coordinates to the frame's), with a flat gray box at `obj` (x0, y0, x1, y1) on top.
    fn frame(w: usize, h: usize, m: &Mat3, obj: Option<(usize, usize, usize, usize)>) -> (Vec<u8>, Vec<u8>) {
        let inv = invert(m).unwrap();
        let tex = |x: f64, y: f64, c: usize| -> f64 {
            let mut v = 0.0;
            for (k, f) in [(0.9, 0.031), (0.5, 0.067), (0.3, 0.13), (0.2, 0.21)] {
                let f = f * (1.0 + 0.15 * c as f64);
                v += k * ((x * f).sin() * (y * f * 1.3).cos() + (x * f * 0.7 + y * f * 1.1).sin());
            }
            128.0 + 40.0 * v
        };
        let mut rgb = vec![0u8; w * h * 3];
        let mut mask = vec![0u8; w * h];
        for k in 0..w * h {
            let (x, y) = (k % w, k / w);
            let (bx, by) = apply(&inv, x as f64, y as f64);
            for c in 0..3 {
                rgb[k * 3 + c] = tex(bx, by, c).clamp(0.0, 255.0).round() as u8;
            }
            if let Some((ox0, oy0, ox1, oy1)) = obj {
                if x >= ox0 && x < ox1 && y >= oy0 && y < oy1 {
                    rgb[k * 3..k * 3 + 3].copy_from_slice(&[90, 90, 90]);
                    mask[k] = 255;
                }
            }
        }
        (rgb, mask)
    }

    fn shift(dx: f64, dy: f64) -> Mat3 {
        [1.0, 0.0, dx, 0.0, 1.0, dy, 0.0, 0.0, 1.0]
    }

    #[test]
    fn distance_is_euclidean() {
        let (w, h) = (40, 30);
        let mut inside = vec![false; w * h];
        inside[10 * w + 12] = true;
        let d = distance(&inside, w, h);
        assert_eq!(d[10 * w + 12], 0.0);
        assert!((d[13 * w + 16] - 5.0).abs() < 1e-5);
        assert!((d[0] - ((12.0f32 * 12.0 + 10.0 * 10.0).sqrt())).abs() < 1e-4);
    }

    #[test]
    fn distance_near_matches_within_its_margin() {
        let (w, h) = (90, 70);
        let mut inside = vec![false; w * h];
        for y in 30..36 {
            for x in 40..47 {
                inside[y * w + x] = true;
            }
        }
        let (all, near) = (distance(&inside, w, h), distance_near(&inside, w, h, 8.0));
        for k in 0..w * h {
            if all[k] <= 8.0 {
                assert_eq!(all[k], near[k], "pixel {k}");
            } else {
                assert!(near[k] > 8.0);
            }
        }
    }

    #[test]
    fn push_pull_fills_smoothly() {
        let (w, h) = (16, 16);
        let mut rgb: Vec<[f32; 3]> = (0..w * h).map(|k| [(k % w) as f32 * 10.0; 3]).collect();
        let unknown: Vec<bool> = (0..w * h).map(|k| (k % w) == 7 || (k % w) == 8).collect();
        push_pull(&mut rgb, &unknown, w, h);
        // Between the known columns 6 (60) and 9 (90).
        for y in 0..h {
            for x in [7, 8] {
                let v = rgb[y * w + x][0];
                assert!(v > 55.0 && v < 95.0, "({x}, {y}) = {v}");
            }
        }
    }

    #[test]
    fn locked_off_shot_is_rebuilt_exactly_and_holds_still() {
        let (w, h, n) = (160, 120, 12);
        // A box moving left to right over a still background.
        let frames: Vec<(Vec<u8>, Vec<u8>)> = (0..n).map(|i| frame(w, h, &shift(0.0, 0.0), Some((10 + i * 11, 40, 40 + i * 11, 80)))).collect();
        let (clean, _) = frame(w, h, &shift(0.0, 0.0), None);
        let motion: Vec<f64> = (0..n).flat_map(|_| crate::track::IDENTITY).collect();
        let mut r = Remover::new(w, h, &motion, RemoveOptions { grow: 2.0, feather: 2.0, locked: true, ..Default::default() });
        for (i, (rgb, mask)) in frames.iter().enumerate().step_by(2) {
            r.add_frame(i, rgb.clone(), mask);
        }
        let mut last: Option<Vec<u8>> = None;
        for i in [4usize, 5, 6] {
            let f = r.fill(i, &frames[i].0, &frames[i].1);
            assert_eq!(f.left, 0);
            assert_eq!(f.real, f.hole);
            for k in 0..w * h {
                if f.rgba[k * 4 + 3] == 255 {
                    for c in 0..3 {
                        assert_eq!(f.rgba[k * 4 + c], clean[k * 3 + c], "frame {i} pixel {k}");
                    }
                }
            }
            // Where two frames' holes overlap, the fill is the same.
            if let Some(prev) = &last {
                for k in 0..w * h {
                    if f.rgba[k * 4 + 3] == 255 && prev[k * 4 + 3] == 255 {
                        assert_eq!(&f.rgba[k * 4..k * 4 + 3], &prev[k * 4..k * 4 + 3]);
                    }
                }
            }
            last = Some(f.rgba);
        }
    }

    #[test]
    fn moving_camera_is_rebuilt_along_the_motion() {
        let (w, h, n) = (160, 120, 16);
        // The camera pans 4 px a frame and brightens 1% a frame; the box stays in the middle of the frame.
        let cams: Vec<Mat3> = (0..n).map(|i| shift(-4.0 * i as f64, 0.0)).collect();
        let obj = Some((65, 40, 95, 80));
        let frames: Vec<(Vec<u8>, Vec<u8>)> = cams
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let (mut rgb, mask) = frame(w, h, m, obj);
                for (k, v) in rgb.iter_mut().enumerate() {
                    if mask[k / 3] == 0 {
                        *v = (*v as f32 * (1.0 + 0.01 * i as f32)).round().min(255.0) as u8;
                    }
                }
                (rgb, mask)
            })
            .collect();
        let motion: Vec<f64> = cams.iter().flat_map(|m| *m).collect();
        let mut r = Remover::new(w, h, &motion, RemoveOptions { grow: 2.0, feather: 2.0, ..Default::default() });
        for (i, (rgb, mask)) in frames.iter().enumerate() {
            r.add_frame(i, rgb.clone(), mask);
        }
        let i = 8;
        let f = r.fill(i, &frames[i].0, &frames[i].1);
        assert_eq!(f.left, 0, "the pan reveals everything behind the box");
        let (clean, _) = frame(w, h, &cams[i], None);
        let (mut err, mut cnt) = (0.0, 0);
        for k in 0..w * h {
            if f.rgba[k * 4 + 3] == 255 {
                for c in 0..3 {
                    let truth = (clean[k * 3 + c] as f32 * (1.0 + 0.01 * i as f32)).round().min(255.0);
                    err += (f.rgba[k * 4 + c] as f32 - truth).abs();
                    cnt += 1;
                }
            }
        }
        let mean = err / cnt as f32;
        assert!(mean < 2.5, "mean error {mean:.2} levels");
    }

    #[test]
    fn what_no_frame_shows_is_left_for_the_model_then_taken_from_its_layer() {
        let (w, h, n) = (120, 90, 6);
        // The box never moves and neither does the camera.
        let frames: Vec<(Vec<u8>, Vec<u8>)> = (0..n).map(|_| frame(w, h, &shift(0.0, 0.0), Some((40, 30, 80, 60)))).collect();
        let motion: Vec<f64> = (0..n).flat_map(|_| crate::track::IDENTITY).collect();
        let mut r = Remover::new(w, h, &motion, RemoveOptions { grow: 2.0, feather: 2.0, locked: true, ..Default::default() });
        for (i, (rgb, mask)) in frames.iter().enumerate() {
            r.add_frame(i, rgb.clone(), mask);
        }
        let f = r.fill(0, &frames[0].0, &frames[0].1);
        assert!(f.left > 1000 && f.real == 0);
        // A stand-in for the model: a flat color.
        let mut painted = frames[0].0.clone();
        for k in 0..w * h {
            if f.residual[k] > 0 {
                painted[k * 3..k * 3 + 3].copy_from_slice(&[200, 100, 50]);
            }
        }
        r.add_layer(0, painted, f.residual.clone());
        for i in [0, 3, 5] {
            let g = r.fill(i, &frames[i].0, &frames[i].1);
            assert_eq!(g.left, 0);
            assert_eq!(g.layered, g.hole);
            let k = 45 * w + 60;
            assert_eq!(&g.rgba[k * 4..k * 4 + 4], &[200, 100, 50, 255]);
        }
    }
}
