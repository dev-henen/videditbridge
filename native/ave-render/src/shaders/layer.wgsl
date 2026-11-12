// One media layer over the picture: the layer image placed at `pos`, mixed by its alpha times
// `opacity`, blended with the modes of FFmpeg's blend filter (the picture is its first input).

struct Params {
    pos: vec2<i32>,
    size: vec2<u32>,
    blend: u32,
    opacity: f32,
    _pad0: f32,
    _pad1: f32,
}

@group(0) @binding(0) var under: texture_2d<f32>;
@group(0) @binding(1) var layer: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;

fn blend(a: vec3<f32>, b: vec3<f32>, mode: u32) -> vec3<f32> {
    switch mode {
        case 1u: { return 1.0 - (1.0 - a) * (1.0 - b); }
        case 2u: { return min(vec3<f32>(1.0), a + b); }
        case 3u: { return a * b; }
        case 4u: { return select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, a < vec3<f32>(128.0 / 255.0)); }
        case 5u: { return clamp(a * a + 2.0 * b * a * (1.0 - a), vec3<f32>(0.0), vec3<f32>(1.0)); }
        case 6u: { return max(a, b); }
        case 7u: { return min(a, b); }
        // Color dodge: the picture over one minus the layer (FFmpeg's dodge with the layer as its first input, compile.ts).
        case 8u: { return select(min(vec3<f32>(1.0), a * (256.0 / 255.0) / max(1.0 - b, vec3<f32>(1e-6))), b, b >= vec3<f32>(1.0)); }
        case 9u: { return abs(a - b); }
        // addlight and screenlight: through display gamma 2.4 to linear light and back (compile.ts LIGHT_BLENDS).
        case 10u: { return pow(min(vec3<f32>(1.0), pow(a, vec3<f32>(2.4)) + pow(b, vec3<f32>(2.4))), vec3<f32>(1.0 / 2.4)); }
        case 11u: { return pow(1.0 - (1.0 - pow(a, vec3<f32>(2.4))) * (1.0 - pow(b, vec3<f32>(2.4))), vec3<f32>(1.0 / 2.4)); }
        default: { return b; }
    }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var c = textureLoad(under, id.xy, 0);
    let local = vec2<i32>(id.xy) - p.pos;
    if (local.x >= 0 && local.y >= 0 && u32(local.x) < p.size.x && u32(local.y) < p.size.y) {
        let l = textureLoad(layer, vec2<u32>(local), 0);
        let alpha = l.a * p.opacity;
        // Normal layers mix in YUV in the backend, unclamped; blend modes run on RGB clipped to 0..1.
        var top = l.rgb;
        if (p.blend != 0u) {
            top = blend(clamp(c.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(l.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), p.blend);
        }
        c = vec4<f32>(mix(c.rgb, top, alpha), 1.0);
    }
    textureStore(dst, id.xy, c);
}
