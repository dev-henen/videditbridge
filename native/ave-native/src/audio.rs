//! Audio analysis kernels, ported from `engine/tools/audio/analyze.ts`. Results match the
//! TypeScript reference (`test/helpers/audio-reference.ts`) within floating point tolerance.

use rayon::prelude::*;
use rustfft::{num_complex::Complex64, FftPlanner};

/// Samples between frames (10 ms at 16 kHz).
pub const HOP: usize = 160;
/// Samples per level and zero-crossing frame (20 ms).
pub const FRAME: usize = 320;
/// Spectrum window (32 ms), centered on each frame.
const N: usize = 512;
/// Frames per parallel chunk; each chunk recomputes the spectrum of the frame before it.
const CHUNK: usize = 1024;

/// Per-frame features of 16 kHz mono samples.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct FrameFeatures {
    /// Level per frame, dBFS.
    pub level: Vec<f32>,
    /// Zero-crossing rate per frame, 0..1.
    pub zcr: Vec<f32>,
    /// Spectral flux (onset strength) per frame.
    pub flux: Vec<f32>,
    /// Spectral flatness per frame, 0 (tonal) .. 1 (noise).
    pub flatness: Vec<f32>,
}

/// Number of frames in `len` samples.
pub fn frame_count(len: usize) -> usize {
    if len < FRAME { 0 } else { (len - FRAME) / HOP + 1 }
}

fn db(power: f64) -> f64 {
    10.0 * (power + 1e-12).log10()
}

/// The Hann window, rounded to f32 as the reference stores it in a Float32Array.
fn window() -> Vec<f64> {
    (0..N)
        .map(|i| (0.5 - 0.5 * ((2.0 * std::f64::consts::PI * i as f64) / (N - 1) as f64).cos()) as f32 as f64)
        .collect()
}

struct Spectrum {
    fft: std::sync::Arc<dyn rustfft::Fft<f64>>,
    win: Vec<f64>,
    buf: Vec<Complex64>,
}

impl Spectrum {
    fn new(win: &[f64]) -> Self {
        Self { fft: FftPlanner::new().plan_fft_forward(N), win: win.to_vec(), buf: vec![Complex64::default(); N] }
    }

    /// Magnitudes of the window centered on frame `f` (bins 1..N/2; bin 0 is unused).
    fn magnitudes(&mut self, x: &[f32], f: usize, out: &mut [f64]) {
        let c = (f * HOP + FRAME / 2) as isize - (N / 2) as isize;
        for i in 0..N {
            let k = c + i as isize;
            let v = if k >= 0 && (k as usize) < x.len() { x[k as usize] as f64 } else { 0.0 };
            self.buf[i] = Complex64::new(v * self.win[i], 0.0);
        }
        self.fft.process(&mut self.buf);
        for k in 1..N / 2 {
            out[k] = self.buf[k].norm();
        }
    }
}

/// Level, zero-crossing rate, spectral flux and flatness per frame, in parallel chunks.
pub fn frame_features(x: &[f32]) -> FrameFeatures {
    let n = frame_count(x.len());
    let win = window();
    let chunks: Vec<(usize, usize)> = (0..n).step_by(CHUNK).map(|a| (a, (a + CHUNK).min(n))).collect();
    let parts: Vec<FrameFeatures> = chunks
        .par_iter()
        .map(|&(a, b)| {
            let mut spec = Spectrum::new(&win);
            let mut m = vec![0.0f64; N / 2];
            // log1p(100 * magnitude) of the previous frame, for the flux.
            let mut prev = vec![0.0f64; N / 2];
            if a > 0 {
                spec.magnitudes(x, a - 1, &mut m);
                for k in 1..N / 2 {
                    prev[k] = (100.0 * m[k]).ln_1p();
                }
            }
            let mut out = FrameFeatures {
                level: Vec::with_capacity(b - a),
                zcr: Vec::with_capacity(b - a),
                flux: Vec::with_capacity(b - a),
                flatness: Vec::with_capacity(b - a),
            };
            for f in a..b {
                let o = f * HOP;
                let mut e = 0.0f64;
                let mut z = 0u32;
                for i in 0..FRAME {
                    let v = x[o + i];
                    e += v as f64 * v as f64;
                    if i > 0 && (v >= 0.0) != (x[o + i - 1] >= 0.0) {
                        z += 1;
                    }
                }
                out.level.push(db(e / FRAME as f64) as f32);
                out.zcr.push((z as f64 / FRAME as f64) as f32);
                spec.magnitudes(x, f, &mut m);
                let (mut log_sum, mut lin_sum, mut fl) = (0.0f64, 0.0f64, 0.0f64);
                for k in 1..N / 2 {
                    let lm = (100.0 * m[k]).ln_1p();
                    let d = lm - prev[k];
                    if d > 0.0 {
                        fl += d;
                    }
                    prev[k] = lm;
                    log_sum += (m[k] + 1e-9).ln();
                    lin_sum += m[k];
                }
                let bins = (N / 2 - 1) as f64;
                out.flux.push(fl as f32);
                out.flatness.push(if lin_sum > 1e-6 { ((log_sum / bins).exp() / (lin_sum / bins)) as f32 } else { 1.0 });
            }
            out
        })
        .collect();
    let mut all = FrameFeatures::default();
    for p in parts {
        all.level.extend(p.level);
        all.zcr.extend(p.zcr);
        all.flux.extend(p.flux);
        all.flatness.extend(p.flatness);
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f64, hz: f64) -> Vec<f32> {
        (0..(seconds * 16000.0) as usize).map(|i| (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / 16000.0).sin()) as f32).collect()
    }

    #[test]
    fn counts_frames() {
        assert_eq!(frame_count(0), 0);
        assert_eq!(frame_count(319), 0);
        assert_eq!(frame_count(320), 1);
        assert_eq!(frame_count(16000), 99);
        assert_eq!(frame_features(&[0.0; 100]).level.len(), 0);
    }

    #[test]
    fn measures_a_tone() {
        let f = frame_features(&tone(1.0, 440.0));
        // A 0.5 amplitude sine has power 0.125: about -9 dBFS.
        assert!((f.level[50] + 9.03).abs() < 0.05, "{}", f.level[50]);
        // 440 Hz crosses zero 880 times a second.
        assert!((f.zcr[50] - 880.0 / 16000.0).abs() < 0.01);
        // Tonal, and steady after the first frames.
        assert!(f.flatness[50] < 0.1);
        assert!(f.flux[50] < 1.0);
    }

    #[test]
    fn chunks_do_not_change_the_result() {
        // Longer than one chunk: the flux at a chunk start uses the frame before it.
        let x: Vec<f32> = tone(12.0, 220.0).iter().enumerate().map(|(i, v)| v * ((i / 3000) % 2) as f32).collect();
        let f = frame_features(&x);
        let mut spec = Spectrum::new(&window());
        let (mut m, mut prev) = (vec![0.0; N / 2], vec![0.0; N / 2]);
        for frame in 0..=CHUNK {
            spec.magnitudes(&x, frame, &mut m);
            let mut fl = 0.0;
            for k in 1..N / 2 {
                let lm = (100.0 * m[k] as f64).ln_1p();
                if lm > prev[k] {
                    fl += lm - prev[k];
                }
                prev[k] = lm;
            }
            if frame == CHUNK {
                assert!((f.flux[CHUNK] as f64 - fl).abs() < 1e-3);
            }
        }
    }
}
