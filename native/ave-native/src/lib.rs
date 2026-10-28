//! Node addon with the CPU kernels of ai-video-editor (see docs/design/cinematic-grade-and-vfx.md,
//! section 3.5). Calls are coarse (a whole buffer each) and run off the JavaScript thread, returning
//! promises, so the host stays responsive.

pub mod audio;

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

/// Version of the addon, so the loader can tell a stale build apart.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
