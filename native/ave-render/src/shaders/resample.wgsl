// Fit a picture to an item image in two separable passes, horizontal then vertical, with
// swscale's default bicubic (B = 0, C = 0.6), widened by the scale factor when shrinking, as the
// FFmpeg backend's scale filter does. Decoded sources are VUYA: scaled and clamped in YUV like the
// backend's, then turned into float RGB. The same passes scale a cropped part of a float picture
// (the zoom effect's crop and scale). (Prefixed with yuv.wgsl.)

struct Params {
    // Source size along the pass (width for the horizontal pass, height for the vertical one).
    src_len: u32,
    // Scaled size along the pass, and where the scaled picture starts in the item image.
    scaled_len: u32,
    offset: i32,
    // Vertical pass: 1 drops the source's alpha.
    opaque: u32,
    // Output size.
    out_size: vec2<u32>,
    // Vertical pass: the scaled picture's horizontal extent in the item image.
    x_range: vec2<i32>,
    fill: vec4<f32>,
    // Horizontal pass: the source part read starts at column `origin` and row `line_origin`.
    origin: i32,
    line_origin: i32,
    // Vertical pass: 1 when the source is VUYA, to be turned into RGB.
    yuv_in: u32,
    _pad: u32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

fn bicubic(d: f32) -> f32 {
    let x = abs(d);
    if (x < 1.0) {
        return (1.4 * x - 2.4) * x * x + 1.0;
    }
    if (x < 2.0) {
        return ((-0.6 * x + 3.0) * x - 4.8) * x + 2.4;
    }
    return 0.0;
}

// The value at scaled position `u` along the pass, from the line `line` of the source.
fn sample(u: i32, line: u32, horizontal: bool) -> vec4<f32> {
    let scale = f32(p.src_len) / f32(p.scaled_len);
    let widen = max(scale, 1.0);
    let s = (f32(u) + 0.5) * scale - 0.5;
    let lo = i32(floor(s - 2.0 * widen)) + 1;
    let hi = i32(floor(s + 2.0 * widen));
    var acc = vec4<f32>(0.0);
    var total = 0.0;
    for (var i = lo; i <= hi; i++) {
        let w = bicubic((f32(i) - s) / widen);
        let at = u32(p.origin + clamp(i, 0, i32(p.src_len) - 1));
        var c: vec4<f32>;
        if (horizontal) {
            c = textureLoad(src, vec2<u32>(at, u32(i32(line) + p.line_origin)), 0);
        } else {
            c = textureLoad(src, vec2<u32>(line, at), 0);
        }
        acc += w * c;
        total += w;
    }
    return acc / total;
}

@compute @workgroup_size(16, 16)
fn horizontal(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.out_size.x || id.y >= p.out_size.y) {
        return;
    }
    let u = i32(id.x) - p.offset;
    var c = vec4<f32>(0.0);
    if (u >= 0 && u < i32(p.scaled_len)) {
        c = sample(u, id.y, true);
    }
    textureStore(dst, id.xy, c);
}

@compute @workgroup_size(16, 16)
fn vertical(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.out_size.x || id.y >= p.out_size.y) {
        return;
    }
    let v = i32(id.y) - p.offset;
    let x = i32(id.x);
    var c = p.fill;
    if (v >= 0 && v < i32(p.scaled_len) && x >= p.x_range.x && x < p.x_range.y) {
        c = clamp(sample(v, id.x, false), vec4<f32>(0.0), vec4<f32>(1.0));
        if (p.yuv_in == 1u) {
            c = vuya_to_rgb(c);
        }
        if (p.opaque == 1u) {
            c.a = 1.0;
        }
    }
    textureStore(dst, id.xy, c);
}
