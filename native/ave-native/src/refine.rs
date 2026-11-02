//! Matte refinement. A model's mask is coarse (SAM predicts at 256 x 256); the guided filter
//! (He, Sun and Tang, "Guided Image Filtering", 2010) snaps its edges to the edges of the full-size
//! frame, so hair and fine outlines survive. Linear in the pixel count: box sums from integral images.

use rayon::prelude::*;

/// Mean over a (2r+1)^2 box around each pixel (fewer pixels at the borders), from an integral image.
fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut sum = vec![0.0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0.0f64;
        for x in 0..w {
            row += src[y * w + x] as f64;
            sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
        }
    }
    (0..h)
        .into_par_iter()
        .flat_map_iter(|y| {
            let sum = &sum;
            let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
            (0..w).map(move |x| {
                let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
                let s = sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
                (s / ((x1 - x0) * (y1 - y0)) as f64) as f32
            })
        })
        .collect()
}

/// Guided filter of `mask` (0..255) by `guide` (gray 0..255), both `w` x `h`. `radius` in pixels;
/// `eps` is the regularization on 0..1 values (smaller follows the guide's edges more closely).
pub fn guided_filter(guide: &[u8], mask: &[u8], w: usize, h: usize, radius: usize, eps: f32) -> Vec<u8> {
    let i: Vec<f32> = guide.iter().map(|&v| v as f32 / 255.0).collect();
    let p: Vec<f32> = mask.iter().map(|&v| v as f32 / 255.0).collect();
    guided_filter_f32(&i, &p, w, h, radius, eps).into_iter().map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8).collect()
}

/// The guided filter on float values: `guide` on 0..1, `src` any range (depth maps).
pub fn guided_filter_f32(i: &[f32], p: &[f32], w: usize, h: usize, radius: usize, eps: f32) -> Vec<f32> {
    let ii: Vec<f32> = i.iter().map(|v| v * v).collect();
    let ip: Vec<f32> = i.iter().zip(p).map(|(a, b)| a * b).collect();
    let (mi, mp, mii, mip) = (box_mean(i, w, h, radius), box_mean(p, w, h, radius), box_mean(&ii, w, h, radius), box_mean(&ip, w, h, radius));
    let a: Vec<f32> = (0..w * h).map(|k| (mip[k] - mi[k] * mp[k]) / (mii[k] - mi[k] * mi[k] + eps)).collect();
    let b: Vec<f32> = (0..w * h).map(|k| mp[k] - a[k] * mi[k]).collect();
    let (ma, mb) = (box_mean(&a, w, h, radius), box_mean(&b, w, h, radius));
    (0..w * h).map(|k| ma[k] * i[k] + mb[k]).collect()
}

/// Warp a mask (`w` x `h`, 0..255) by each 3x3 row-major transform in `matrices` (from the mask's
/// pixels to the output's), with bilinear sampling. Returns one mask per transform, back to back.
pub fn warp_masks(mask: &[u8], w: usize, h: usize, matrices: &[f64]) -> Vec<u8> {
    let m = |i: usize| -> [f64; 9] { matrices[i * 9..i * 9 + 9].try_into().unwrap() };
    (0..matrices.len() / 9)
        .into_par_iter()
        .flat_map_iter(|i| {
            let inv = crate::track::invert(&m(i));
            (0..w * h).map(move |k| {
                let Some(inv) = inv else { return 0u8 };
                let (x, y) = crate::track::apply(&inv, (k % w) as f64, (k / w) as f64);
                let (x0, y0) = (x.floor(), y.floor());
                let (fx, fy) = (x - x0, y - y0);
                let px = |xx: f64, yy: f64| -> f64 {
                    if xx < 0.0 || yy < 0.0 || xx >= w as f64 || yy >= h as f64 { 0.0 } else { mask[yy as usize * w + xx as usize] as f64 }
                };
                let v = (px(x0, y0) * (1.0 - fx) + px(x0 + 1.0, y0) * fx) * (1.0 - fy) + (px(x0, y0 + 1.0) * (1.0 - fx) + px(x0 + 1.0, y0 + 1.0) * fx) * fy;
                v.round().clamp(0.0, 255.0) as u8
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warps_by_each_transform() {
        let (w, h) = (8usize, 6usize);
        let mut mask = vec![0u8; w * h];
        mask[2 * w + 2] = 255;
        // Identity, then a shift of 3 right and 1 down.
        let ms = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 3.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0];
        let out = warp_masks(&mask, w, h, &ms);
        assert_eq!(out.len(), 2 * w * h);
        assert_eq!(out[2 * w + 2], 255);
        assert_eq!(out[w * h + 3 * w + 5], 255);
        assert_eq!(out[w * h + 2 * w + 2], 0);
    }

    #[test]
    fn box_mean_is_exact() {
        let src: Vec<f32> = (0..20).map(|v| v as f32).collect();
        let m = box_mean(&src, 5, 4, 1);
        // Pixel (2, 1): neighbours 1,2,3 / 6,7,8 / 11,12,13.
        assert!((m[5 + 2] - 7.0).abs() < 1e-5);
        // Corner (0, 0): 0,1 / 5,6.
        assert!((m[0] - 3.0).abs() < 1e-5);
    }

    #[test]
    fn snaps_a_coarse_mask_to_the_guide_edge() {
        let (w, h) = (64usize, 32usize);
        // The object ends at x = 40 in the frame; the coarse mask ends at x = 36 with a soft ramp.
        let guide: Vec<u8> = (0..w * h).map(|k| if k % w < 40 { 220 } else { 30 }).collect();
        let mask: Vec<u8> = (0..w * h).map(|k| (((44.0 - (k % w) as f32) / 16.0).clamp(0.0, 1.0) * 255.0) as u8).collect();
        let out = guided_filter(&guide, &mask, w, h, 8, 1e-4);
        let row = &out[16 * w..17 * w];
        // Inside the object it fills in; past the edge it drops away within a couple of pixels.
        assert!(row[30] > 200, "{}", row[30]);
        assert!(row[43] < 40, "{}", row[43]);
        assert!(row[38] as i32 - row[42] as i32 > 120);
    }
}
