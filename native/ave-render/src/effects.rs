//! Effects on a picture: the plan's operations (plan::Op) run as GPU passes, each reading the
//! previous result and writing the other texture of a pair.

use crate::gpu::{view, BlurParams, CombineParams, ConvParams, GradeParams, Gpu, LightParams, PixelParams, ResampleParams, FLOAT};
use wgpu::util::DeviceExt;
use crate::plan::{Blend, Op};
use std::collections::HashMap;
use std::process::{Command, Stdio};

/// Points per channel of a Hald level 8 table, and its image side.
const TABLE: u32 = 64;
const HALD: usize = 512;

pub struct Effects<'a> {
    gpu: &'a Gpu,
    ffmpeg: String,
    fps: f64,
    tables: HashMap<Vec<String>, wgpu::Texture>,
    cubes: HashMap<String, (wgpu::Texture, [f32; 2])>,
    scratch: HashMap<(u32, u32), wgpu::Texture>,
    buffers: HashMap<(u32, u32), wgpu::Buffer>,
    /// Textures for branches and averages, by size and nesting level.
    temps: HashMap<(u32, u32, usize), [wgpu::Texture; 4]>,
    /// Other working textures, by use and size.
    named: HashMap<(&'static str, u32, u32), wgpu::Texture>,
}

/// FFmpeg blend mode numbers shared with combine.wgsl.
fn blend_number(mode: &str) -> Result<u32, String> {
    Ok(match mode {
        "addition" => 1,
        "average" => 2,
        "screen" => 3,
        "softlight" => 4,
        "multiply" => 5,
        _ => return Err(format!("unknown blend {mode}")),
    })
}

/// FFmpeg's fade on frame `j`: start and length rounded to whole frames (its 1/fps timebase).
/// How much of the picture shows, 0..1.
pub fn fade_factor(j: i64, fps: f64, start: f64, duration: f64, out: bool) -> f32 {
    let (from, len) = ((start * fps).round(), (duration * fps).round());
    let ramp = if len > 0.0 { ((j as f64 - from) / len).clamp(0.0, 1.0) } else if j as f64 >= from { 1.0 } else { 0.0 };
    (if out { 1.0 - ramp } else { ramp }) as f32
}

/// gblur's constants for one step at `sigma`: nu, the boundary scale, and the scale of one direction.
fn gblur(sigma: f32) -> (f32, f32, f32) {
    let lambda = (sigma as f64).powi(2) / 2.0;
    if lambda <= 0.0 {
        return (0.0, 1.0, 1.0);
    }
    let nu = (1.0 + 2.0 * lambda - (1.0 + 4.0 * lambda).sqrt()) / (2.0 * lambda);
    (nu as f32, (1.0 / (1.0 - nu)) as f32, (nu / lambda) as f32)
}

impl<'a> Effects<'a> {
    pub fn new(gpu: &'a Gpu, ffmpeg: &str, fps: f64) -> Self {
        Effects { gpu, ffmpeg: ffmpeg.to_string(), fps, tables: HashMap::new(), cubes: HashMap::new(), scratch: HashMap::new(), buffers: HashMap::new(), temps: HashMap::new(), named: HashMap::new() }
    }

    /// Bake a color table by running ffmpeg once per distinct chain.
    fn table(&mut self, args: &[String]) -> Result<&wgpu::Texture, String> {
        if !self.tables.contains_key(args) {
            let out = Command::new(&self.ffmpeg).args(args).stdin(Stdio::null()).output().map_err(|e| format!("cannot start ffmpeg ({}): {e}", self.ffmpeg))?;
            if !out.status.success() || out.stdout.len() < HALD * HALD * 3 {
                return Err(format!("baking a color table failed:\n{}", String::from_utf8_lossy(&out.stderr)));
            }
            let rgba: Vec<u8> = out.stdout[..HALD * HALD * 3].chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect();
            self.tables.insert(args.to_vec(), self.gpu.table(&rgba, TABLE));
        }
        Ok(&self.tables[args])
    }

    /// Load a .cube table once: its points as a float 3D texture, and its input range.
    fn cube(&mut self, file: &str) -> Result<(&wgpu::Texture, [f32; 2]), String> {
        if !self.cubes.contains_key(file) {
            let text = std::fs::read_to_string(file).map_err(|e| format!("color table {file}: {e}"))?;
            let cube = parse_cube(&text).map_err(|e| format!("color table {file}: {e}"))?;
            let texture = self.gpu.table_half(&cube.points, cube.size);
            self.cubes.insert(file.to_string(), (texture, cube.domain));
        }
        let (texture, domain) = &self.cubes[file];
        Ok((texture, *domain))
    }

    fn scratch(&mut self, width: u32, height: u32) -> &wgpu::Texture {
        let gpu = self.gpu;
        self.scratch.entry((width, height)).or_insert_with(|| gpu.texture("effect-rows", width, height, FLOAT, true))
    }

    fn buffer(&mut self, width: u32, height: u32) -> &wgpu::Buffer {
        let gpu = self.gpu;
        self.buffers.entry((width, height)).or_insert_with(|| {
            gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("blur"), size: width as u64 * height as u64 * 16, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false })
        })
    }

    /// Run `ops` on frame `j` of a piece: the first reads `first`, then they alternate between the
    /// two textures of `pair`, starting by writing `pair[slot]`. Returns the slot holding the result,
    /// or None when there were no operations (the result is still `first`).
    pub fn run(&mut self, enc: &mut wgpu::CommandEncoder, ops: &[Op], first: &wgpu::TextureView, pair: [&wgpu::TextureView; 2], slot: usize, size: (u32, u32), j: i64) -> Result<Option<usize>, String> {
        self.run_level(enc, ops, first, pair, slot, size, j, 0)
    }

    fn named(&mut self, name: &'static str, w: u32, h: u32) -> wgpu::TextureView {
        let gpu = self.gpu;
        view(self.named.entry((name, w, h)).or_insert_with(|| gpu.texture(name, w, h, FLOAT, true)))
    }

    fn temps(&mut self, w: u32, h: u32, level: usize) -> [wgpu::TextureView; 4] {
        let gpu = self.gpu;
        let t = self.temps.entry((w, h, level)).or_insert_with(|| ["branch-a", "branch-b", "branch-c", "branch-d"].map(|l| gpu.texture(l, w, h, FLOAT, true)));
        [view(&t[0]), view(&t[1]), view(&t[2]), view(&t[3])]
    }

    /// combine.wgsl: `top` and `bottom` into `out` with blend mode number `mode` (0 copies bottom).
    fn combine(&self, enc: &mut wgpu::CommandEncoder, top: &wgpu::TextureView, bottom: &wgpu::TextureView, out: &wgpu::TextureView, (mode, luma, opacity): (u32, bool, f32), (w, h): (u32, u32)) {
        let gpu = self.gpu;
        let u = gpu.uniform(&CombineParams { mode, luma: luma as u32, opacity, _pad: 0.0, color: [0.0; 4] });
        gpu.dispatch(enc, gpu.combine(), &[wgpu::BindingResource::TextureView(top), wgpu::BindingResource::TextureView(bottom), wgpu::BindingResource::TextureView(out), u.as_entire_binding()], w, h);
    }

    /// A color table (`args` bake it, see Op::Lut) from `input` into `output`, both `w` x `h`.
    fn lut_pass(&mut self, enc: &mut wgpu::CommandEncoder, args: &[String], input: &wgpu::TextureView, output: &wgpu::TextureView, (w, h): (u32, u32)) -> Result<(), String> {
        let gpu = self.gpu;
        let table = view(self.table(args)?);
        let du = gpu.uniform(&[0.0f32, 1.0, 0.0, 0.0]);
        gpu.dispatch(enc, gpu.lut(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&table), wgpu::BindingResource::TextureView(output), du.as_entire_binding()], w, h);
        Ok(())
    }

    /// The fit's bicubic scale (swscale's): `src` (`from`) scaled to `scaled` and placed at `offset`
    /// (negative for a crop) in `dst` (`to`), through `rows` (to.0 x from.1).
    #[allow(clippy::too_many_arguments)]
    fn scale(&self, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, rows: &wgpu::TextureView, dst: &wgpu::TextureView, from: (u32, u32), scaled: [u32; 2], offset: [i32; 2], to: (u32, u32)) {
        let gpu = self.gpu;
        let hp = gpu.uniform(&ResampleParams { src_len: from.0, scaled_len: scaled[0], offset: offset[0], opaque: 0, out_size: [to.0, from.1], x_range: [0, 0], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
        gpu.dispatch(enc, gpu.resample_h(), &[wgpu::BindingResource::TextureView(src), wgpu::BindingResource::TextureView(rows), hp.as_entire_binding()], to.0, from.1);
        let vp = gpu.uniform(&ResampleParams { src_len: from.1, scaled_len: scaled[1], offset: offset[1], opaque: 0, out_size: [to.0, to.1], x_range: [i32::MIN / 2, i32::MAX / 2], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
        gpu.dispatch(enc, gpu.resample_v(), &[wgpu::BindingResource::TextureView(rows), wgpu::BindingResource::TextureView(dst), vp.as_entire_binding()], to.0, to.1);
    }

    /// A pixel.wgsl pass from `src` into `dst` (`size` is dst's).
    fn pixel_pass(&self, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, dst: &wgpu::TextureView, params: PixelParams, (w, h): (u32, u32)) {
        let gpu = self.gpu;
        let u = gpu.uniform(&params);
        gpu.dispatch(enc, gpu.pixel(), &[wgpu::BindingResource::TextureView(src), wgpu::BindingResource::TextureView(dst), u.as_entire_binding()], w, h);
    }

    /// Scale `src` (`from`) to `dst` (`to`) with swscale's bicubic, its area filter or nearest.
    fn resize(&mut self, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, dst: &wgpu::TextureView, from: (u32, u32), to: (u32, u32), how: &str) -> Result<(), String> {
        match how {
            "bicubic" => {
                let rows = self.named("resize-rows", to.0, from.1);
                self.scale(enc, src, &rows, dst, from, [to.0, to.1], [0, 0], to);
            }
            "area" => self.pixel_pass(enc, src, dst, PixelParams { mode: 15, ..Default::default() }, to),
            "neighbor" => self.pixel_pass(enc, src, dst, PixelParams { mode: 16, ..Default::default() }, to),
            _ => return Err(format!("unknown scaling {how}")),
        }
        Ok(())
    }

    /// `run` inside `level` branches (each level has its own textures).
    #[allow(clippy::too_many_arguments)]
    fn run_level(&mut self, enc: &mut wgpu::CommandEncoder, ops: &[Op], first: &wgpu::TextureView, pair: [&wgpu::TextureView; 2], mut slot: usize, size: (u32, u32), j: i64, level: usize) -> Result<Option<usize>, String> {
        let gpu = self.gpu;
        let (w, h) = size;
        let mut last: Option<usize> = None;
        for op in ops {
            let input = match last {
                Some(s) => pair[s],
                None => first,
            };
            let output = pair[slot];
            let pixel = |enc: &mut wgpu::CommandEncoder, params: PixelParams| {
                let u = gpu.uniform(&params);
                gpu.dispatch(enc, gpu.pixel(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(output), u.as_entire_binding()], w, h);
            };
            match op {
                Op::Grade { gains, contrast, saturation, shadows, midtones, highlights } => {
                    let v = |x: &[f32; 3]| [x[0], x[1], x[2], 0.0];
                    let u = gpu.uniform(&GradeParams { gains: v(gains), shadows: v(shadows), midtones: v(midtones), highlights: v(highlights), contrast: *contrast, saturation: *saturation, _pad: [0.0; 2] });
                    gpu.dispatch(enc, gpu.grade(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(output), u.as_entire_binding()], w, h);
                }
                Op::Cube { file } => {
                    let (table, domain) = self.cube(file)?;
                    let (table, du) = (view(table), gpu.uniform(&[domain[0], domain[1], 0.0f32, 0.0]));
                    gpu.dispatch(enc, gpu.lut(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&table), wgpu::BindingResource::TextureView(output), du.as_entire_binding()], w, h);
                }
                Op::Lut { args } => {
                    let table = view(self.table(args)?);
                    let du = gpu.uniform(&[0.0f32, 1.0, 0.0, 0.0]);
                    gpu.dispatch(enc, gpu.lut(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&table), wgpu::BindingResource::TextureView(output), du.as_entire_binding()], w, h);
                }
                Op::Crop { rects, filter } => {
                    let r = rects.get((j.max(0) as usize).min(rects.len().saturating_sub(1))).copied().unwrap_or([0.0, 0.0, w as f32, h as f32]);
                    if filter == "bicubic" {
                        // Whole pixels cropped, then scaled with the fit's bicubic passes.
                        let [x, y, cw, ch] = r.map(|v| v.round() as i32);
                        let (cw, ch) = (cw.max(1) as u32, ch.max(1) as u32);
                        let rows = view(self.scratch(w, h));
                        let hp = gpu.uniform(&ResampleParams { src_len: cw, scaled_len: w, offset: 0, opaque: 0, out_size: [w, ch], x_range: [0, 0], fill: [0.0; 4], origin: x, line_origin: y, yuv_in: 0, _pad: 0 });
                        gpu.dispatch(enc, gpu.resample_h(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&rows), hp.as_entire_binding()], w, ch);
                        let vp = gpu.uniform(&ResampleParams { src_len: ch, scaled_len: h, offset: 0, opaque: 0, out_size: [w, h], x_range: [0, w as i32], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
                        gpu.dispatch(enc, gpu.resample_v(), &[wgpu::BindingResource::TextureView(&rows), wgpu::BindingResource::TextureView(output), vp.as_entire_binding()], w, h);
                    } else {
                        pixel(enc, PixelParams { mode: 0, rect: r, ..Default::default() });
                    }
                }
                Op::Vignette { angle, backward } => pixel(enc, PixelParams { mode: 1, angle: *angle, backward: *backward as u32, ..Default::default() }),
                Op::Bars { height } => pixel(enc, PixelParams { mode: 2, bar: (*height).min(h / 2), ..Default::default() }),
                Op::Corners { radius } => pixel(enc, PixelParams { mode: 7, bar: *radius, ..Default::default() }),
                Op::Fade { color, out, start, duration } => {
                    let factor = fade_factor(j, self.fps, *start, *duration, *out);
                    pixel(enc, PixelParams { mode: 3, color: [color[0], color[1], color[2], 1.0], factor, ..Default::default() })
                }
                Op::Shift { red, green, blue } => pixel(enc, PixelParams { mode: 4, shift_red: *red, shift_green: *green, shift_blue: *blue, ..Default::default() }),
                Op::Eq { brightness, contrast, saturation, gamma, gamma_weight } => {
                    pixel(enc, PixelParams { mode: 6, rect: [*brightness, *contrast, *saturation, *gamma], angle: *gamma_weight, ..Default::default() })
                }
                Op::Noise { strength, uniform, rgb } => pixel(enc, PixelParams { mode: 5, strength: *strength, uniform: *uniform as u32, backward: *rgb as u32, frame: j.max(0) as u32, ..Default::default() }),
                Op::Blur { sigma, sigma_v, rgb } => {
                    let sv = sigma_v.unwrap_or(*sigma);
                    let params = if *rgb {
                        // RGB planes are all full size: one sigma across and one down, for every channel.
                        let (nh, bh, ph) = gblur(*sigma);
                        let (nv, bv, pv) = gblur(sv);
                        BlurParams { nu: [nh; 4], boundary: [bh; 4], post: [ph * pv; 4], nu_v: [nv; 4], boundary_v: [bv; 4], size: [w, h], _pad: [0; 2] }
                    } else {
                        // YUV: chroma gets the same sigma in FFmpeg's half-size chroma pixels.
                        let (ny, by, py) = gblur(*sigma);
                        let (nc, bc, pc) = gblur(*sigma * 2.0);
                        let (nyv, byv, pyv) = gblur(sv);
                        let (ncv, bcv, pcv) = gblur(sv * 2.0);
                        BlurParams {
                            nu: [nc, nc, ny, ny],
                            boundary: [bc, bc, by, by],
                            post: [pc * pcv, pc * pcv, py * pyv, py * pyv],
                            nu_v: [ncv, ncv, nyv, nyv],
                            boundary_v: [bcv, bcv, byv, byv],
                            size: [w, h],
                            _pad: [0; 2],
                        }
                    };
                    let params = gpu.uniform(&params);
                    let buf = self.buffer(w, h).as_entire_binding();
                    let (gx, gy) = (w.div_ceil(16), h.div_ceil(16));
                    let (load, store) = if *rgb { (gpu.blur_load_rgb(), gpu.blur_store_raw()) } else { (gpu.blur_load(), gpu.blur_store()) };
                    gpu.dispatch_bound(enc, load, &[(0, wgpu::BindingResource::TextureView(input)), (1, buf.clone()), (3, params.as_entire_binding())], gx, gy);
                    gpu.dispatch_bound(enc, gpu.blur_rows(), &[(1, buf.clone()), (3, params.as_entire_binding())], h.div_ceil(64), 1);
                    gpu.dispatch_bound(enc, gpu.blur_columns(), &[(1, buf.clone()), (3, params.as_entire_binding())], w.div_ceil(64), 1);
                    gpu.dispatch_bound(enc, store, &[(1, buf), (2, wgpu::BindingResource::TextureView(output)), (3, params.as_entire_binding())], gx, gy);
                }
                Op::Grain { size: [gw, gh], strength, seed } => {
                    let (gw, gh) = ((*gw).clamp(1, w), (*gh).clamp(1, h));
                    let (gray, noisy, rows, up) = (self.named("grain-gray", gw, gh), self.named("grain-noise", gw, gh), self.named("grain-rows", w, gh), self.named("grain-up", w, h));
                    let pass = |enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, dst: &wgpu::TextureView, params: PixelParams| {
                        let u = gpu.uniform(&params);
                        gpu.dispatch(enc, gpu.pixel(), &[wgpu::BindingResource::TextureView(src), wgpu::BindingResource::TextureView(dst), u.as_entire_binding()], gw, gh);
                    };
                    // lutyuv's mid-gray (Y, U and V 128), then noise on luma only.
                    let mid = (128.0 - 16.0) / 219.0;
                    pass(enc, input, &gray, PixelParams { mode: 3, color: [mid, mid, mid, 1.0], factor: 0.0, ..Default::default() });
                    let frame = (j.max(0) as u32).wrapping_add(seed.wrapping_mul(0x9e37_79b9));
                    pass(enc, &gray, &noisy, PixelParams { mode: 5, strength: *strength, uniform: 0, bar: 1, frame, ..Default::default() });
                    // Scaled up as the fit scales (swscale's bicubic).
                    let hp = gpu.uniform(&ResampleParams { src_len: gw, scaled_len: w, offset: 0, opaque: 0, out_size: [w, gh], x_range: [0, 0], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
                    gpu.dispatch(enc, gpu.resample_h(), &[wgpu::BindingResource::TextureView(&noisy), wgpu::BindingResource::TextureView(&rows), hp.as_entire_binding()], w, gh);
                    let vp = gpu.uniform(&ResampleParams { src_len: gh, scaled_len: h, offset: 0, opaque: 0, out_size: [w, h], x_range: [0, w as i32], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
                    gpu.dispatch(enc, gpu.resample_v(), &[wgpu::BindingResource::TextureView(&rows), wgpu::BindingResource::TextureView(&up), vp.as_entire_binding()], w, h);
                    self.combine(enc, input, &up, output, (4, true, 1.0), (w, h));
                }
                Op::Warp { maps, cubic } => {
                    let m = maps.get((j.max(0) as usize).min(maps.len().saturating_sub(1))).copied().unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
                    pixel(enc, PixelParams { mode: 10, rect: [m[0], m[1], m[2], m[3]], color: [m[4], m[5], m[6], m[7]], uniform: *cubic as u32, ..Default::default() })
                }
                Op::Lens { k1, k2, rgb } => match rgb {
                    Some(k) => pixel(enc, PixelParams { mode: 9, color: [k[0], k[1], k[2], 0.0], uniform: 1, ..Default::default() }),
                    None => pixel(enc, PixelParams { mode: 9, rect: [*k1, *k2, 0.0, 0.0], ..Default::default() }),
                },
                Op::Rays { size: [rw, rh], curve, zooms, levels } => {
                    let (rw, rh) = (*rw, *rh);
                    let rows_down = self.named("rays-rows-down", rw, h);
                    let [a, b, z] = [self.named("rays-a", rw, rh), self.named("rays-b", rw, rh), self.named("rays-zoom", rw, rh)];
                    // Down to a quarter, then the highlight curve.
                    self.scale(enc, input, &rows_down, &z, (w, h), [rw, rh], [0, 0], (rw, rh));
                    self.lut_pass(enc, curve, &z, &a, (rw, rh))?;
                    // Each pass: the picture averaged with a copy scaled up and cropped about the source.
                    let (mut cur, mut other) = (a, b);
                    for [sw, sh, x, y] in zooms {
                        let rows = self.named("rays-rows", rw, rh);
                        self.scale(enc, &cur, &rows, &z, (rw, rh), [*sw as u32, *sh as u32], [-*x, -*y], (rw, rh));
                        self.combine(enc, &cur, &z, &other, (2, false, 1.0), (rw, rh));
                        std::mem::swap(&mut cur, &mut other);
                    }
                    self.lut_pass(enc, levels, &cur, &other, (rw, rh))?;
                    // Back up to the frame, then screen.
                    let (rows_up, up) = (self.named("rays-rows-up", w, rh), self.named("rays-up", w, h));
                    self.scale(enc, &other, &rows_up, &up, (rw, rh), [w, h], [0, 0], (w, h));
                    self.combine(enc, input, &up, output, (3, false, 1.0), (w, h));
                }
                Op::Light { canvas: [cw, ch], color, opacity, leak, orbs } => {
                    let (cw, ch) = (*cw, *ch);
                    let canvas = self.named("light-canvas", cw, ch);
                    let frame = orbs.get((j.max(0) as usize).min(orbs.len().saturating_sub(1)));
                    let list: Vec<[f32; 4]> = frame.cloned().unwrap_or_default();
                    let data: Vec<f32> = if list.is_empty() { vec![0.0; 4] } else { list.iter().flatten().copied().collect() };
                    let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("orbs"), contents: bytemuck::cast_slice(&data), usage: wgpu::BufferUsages::STORAGE });
                    let l = leak.unwrap_or([0.0; 5]);
                    let lp = gpu.uniform(&LightParams { mode: leak.is_none() as u32, count: list.len() as u32, t: (j.max(0) as f64 / self.fps) as f32, _pad: 0.0, speeds: [l[0], l[1], l[2], l[3]], speed5: l[4], _pad2: [0.0; 3] });
                    gpu.dispatch(enc, gpu.light(), &[wgpu::BindingResource::TextureView(&canvas), lp.as_entire_binding(), buffer.as_entire_binding()], cw, ch);
                    let (rows, up) = (self.named("light-rows", w, ch), self.named("light-up", w, h));
                    self.scale(enc, &canvas, &rows, &up, (cw, ch), [w, h], [0, 0], (w, h));
                    let u = gpu.uniform(&CombineParams { mode: 6, luma: 0, opacity: *opacity, _pad: 0.0, color: [color[0], color[1], color[2], 1.0] });
                    gpu.dispatch(enc, gpu.combine(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&up), wgpu::BindingResource::TextureView(output), u.as_entire_binding()], w, h);
                }
                Op::Move { size: [sw, sh], frames, rotate } => {
                    let (sw, sh) = (*sw, *sh);
                    let f = frames.get((j.max(0) as usize).min(frames.len().saturating_sub(1))).copied().unwrap_or([0.0; 3]);
                    let (rows, scaled) = (self.named("move-rows", sw, h), self.named("move-scaled", sw, sh));
                    self.scale(enc, input, &rows, &scaled, (w, h), [sw, sh], [0, 0], (sw, sh));
                    let u = gpu.uniform(&PixelParams { mode: 11, rect: [f[0], f[1], f[2], 0.0], uniform: *rotate as u32, ..Default::default() });
                    gpu.dispatch(enc, gpu.pixel(), &[wgpu::BindingResource::TextureView(&scaled), wgpu::BindingResource::TextureView(output), u.as_entire_binding()], w, h);
                }
                Op::Flip { horizontal } => pixel(enc, PixelParams { mode: 12, backward: !*horizontal as u32, ..Default::default() }),
                Op::Grid { cell, thickness, alpha } => pixel(enc, PixelParams { mode: 13, rect: [cell[0].max(1) as f32, cell[1].max(1) as f32, 0.0, 0.0], bar: *thickness, factor: *alpha, ..Default::default() }),
                Op::Dilate { rgb } => pixel(enc, PixelParams { mode: 14, backward: *rgb as u32, ..Default::default() }),
                Op::Conv { kernel, rdiv, bias, rgb } => {
                    let n = (kernel.len() as f64).sqrt().round() as u32;
                    let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("kernel"), contents: bytemuck::cast_slice(kernel), usage: wgpu::BufferUsages::STORAGE });
                    let u = gpu.uniform(&ConvParams { size: n, rgb: *rgb as u32, rdiv: *rdiv, bias: *bias, mode: 0, amount: 0, height: n, scalebits: 0 });
                    gpu.dispatch(enc, gpu.conv(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(output), u.as_entire_binding(), buffer.as_entire_binding()], w, h);
                }
                Op::Unsharp { size: [mx, my], amount } => {
                    // unsharp's cascade of two-tap sums (2 x steps of them each way) is a binomial kernel.
                    let (wx, wy) = (binomial(mx / 2 * 2), binomial(my / 2 * 2));
                    let kernel: Vec<f32> = wy.iter().flat_map(|a| wx.iter().map(move |b| (a * b) as f32)).collect();
                    let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("unsharp"), contents: bytemuck::cast_slice(&kernel), usage: wgpu::BufferUsages::STORAGE });
                    let scalebits = (mx / 2 + my / 2) * 2;
                    let u = gpu.uniform(&ConvParams { size: wx.len() as u32, rgb: 0, rdiv: 1.0, bias: 0.0, mode: 1, amount: *amount, height: wy.len() as u32, scalebits });
                    gpu.dispatch(enc, gpu.conv(), &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(output), u.as_entire_binding(), buffer.as_entire_binding()], w, h);
                }
                Op::Mix { branches } => {
                    // Each branch from the same picture; its 8-bit planes summed, then times 1 / n
                    // (mix's float wfactor), rounded to nearest.
                    let t = self.temps(w, h, level);
                    for (k, b) in branches.iter().enumerate() {
                        let result = match self.run_level(enc, b, input, [&t[0], &t[1]], 0, size, j, level + 1)? {
                            Some(s) => t[s].clone(),
                            None => input.clone(),
                        };
                        // Sums alternate between t[2] and t[3]; the first ignores its top (x 0).
                        let (from, to) = if k % 2 == 0 { (&t[3], &t[2]) } else { (&t[2], &t[3]) };
                        let from = if k == 0 { &result } else { from };
                        self.combine(enc, from, &result, to, (10, false, if k == 0 { 0.0 } else { 1.0 }), (w, h));
                    }
                    if branches.is_empty() {
                        self.combine(enc, input, input, output, (0, false, 1.0), (w, h));
                    } else {
                        let sums = if branches.len() % 2 == 1 { &t[2] } else { &t[3] };
                        self.combine(enc, sums, sums, output, (11, false, 1.0f32 / branches.len() as f32), (w, h));
                    }
                }
                Op::At { size: [sw, sh], down, up, ops, rgb } => {
                    // The picture through `ops` at `small`, scaled to `to` into `dst`.
                    let path = |me: &mut Self, enc: &mut wgpu::CommandEncoder, small: (u32, u32), to: (u32, u32), dst: &wgpu::TextureView, key: usize| -> Result<(), String> {
                        let t = me.temps(small.0, small.1, level + 1 + 2 * key);
                        let start = me.named(if key == 0 { "at-small" } else { "at-small-chroma" }, small.0, small.1);
                        me.resize(enc, input, &start, (w, h), small, down)?;
                        let result = match me.run_level(enc, ops, &start, [&t[2], &t[3]], 0, small, j, level + 2 + 2 * key)? {
                            Some(s) => [&t[2], &t[3]][s].clone(),
                            None => start.clone(),
                        };
                        me.resize(enc, &result, dst, small, to, up)
                    };
                    if *rgb {
                        path(self, enc, (*sw, *sh), (w, h), output, 0)?;
                    } else {
                        // Luma at the small size, chroma at the chroma planes' small size, joined as planes.
                        let luma = self.named("at-luma", w, h);
                        path(self, enc, (*sw, *sh), (w, h), &luma, 0)?;
                        let half = self.named("at-chroma", w.div_ceil(2), h.div_ceil(2));
                        path(self, enc, (sw.div_ceil(2), sh.div_ceil(2)), (w.div_ceil(2), h.div_ceil(2)), &half, 1)?;
                        self.combine(enc, &luma, &half, output, (9, false, 1.0), (w, h));
                    }
                }
                Op::Tint { gains } => pixel(enc, PixelParams { mode: 8, color: [gains[0], gains[1], gains[2], 1.0], ..Default::default() }),
                Op::Branch { ops, blend } => {
                    // The steps on a copy of the picture, then blended back over it (the picture is blend's top).
                    let t = self.temps(w, h, level);
                    let result = match self.run_level(enc, ops, input, [&t[0], &t[1]], 0, size, j, level + 1)? {
                        Some(s) => t[s].clone(),
                        None => input.clone(),
                    };
                    let Blend { mode, opacity, luma } = blend;
                    self.combine(enc, input, &result, output, (blend_number(mode)?, *luma, *opacity), (w, h));
                }
                Op::Average { branches } => {
                    // Each branch from the same picture, averaged pairwise in order (a chain of blend=average).
                    let t = self.temps(w, h, level);
                    let mut acc: Option<usize> = None;
                    for b in branches {
                        let result = match self.run_level(enc, b, input, [&t[0], &t[1]], 0, size, j, level + 1)? {
                            Some(s) => t[s].clone(),
                            None => input.clone(),
                        };
                        acc = Some(match acc {
                            None => {
                                self.combine(enc, &result, &result, &t[2], (0, false, 1.0), (w, h));
                                2
                            }
                            Some(a) => {
                                self.combine(enc, &t[a], &result, &t[5 - a], (2, false, 1.0), (w, h));
                                5 - a
                            }
                        });
                    }
                    let from = acc.map(|a| t[a].clone()).unwrap_or_else(|| input.clone());
                    self.combine(enc, &from, &from, output, (0, false, 1.0), (w, h));
                }
            }
            last = Some(slot);
            slot = 1 - slot;
        }
        Ok(last)
    }
}

/// The binomial coefficients of (1 + z)^n: n two-tap sums in a row, as unsharp cascades them.
pub fn binomial(n: u32) -> Vec<u64> {
    let mut row = vec![1u64];
    for _ in 0..n {
        let mut next = vec![1u64; row.len() + 1];
        for i in 1..row.len() {
            next[i] = row[i - 1] + row[i];
        }
        row = next;
    }
    row
}

/// A .cube 3D table: points (red fastest, as half-float RGBA bits), points per axis, input range.
pub struct Cube {
    pub points: Vec<u16>,
    pub size: u32,
    pub domain: [f32; 2],
}

/// Read a .cube file (Adobe/Resolve format): LUT_3D_SIZE, DOMAIN_MIN and DOMAIN_MAX (one range for
/// all three channels), then the points, red fastest.
pub fn parse_cube(text: &str) -> Result<Cube, String> {
    let (mut size, mut domain) = (0u32, [0.0f32, 1.0]);
    let mut points = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("TITLE") {
            continue;
        }
        let mut words = line.split_whitespace();
        match words.next() {
            Some("LUT_3D_SIZE") => size = words.next().and_then(|w| w.parse().ok()).ok_or("bad LUT_3D_SIZE")?,
            Some("DOMAIN_MIN") => domain[0] = words.next().and_then(|w| w.parse().ok()).ok_or("bad DOMAIN_MIN")?,
            Some("DOMAIN_MAX") => domain[1] = words.next().and_then(|w| w.parse().ok()).ok_or("bad DOMAIN_MAX")?,
            Some(first) if first.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.') => {
                let r: f32 = first.parse().map_err(|_| format!("bad point: {line}"))?;
                let g: f32 = words.next().and_then(|w| w.parse().ok()).ok_or_else(|| format!("bad point: {line}"))?;
                let b: f32 = words.next().and_then(|w| w.parse().ok()).ok_or_else(|| format!("bad point: {line}"))?;
                points.extend([half(r), half(g), half(b), half(1.0)]);
            }
            _ => {}
        }
    }
    if size < 2 || points.len() != (size * size * size * 4) as usize {
        return Err(format!("expected {size}^3 points, found {}", points.len() / 4));
    }
    Ok(Cube { points, size, domain })
}

/// An f32 as IEEE half-float bits, rounded to nearest (values past the half range become infinity).
pub fn half(v: f32) -> u16 {
    let bits = v.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exp = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mant = bits & 0x7f_ffff;
    if exp >= 31 {
        return sign | 0x7c00;
    }
    if exp <= 0 {
        if exp < -10 {
            return sign;
        }
        // Subnormal: shift the mantissa (with its hidden bit) into place, rounding to nearest.
        let m = mant | 0x80_0000;
        let shift = (14 - exp) as u32;
        let rounded = (m + (1 << (shift - 1))) >> shift;
        return sign | rounded as u16;
    }
    let rounded = ((exp as u32) << 10 | (mant >> 13)) + ((mant >> 12) & 1);
    sign | rounded as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats() {
        assert_eq!(half(0.0), 0);
        assert_eq!(half(1.0), 0x3c00);
        assert_eq!(half(-2.0), 0xc000);
        assert_eq!(half(0.5), 0x3800);
        assert_eq!(half(65504.0), 0x7bff);
        assert_eq!(half(1e6), 0x7c00);
        // 1/3 rounds to 0x3555.
        assert_eq!(half(1.0 / 3.0), 0x3555);
    }

    #[test]
    fn unsharp_kernel_is_binomial() {
        assert_eq!(binomial(0), vec![1]);
        assert_eq!(binomial(4), vec![1, 4, 6, 4, 1]);
        // 5 x 5: weights sum to 2^scalebits, scalebits (2 + 2) x 2.
        assert_eq!(binomial(4).iter().sum::<u64>().pow(2), 1 << 8);
    }

    #[test]
    fn reads_a_cube() {
        let text = "TITLE \"t\"\nLUT_3D_SIZE 2\nDOMAIN_MIN -0.25 -0.25 -0.25\nDOMAIN_MAX 1.25 1.25 1.25\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
        let c = parse_cube(text).unwrap();
        assert_eq!(c.size, 2);
        assert_eq!(c.domain, [-0.25, 1.25]);
        assert_eq!(&c.points[4..8], &[half(1.0), 0, 0, half(1.0)]);
        assert!(parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err());
    }
}
