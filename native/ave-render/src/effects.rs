//! Effects on a picture: the plan's operations (plan::Op) run as GPU passes, each reading the
//! previous result and writing the other texture of a pair.

use crate::gpu::{view, BlurParams, GradeParams, Gpu, PixelParams, ResampleParams, FLOAT};
use crate::plan::Op;
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
        Effects { gpu, ffmpeg: ffmpeg.to_string(), fps, tables: HashMap::new(), cubes: HashMap::new(), scratch: HashMap::new(), buffers: HashMap::new() }
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
    pub fn run(&mut self, enc: &mut wgpu::CommandEncoder, ops: &[Op], first: &wgpu::TextureView, pair: [&wgpu::TextureView; 2], mut slot: usize, size: (u32, u32), j: i64) -> Result<Option<usize>, String> {
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
                gpu.dispatch(enc, &gpu.pixel, &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(output), u.as_entire_binding()], w, h);
            };
            match op {
                Op::Grade { gains, contrast, saturation, shadows, midtones, highlights } => {
                    let v = |x: &[f32; 3]| [x[0], x[1], x[2], 0.0];
                    let u = gpu.uniform(&GradeParams { gains: v(gains), shadows: v(shadows), midtones: v(midtones), highlights: v(highlights), contrast: *contrast, saturation: *saturation, _pad: [0.0; 2] });
                    gpu.dispatch(enc, &gpu.grade, &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(output), u.as_entire_binding()], w, h);
                }
                Op::Cube { file } => {
                    let (table, domain) = self.cube(file)?;
                    let (table, du) = (view(table), gpu.uniform(&[domain[0], domain[1], 0.0f32, 0.0]));
                    gpu.dispatch(enc, &gpu.lut, &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&table), wgpu::BindingResource::TextureView(output), du.as_entire_binding()], w, h);
                }
                Op::Lut { args } => {
                    let table = view(self.table(args)?);
                    let du = gpu.uniform(&[0.0f32, 1.0, 0.0, 0.0]);
                    gpu.dispatch(enc, &gpu.lut, &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&table), wgpu::BindingResource::TextureView(output), du.as_entire_binding()], w, h);
                }
                Op::Crop { rects, filter } => {
                    let r = rects.get((j.max(0) as usize).min(rects.len().saturating_sub(1))).copied().unwrap_or([0.0, 0.0, w as f32, h as f32]);
                    if filter == "bicubic" {
                        // Whole pixels cropped, then scaled with the fit's bicubic passes.
                        let [x, y, cw, ch] = r.map(|v| v.round() as i32);
                        let (cw, ch) = (cw.max(1) as u32, ch.max(1) as u32);
                        let rows = view(self.scratch(w, h));
                        let hp = gpu.uniform(&ResampleParams { src_len: cw, scaled_len: w, offset: 0, opaque: 0, out_size: [w, ch], x_range: [0, 0], fill: [0.0; 4], origin: x, line_origin: y, yuv_in: 0, _pad: 0 });
                        gpu.dispatch(enc, &gpu.resample_h, &[wgpu::BindingResource::TextureView(input), wgpu::BindingResource::TextureView(&rows), hp.as_entire_binding()], w, ch);
                        let vp = gpu.uniform(&ResampleParams { src_len: ch, scaled_len: h, offset: 0, opaque: 0, out_size: [w, h], x_range: [0, w as i32], fill: [0.0; 4], origin: 0, line_origin: 0, yuv_in: 0, _pad: 0 });
                        gpu.dispatch(enc, &gpu.resample_v, &[wgpu::BindingResource::TextureView(&rows), wgpu::BindingResource::TextureView(output), vp.as_entire_binding()], w, h);
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
                Op::Blur { sigma } => {
                    // Chroma: the same sigma in FFmpeg's half-size chroma pixels.
                    let (ny, by, py) = gblur(*sigma);
                    let (nc, bc, pc) = gblur(*sigma * 2.0);
                    let params = gpu.uniform(&BlurParams {
                        nu: [nc, nc, ny, ny],
                        boundary: [bc, bc, by, by],
                        post: [pc * pc, pc * pc, py * py, py * py],
                        size: [w, h],
                        _pad: [0; 2],
                    });
                    let buf = self.buffer(w, h).as_entire_binding();
                    let (gx, gy) = (w.div_ceil(16), h.div_ceil(16));
                    gpu.dispatch_bound(enc, &gpu.blur_load, &[(0, wgpu::BindingResource::TextureView(input)), (1, buf.clone()), (3, params.as_entire_binding())], gx, gy);
                    gpu.dispatch_bound(enc, &gpu.blur_rows, &[(1, buf.clone()), (3, params.as_entire_binding())], h.div_ceil(64), 1);
                    gpu.dispatch_bound(enc, &gpu.blur_columns, &[(1, buf.clone()), (3, params.as_entire_binding())], w.div_ceil(64), 1);
                    gpu.dispatch_bound(enc, &gpu.blur_store, &[(1, buf), (2, wgpu::BindingResource::TextureView(output)), (3, params.as_entire_binding())], gx, gy);
                }
            }
            last = Some(slot);
            slot = 1 - slot;
        }
        Ok(last)
    }
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
    fn reads_a_cube() {
        let text = "TITLE \"t\"\nLUT_3D_SIZE 2\nDOMAIN_MIN -0.25 -0.25 -0.25\nDOMAIN_MAX 1.25 1.25 1.25\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
        let c = parse_cube(text).unwrap();
        assert_eq!(c.size, 2);
        assert_eq!(c.domain, [-0.25, 1.25]);
        assert_eq!(&c.points[4..8], &[half(1.0), 0, 0, half(1.0)]);
        assert!(parse_cube("LUT_3D_SIZE 2\n0 0 0\n").is_err());
    }
}
