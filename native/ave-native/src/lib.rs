//! Node addon with the CPU kernels of ai-video-editor (see docs/design/cinematic-grade-and-vfx.md,
//! section 3.5). Calls are coarse (a whole buffer each) and run off the JavaScript thread, returning
//! promises, so the host stays responsive.

pub mod audio;
pub mod control;
pub mod depth;
pub mod particles;
pub mod refine;
pub mod remove;
pub mod track;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

/// Cancelling and progress for a kernel that works through many frames (`trackRegion`,
/// `depthSequence`): `cancel()` stops it at its next frame, with an "ave-native: cancelled" error;
/// `done` and `total` count its steps while it runs.
#[napi]
pub struct TaskControl {
    inner: Arc<control::Control>,
}

#[napi]
impl TaskControl {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        TaskControl { inner: Arc::new(control::Control::default()) }
    }

    #[napi]
    pub fn cancel(&self) {
        self.inner.cancel();
    }

    #[napi(getter)]
    pub fn done(&self) -> u32 {
        self.inner.progress().0
    }

    #[napi(getter)]
    pub fn total(&self) -> u32 {
        self.inner.progress().1
    }
}

/// The control a call was given, or one nobody cancels.
fn control_of(c: Option<&TaskControl>) -> Arc<control::Control> {
    c.map(|c| c.inner.clone()).unwrap_or_default()
}

fn cancelled(_: control::Cancelled) -> Error {
    Error::from_reason("ave-native: cancelled")
}

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
    control: Arc<control::Control>,
}

impl Task for TrackTask {
    type Output = Vec<track::Step>;
    type JsValue = RegionTrack;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.frames.len() < self.width * self.height * self.count || self.region.len() != self.width * self.height {
            return Err(Error::from_reason("ave-native: trackRegion needs count frames of width x height bytes and a region of width x height bytes"));
        }
        std::panic::catch_unwind(|| track::track_region(&self.frames, self.width, self.height, self.count, &self.region, &self.opts, &self.control))
            .map_err(|_| Error::from_reason("ave-native: track_region panicked"))?
            .map_err(cancelled)
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
/// `width` x `height` packed in `frames`, as a transform per frame. `control` cancels it and counts
/// a step per frame.
#[napi(js_name = "trackRegion")]
pub fn track_region(frames: Uint8Array, width: u32, height: u32, count: u32, region: Uint8Array, options: Option<TrackRegionOptions>, control: Option<&TaskControl>) -> Result<AsyncTask<TrackTask>> {
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
    Ok(AsyncTask::new(TrackTask { frames: frames.to_vec(), width: width as usize, height: height as usize, count: count as usize, region: region.to_vec(), opts, control: control_of(control) }))
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

pub struct DepthTask {
    gray: Vec<u8>,
    width: usize,
    height: usize,
    count: usize,
    keys: Vec<usize>,
    disparity: Vec<f32>,
    motion: Vec<f64>,
    previous: Option<Vec<f32>>,
    opts: depth::DepthOptions,
    control: Arc<control::Control>,
}

impl Task for DepthTask {
    type Output = Vec<f32>;
    type JsValue = Float32Array;

    fn compute(&mut self) -> Result<Self::Output> {
        let area = self.width * self.height;
        let ok = self.count > 0
            && self.gray.len() == self.count * area
            && !self.keys.is_empty()
            && self.keys[0] == 0
            && *self.keys.last().unwrap() == self.count - 1
            && self.keys.windows(2).all(|k| k[0] < k[1])
            && self.disparity.len() == self.keys.len() * area
            && self.motion.len() == self.count * 9
            && self.previous.as_ref().map_or(true, |p| p.len() == area);
        if !ok {
            return Err(Error::from_reason("ave-native: depthSequence needs count gray frames, ascending keys from 0 to count - 1, a disparity map per key, 9 numbers of motion per frame, and a previous map of one frame"));
        }
        std::panic::catch_unwind(|| depth::depth_sequence(&self.gray, self.width, self.height, self.count, &self.keys, &self.disparity, &self.motion, self.previous.as_deref(), &self.opts, &self.control))
            .map_err(|_| Error::from_reason("ave-native: depth_sequence panicked"))?
            .map_err(cancelled)
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out.into())
    }
}

#[napi(object)]
pub struct DepthSequenceOptions {
    /// Guided filter radius in pixels (default 4) and regularization (default 0.001).
    pub radius: Option<u32>,
    pub eps: Option<f64>,
    /// Weight of the previous frame in the blend over time (default 0.3).
    pub keep: Option<f64>,
    /// Frame 0's depth from the chunk before, so chunks join on the same scale.
    pub previous: Option<Float32Array>,
}

/// Depth for every frame of a chunk from model results on keyframes: each keyframe fitted to the one
/// before, carried between keyframes along the camera's motion, edges snapped to the frames, and
/// blended lightly over time. Distance on 0 (near) .. 1 (far), one frame after another. `control`
/// cancels it and counts a step per keyframe and per frame of each pass.
#[napi(js_name = "depthSequence")]
#[allow(clippy::too_many_arguments)]
pub fn depth_sequence(gray: Uint8Array, width: u32, height: u32, count: u32, keys: Uint32Array, disparity: Float32Array, motion: Float64Array, options: Option<DepthSequenceOptions>, control: Option<&TaskControl>) -> AsyncTask<DepthTask> {
    let mut opts = depth::DepthOptions::default();
    let mut previous = None;
    if let Some(o) = options {
        if let Some(r) = o.radius {
            opts.radius = r as usize;
        }
        if let Some(e) = o.eps {
            opts.eps = e as f32;
        }
        if let Some(k) = o.keep {
            opts.keep = k as f32;
        }
        previous = o.previous.map(|p| p.to_vec());
    }
    AsyncTask::new(DepthTask {
        gray: gray.to_vec(),
        width: width as usize,
        height: height as usize,
        count: count as usize,
        keys: keys.iter().map(|&k| k as usize).collect(),
        disparity: disparity.to_vec(),
        motion: motion.to_vec(),
        previous,
        opts,
        control: control_of(control),
    })
}

// --- Particles and light (particles.rs). The specs mirror particles::Spec; see its docs for units.

#[napi(object)]
pub struct ParticleGroundSpec {
    pub y: f64,
    pub spread: f64,
    pub splash: u32,
    pub splash_size: f64,
}

#[napi(object)]
pub struct ParticleEmitterSpec {
    pub area: Vec<f64>,
    pub rate: f64,
    pub burst: u32,
    pub max: u32,
    pub life: Vec<f64>,
    pub speed: Vec<f64>,
    pub direction: f64,
    pub spread: f64,
    pub gravity: f64,
    pub wind: Vec<f64>,
    pub drag: f64,
    pub turbulence: f64,
    pub turbulence_scale: f64,
    pub turbulence_speed: f64,
    pub size: Vec<f64>,
    pub size_over_life: Vec<Vec<f64>>,
    pub opacity: Vec<f64>,
    pub opacity_over_life: Vec<Vec<f64>>,
    pub colors: Vec<Vec<f64>>,
    pub color_over_life: Vec<Vec<f64>>,
    pub shape: String,
    pub softness: f64,
    pub streak: f64,
    pub aspect: f64,
    pub spin: Vec<f64>,
    pub flip: f64,
    pub flicker: f64,
    pub flicker_rate: f64,
    pub glow: f64,
    pub depth: Vec<f64>,
    pub depth_blur: f64,
    pub additive: bool,
    pub ground: Option<ParticleGroundSpec>,
}

#[napi(object)]
pub struct NoiseSpec {
    pub color: Vec<f64>,
    pub opacity: f64,
    pub scale: f64,
    pub octaves: u32,
    pub drift: Vec<f64>,
    pub evolve: f64,
    pub density: Vec<f64>,
    pub falloff: Vec<f64>,
    pub layers: u32,
    pub downscale: u32,
}

#[napi(object)]
pub struct GhostSpec {
    pub at: f64,
    pub size: f64,
    pub color: Vec<f64>,
    pub opacity: f64,
    pub ring: bool,
}

#[napi(object)]
pub struct FlareSpec {
    /// x, y per output frame, flattened.
    pub positions: Vec<f64>,
    pub intensity: Vec<f64>,
    pub color: Vec<f64>,
    pub size: f64,
    pub streak: f64,
    pub streak_color: Vec<f64>,
    pub ghosts: Vec<GhostSpec>,
}

/// One system: exactly one of the three.
#[napi(object)]
pub struct ParticleSystemSpec {
    pub emitter: Option<ParticleEmitterSpec>,
    pub noise: Option<NoiseSpec>,
    pub flare: Option<FlareSpec>,
}

#[napi(object)]
pub struct ParticleSpec {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub seed: u32,
    pub preroll: f64,
    pub time_scale: Option<Vec<f64>>,
    pub systems: Vec<ParticleSystemSpec>,
}

fn fixed<const N: usize>(v: &[f64], what: &str) -> Result<[f32; N]> {
    if v.len() != N {
        return Err(Error::from_reason(format!("ave-native: {what} needs {N} numbers, got {}", v.len())));
    }
    Ok(std::array::from_fn(|i| v[i] as f32))
}

fn list<const N: usize>(v: &[Vec<f64>], what: &str) -> Result<Vec<[f32; N]>> {
    v.iter().map(|x| fixed::<N>(x, what)).collect()
}

fn emitter(e: ParticleEmitterSpec) -> Result<particles::Emitter> {
    Ok(particles::Emitter {
        area: fixed(&e.area, "area")?,
        rate: e.rate as f32,
        burst: e.burst,
        max: e.max,
        life: fixed(&e.life, "life")?,
        speed: fixed(&e.speed, "speed")?,
        direction: e.direction as f32,
        spread: e.spread as f32,
        gravity: e.gravity as f32,
        wind: fixed(&e.wind, "wind")?,
        drag: e.drag as f32,
        turbulence: e.turbulence as f32,
        turbulence_scale: e.turbulence_scale as f32,
        turbulence_speed: e.turbulence_speed as f32,
        size: fixed(&e.size, "size")?,
        size_over_life: list(&e.size_over_life, "sizeOverLife stops")?,
        opacity: fixed(&e.opacity, "opacity")?,
        opacity_over_life: list(&e.opacity_over_life, "opacityOverLife stops")?,
        colors: list(&e.colors, "colors")?,
        color_over_life: list(&e.color_over_life, "colorOverLife stops")?,
        shape: particles::Shape::parse(&e.shape).ok_or_else(|| Error::from_reason(format!("ave-native: unknown particle shape \"{}\"", e.shape)))?,
        softness: e.softness as f32,
        streak: e.streak as f32,
        aspect: e.aspect as f32,
        spin: fixed(&e.spin, "spin")?,
        flip: e.flip as f32,
        flicker: e.flicker as f32,
        flicker_rate: e.flicker_rate as f32,
        glow: e.glow as f32,
        depth: fixed(&e.depth, "depth")?,
        depth_blur: e.depth_blur as f32,
        additive: e.additive,
        ground: e.ground.map(|g| particles::Ground { y: g.y as f32, spread: g.spread as f32, splash: g.splash, splash_size: g.splash_size as f32 }),
    })
}

fn particle_spec(s: ParticleSpec) -> Result<particles::Spec> {
    if s.width == 0 || s.height == 0 || !(s.fps > 0.0) {
        return Err(Error::from_reason("ave-native: particles need a frame size and a frame rate"));
    }
    let systems = s
        .systems
        .into_iter()
        .map(|sys| match (sys.emitter, sys.noise, sys.flare) {
            (Some(e), None, None) => Ok(particles::System::Particles(emitter(e)?)),
            (None, Some(n), None) => Ok(particles::System::Noise(particles::Noise {
                color: fixed(&n.color, "noise color")?,
                opacity: n.opacity as f32,
                scale: n.scale as f32,
                octaves: n.octaves,
                drift: fixed(&n.drift, "drift")?,
                evolve: n.evolve as f32,
                density: fixed(&n.density, "density")?,
                falloff: fixed(&n.falloff, "falloff")?,
                layers: n.layers,
                downscale: n.downscale,
            })),
            (None, None, Some(f)) => Ok(particles::System::Flare(particles::Flare {
                positions: f.positions.chunks_exact(2).map(|p| [p[0] as f32, p[1] as f32]).collect(),
                intensity: f.intensity.iter().map(|&v| v as f32).collect(),
                color: fixed(&f.color, "flare color")?,
                size: f.size as f32,
                streak: f.streak as f32,
                streak_color: fixed(&f.streak_color, "streak color")?,
                ghosts: f
                    .ghosts
                    .into_iter()
                    .map(|g| Ok(particles::Ghost { at: g.at as f32, size: g.size as f32, color: fixed(&g.color, "ghost color")?, opacity: g.opacity as f32, ring: g.ring }))
                    .collect::<Result<_>>()?,
            })),
            _ => Err(Error::from_reason("ave-native: each particle system needs exactly one of emitter, noise or flare")),
        })
        .collect::<Result<_>>()?;
    Ok(particles::Spec {
        width: s.width as usize,
        height: s.height as usize,
        fps: s.fps as f32,
        seed: s.seed as u64,
        preroll: s.preroll as f32,
        time_scale: s.time_scale.unwrap_or_default().into_iter().map(|v| v as f32).collect(),
        systems,
    })
}

pub struct ParticleFramesTask {
    renderer: Arc<Mutex<particles::Renderer>>,
    count: usize,
}

impl Task for ParticleFramesTask {
    type Output = Vec<u8>;
    type JsValue = Uint8Array;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut r = self.renderer.lock().map_err(|_| Error::from_reason("ave-native: the particle renderer failed earlier"))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| r.frames(self.count))).map_err(|_| Error::from_reason("ave-native: particle frames panicked"))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out.into())
    }
}

/// Draws particles, smoke, fog and lens flares into RGBA frames, one batch after another. Each
/// batch continues where the last one ended; the same spec always gives the same frames.
#[napi]
pub struct ParticleRenderer {
    inner: Arc<Mutex<particles::Renderer>>,
}

#[napi]
impl ParticleRenderer {
    #[napi(constructor)]
    pub fn new(spec: ParticleSpec) -> Result<Self> {
        Ok(ParticleRenderer { inner: Arc::new(Mutex::new(particles::Renderer::new(particle_spec(spec)?))) })
    }

    /// The next `count` frames as straight-alpha RGBA, width x height x 4 bytes each, back to back.
    #[napi]
    pub fn frames(&self, count: u32) -> AsyncTask<ParticleFramesTask> {
        AsyncTask::new(ParticleFramesTask { renderer: self.inner.clone(), count: count as usize })
    }
}

// --- Object removal (remove.rs).

#[napi(object)]
pub struct RemoverOptions {
    /// Grow the mask by this many pixels (default 6), then fade out over `feather` (default 4).
    pub grow: Option<f64>,
    pub feather: Option<f64>,
    /// Ring around the hole where exposure is matched, pixels (default 12).
    pub ring: Option<f64>,
    /// The camera does not move: take the median of the whole pool, unmatched (default false).
    pub locked: Option<bool>,
    /// Pool frames nearest in time a moving camera's fill takes the median of (default 5).
    pub nearest: Option<u32>,
    /// Leftovers within this many pixels of a filled one are interpolated (default 3); thicker ones are returned.
    pub thin: Option<f64>,
}

#[napi(object)]
pub struct RemovalFill {
    /// Straight-alpha RGBA: the fill inside the hole, fading out over the feather; clear elsewhere.
    pub rgba: Uint8Array,
    /// 1 where nothing could fill the hole (thicker than `thin`); there `rgba` holds the frame itself.
    pub residual: Uint8Array,
    pub hole: u32,
    pub real: u32,
    pub layered: u32,
    pub interpolated: u32,
    pub left: u32,
}

enum RemoverJob {
    Frame { index: usize, rgb: Vec<u8>, mask: Vec<u8> },
    Layer { index: usize, rgb: Vec<u8>, generated: Vec<u8> },
    Fill { index: usize, rgb: Vec<u8>, mask: Vec<u8> },
}

pub struct RemoverTask {
    remover: Arc<Mutex<remove::Remover>>,
    area: usize,
    job: Option<RemoverJob>,
}

impl Task for RemoverTask {
    type Output = Option<remove::Fill>;
    type JsValue = Option<RemovalFill>;

    fn compute(&mut self) -> Result<Self::Output> {
        let job = self.job.take().ok_or_else(|| Error::from_reason("ave-native: remover task ran twice"))?;
        let area = self.area;
        let sized = match &job {
            RemoverJob::Frame { rgb, mask, .. } | RemoverJob::Fill { rgb, mask, .. } => rgb.len() == area * 3 && mask.len() == area,
            RemoverJob::Layer { rgb, generated, .. } => rgb.len() == area * 3 && generated.len() == area,
        };
        if !sized {
            return Err(Error::from_reason("ave-native: the remover needs RGB frames of width x height x 3 bytes and masks of width x height"));
        }
        let mut r = self.remover.lock().map_err(|_| Error::from_reason("ave-native: the remover failed earlier"))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match job {
            RemoverJob::Frame { index, rgb, mask } => {
                r.add_frame(index, rgb, &mask);
                None
            }
            RemoverJob::Layer { index, rgb, generated } => {
                r.add_layer(index, rgb, generated);
                None
            }
            RemoverJob::Fill { index, rgb, mask } => Some(r.fill(index, &rgb, &mask)),
        }))
        .map_err(|_| Error::from_reason("ave-native: the remover panicked"))
    }

    fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(out.map(|f| RemovalFill {
            rgba: f.rgba.into(),
            residual: f.residual.into(),
            hole: f.hole,
            real: f.real,
            layered: f.layered,
            interpolated: f.interpolated,
            left: f.left,
        }))
    }
}

/// Fills the area under an object with what other frames of the clip show there (see remove.rs):
/// add pool frames, then fill frames one by one; what nothing shows comes back for a model, whose
/// result goes in as a layer.
#[napi]
pub struct Remover {
    inner: Arc<Mutex<remove::Remover>>,
    area: usize,
}

#[napi]
impl Remover {
    /// `motion`: per frame of the clip, the 3x3 transform from frame 0's pixels to that frame's.
    #[napi(constructor)]
    pub fn new(width: u32, height: u32, motion: Float64Array, options: Option<RemoverOptions>) -> Result<Self> {
        if motion.len() % 9 != 0 || width == 0 || height == 0 {
            return Err(Error::from_reason("ave-native: the remover needs a frame size and 9 numbers of motion per frame"));
        }
        let mut opts = remove::RemoveOptions::default();
        if let Some(o) = options {
            opts.grow = o.grow.map_or(opts.grow, |v| v as f32);
            opts.feather = o.feather.map_or(opts.feather, |v| v as f32);
            opts.ring = o.ring.map_or(opts.ring, |v| v as f32);
            opts.locked = o.locked.unwrap_or(opts.locked);
            opts.nearest = o.nearest.map_or(opts.nearest, |v| (v as usize).max(1));
            opts.thin = o.thin.map_or(opts.thin, |v| v as f32);
        }
        let (w, h) = (width as usize, height as usize);
        Ok(Remover { inner: Arc::new(Mutex::new(remove::Remover::new(w, h, &motion, opts))), area: w * h })
    }

    fn task(&self, job: RemoverJob) -> AsyncTask<RemoverTask> {
        AsyncTask::new(RemoverTask { remover: self.inner.clone(), area: self.area, job: Some(job) })
    }

    /// Frame `index` (RGB) and its object mask (0..255) join the pool.
    #[napi(js_name = "addFrame")]
    pub fn add_frame(&self, index: u32, rgb: Uint8Array, mask: Uint8Array) -> AsyncTask<RemoverTask> {
        self.task(RemoverJob::Frame { index: index as usize, rgb: rgb.to_vec(), mask: mask.to_vec() })
    }

    /// Frame `index`'s filled picture (RGB) and where it was generated (1) become a layer.
    #[napi(js_name = "addLayer")]
    pub fn add_layer(&self, index: u32, rgb: Uint8Array, generated: Uint8Array) -> AsyncTask<RemoverTask> {
        self.task(RemoverJob::Layer { index: index as usize, rgb: rgb.to_vec(), generated: generated.to_vec() })
    }

    /// Fill frame `index` (RGB) under its object mask (0..255).
    #[napi]
    pub fn fill(&self, index: u32, rgb: Uint8Array, mask: Uint8Array) -> AsyncTask<RemoverTask> {
        self.task(RemoverJob::Fill { index: index as usize, rgb: rgb.to_vec(), mask: mask.to_vec() })
    }
}

/// Version of the addon, so the loader can tell a stale build apart.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
