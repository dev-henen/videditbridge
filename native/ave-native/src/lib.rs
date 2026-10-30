//! Node addon with the CPU kernels of ai-video-editor (see docs/design/cinematic-grade-and-vfx.md,
//! section 3.5). Calls are coarse (a whole buffer each) and run off the JavaScript thread, returning
//! promises, so the host stays responsive.

pub mod audio;
pub mod refine;
pub mod track;

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct FrameFeatures {
    /// Level per frame, dBFS.
    pub level: Float32Array,
    /// Zero-crossing rate per frame, 0..1.
    pub zcr: Float32Array,
    /// Spectral flux (onset strength) per frame.
    pub flux: Float32Array,
    /// Spectral flatness per frame, 0 (tonal) .. 1 (noise).
    pub flatness: Float32Array,
}

pub struct FrameFeaturesTask {
    samples: Vec<f32>,
}

impl Task for FrameFeaturesTask {
    type Output = audio::FrameFeatures;
    type JsValue = FrameFeatures;

    fn compute(&mut self) -> Result<Self::Output> {
        // A panic must never take down the host: report it as an error instead.
        std::panic::catch_unwind(|| audio::frame_features(&self.samples)).map_err(|_| Error::from_reason("ave-native: frame_features panicked"))
    }

    fn resolve(&mut self, _env: Env, f: Self::Output) -> Result<Self::JsValue> {
        Ok(FrameFeatures { level: f.level.into(), zcr: f.zcr.into(), flux: f.flux.into(), flatness: f.flatness.into() })
    }
}

/// Per-frame level, zero-crossing rate, spectral flux and flatness of 16 kHz mono samples
/// (10 ms hop, 20 ms frames, 32 ms spectrum window).
#[napi(js_name = "frameFeatures")]
pub fn frame_features(samples: Float32Array) -> AsyncTask<FrameFeaturesTask> {
    AsyncTask::new(FrameFeaturesTask { samples: samples.to_vec() })
}

#[napi(object)]
pub struct RegionTrack {
    /// One 3x3 row-major transform per frame, from the first frame's pixels to that frame's.
    pub matrices: Float64Array,
    /// Points agreeing with each frame's transform (0 when the region was lost there).
    pub inliers: Uint32Array,
    /// Root mean square fit error per frame, pixels (Infinity when lost).
    pub errors: Float32Array,
    /// 1 where new corners had to be found because too few survived.
    pub redetected: Uint8Array,
}

pub struct TrackTask {
    frames: Vec<u8>,
    width: usize,
    height: usize,
    count: usize,
    region: Vec<u8>,
    opts: track::TrackOptions,
}

impl Task for TrackTask {
    type Output = Vec<track::Step>;
    type JsValue = RegionTrack;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.frames.len() < self.width * self.height * self.count || self.region.len() != self.width * self.height {
            return Err(Error::from_reason("ave-native: trackRegion needs count frames of width x height bytes and a region of width x height bytes"));
        }
        std::panic::catch_unwind(|| track::track_region(&self.frames, self.width, self.height, self.count, &self.region, &self.opts))
            .map_err(|_| Error::from_reason("ave-native: track_region panicked"))
    }

    fn resolve(&mut self, _env: Env, steps: Self::Output) -> Result<Self::JsValue> {
        Ok(RegionTrack {
            matrices: steps.iter().flat_map(|s| s.m).collect::<Vec<f64>>().into(),
            inliers: steps.iter().map(|s| s.inliers).collect::<Vec<u32>>().into(),
            errors: steps.iter().map(|s| s.error).collect::<Vec<f32>>().into(),
            redetected: steps.iter().map(|s| s.redetected as u8).collect::<Vec<u8>>().into(),
        })
    }
}

#[napi(object)]
pub struct TrackRegionOptions {
    /// "translation", "similarity", "affine" (default) or "homography" (a flat surface).
    pub model: Option<String>,
    pub max_points: Option<u32>,
    /// Corners stay this many pixels inside the region (default 4).
    pub inset: Option<u32>,
}

/// Follow a region (non-zero bytes of `region` on the first frame) through `count` gray frames of
/// `width` x `height` packed in `frames`, as a transform per frame.
#[napi(js_name = "trackRegion")]
pub fn track_region(frames: Uint8Array, width: u32, height: u32, count: u32, region: Uint8Array, options: Option<TrackRegionOptions>) -> Result<AsyncTask<TrackTask>> {
    let mut opts = track::TrackOptions::default();
    if let Some(o) = options {
        if let Some(m) = o.model {
            opts.model = track::Model::parse(&m).ok_or_else(|| Error::from_reason(format!("ave-native: unknown motion model \"{m}\"")))?;
        }
        if let Some(n) = o.max_points {
            opts.max_points = n as usize;
        }
        if let Some(n) = o.inset {
            opts.inset = n as usize;
        }
    }
    Ok(AsyncTask::new(TrackTask { frames: frames.to_vec(), width: width as usize, height: height as usize, count: count as usize, region: region.to_vec(), opts }))
}

pub struct GuidedTask {
    guide: Vec<u8>,
    mask: Vec<u8>,
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
}

impl Task for GuidedTask {
    type Output = Vec<u8>;
    type JsValue = Uint8Array;

    fn compute(&mut self) -> Result<Self::Output> {
        let n = self.width * self.height;
        if self.guide.len() % n != 0 || self.mask.len() != self.guide.len() {
            return Err(Error::from_reason("ave-native: guidedFilter needs guide and mask of the same size, whole frames of width x height"));
        }
        // Several frames in one call: each is filtered on its own, in parallel.
        std::panic::catch_unwind(|| {
            use rayon::prelude::*;
            self.guide
                .par_chunks(n)
                .zip(self.mask.par_chunks(n))
                .flat_map_iter(|(g, m)| refine::guided_filter(g, m, self.width, self.height, self.radius, self.eps))
                .collect()
        })
        .map_err(|_| Error::from_reason("ave-native: guided_filter panicked"))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out.into())
    }
}

/// Snap mask edges (0..255) to the edges of a gray guide frame of the same size; `guide` and
/// `mask` may hold several frames back to back. `radius` in pixels, `eps` on 0..1 values.
#[napi(js_name = "guidedFilter")]
pub fn guided_filter(guide: Uint8Array, mask: Uint8Array, width: u32, height: u32, radius: u32, eps: f64) -> AsyncTask<GuidedTask> {
    AsyncTask::new(GuidedTask { guide: guide.to_vec(), mask: mask.to_vec(), width: width as usize, height: height as usize, radius: radius as usize, eps: eps as f32 })
}

pub struct WarpTask {
    mask: Vec<u8>,
    width: usize,
    height: usize,
    matrices: Vec<f64>,
}

impl Task for WarpTask {
    type Output = Vec<u8>;
    type JsValue = Uint8Array;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.mask.len() != self.width * self.height || self.matrices.len() % 9 != 0 {
            return Err(Error::from_reason("ave-native: warpMasks needs a width x height mask and 9 numbers per transform"));
        }
        std::panic::catch_unwind(|| refine::warp_masks(&self.mask, self.width, self.height, &self.matrices)).map_err(|_| Error::from_reason("ave-native: warp_masks panicked"))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out.into())
    }
}

/// Warp a mask by each transform (3x3 row major, 9 numbers each): one mask per transform, back to back.
#[napi(js_name = "warpMasks")]
pub fn warp_masks(mask: Uint8Array, width: u32, height: u32, matrices: Float64Array) -> AsyncTask<WarpTask> {
    AsyncTask::new(WarpTask { mask: mask.to_vec(), width: width as usize, height: height as usize, matrices: matrices.to_vec() })
}

/// Version of the addon, so the loader can tell a stale build apart.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
