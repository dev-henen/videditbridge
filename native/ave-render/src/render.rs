//! Render a plan: per output frame, fit each visible item's source frame on the GPU, build the
//! primary picture (clips, fades, transitions), put the layers over it, and hand the frame to the
//! encoder.

use crate::gpu::{view, Gpu, LayerParams, PrimaryParams, ResampleParams, FLOAT};
use crate::media::{Decoder, Encoder};
use crate::plan::{blend_mode, transition_kind, Item, Plan, Source, PLAN_VERSION};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
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

struct Renderer<'a> {
    gpu: &'a Gpu,
    plan: &'a Plan,
    states: Vec<ItemState>,
}

impl<'a> Renderer<'a> {
    fn start_decoder(&mut self, i: usize) -> Result<(), String> {
        let state = &mut self.states[i];
        if state.decoder.is_some() || state.released {
            return Ok(());
        }
        if let Source::Decode { width, height, args, .. } = &self.plan.items[i].source {
            state.decoder = Some(Decoder::start(&self.plan.ffmpeg, args, self.plan.cwd.as_deref(), (*width * *height * 4) as usize)?);
        }
        Ok(())
    }

    /// Fit frame `k` of item `i` into its item image, recording the passes into `enc`. Clips (`hold`)
    /// show their last frame once the source runs out. Layers follow FFmpeg's overlay: after the
    /// source's last frame they are gone, and the last frame itself shows only at its own time
    /// (`exact`), so the frame after it is read to know it is not the last.
    fn prepare(&mut self, i: usize, k: i64, hold: bool, exact: bool, enc: &mut wgpu::CommandEncoder) -> Result<Option<usize>, String> {
        let item: &Item = &self.plan.items[i];
        let gpu = self.gpu;
        self.start_decoder(i)?;
        let state = &mut self.states[i];
        let (sw, sh, shown) = match &item.source {
            Source::Decode { width, height, still: true, .. } => {
                state.decoder.as_mut().unwrap().seek(0)?;
                (*width, *height, 0)
            }
            Source::Decode { width, height, .. } => {
                let decoder = state.decoder.as_mut().unwrap();
                let need = if hold || exact { k } else { k + 1 };
                decoder.seek(need)?;
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
        if state.fitted != Some(shown) {
            let (src, tmp, out) = (view(state.source.as_ref().unwrap()), view(state.tmp.as_ref().unwrap()), view(state.out.as_ref().unwrap()));
            let h = gpu.uniform(&ResampleParams {
                src_len: sw,
                scaled_len: item.scaled[0],
                offset: item.offset[0],
                opaque: 0,
                out_size: [item.width, sh],
                x_range: [0, 0],
                fill: [0.0; 4],
            });
            gpu.dispatch(enc, &gpu.resample_h, &[wgpu::BindingResource::TextureView(&src), wgpu::BindingResource::TextureView(&tmp), h.as_entire_binding()], item.width, sh);
            let v = gpu.uniform(&ResampleParams {
                src_len: sh,
                scaled_len: item.scaled[1],
                offset: item.offset[1],
                opaque: item.opaque as u32,
                out_size: [item.width, item.height],
                x_range: [item.offset[0], item.offset[0] + item.scaled[0] as i32],
                fill: item.fill,
            });
            gpu.dispatch(enc, &gpu.resample_v, &[wgpu::BindingResource::TextureView(&tmp), wgpu::BindingResource::TextureView(&out), v.as_entire_binding()], item.width, item.height);
            state.fitted = Some(shown);
        }
        Ok(Some(i))
    }

    fn release(&mut self, i: usize) {
        self.states[i] = ItemState { released: true, ..Default::default() };
    }
}

pub fn render(gpu: &Gpu, plan: &Plan, cancel: &AtomicBool, progress: &mut dyn FnMut(u32, u32)) -> Result<Value, String> {
    if plan.version != PLAN_VERSION {
        return Err(format!("plan version {} is not supported (this engine reads version {PLAN_VERSION})", plan.version));
    }
    let started = Instant::now();
    let (w, h, fps) = (plan.width, plan.height, plan.fps);
    let blends = plan.layers.iter().map(|l| blend_mode(&l.blend)).collect::<Result<Vec<_>, _>>()?;
    let kinds = plan.clips.iter().map(|c| c.transition.as_ref().map(|t| transition_kind(&t.kind)).transpose()).collect::<Result<Vec<_>, _>>()?;
    let spans = spans(plan);
    let mut r = Renderer { gpu, plan, states: (0..plan.items.len()).map(|_| ItemState::default()).collect() };
    let canvas = [gpu.texture("canvas-a", w, h, FLOAT, true), gpu.texture("canvas-b", w, h, FLOAT, true)];
    let canvas_views = [view(&canvas[0]), view(&canvas[1])];
    let blank = view(&gpu.texture("blank", 1, 1, FLOAT, true));
    let bytes = (w * h * 4) as u64;
    let packed = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("packed"), size: bytes, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("staging"), size: bytes, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut encoder = Encoder::start(&plan.ffmpeg, &plan.output.args, plan.cwd.as_deref())?;
    let lead = (DECODE_LEAD * fps).ceil() as i64;
    let mut last_report = Instant::now();
    let result = (|| -> Result<(), String> {
        for n in 0..plan.frames as i64 {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            for (i, &(a, b)) in spans.iter().enumerate() {
                if a <= n + lead && b >= n {
                    r.start_decoder(i)?;
                }
            }
            let t = n as f64 / fps;
            let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
            // The primary track: at most the outgoing and the incoming clip of a transition.
            let active: Vec<usize> = plan.clips.iter().enumerate().filter(|(_, c)| c.first <= n && n < c.first + c.frames).map(|(i, _)| i).collect();
            let mut params = PrimaryParams { mode: 0, kind: 0, fade_a: 1.0, fade_b: 1.0, progress: 1.0, _pad: [0.0; 3], background: [plan.background[0], plan.background[1], plan.background[2], 1.0] };
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
                let item = r.prepare(c.item, j, true, true, &mut enc)?.unwrap();
                views.push(view(r.states[item].out.as_ref().unwrap()));
                let f = fade(j, fps, c.duration, c.fade_in, c.fade_out);
                if slot == 0 {
                    params.fade_a = f;
                } else {
                    params.fade_b = f;
                    let tr = c.transition.as_ref().unwrap();
                    params.kind = kinds[ci].unwrap();
                    params.progress = (1.0 - (t - tr.offset) / tr.duration).clamp(0.0, 1.0) as f32;
                }
            }
            params.mode = shown.len() as u32;
            let pu = gpu.uniform(&params);
            gpu.dispatch(
                &mut enc,
                &gpu.primary,
                &[
                    wgpu::BindingResource::TextureView(views.first().unwrap_or(&blank)),
                    wgpu::BindingResource::TextureView(views.get(1).unwrap_or(&blank)),
                    wgpu::BindingResource::TextureView(&canvas_views[0]),
                    pu.as_entire_binding(),
                ],
                w,
                h,
            );
            let mut cur = 0;
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
                let Some(item) = r.prepare(l.item, k, false, exact, &mut enc)? else { continue };
                let it = &plan.items[item];
                let lu = gpu.uniform(&LayerParams {
                    pos: [l.x, l.y],
                    size: [it.width, it.height],
                    blend: blends[li],
                    opacity: l.opacity * fade(k, fps, l.duration, l.fade_in, l.fade_out),
                    _pad: [0.0; 2],
                });
                let item_view = view(r.states[item].out.as_ref().unwrap());
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
            gpu.dispatch(&mut enc, &gpu.pack, &[wgpu::BindingResource::TextureView(&canvas_views[cur]), packed.as_entire_binding()], w, h);
            enc.copy_buffer_to_buffer(&packed, 0, &staging, 0, bytes);
            gpu.queue.submit([enc.finish()]);
            let slice = staging.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("graphics device: {e}"))?;
            let frame = slice.get_mapped_range().map_err(|e| format!("reading the frame back: {e}"))?.to_vec();
            staging.unmap();
            encoder.write(frame)?;
            for (i, &(_, b)) in spans.iter().enumerate() {
                if b <= n && !r.states[i].released {
                    r.release(i);
                }
            }
            if last_report.elapsed().as_millis() >= 250 {
                progress(n as u32 + 1, plan.frames);
                last_report = Instant::now();
            }
        }
        Ok(())
    })();
    drop(r);
    match result {
        Ok(()) => {
            encoder.finish()?;
            progress(plan.frames, plan.frames);
            let seconds = started.elapsed().as_secs_f64();
            Ok(json!({ "frames": plan.frames, "seconds": seconds, "fps": plan.frames as f64 / seconds.max(1e-9) }))
        }
        Err(e) => {
            encoder.abort();
            Err(e)
        }
    }
}
