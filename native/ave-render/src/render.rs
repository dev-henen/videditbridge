//! Render a plan: per output frame, fit each visible item's source frame on the GPU, build the
//! primary picture (clips, fades, transitions), put the layers over it, and hand the frame to the
//! encoder.

use crate::effects::Effects;
use crate::gpu::{view, Gpu, HblurParams, LayerParams, PrimaryParams, ResampleParams, FLOAT};
use crate::media::{Decoder, Encoder};
use crate::plan::{blend_mode, transition_kind, Item, Plan, Source, HBLUR, PLAN_VERSION};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Seconds of lookahead for starting decoders, so ffmpeg's start and seek are hidden.
const DECODE_LEAD: f64 = 1.0;

/// An item's decoder and textures while it is in use.
#[derive(Default)]
struct ItemState {
    decoder: Option<Decoder>,
    source: Option<wgpu::Texture>,
    tmp: Option<wgpu::Texture>,
    out: Option<wgpu::Texture>,
    uploaded: Option<i64>,
    fitted: Option<i64>,
    /// With effects: the two textures they alternate between, and which one holds this frame's result.
    fx: Option<[wgpu::Texture; 2]>,
    result: Option<usize>,
    /// fit blur: the backdrop's fitted picture, its effect textures, and the picture laid over it.
    back: Option<[wgpu::Texture; 4]>,
    released: bool,
}

/// Output frames an item is in use: the first and the last.
fn spans(plan: &Plan) -> Vec<(i64, i64)> {
    let mut s = vec![(i64::MAX, i64::MIN); plan.items.len()];
    let mut add = |item: usize, a: i64, b: i64| {
        s[item].0 = s[item].0.min(a);
        s[item].1 = s[item].1.max(b);
    };
    for c in &plan.clips {
        add(c.item, c.first, c.first + c.frames - 1);
    }
    for l in &plan.layers {
        add(l.item, (l.start * plan.fps - 1e-6).ceil() as i64, (l.end * plan.fps + 1e-6).floor() as i64);
    }
    s
}

/// FFmpeg's fade filter (to and from black) on frame `j` of a piece lasting `duration`. Its start
/// and length are rounded to whole frames, as the filter converts them to the 1/fps timebase.
fn fade(j: i64, fps: f64, duration: f64, fade_in: f64, fade_out: f64) -> f32 {
    let frames = |s: f64| (s * fps).round();
    let ramp = |from: f64, len: f64| if len > 0.0 { ((j as f64 - from) / len).clamp(0.0, 1.0) } else if j as f64 >= from { 1.0 } else { 0.0 };
    let mut f = 1.0;
    if fade_in > 0.0 {
        f *= ramp(0.0, frames(fade_in));
    }
    if fade_out > 0.0 {
        f *= 1.0 - ramp(frames((duration - fade_out).max(0.0)), frames(fade_out));
    }
    f as f32
}

/// Entry `i` of a per-frame list, the last one holding after its end.
fn hold<T: Copy>(v: &[T], i: i64) -> Option<T> {
    v.get((i.max(0) as usize).min(v.len().saturating_sub(1))).copied()
}

/// xfade's progress at output frame `n` (1 at the start, 0 at the end), computed as it does: frame
/// times in microseconds (the backend's AV_TIME_BASE), the ratio in 32-bit floats. Slides and wipes
/// truncate `progress * width` to whole pixels, so a rounding difference there moves the seam.
fn xfade_progress(n: i64, fps: f64, offset: f64, duration: f64) -> f32 {
    let pts = (n as f64 * 1e6 / fps).round() as i64;
    let (start, length) = ((offset * 1e6).round() as i64, ((duration * 1e6).round() as i64).max(1));
    (1.0f32 - (pts - start) as f32 / length as f32).clamp(0.0, 1.0)
}

/// Fit a decoded VUYA frame into an item image: scaled to `scaled`, placed at `offset`, the rest `fill`
/// (two bicubic passes through `rows`).
#[allow(clippy::too_many_arguments)]
fn fit(gpu: &Gpu, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, rows: &wgpu::TextureView, out: &wgpu::TextureView, (sw, sh): (u32, u32), scaled: [u32; 2], offset: [i32; 2], (w, h): (u32, u32), opaque: bool, fill: [f32; 4]) {
    let hp = gpu.uniform(&ResampleParams { src_len: sw, scaled_len: scaled[0], offset: offset[0], opaque: 0, out_size: [w, sh], x_range: [0, 0], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
    gpu.dispatch(enc, &gpu.resample_h, &[wgpu::BindingResource::TextureView(src), wgpu::BindingResource::TextureView(rows), hp.as_entire_binding()], w, sh);
    let vp = gpu.uniform(&ResampleParams {
        src_len: sh,
        scaled_len: scaled[1],
        offset: offset[1],
        opaque: opaque as u32,
        out_size: [w, h],
        x_range: [offset[0], offset[0] + scaled[0] as i32],
        fill,
        origin: 0,
        line_origin: 0,
        yuv_in: 1,
        _pad: 0,
    });
    gpu.dispatch(enc, &gpu.resample_v, &[wgpu::BindingResource::TextureView(rows), wgpu::BindingResource::TextureView(out), vp.as_entire_binding()], w, h);
}

/// Frames past what a decoder has read that are worth reading through rather than restarting it at
/// the frame wanted (when its source can seek).
const READ_THROUGH: i64 = 45;

/// Draws a plan's frames: fits each visible item's source frame, builds the primary picture, puts
/// the whole-video effects and the layers over it, and reads the frame back. Exports draw every
/// frame in order; sessions (previews) draw any frame, restarting decoders where they jump.
pub struct Composer<'a> {
    gpu: &'a Gpu,
    pub plan: Arc<Plan>,
    states: Vec<ItemState>,
    effects: Effects<'a>,
    blends: Vec<u32>,
    kinds: Vec<Option<u32>>,
    spans: Vec<(i64, i64)>,
    canvas: [wgpu::Texture; 2],
    blank: wgpu::Texture,
    sums: wgpu::Buffer,
    packed: wgpu::Buffer,
    /// Two readback buffers, so one frame can be read while the next draws, and the submission that
    /// last filled each.
    staging: [wgpu::Buffer; 2],
    filled: [Option<wgpu::SubmissionIndex>; 2],
    next_slot: usize,
}

impl<'a> Composer<'a> {
    pub fn new(gpu: &'a Gpu, plan: Arc<Plan>) -> Result<Self, String> {
        if plan.version != PLAN_VERSION {
            return Err(format!("plan version {} is not supported (this engine reads version {PLAN_VERSION})", plan.version));
        }
        let (w, h) = (plan.width, plan.height);
        let blends = plan.layers.iter().map(|l| blend_mode(&l.blend)).collect::<Result<Vec<_>, _>>()?;
        let kinds = plan.clips.iter().map(|c| c.transition.as_ref().map(|t| transition_kind(&t.kind)).transpose()).collect::<Result<Vec<_>, _>>()?;
        // hblur's row sums (width + 1 per row and clip), only when a transition needs them.
        let sums_size = if kinds.iter().any(|k| *k == Some(HBLUR)) { h as u64 * (w as u64 + 1) * 2 * 16 } else { 32 };
        let bytes = (w * h * 4) as u64;
        let buffer = |label: &str, size: u64, usage: wgpu::BufferUsages| gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage, mapped_at_creation: false });
        Ok(Composer {
            gpu,
            states: (0..plan.items.len()).map(|_| ItemState::default()).collect(),
            effects: Effects::new(gpu, &plan.ffmpeg, plan.fps),
            spans: spans(&plan),
            blends,
            kinds,
            canvas: [gpu.texture("canvas-a", w, h, FLOAT, true), gpu.texture("canvas-b", w, h, FLOAT, true)],
            blank: gpu.texture("blank", 1, 1, FLOAT, true),
            sums: buffer("row-sums", sums_size, wgpu::BufferUsages::STORAGE),
            packed: buffer("packed", bytes, wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC),
            staging: ["staging-a", "staging-b"].map(|l| buffer(l, bytes, wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST)),
            filled: [None, None],
            next_slot: 0,
            plan,
        })
    }

    /// Start item `i`'s decoder: from its first frame with the plan's arguments, or from frame `at`
    /// when its source can seek there.
    fn start_decoder(&mut self, i: usize, at: Option<i64>) -> Result<(), String> {
        let plan = self.plan.clone();
        let state = &mut self.states[i];
        if let Source::Decode { width, height, args, seek, .. } = &plan.items[i].source {
            let bytes = (*width * *height * 4) as usize;
            state.decoder = Some(match (at, seek) {
                (Some(k), Some(seek)) if k > 0 => Decoder::start(&plan.ffmpeg, &seek.args(k, plan.fps), plan.cwd.as_deref(), bytes, k)?,
                _ => Decoder::start(&plan.ffmpeg, args, plan.cwd.as_deref(), bytes, 0)?,
            });
        }
        Ok(())
    }

    /// Start the decoders of items shown within `lead` frames from `n`, so ffmpeg's start is hidden
    /// (exports, which draw frames in order).
    fn look_ahead(&mut self, n: i64, lead: i64) -> Result<(), String> {
        for i in 0..self.spans.len() {
            let (a, b) = self.spans[i];
            let state = &self.states[i];
            if a <= n + lead && b >= n && state.decoder.is_none() && !state.released {
                self.start_decoder(i, None)?;
            }
        }
        Ok(())
    }

    /// Drop the decoders and textures of items no longer shown after frame `n` (exports).
    fn release_done(&mut self, n: i64) {
        for i in 0..self.spans.len() {
            if self.spans[i].1 <= n && !self.states[i].released {
                self.states[i] = ItemState { released: true, ..Default::default() };
            }
        }
    }

    /// Fit frame `k` of item `i` into its item image, recording the passes into `enc`. Clips (`hold`)
    /// show their last frame once the source runs out. Layers follow FFmpeg's overlay: after the
    /// source's last frame they are gone, and the last frame itself shows only at its own time
    /// (`exact`), so the frame after it is read to know it is not the last. A decoder behind the
    /// frame wanted, or far ahead of it, starts again there.
    fn prepare(&mut self, i: usize, k: i64, hold: bool, exact: bool, enc: &mut wgpu::CommandEncoder) -> Result<Option<usize>, String> {
        let plan = self.plan.clone();
        let item: &Item = &plan.items[i];
        let gpu = self.gpu;
        if let Source::Decode { still, seek, .. } = &item.source {
            let need = if *still { 0 } else if hold || exact { k } else { k + 1 };
            let restart = match &self.states[i].decoder {
                None => true,
                Some(d) => {
                    let have = d.current.as_ref().map_or(d.base, |(index, _)| *index - 1);
                    // A finished decoder has nothing further on: the source ended there.
                    !*still && (need < have || (seek.is_some() && !d.ended && need - d.next() > READ_THROUGH))
                }
            };
            if restart {
                self.states[i].released = false;
                self.start_decoder(i, (!*still).then_some(k))?;
            }
        }
        let state = &mut self.states[i];
        let (sw, sh, shown) = match &item.source {
            Source::Decode { width, height, still: true, .. } => {
                state.decoder.as_mut().unwrap().seek(0)?;
                (*width, *height, 0)
            }
            Source::Decode { width, height, args, .. } => {
                let need = if hold || exact { k } else { k + 1 };
                if let Err(e) = state.decoder.as_mut().unwrap().seek(need) {
                    // A seek past the end of the source gives nothing: read it from the start instead.
                    if state.decoder.as_ref().unwrap().base == 0 {
                        return Err(e);
                    }
                    state.decoder = Some(Decoder::start(&plan.ffmpeg, args, plan.cwd.as_deref(), (*width * *height * 4) as usize, 0)?);
                    state.decoder.as_mut().unwrap().seek(need)?;
                }
                let decoder = state.decoder.as_mut().unwrap();
                let last = decoder.current.as_ref().unwrap().0;
                if hold {
                    (*width, *height, last.min(k))
                } else if last < need {
                    return Ok(None);
                } else {
                    (*width, *height, k)
                }
            }
            Source::Color { .. } => (1, 1, 0),
        };
        if state.source.is_none() {
            state.source = Some(gpu.texture("source", sw, sh, wgpu::TextureFormat::Rgba8Unorm, false));
            state.tmp = Some(gpu.texture("fit-rows", item.width, sh, FLOAT, true));
            state.out = Some(gpu.texture("item", item.width, item.height, FLOAT, true));
        }
        if state.uploaded != Some(shown) {
            match &item.source {
                Source::Decode { still, .. } => {
                    let decoder = state.decoder.as_ref().unwrap();
                    let frame = if *still { decoder.frame(0) } else { decoder.frame(shown) };
                    gpu.upload(state.source.as_ref().unwrap(), frame.ok_or("a decoded frame went missing")?, sw, sh)
                }
                Source::Color { color } => {
                    // As the backend makes a color: RGB to 8-bit BT.601 YUV (VUYA, as decoders give).
                    let [r, g, b, a] = color.map(|c| c.clamp(0.0, 1.0) as f64);
                    let y = 0.299 * r + 0.587 * g + 0.114 * b;
                    let px = [128.0 + 224.0 * (r - y) / 1.402, 128.0 + 224.0 * (b - y) / 1.772, 16.0 + 219.0 * y, 255.0 * a].map(|v| v.round().clamp(0.0, 255.0) as u8);
                    gpu.upload(state.source.as_ref().unwrap(), &px, 1, 1);
                }
            }
            state.uploaded = Some(shown);
        }
        let (w, h) = (item.width, item.height);
        let (src, tmp) = (view(state.source.as_ref().unwrap()), view(state.tmp.as_ref().unwrap()));
        let refit = state.fitted != Some(shown);
        if refit {
            fit(gpu, enc, &src, &tmp, &view(state.out.as_ref().unwrap()), (sw, sh), item.scaled, item.offset, (w, h), item.opaque, item.fill);
            state.fitted = Some(shown);
        }
        // fit blur: the backdrop from the same frame, through its effects, with the picture laid over it.
        let mut first = view(state.out.as_ref().unwrap());
        if let Some(back) = &item.backdrop {
            let t = state.back.get_or_insert_with(|| ["backdrop", "backdrop-a", "backdrop-b", "laid"].map(|l| gpu.texture(l, w, h, FLOAT, true)));
            let [fitted, a, b, laid] = [view(&t[0]), view(&t[1]), view(&t[2]), view(&t[3])];
            if refit {
                fit(gpu, enc, &src, &tmp, &fitted, (sw, sh), back.scaled, back.offset, (w, h), true, item.fill);
                let under = match self.effects.run(enc, &back.effects, &fitted, [&a, &b], 0, (w, h), k)? {
                    Some(s) => [&a, &b][s].clone(),
                    None => fitted.clone(),
                };
                let lu = gpu.uniform(&LayerParams { pos: [0, 0], size: [w, h], blend: 0, opacity: 1.0, _pad: [0.0; 2] });
                gpu.dispatch(enc, &gpu.layer, &[wgpu::BindingResource::TextureView(&under), wgpu::BindingResource::TextureView(&first), wgpu::BindingResource::TextureView(&laid), lu.as_entire_binding()], w, h);
            }
            first = laid;
        }
        // Effects can change with time, so they run on every frame (frame `k` of the piece).
        if !item.effects.is_empty() {
            let fx = state.fx.get_or_insert_with(|| [gpu.texture("effect-a", w, h, FLOAT, true), gpu.texture("effect-b", w, h, FLOAT, true)]);
            let (a, b) = (view(&fx[0]), view(&fx[1]));
            state.result = self.effects.run(enc, &item.effects, &first, [&a, &b], 0, (w, h), k)?;
        }
        Ok(Some(i))
    }

    /// The picture of item `i` for this frame: fitted (over its backdrop), then through its effects.
    fn shown(&self, i: usize) -> wgpu::TextureView {
        let state = &self.states[i];
        match (state.result, &state.fx, &state.back) {
            (Some(s), Some(fx), _) => view(&fx[s]),
            (_, _, Some(back)) => view(&back[3]),
            _ => view(state.out.as_ref().unwrap()),
        }
    }

    /// Draw output frame `n` and read it back: packed 8-bit VUYA, width x height.
    pub fn frame(&mut self, n: i64) -> Result<Vec<u8>, String> {
        let slot = self.draw(n)?;
        self.read(slot)
    }

    /// Read back the frame `draw` put in `slot`, waiting only for its own submission.
    pub fn read(&mut self, slot: usize) -> Result<Vec<u8>, String> {
        let index = self.filled[slot].take().ok_or("nothing was drawn into that slot")?;
        let slice = self.staging[slot].slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.gpu.device.poll(wgpu::PollType::Wait { submission_index: Some(index), timeout: None }).map_err(|e| format!("graphics device: {e}"))?;
        let frame = slice.get_mapped_range().map_err(|e| format!("reading the frame back: {e}"))?.to_vec();
        self.staging[slot].unmap();
        Ok(frame)
    }

    /// Draw output frame `n` and send it to the GPU, into the next readback slot (returned). Read
    /// it with `read`; meanwhile the next frame can be drawn into the other slot.
    pub fn draw(&mut self, n: i64) -> Result<usize, String> {
        let plan = self.plan.clone();
        let gpu = self.gpu;
        let (w, h, fps) = (plan.width, plan.height, plan.fps);
        let t = n as f64 / fps;
        let canvas_views = [view(&self.canvas[0]), view(&self.canvas[1])];
        let blank = view(&self.blank);
        let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        // The primary track: at most the outgoing and the incoming clip of a transition.
        let active: Vec<usize> = plan.clips.iter().enumerate().filter(|(_, c)| c.first <= n && n < c.first + c.frames).map(|(i, _)| i).collect();
        let mut params = PrimaryParams {
            mode: 0,
            kind: 0,
            fade_a: 1.0,
            fade_b: 1.0,
            progress: 1.0,
            reach: 0.0,
            aspect: 1.0,
            rgb: plan.rgb_transitions as u32,
            background: [plan.background[0], plan.background[1], plan.background[2], 1.0],
            origin: [0.5, 0.5],
            _pad1: [0.0; 2],
        };
        let mut views: Vec<wgpu::TextureView> = Vec::new();
        let shown: Vec<usize> = match active.as_slice() {
            [] => vec![],
            [one] => vec![*one],
            [.., a, b] => {
                if plan.clips[*b].transition.is_some() {
                    vec![*a, *b]
                } else {
                    vec![*b]
                }
            }
        };
        for (slot, &ci) in shown.iter().enumerate() {
            let c = &plan.clips[ci];
            let j = n - c.first;
            let item = self.prepare(c.item, j, true, true, &mut enc)?.unwrap();
            views.push(self.shown(item));
            let f = fade(j, fps, c.duration, c.fade_in, c.fade_out);
            if slot == 0 {
                params.fade_a = f;
            } else {
                params.fade_b = f;
                let tr = c.transition.as_ref().unwrap();
                params.kind = self.kinds[ci].unwrap();
                params.origin = tr.origin.unwrap_or([0.5, 0.5]);
                params.reach = tr.reach;
                params.aspect = tr.aspect;
                params.progress = xfade_progress(n, fps, tr.offset, tr.duration);
            }
        }
        params.mode = shown.len() as u32;
        if params.mode == 2 && params.kind == HBLUR {
            let hp = gpu.uniform(&HblurParams { fade_a: params.fade_a, fade_b: params.fade_b, width: w, height: h });
            gpu.dispatch_bound(
                &mut enc,
                &gpu.hblur,
                &[(0, wgpu::BindingResource::TextureView(&views[0])), (1, wgpu::BindingResource::TextureView(&views[1])), (2, self.sums.as_entire_binding()), (3, hp.as_entire_binding())],
                h.div_ceil(64),
                1,
            );
        }
        let pu = gpu.uniform(&params);
        gpu.dispatch(
            &mut enc,
            &gpu.primary,
            &[
                wgpu::BindingResource::TextureView(views.first().unwrap_or(&blank)),
                wgpu::BindingResource::TextureView(views.get(1).unwrap_or(&blank)),
                wgpu::BindingResource::TextureView(&canvas_views[0]),
                pu.as_entire_binding(),
                self.sums.as_entire_binding(),
            ],
            w,
            h,
        );
        // Whole-video effects on the primary picture, before the layers.
        let mut cur = self.effects.run(&mut enc, &plan.effects, &canvas_views[0], [&canvas_views[0], &canvas_views[1]], 1, (w, h), n)?.unwrap_or(0);
        for (li, l) in plan.layers.iter().enumerate() {
            if t < l.start - 1e-9 || t > l.end + 1e-9 {
                continue;
            }
            let pos = (t - l.start) * fps;
            let k = (pos + 1e-6).floor() as i64;
            let exact = (pos - k as f64).abs() < 1e-6;
            if l.frames.is_some_and(|f| k > f - 1 || (k == f - 1 && !exact)) {
                continue;
            }
            let Some(item) = self.prepare(l.item, k, false, exact, &mut enc)? else { continue };
            let it = &plan.items[item];
            let pos = hold(&l.positions, n - l.frame0).unwrap_or([l.x, l.y]);
            let keyed = hold(&l.opacities, k).unwrap_or(1.0);
            let lu = gpu.uniform(&LayerParams {
                pos,
                size: [it.width, it.height],
                blend: self.blends[li],
                opacity: l.opacity * keyed * fade(k, fps, l.duration, l.fade_in, l.fade_out),
                _pad: [0.0; 2],
            });
            let item_view = self.shown(item);
            gpu.dispatch(
                &mut enc,
                &gpu.layer,
                &[
                    wgpu::BindingResource::TextureView(&canvas_views[cur]),
                    wgpu::BindingResource::TextureView(&item_view),
                    wgpu::BindingResource::TextureView(&canvas_views[1 - cur]),
                    lu.as_entire_binding(),
                ],
                w,
                h,
            );
            cur = 1 - cur;
        }
        let bytes = (w * h * 4) as u64;
        gpu.dispatch(&mut enc, &gpu.pack, &[wgpu::BindingResource::TextureView(&canvas_views[cur]), self.packed.as_entire_binding()], w, h);
        let slot = self.next_slot;
        if self.filled[slot].is_some() {
            return Err("both readback slots are waiting to be read".into());
        }
        enc.copy_buffer_to_buffer(&self.packed, 0, &self.staging[slot], 0, bytes);
        self.filled[slot] = Some(gpu.queue.submit([enc.finish()]));
        self.next_slot = 1 - slot;
        Ok(slot)
    }
}

/// Render a whole plan in order to its encoder.
pub fn render(gpu: &Gpu, plan: Arc<Plan>, cancel: &AtomicBool, progress: &mut dyn FnMut(u32, u32)) -> Result<Value, String> {
    let started = Instant::now();
    let frames = plan.frames;
    let lead = (DECODE_LEAD * plan.fps).ceil() as i64;
    let mut c = Composer::new(gpu, plan.clone())?;
    let mut encoder = Encoder::start(&plan.ffmpeg, &plan.output.args, plan.cwd.as_deref())?;
    let mut last_report = Instant::now();
    let result = (|| -> Result<(), String> {
        // Frame n draws on the GPU while frame n - 1 is read back and sent to the encoder.
        let mut waiting: Option<usize> = None;
        for n in 0..frames as i64 {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            c.look_ahead(n, lead)?;
            let slot = c.draw(n)?;
            if let Some(previous) = waiting.replace(slot) {
                encoder.write(c.read(previous)?)?;
            }
            c.release_done(n);
            if last_report.elapsed().as_millis() >= 250 {
                progress(n as u32 + 1, frames);
                last_report = Instant::now();
            }
        }
        if let Some(last) = waiting {
            encoder.write(c.read(last)?)?;
        }
        Ok(())
    })();
    drop(c);
    match result {
        Ok(()) => {
            encoder.finish()?;
            progress(frames, frames);
            let seconds = started.elapsed().as_secs_f64();
            Ok(json!({ "frames": frames, "seconds": seconds, "fps": frames as f64 / seconds.max(1e-9) }))
        }
        Err(e) => {
            encoder.abort();
            Err(e)
        }
    }
}

/// Draw one frame of an open composer and hand it to ffmpeg with `args` (which read VUYA frames
/// on stdin, e.g. to burn in the text and write a picture). Returns how long the parts took.
pub fn frame(c: &mut Composer, n: i64, args: &[String]) -> Result<Value, String> {
    let started = Instant::now();
    let last = c.plan.frames.saturating_sub(1) as i64;
    let pixels = c.frame(n.clamp(0, last))?;
    let drawn = started.elapsed().as_secs_f64();
    let mut out = Encoder::start(&c.plan.ffmpeg, args, c.plan.cwd.as_deref())?;
    out.write(pixels)?;
    out.finish()?;
    Ok(json!({ "draw": drawn, "seconds": started.elapsed().as_secs_f64() }))
}
