//! Depth over time (section 7.1 of docs/design/cinematic-grade-and-vfx.md). A monocular model gives
//! relative depth on keyframes, each with its own unknown scale and shift, so on its own it flickers.
//! Here each keyframe is fitted to the one before it (least-squares scale and shift over the pixels
//! that agree, so moving things do not pull the fit), depth is carried between keyframes along the
//! camera's motion from both sides, edges are snapped to each frame with a guided filter, and a light
//! blend with the previous frame (moved with the camera) settles what is left.
//!
//! Values are distance on the first keyframe's scale: its nearest things (2nd percentile) at 0.1 and
//! its farthest (98th) at 0.9, leaving room for nearer and farther things later in the clip.

use crate::control::{Cancelled, Control};
use crate::refine::guided_filter_f32;
use crate::track::{apply, invert, Mat3};
use rayon::prelude::*;

#[derive(Clone, Debug)]
pub struct DepthOptions {
    /// Guided filter radius in pixels, and its regularization on 0..1 values.
    pub radius: usize,
    pub eps: f32,
    /// Weight of the previous frame in the final blend over time.
    pub keep: f32,
}

impl Default for DepthOptions {
    fn default() -> Self {
        DepthOptions { radius: 4, eps: 1e-3, keep: 0.3 }
    }
}

fn mat(motion: &[f64], i: usize) -> Mat3 {
    motion[i * 9..i * 9 + 9].try_into().unwrap()
}

pub fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut m = [0.0; 9];
    for r in 0..3 {
        for c in 0..3 {
            m[r * 3 + c] = (0..3).map(|k| a[r * 3 + k] * b[k * 3 + c]).sum();
        }
    }
    m
}

/// `src` moved by `m` (from its pixels to the output's), bilinear, with where it had data.
pub fn warp(src: &[f32], w: usize, h: usize, m: &Mat3) -> (Vec<f32>, Vec<bool>) {
    let Some(inv) = invert(m) else { return (vec![0.0; w * h], vec![false; w * h]) };
    (0..w * h)
        .into_par_iter()
        .map(|k| {
            let (x, y) = apply(&inv, (k % w) as f64, (k / w) as f64);
            if x < 0.0 || y < 0.0 || x > (w - 1) as f64 || y > (h - 1) as f64 {
                return (0.0, false);
            }
            let (x0, y0) = (x.floor() as usize, y.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
            let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
            let at = |xx: usize, yy: usize| src[yy * w + xx];
            let v = (at(x0, y0) * (1.0 - fx) + at(x1, y0) * fx) * (1.0 - fy) + (at(x0, y1) * (1.0 - fx) + at(x1, y1) * fx) * fy;
            (v, true)
        })
        .unzip()
}

/// The scale and shift taking `src` closest to `dst` over `valid` pixels. It starts from a robust
/// guess (the interquartile ranges and medians matched), then twice leaves out the pixels whose
/// error is over twice the median (moving things, new occlusions) and fits by least squares.
pub fn fit_scale_shift(src: &[f32], dst: &[f32], valid: &[bool]) -> (f32, f32) {
    let pick = |v: &[f32]| -> Vec<f32> { v.iter().zip(valid).filter(|(_, &ok)| ok).map(|(&x, _)| x).collect() };
    let (ps, pd) = (pick(src), pick(dst));
    if ps.len() < 16 {
        return (1.0, 0.0);
    }
    let iqr = |v: &[f32]| percentile(v, 0.75) - percentile(v, 0.25);
    let std = |v: &[f32]| {
        let m = v.iter().map(|&x| x as f64).sum::<f64>() / v.len() as f64;
        (v.iter().map(|&x| (x as f64 - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
    };
    // Where most pixels share one value (a flat wall), the quartiles meet: compare spreads instead.
    let mut s = if iqr(&ps) > 1e-6 && iqr(&pd) > 1e-6 { (iqr(&pd) / iqr(&ps)) as f64 } else { std(&pd) / std(&ps).max(1e-12) };
    let mut t = percentile(&pd, 0.5) as f64 - s * percentile(&ps, 0.5) as f64;
    let mut keep: Vec<bool> = valid.to_vec();
    for round in 0..3 {
        if round > 0 {
            let mut errs: Vec<f32> = (0..src.len()).filter(|&k| keep[k]).map(|k| ((s * src[k] as f64 + t) - dst[k] as f64).abs() as f32).collect();
            if errs.is_empty() {
                break;
            }
            let mid = errs.len() / 2;
            let median = *errs.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap()).1;
            let limit = (2.0 * median).max(1e-6) as f64;
            for k in 0..src.len() {
                keep[k] = keep[k] && ((s * src[k] as f64 + t) - dst[k] as f64).abs() <= limit;
            }
        }
        if round == 0 {
            continue;
        }
        let (mut n, mut sx, mut sy, mut sxx, mut sxy) = (0f64, 0f64, 0f64, 0f64, 0f64);
        for k in 0..src.len() {
            if keep[k] {
                let (x, y) = (src[k] as f64, dst[k] as f64);
                n += 1.0;
                sx += x;
                sy += y;
                sxx += x * x;
                sxy += x * y;
            }
        }
        let den = n * sxx - sx * sx;
        if n < 16.0 || den.abs() < 1e-12 {
            break;
        }
        s = (n * sxy - sx * sy) / den;
        t = (sy - s * sx) / n;
    }
    (s as f32, t as f32)
}

fn percentile(v: &[f32], q: f32) -> f32 {
    let mut s = v.to_vec();
    let i = ((s.len() - 1) as f32 * q) as usize;
    *s.select_nth_unstable_by(i, |a, b| a.partial_cmp(b).unwrap()).1
}

/// Depth for every frame of a chunk.
///
/// `gray`: `n` frames of `w` x `h`. `keys`: ascending frame indexes with a model result, the first 0
/// and the last n - 1. `disparity`: the model's output for each key (larger is nearer), resized to
/// `w` x `h`. `motion`: per frame, the 3x3 transform from frame 0's pixels to that frame's.
/// `previous`: frame 0's depth from the chunk before, so chunks join on the same scale. `ctl` counts
/// a step per keyframe and per frame of each pass, and stops the work when cancelled.
pub fn depth_sequence(gray: &[u8], w: usize, h: usize, n: usize, keys: &[usize], disparity: &[f32], motion: &[f64], previous: Option<&[f32]>, opts: &DepthOptions, ctl: &Control) -> Result<Vec<f32>, Cancelled> {
    let area = w * h;
    ctl.start((keys.len() + 3 * n) as u32);
    ctl.check()?;
    let all = vec![true; area];
    // Distance grows as disparity falls; its scale and shift are fitted below.
    let raw = |j: usize| -> Vec<f32> { disparity[j * area..(j + 1) * area].iter().map(|v| -v).collect() };
    let mut aligned: Vec<Vec<f32>> = Vec::with_capacity(keys.len());
    for (j, &f) in keys.iter().enumerate() {
        let d = raw(j);
        let (s, t) = if j == 0 {
            match previous {
                Some(p) => fit_scale_shift(&d, p, &all),
                None => {
                    // The first keyframe sets the scale: its 2nd..98th percentiles become 0.1..0.9.
                    let (lo, hi) = (percentile(&d, 0.02), percentile(&d, 0.98));
                    let s = 0.8 / (hi - lo).max(1e-6);
                    (s, 0.1 - lo * s)
                }
            }
        } else {
            // Fit to the previous keyframe, moved to where the camera is now.
            let a = keys[j - 1];
            let to = mul(&mat(motion, f), &invert(&mat(motion, a)).unwrap_or(mat(motion, 0)));
            let (reference, valid) = warp(&aligned[j - 1], w, h, &to);
            let (s, t) = fit_scale_shift(&d, &reference, &valid);
            // A fit that turns depth inside out (too little overlap) is not trusted.
            if s > 0.0 { (s, t) } else { fit_scale_shift(&d, &aligned[j - 1], &all) }
        };
        aligned.push(d.iter().map(|v| s * v + t).collect());
        ctl.step()?;
    }
    if let (Some(p), Some(first)) = (previous, aligned.first_mut()) {
        first.copy_from_slice(p);
    }

    // Carried between keyframes from both sides, blended by distance; where neither side saw a
    // pixel (it came into view), the nearer keyframe's value stays.
    let carried: Vec<Vec<f32>> = (0..n)
        .into_par_iter()
        .map(|i| -> Result<Vec<f32>, Cancelled> {
            ctl.step()?;
            let j = keys.iter().rposition(|&k| k <= i).unwrap_or(0);
            if keys[j] == i {
                return Ok(aligned[j].clone());
            }
            let (a, b) = (keys[j], keys[(j + 1).min(keys.len() - 1)]);
            let u = (i - a) as f32 / (b - a).max(1) as f32;
            let cur = mat(motion, i);
            let move_from = |k: usize| mul(&cur, &invert(&mat(motion, k)).unwrap_or(cur));
            let (fa, va) = warp(&aligned[j], w, h, &move_from(a));
            let (fb, vb) = warp(&aligned[(j + 1).min(keys.len() - 1)], w, h, &move_from(b));
            let near = if u < 0.5 { &aligned[j] } else { &aligned[(j + 1).min(keys.len() - 1)] };
            Ok((0..area)
                .map(|q| match (va[q], vb[q]) {
                    (true, true) => fa[q] * (1.0 - u) + fb[q] * u,
                    (true, false) => fa[q],
                    (false, true) => fb[q],
                    _ => near[q],
                })
                .collect())
        })
        .collect::<Result<_, _>>()?;

    // Edges snapped to each frame.
    let refined: Vec<Vec<f32>> = carried
        .par_iter()
        .enumerate()
        .map(|(i, d)| -> Result<Vec<f32>, Cancelled> {
            ctl.step()?;
            let g: Vec<f32> = gray[i * area..(i + 1) * area].iter().map(|&v| v as f32 / 255.0).collect();
            Ok(guided_filter_f32(&g, d, w, h, opts.radius, opts.eps))
        })
        .collect::<Result<_, _>>()?;

    // A light blend with the previous frame, moved with the camera.
    let mut out = vec![0.0f32; n * area];
    for i in 0..n {
        ctl.step()?;
        let cur = &refined[i];
        if i == 0 || opts.keep <= 0.0 {
            out[i * area..(i + 1) * area].copy_from_slice(cur);
            continue;
        }
        let step = mul(&mat(motion, i), &invert(&mat(motion, i - 1)).unwrap_or(mat(motion, i)));
        let (prev, valid) = warp(&out[(i - 1) * area..i * area], w, h, &step);
        for q in 0..area {
            out[i * area + q] = if valid[q] { cur[q] * (1.0 - opts.keep) + prev[q] * opts.keep } else { cur[q] };
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: Mat3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    /// A scene's true distance: a far wall (0.9) with a near box (0.2) and a slope in between.
    fn scene(w: usize, h: usize, dx: f32) -> Vec<f32> {
        (0..w * h)
            .map(|k| {
                let (x, y) = ((k % w) as f32 - dx, (k / w) as f32);
                if (20.0..40.0).contains(&x) && (10.0..30.0).contains(&y) { 0.2 } else { 0.4 + 0.5 * (y / h as f32) }
            })
            .collect()
    }

    #[test]
    fn fits_scale_and_shift_despite_outliers() {
        let dst: Vec<f32> = (0..1000).map(|k| k as f32 / 1000.0).collect();
        // A model's output on another scale, with a tenth of it wrong (something moved).
        let src: Vec<f32> = dst.iter().enumerate().map(|(k, v)| if k % 10 == 0 { 5.0 } else { (v - 0.3) / 2.0 }).collect();
        let (s, t) = fit_scale_shift(&src, &dst, &vec![true; 1000]);
        assert!((s - 2.0).abs() < 1e-3 && (t - 0.3).abs() < 1e-3, "{s} {t}");
    }

    #[test]
    fn fits_mostly_flat_maps() {
        // A flat wall with a small near box: the quartiles of both maps are the same value.
        let dst: Vec<f32> = (0..1000).map(|k| if k % 10 == 0 { 0.1 } else { 0.9 }).collect();
        let src: Vec<f32> = dst.iter().map(|v| v * 4.0 - 7.0).collect();
        let (s, t) = fit_scale_shift(&src, &dst, &vec![true; 1000]);
        assert!((s - 0.25).abs() < 1e-3 && (t - 1.75).abs() < 1e-3, "{s} {t}");
    }

    #[test]
    fn keyframes_on_different_scales_come_out_on_one() {
        let (w, h, n) = (64, 48, 9);
        let truth = scene(w, h, 0.0);
        // The model's disparity on each keyframe, with its own scale and offset (and inverted, as disparity is).
        let disp: Vec<f32> = [(3.0, 1.0), (0.5, -2.0), (7.0, 4.0)].iter().flat_map(|&(s, t)| truth.iter().map(move |v| -(v * s) + t)).collect();
        let gray: Vec<u8> = (0..n).flat_map(|_| truth.iter().map(|v| (v * 255.0) as u8)).collect();
        let motion: Vec<f64> = (0..n).flat_map(|_| ID).collect();
        let out = depth_sequence(&gray, w, h, n, &[0, 4, 8], &disp, &motion, None, &DepthOptions { keep: 0.0, ..Default::default() }, &Control::default()).unwrap();
        // Every frame on the first keyframe's scale: frame 8 matches frame 0 everywhere.
        let worst = (0..w * h).map(|q| (out[8 * w * h + q] - out[q]).abs()).fold(0.0, f32::max);
        assert!(worst < 0.02, "frames differ by {worst}");
        // Near is small, far is large.
        assert!(out[20 * w + 30] < out[45 * w + 5]);
    }

    #[test]
    fn carries_depth_along_the_camera() {
        let (w, h, n) = (96, 48, 7);
        // The camera pans: the scene moves 2 px right a frame.
        let frames: Vec<Vec<f32>> = (0..n).map(|i| scene(w, h, 2.0 * i as f32)).collect();
        let gray: Vec<u8> = frames.iter().flat_map(|f| f.iter().map(|v| (v * 255.0) as u8)).collect();
        let disp: Vec<f32> = [0, n - 1].iter().flat_map(|&i| frames[i].iter().map(|v| -v)).collect();
        let motion: Vec<f64> = (0..n).flat_map(|i| [1.0, 0.0, 2.0 * i as f64, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]).collect();
        let out = depth_sequence(&gray, w, h, n, &[0, n - 1], &disp, &motion, None, &DepthOptions { keep: 0.0, radius: 2, ..Default::default() }, &Control::default()).unwrap();
        // In the middle frame the box sits at x 26..46: near inside it, far beside it.
        let mid = 3 * w * h;
        let (inside, beside) = (out[mid + 20 * w + 36], out[mid + 20 * w + 52]);
        assert!(beside - inside > 0.4, "box {inside}, wall {beside}");
    }

    #[test]
    fn continues_from_the_previous_chunk() {
        let (w, h, n) = (32, 24, 3);
        let truth = scene(w, h, 0.0);
        let previous: Vec<f32> = truth.iter().map(|v| v * 0.5 + 0.1).collect();
        let disp: Vec<f32> = (0..2).flat_map(|_| truth.iter().map(|v| -v * 9.0)).collect();
        let gray = vec![128u8; n * w * h];
        let motion: Vec<f64> = (0..n).flat_map(|_| ID).collect();
        let out = depth_sequence(&gray, w, h, n, &[0, 2], &disp, &motion, Some(&previous), &DepthOptions { keep: 0.0, ..Default::default() }, &Control::default()).unwrap();
        // The last frame lands on the previous chunk's scale (both went through the same edge filter).
        let worst = (0..w * h).map(|q| (out[2 * w * h + q] - out[q]).abs()).fold(0.0, f32::max);
        assert!(worst < 0.02, "{worst}");
        let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
        assert!((mean(&out[..w * h]) - mean(&previous)).abs() < 0.01);
    }

    #[test]
    fn counts_progress_and_stops_when_cancelled() {
        let (w, h, n) = (32, 24, 5);
        let truth = scene(w, h, 0.0);
        let disp: Vec<f32> = (0..2).flat_map(|_| truth.iter().map(|v| -v)).collect();
        let gray = vec![128u8; n * w * h];
        let motion: Vec<f64> = (0..n).flat_map(|_| ID).collect();
        let ctl = Control::default();
        depth_sequence(&gray, w, h, n, &[0, n - 1], &disp, &motion, None, &DepthOptions::default(), &ctl).unwrap();
        // Two keyframes, then three passes over five frames.
        assert_eq!(ctl.progress(), (17, 17));
        ctl.cancel();
        assert_eq!(depth_sequence(&gray, w, h, n, &[0, n - 1], &disp, &motion, None, &DepthOptions::default(), &ctl), Err(Cancelled));
    }
}
