// FFmpeg's convolution filter: a square kernel (`size` x `size`, at most 7 x 7) times rdiv plus
// bias, on each YUV plane as 8-bit values (or on R, G and B), edges repeated. (Prefixed with yuv.wgsl.)

struct Params {
    size: u32,
    rgb: u32,
    rdiv: f32,
    bias: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var<storage, read> kernel: array<f32>;

fn sample(x: i32, y: i32) -> vec4<f32> {
    let s = vec2<i32>(textureDimensions(src));
    let c = textureLoad(src, vec2<i32>(clamp(x, 0, s.x - 1), clamp(y, 0, s.y - 1)), 0);
    if (p.rgb == 1u) {
        return round(clamp(c, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0);
    }
    return round(clamp(rgb_to_vuya(c), vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let r = i32(p.size / 2u);
    var sum = vec4<f32>(0.0);
    for (var j = 0; j < i32(p.size); j++) {
        for (var i = 0; i < i32(p.size); i++) {
            sum += kernel[u32(j) * p.size + u32(i)] * sample(i32(id.x) + i - r, i32(id.y) + j - r);
        }
    }
    // convolution's 8-bit result: sum x rdiv + bias, rounded to nearest and clipped.
    let v = clamp(round(sum * p.rdiv + p.bias), vec4<f32>(0.0), vec4<f32>(255.0)) / 255.0;
    let a = textureLoad(src, id.xy, 0).a;
    if (p.rgb == 1u) {
        textureStore(dst, id.xy, vec4<f32>(v.rgb, a));
    } else {
        textureStore(dst, id.xy, vec4<f32>(vuya_to_rgb(vec4<f32>(v.xyz, 1.0)).rgb, a));
    }
}
