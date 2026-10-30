//! Region tracking: follow a region (a mask on the first frame) through gray frames, as a transform
//! per frame from the first frame's coordinates. Shi-Tomasi corners inside the region, pyramidal
//! Lucas-Kanade with a forward-backward check, and a RANSAC fit of the chosen motion model; when too
//! few points survive, new corners are found inside the region where it is now. Used to carry object
//! masks between keyframes and to pin layers to surfaces (docs/design/cinematic-grade-and-vfx.md 5.2, 5.4).

use rayon::prelude::*;

/// A one-channel float image.
#[derive(Clone)]
pub struct Image {
    pub w: usize,
    pub h: usize,
    pub px: Vec<f32>,
}

impl Image {
    pub fn from_gray(data: &[u8], w: usize, h: usize) -> Self {
        Self { w, h, px: data.iter().map(|&v| v as f32).collect() }
    }

    #[inline]
    fn at(&self, x: isize, y: isize) -> f32 {
        let x = x.clamp(0, self.w as isize - 1) as usize;
        let y = y.clamp(0, self.h as isize - 1) as usize;
        self.px[y * self.w + x]
    }

    /// Bilinear sample, clamped at the borders.
    #[inline]
    fn sample(&self, x: f32, y: f32) -> f32 {
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let (x0, y0) = (x0 as isize, y0 as isize);
        let a = self.at(x0, y0) * (1.0 - fx) + self.at(x0 + 1, y0) * fx;
        let b = self.at(x0, y0 + 1) * (1.0 - fx) + self.at(x0 + 1, y0 + 1) * fx;
        a * (1.0 - fy) + b * fy
    }

    /// Half size, after a [1 4 6 4 1] blur.
    fn half(&self) -> Self {
        let (w, h) = ((self.w + 1) / 2, (self.h + 1) / 2);
        let k = [1.0, 4.0, 6.0, 4.0, 1.0];
        let mut tmp = vec![0.0f32; self.w * h];
        for y in 0..h {
            for x in 0..self.w {
                let mut s = 0.0;
                for (i, kv) in k.iter().enumerate() {
                    s += kv * self.at(x as isize, (2 * y) as isize + i as isize - 2);
                }
                tmp[y * self.w + x] = s / 16.0;
            }
        }
        let tmp = Image { w: self.w, h, px: tmp };
        let mut px = vec![0.0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut s = 0.0;
                for (i, kv) in k.iter().enumerate() {
                    s += kv * tmp.at((2 * x) as isize + i as isize - 2, y as isize);
                }
                px[y * w + x] = s / 16.0;
            }
        }
        Image { w, h, px }
    }
}

/// An image pyramid with its gradients, finest level first.
pub struct Pyramid {
    levels: Vec<(Image, Image, Image)>,
}

impl Pyramid {
    pub fn new(img: Image, levels: usize) -> Self {
        let mut imgs = vec![img];
        while imgs.len() < levels && imgs.last().unwrap().w >= 32 && imgs.last().unwrap().h >= 32 {
            let next = imgs.last().unwrap().half();
            imgs.push(next);
        }
        let levels = imgs
            .into_iter()
            .map(|im| {
                let (mut gx, mut gy) = (vec![0.0; im.w * im.h], vec![0.0; im.w * im.h]);
                for y in 0..im.h as isize {
                    for x in 0..im.w as isize {
                        // Scharr, scaled to a unit step.
                        let i = y as usize * im.w + x as usize;
                        gx[i] = (3.0 * (im.at(x + 1, y - 1) - im.at(x - 1, y - 1)) + 10.0 * (im.at(x + 1, y) - im.at(x - 1, y)) + 3.0 * (im.at(x + 1, y + 1) - im.at(x - 1, y + 1))) / 32.0;
                        gy[i] = (3.0 * (im.at(x - 1, y + 1) - im.at(x - 1, y - 1)) + 10.0 * (im.at(x, y + 1) - im.at(x, y - 1)) + 3.0 * (im.at(x + 1, y + 1) - im.at(x + 1, y - 1))) / 32.0;
                    }
                }
                let (w, h) = (im.w, im.h);
                (im, Image { w, h, px: gx }, Image { w, h, px: gy })
            })
            .collect();
        Self { levels }
    }
}

/// Up to `max` corners (Shi-Tomasi: the smaller eigenvalue of the structure tensor), at least
/// `min_dist` apart, where `region` (same size as the image) is non-zero for `inset` pixels around.
/// The inset keeps points off the region's edge, where they often lie on the background.
pub fn good_features(p: &Pyramid, region: Option<&[u8]>, max: usize, min_dist: f32, inset: usize) -> Vec<(f32, f32)> {
    let (img, gx, gy) = &p.levels[0];
    let (w, h) = (img.w, img.h);
    // Integral image of the region, so "all inside within inset" is one box sum.
    let inside: Option<Vec<u32>> = region.map(|m| {
        let mut sum = vec![0u32; (w + 1) * (h + 1)];
        for y in 0..h {
            let mut row = 0u32;
            for x in 0..w {
                row += (m[y * w + x] > 0) as u32;
                sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
            }
        }
        sum
    });
    let full = |x: usize, y: usize| -> bool {
        let Some(sum) = &inside else { return true };
        let (x0, y0, x1, y1) = (x.saturating_sub(inset), y.saturating_sub(inset), (x + inset + 1).min(w), (y + inset + 1).min(h));
        let s = sum[y1 * (w + 1) + x1] + sum[y0 * (w + 1) + x0] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0];
        s as usize == (x1 - x0) * (y1 - y0)
    };
    let r = 3isize;
    let border = 8usize;
    let mut scores: Vec<(f32, usize)> = (border..h.saturating_sub(border))
        .into_par_iter()
        .flat_map_iter(|y| {
            (border..w.saturating_sub(border)).filter_map(move |x| {
                if !full(x, y) {
                    return None;
                }
                let (mut a, mut b, mut c) = (0.0f32, 0.0f32, 0.0f32);
                for dy in -r..=r {
                    for dx in -r..=r {
                        let (u, v) = (gx.at(x as isize + dx, y as isize + dy), gy.at(x as isize + dx, y as isize + dy));
                        a += u * u;
                        b += u * v;
                        c += v * v;
                    }
                }
                let lambda = 0.5 * ((a + c) - ((a - c) * (a - c) + 4.0 * b * b).sqrt());
                (lambda > 0.0).then_some((lambda, y * w + x))
            })
        })
        .collect();
    if scores.is_empty() {
        return vec![];
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let floor = scores[0].0 * 0.01;
    // A coarse grid keeps the minimum distance check cheap.
    let cell = min_dist.max(1.0);
    let (gw, gh) = ((w as f32 / cell) as usize + 1, (h as f32 / cell) as usize + 1);
    let mut grid: Vec<Vec<(f32, f32)>> = vec![vec![]; gw * gh];
    let mut out = vec![];
    for (s, i) in scores {
        if s < floor || out.len() >= max {
            break;
        }
        let (x, y) = ((i % w) as f32, (i / w) as f32);
        let (cx, cy) = ((x / cell) as isize, (y / cell) as isize);
        let mut free = true;
        'n: for ny in cy - 1..=cy + 1 {
            for nx in cx - 1..=cx + 1 {
                if nx < 0 || ny < 0 || nx as usize >= gw || ny as usize >= gh {
                    continue;
                }
                for &(px, py) in &grid[ny as usize * gw + nx as usize] {
                    if (px - x).powi(2) + (py - y).powi(2) < min_dist * min_dist {
                        free = false;
                        break 'n;
                    }
                }
            }
        }
        if free {
            grid[cy as usize * gw + cx as usize].push((x, y));
            out.push((x, y));
        }
    }
    out
}

const WIN: isize = 7;

/// Pyramidal Lucas-Kanade: where each point of `a` went in `b` (None when lost).
pub fn lucas_kanade(a: &Pyramid, b: &Pyramid, pts: &[(f32, f32)]) -> Vec<Option<(f32, f32)>> {
    pts.par_iter()
        .map(|&(px, py)| {
            let top = a.levels.len().min(b.levels.len()) - 1;
            let mut gxy = (0.0f32, 0.0f32);
            for l in (0..=top).rev() {
                let s = (1 << l) as f32;
                let (ia, ax, ay) = &a.levels[l];
                let (ib, _, _) = &b.levels[l];
                let (x, y) = (px / s, py / s);
                let (mut sxx, mut sxy, mut syy) = (0.0f32, 0.0f32, 0.0f32);
                for dy in -WIN..=WIN {
                    for dx in -WIN..=WIN {
                        let (u, v) = (ax.sample(x + dx as f32, y + dy as f32), ay.sample(x + dx as f32, y + dy as f32));
                        sxx += u * u;
                        sxy += u * v;
                        syy += v * v;
                    }
                }
                let det = sxx * syy - sxy * sxy;
                if det.abs() < 1e-3 {
                    return None;
                }
                let mut d = (0.0f32, 0.0f32);
                for _ in 0..20 {
                    let (mut bx, mut by) = (0.0f32, 0.0f32);
                    for dy in -WIN..=WIN {
                        for dx in -WIN..=WIN {
                            let (qx, qy) = (x + dx as f32, y + dy as f32);
                            let diff = ia.sample(qx, qy) - ib.sample(qx + gxy.0 + d.0, qy + gxy.1 + d.1);
                            bx += diff * ax.sample(qx, qy);
                            by += diff * ay.sample(qx, qy);
                        }
                    }
                    let step = ((syy * bx - sxy * by) / det, (sxx * by - sxy * bx) / det);
                    d = (d.0 + step.0, d.1 + step.1);
                    if step.0 * step.0 + step.1 * step.1 < 1e-4 {
                        break;
                    }
                }
                gxy = if l > 0 { (2.0 * (gxy.0 + d.0), 2.0 * (gxy.1 + d.1)) } else { (gxy.0 + d.0, gxy.1 + d.1) };
            }
            let (nx, ny) = (px + gxy.0, py + gxy.1);
            let (w, h) = (b.levels[0].0.w as f32, b.levels[0].0.h as f32);
            (nx.is_finite() && ny.is_finite() && nx >= 0.0 && ny >= 0.0 && nx < w && ny < h).then_some((nx, ny))
        })
        .collect()
}

/// Motion models, from the fewest to the most degrees of freedom.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Model {
    Translation,
    Similarity,
    Affine,
    Homography,
}

impl Model {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "translation" => Self::Translation,
            "similarity" => Self::Similarity,
            "affine" => Self::Affine,
            "homography" => Self::Homography,
            _ => return None,
        })
    }

    fn sample_size(self) -> usize {
        match self {
            Self::Translation => 1,
            Self::Similarity => 2,
            Self::Affine => 3,
            Self::Homography => 4,
        }
    }
}

/// A 3x3 matrix, row major, mapping (x, y, 1).
pub type Mat3 = [f64; 9];

pub const IDENTITY: Mat3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

pub fn apply(m: &Mat3, x: f64, y: f64) -> (f64, f64) {
    let w = m[6] * x + m[7] * y + m[8];
    ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w)
}

pub fn invert(m: &Mat3) -> Option<Mat3> {
    let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if det.abs() < 1e-12 {
        return None;
    }
    let d = 1.0 / det;
    Some([
        (m[4] * m[8] - m[5] * m[7]) * d,
        (m[2] * m[7] - m[1] * m[8]) * d,
        (m[1] * m[5] - m[2] * m[4]) * d,
        (m[5] * m[6] - m[3] * m[8]) * d,
        (m[0] * m[8] - m[2] * m[6]) * d,
        (m[2] * m[3] - m[0] * m[5]) * d,
        (m[3] * m[7] - m[4] * m[6]) * d,
        (m[1] * m[6] - m[0] * m[7]) * d,
        (m[0] * m[4] - m[1] * m[3]) * d,
    ])
}

/// Solve a small linear system (normal equations of least squares) by Gaussian elimination.
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        if a[p][c].abs() < 1e-12 {
            return None;
        }
        a.swap(c, p);
        b.swap(c, p);
        for r in c + 1..n {
            let f = a[r][c] / a[c][c];
            for k in c..n {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = vec![0.0; n];
    for r in (0..n).rev() {
        let s: f64 = (r + 1..n).map(|k| a[r][k] * x[k]).sum();
        x[r] = (b[r] - s) / a[r][r];
    }
    Some(x)
}

/// Least-squares fit of a model mapping `src` to `dst`.
pub fn fit(model: Model, src: &[(f64, f64)], dst: &[(f64, f64)]) -> Option<Mat3> {
    if src.len() < model.sample_size() {
        return None;
    }
    // Rows of the design: each point gives two equations in the unknowns.
    let rows: Vec<(Vec<f64>, f64)> = src
        .iter()
        .zip(dst)
        .flat_map(|(&(x, y), &(u, v))| match model {
            Model::Translation => vec![(vec![1.0, 0.0], u - x), (vec![0.0, 1.0], v - y)],
            // [a -b tx; b a ty]
            Model::Similarity => vec![(vec![x, -y, 1.0, 0.0], u), (vec![y, x, 0.0, 1.0], v)],
            Model::Affine => vec![(vec![x, y, 1.0, 0.0, 0.0, 0.0], u), (vec![0.0, 0.0, 0.0, x, y, 1.0], v)],
            // h33 = 1: u (h31 x + h32 y + 1) = h11 x + h12 y + h13
            Model::Homography => vec![
                (vec![x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y], u),
                (vec![0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y], v),
            ],
        })
        .collect();
    let n = rows[0].0.len();
    let mut ata = vec![vec![0.0; n]; n];
    let mut atb = vec![0.0; n];
    for (r, t) in &rows {
        for i in 0..n {
            atb[i] += r[i] * t;
            for j in 0..n {
                ata[i][j] += r[i] * r[j];
            }
        }
    }
    let p = solve(ata, atb)?;
    Some(match model {
        Model::Translation => [1.0, 0.0, p[0], 0.0, 1.0, p[1], 0.0, 0.0, 1.0],
        Model::Similarity => [p[0], -p[1], p[2], p[1], p[0], p[3], 0.0, 0.0, 1.0],
        Model::Affine => [p[0], p[1], p[2], p[3], p[4], p[5], 0.0, 0.0, 1.0],
        Model::Homography => [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], 1.0],
    })
}

/// RANSAC fit: the model with the most points within `thresh` pixels, refit on those points.
/// Deterministic (a fixed seed), so the same frames always track the same way.
pub fn ransac(model: Model, src: &[(f64, f64)], dst: &[(f64, f64)], thresh: f64) -> Option<(Mat3, Vec<bool>)> {
    let k = model.sample_size();
    if src.len() < k {
        return None;
    }
    let mut seed = 0x9E3779B97F4A7C15u64;
    let mut rand = |n: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % n as u64) as usize
    };
    let inliers_of = |m: &Mat3| -> Vec<bool> {
        src.iter().zip(dst).map(|(&(x, y), &(u, v))| {
            let (px, py) = apply(m, x, y);
            (px - u).powi(2) + (py - v).powi(2) < thresh * thresh
        }).collect()
    };
    let mut best: Option<(Mat3, Vec<bool>, usize)> = None;
    for _ in 0..200 {
        let mut idx = vec![];
        while idx.len() < k {
            let i = rand(src.len());
            if !idx.contains(&i) {
                idx.push(i);
            }
        }
        let s: Vec<_> = idx.iter().map(|&i| src[i]).collect();
        let d: Vec<_> = idx.iter().map(|&i| dst[i]).collect();
        let Some(m) = fit(model, &s, &d) else { continue };
        let inl = inliers_of(&m);
        let count = inl.iter().filter(|&&b| b).count();
        if best.as_ref().map_or(true, |b| count > b.2) {
            best = Some((m, inl, count));
        }
    }
    let (m, inl, _) = best?;
    let s: Vec<_> = src.iter().zip(&inl).filter(|(_, &b)| b).map(|(p, _)| *p).collect();
    let d: Vec<_> = dst.iter().zip(&inl).filter(|(_, &b)| b).map(|(p, _)| *p).collect();
    let refined = fit(model, &s, &d).unwrap_or(m);
    let inl = inliers_of(&refined);
    Some((refined, inl))
}

/// The transform of one frame (from the first frame), and how well it is supported.
#[derive(Clone, Debug)]
pub struct Step {
    pub m: Mat3,
    /// Points that agree with the transform.
    pub inliers: u32,
    /// Root mean square distance of those points from where the transform puts them (pixels).
    pub error: f32,
    /// New corners were found in this frame because too few survived.
    pub redetected: bool,
}

pub struct TrackOptions {
    pub model: Model,
    /// Corners stay this many pixels inside the region.
    pub inset: usize,
    pub max_points: usize,
    /// Pixels between corners.
    pub min_dist: f32,
    /// Forward-backward check: a point must come back within this many pixels.
    pub fb_max: f32,
    /// RANSAC inlier distance, pixels.
    pub thresh: f64,
}

impl Default for TrackOptions {
    fn default() -> Self {
        Self { model: Model::Affine, inset: 4, max_points: 300, min_dist: 6.0, fb_max: 1.0, thresh: 1.5 }
    }
}

/// Follow `region` (non-zero pixels of the first frame) through `n` gray frames of `w` x `h`.
/// Returns one step per frame; the first is the identity.
pub fn track_region(frames: &[u8], w: usize, h: usize, n: usize, region: &[u8], opts: &TrackOptions) -> Vec<Step> {
    let frame = |i: usize| Pyramid::new(Image::from_gray(&frames[i * w * h..(i + 1) * w * h], w, h), 4);
    let mut steps = vec![Step { m: IDENTITY, inliers: 0, error: 0.0, redetected: false }];
    if n == 0 {
        return vec![];
    }
    let mut prev = frame(0);
    // Each point: where it is now, and where it was on the first frame.
    let mut cur: Vec<(f32, f32)> = good_features(&prev, Some(region), opts.max_points, opts.min_dist, opts.inset);
    let mut anchor: Vec<(f64, f64)> = cur.iter().map(|&(x, y)| (x as f64, y as f64)).collect();
    steps[0].inliers = cur.len() as u32;
    let start = cur.len().max(1);
    let mut last = IDENTITY;
    for i in 1..n {
        let next = frame(i);
        let fwd = lucas_kanade(&prev, &next, &cur);
        let moved: Vec<(f32, f32)> = fwd.iter().map(|p| p.unwrap_or((-1.0, -1.0))).collect();
        let back = lucas_kanade(&next, &prev, &moved);
        let (mut c2, mut a2) = (vec![], vec![]);
        for k in 0..cur.len() {
            if let (Some(f), Some(b)) = (fwd[k], back[k]) {
                if (b.0 - cur[k].0).powi(2) + (b.1 - cur[k].1).powi(2) < opts.fb_max * opts.fb_max {
                    c2.push(f);
                    a2.push(anchor[k]);
                }
            }
        }
        let dst: Vec<(f64, f64)> = c2.iter().map(|&(x, y)| (x as f64, y as f64)).collect();
        let mut step = match ransac(opts.model, &a2, &dst, opts.thresh) {
            Some((m, inl)) => {
                let kept: Vec<usize> = (0..inl.len()).filter(|&k| inl[k]).collect();
                let err = (kept.iter().map(|&k| {
                    let (px, py) = apply(&m, a2[k].0, a2[k].1);
                    (px - dst[k].0).powi(2) + (py - dst[k].1).powi(2)
                }).sum::<f64>() / kept.len().max(1) as f64).sqrt();
                cur = kept.iter().map(|&k| c2[k]).collect();
                anchor = kept.iter().map(|&k| a2[k]).collect();
                last = m;
                Step { m, inliers: kept.len() as u32, error: err as f32, redetected: false }
            }
            // Lost: hold the last transform, and look for new corners below.
            None => {
                cur.clear();
                anchor.clear();
                Step { m: last, inliers: 0, error: f32::INFINITY, redetected: false }
            }
        };
        // Too few points left: find new corners inside the region where it is now.
        if cur.len() < (start / 3).max(12) {
            if let Some(inv) = invert(&step.m) {
                let warped: Vec<u8> = (0..w * h)
                    .into_par_iter()
                    .map(|i| {
                        let (x0, y0) = apply(&inv, (i % w) as f64, (i / w) as f64);
                        let (x0, y0) = (x0.round(), y0.round());
                        (x0 >= 0.0 && y0 >= 0.0 && (x0 as usize) < w && (y0 as usize) < h && region[y0 as usize * w + x0 as usize] > 0) as u8
                    })
                    .collect();
                let fresh = good_features(&next, Some(&warped), opts.max_points, opts.min_dist, opts.inset);
                anchor.extend(fresh.iter().map(|&(x, y)| apply(&inv, x as f64, y as f64)));
                cur.extend(fresh);
                step.redetected = true;
            }
        }
        steps.push(step);
        prev = next;
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured test image (smooth noise of several sizes), warped by `m` (inverse mapping).
    fn scene(w: usize, h: usize, m: &Mat3) -> Vec<u8> {
        let inv = invert(m).unwrap();
        let tex = |x: f64, y: f64| -> f64 {
            let mut v = 0.0;
            for (k, f) in [(0.9, 0.031), (0.5, 0.067), (0.3, 0.13), (0.2, 0.21)] {
                v += k * ((x * f).sin() * (y * f * 1.3).cos() + (x * f * 0.7 + y * f * 1.1).sin());
            }
            128.0 + 40.0 * v
        };
        (0..w * h).map(|i| {
            let (x, y) = apply(&inv, (i % w) as f64, (i / w) as f64);
            tex(x, y).clamp(0.0, 255.0) as u8
        }).collect()
    }

    fn corners_error(a: &Mat3, b: &Mat3, w: f64, h: f64) -> f64 {
        [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)].iter().map(|&(x, y)| {
            let (p, q) = (apply(a, x, y), apply(b, x, y));
            ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt()
        }).fold(0.0, f64::max)
    }

    #[test]
    fn fits_each_model_exactly() {
        let truth: Mat3 = [1.02, -0.05, 4.0, 0.04, 0.98, -3.0, 0.0001, -0.00005, 1.0];
        let src: Vec<(f64, f64)> = (0..20).map(|i| ((i * 37 % 200) as f64, (i * 53 % 150) as f64)).collect();
        let dst: Vec<(f64, f64)> = src.iter().map(|&(x, y)| apply(&truth, x, y)).collect();
        let m = fit(Model::Homography, &src, &dst).unwrap();
        assert!(corners_error(&m, &truth, 200.0, 150.0) < 1e-6);
    }

    #[test]
    fn ransac_ignores_outliers() {
        let truth: Mat3 = [1.0, 0.0, 7.0, 0.0, 1.0, -2.0, 0.0, 0.0, 1.0];
        let src: Vec<(f64, f64)> = (0..50).map(|i| ((i * 13 % 100) as f64, (i * 29 % 80) as f64)).collect();
        let mut dst: Vec<(f64, f64)> = src.iter().map(|&(x, y)| apply(&truth, x, y)).collect();
        for k in 0..15 {
            dst[k * 3].0 += 40.0;
        }
        let (m, inl) = ransac(Model::Affine, &src, &dst, 1.0).unwrap();
        assert!(corners_error(&m, &truth, 100.0, 80.0) < 1e-6);
        assert_eq!(inl.iter().filter(|&&b| b).count(), 35);
    }

    #[test]
    fn follows_known_homographies_within_half_a_pixel() {
        let (w, h, n) = (320usize, 240usize, 12usize);
        // A flat surface turning and sliding: a small change each frame.
        let truth: Vec<Mat3> = (0..n).map(|i| {
            let t = i as f64;
            let (a, s) = (0.01 * t, 1.0 + 0.006 * t);
            [s * a.cos(), -s * a.sin(), 2.0 * t, s * a.sin(), s * a.cos(), 1.2 * t, 0.00002 * t, 0.00001 * t, 1.0]
        }).collect();
        let frames: Vec<u8> = truth.iter().flat_map(|m| scene(w, h, m)).collect();
        let mut region = vec![0u8; w * h];
        for y in 60..180 {
            for x in 80..240 {
                region[y * w + x] = 1;
            }
        }
        let steps = track_region(&frames, w, h, n, &region, &TrackOptions { model: Model::Homography, ..Default::default() });
        assert_eq!(steps.len(), n);
        for (i, s) in steps.iter().enumerate() {
            // The region's corners, as the design's check for screen and sign inserts.
            let err = [(80.0, 60.0), (240.0, 60.0), (80.0, 180.0), (240.0, 180.0)].iter().map(|&(x, y)| {
                let (p, q) = (apply(&s.m, x, y), apply(&truth[i], x, y));
                ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt()
            }).fold(0.0, f64::max);
            assert!(err < 0.5, "frame {i}: corner error {err:.3} px");
        }
    }
}
