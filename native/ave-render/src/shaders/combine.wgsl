// Two pictures into one, as FFmpeg's blend filter does it: `top` is blend's first input, `bottom`
// its second, and the result is top + (mode(top, bottom) - top) x opacity, with blend's formulas
// (libavfilter/blend_modes.c) on values over 0..1 in RGB (16-bit and float blends, where integer
// rounding does not show), or on the 8-bit luma plane alone (`luma`), with its integer math.
// Alpha comes from top. Mode 0 copies bottom (a branch's result kept for later). (Prefixed with yuv.wgsl.)

struct Params {
    // 0 copy, 1 addition, 2 average, 3 screen, 4 softlight, 5 multiply, 6 `color` laid over top
    // with bottom's red x opacity as its alpha (alphamerge and overlay of a solid color), 9 luma
    // from top and chroma from bottom, a half-size picture (4:2:0 planes joined), 10 a mix sum: top x
    // opacity plus bottom as 8-bit V, U, Y and A values (top holds sums, not colors), 11 a mix
    // result: top (sums) x opacity rounded to nearest (lrintf) and clipped, as 8-bit VUYA.
    mode: u32,
    // 1: blend luma only (Y on the 8-bit scale), chroma from top.
    luma: u32,
    opacity: f32,
    _pad: f32,
    color: vec4<f32>,
}

@group(0) @binding(0) var top: texture_2d<f32>;
@group(0) @binding(1) var bottom: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;

fn mode_float(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    switch p.mode {
        case 1u: { return min(vec3<f32>(1.0), a + b); }
        case 2u: { return (a + b) / 2.0; }
        case 3u: { return 1.0 - (1.0 - a) * (1.0 - b); }
        case 4u: { return clamp(a * a + 2.0 * (b * (a * (1.0 - a))), vec3<f32>(0.0), vec3<f32>(1.0)); }
        case 5u: { return a * b; }
        default: { return b; }
    }
}

// blend's 8-bit integer formulas on one plane (A and B whole numbers 0..255).
fn mode_int(a: i32, b: i32) -> i32 {
    switch p.mode {
        case 1u: { return min(255, a + b); }
        case 2u: { return (a + b) / 2; }
        case 3u: { return 255 - ((255 - a) * (255 - b) / 255); }
        case 4u: { return clamp(a * a / 255 + (2 * (b * ((a * (255 - a)) / 255) / 255)), 0, 255); }
        case 5u: { return a * b / 255; }
        default: { return b; }
    }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let a = textureLoad(top, id.xy, 0);
    let b = textureLoad(bottom, id.xy, 0);
    if (p.mode == 0u) {
        textureStore(dst, id.xy, b);
        return;
    }
    if (p.mode == 10u) {
        textureStore(dst, id.xy, a * p.opacity + round(clamp(rgb_to_vuya(b), vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0));
        return;
    }
    if (p.mode == 11u) {
        let v = clamp(round(a * p.opacity), vec4<f32>(0.0), vec4<f32>(255.0)) / 255.0;
        textureStore(dst, id.xy, vuya_to_rgb(v));
        return;
    }
    if (p.mode == 9u) {
        // Luma from top, chroma from bottom at half size (each chroma sample on its 2 x 2 block).
        let yb = rgb_to_vuya(textureLoad(bottom, id.xy / 2u, 0));
        let ya = rgb_to_vuya(a);
        textureStore(dst, id.xy, vec4<f32>(vuya_to_rgb(vec4<f32>(yb.x, yb.y, ya.z, 1.0)).rgb, a.a));
        return;
    }
    if (p.mode == 6u) {
        let alpha = clamp(b.r, 0.0, 1.0) * p.opacity;
        textureStore(dst, id.xy, vec4<f32>(a.rgb * (1.0 - alpha) + p.color.rgb * alpha, a.a));
        return;
    }
    if (p.luma == 1u) {
        let ya = rgb_to_vuya(a);
        let yb = rgb_to_vuya(b);
        let A = i32(round(clamp(ya.z, 0.0, 1.0) * 255.0));
        let B = i32(round(clamp(yb.z, 0.0, 1.0) * 255.0));
        // blend stores top + (mode - top) x opacity in a float, truncated into the 8-bit plane.
        let y = floor(f32(A) + f32(mode_int(A, B) - A) * p.opacity);
        textureStore(dst, id.xy, vec4<f32>(vuya_to_rgb(vec4<f32>(ya.x, ya.y, y / 255.0, 1.0)).rgb, a.a));
        return;
    }
    let ca = clamp(a.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    let cb = clamp(b.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(dst, id.xy, vec4<f32>(ca + (mode_float(ca, cb) - ca) * p.opacity, a.a));
}
