// The color panel's primaries graded in ACEScct, for footage in a color space, between the camera
// half and the output half of its transform (engine/library/color/grade.ts: gradeAcescct, which
// this follows step for step; gradeConstants works out the numbers). Pixels hold ACEScct values.

struct Params {
    // Linear gains per channel: white balance times exposure.
    gains: vec4<f32>,
    // ACEScct offsets of the shadows, midtones and highlights wheels.
    shadows: vec4<f32>,
    midtones: vec4<f32>,
    highlights: vec4<f32>,
    // Contrast around 18% gray (in ACEScct) and saturation around luminance.
    contrast: f32,
    saturation: f32,
    _pad: vec2<f32>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

// ACEScct of 18% gray, and ACEScg's luminance weights.
const PIVOT: f32 = 0.4135884;
const AP1_Y: vec3<f32> = vec3<f32>(0.2722287168, 0.6740817658, 0.0536895174);

fn to_linear(c: f32) -> f32 {
    if (c <= 0.155251141552511) {
        return (c - 0.0729055341958355) / 10.5402377416545;
    }
    return min(65504.0, exp2(c * 17.52 - 9.72));
}

fn from_linear(x: f32) -> f32 {
    if (x <= 0.0078125) {
        return 10.5402377416545 * x + 0.0729055341958355;
    }
    return (log2(x) + 9.72) / 17.52;
}

fn contrast(x: f32) -> f32 {
    return to_linear(PIVOT + (from_linear(x) - PIVOT) * p.contrast);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let c = textureLoad(src, id.xy, 0);
    var lin = vec3<f32>(to_linear(c.r), to_linear(c.g), to_linear(c.b)) * p.gains.xyz;
    lin = vec3<f32>(contrast(lin.r), contrast(lin.g), contrast(lin.b));
    let lum = dot(AP1_Y, lin);
    lin = vec3<f32>(lum) + (lin - vec3<f32>(lum)) * p.saturation;
    var out = vec3<f32>(from_linear(lin.r), from_linear(lin.g), from_linear(lin.b));
    let zone = from_linear(max(dot(AP1_Y, lin), 0.0));
    let shadows = 1.0 - smoothstep(0.15, PIVOT, zone);
    let highlights = smoothstep(PIVOT, 0.65, zone);
    let midtones = max(0.0, 1.0 - shadows - highlights);
    out += shadows * p.shadows.xyz + midtones * p.midtones.xyz + highlights * p.highlights.xyz;
    textureStore(dst, id.xy, vec4<f32>(out, c.a));
}
