// FFmpeg's gblur: Alvarez and Mazorra's recursive filter (one step), run rightwards then leftwards
// along every row, then down and up every column, then scaled. FFmpeg blurs 4:2:0 YUV, so chroma
// gets the same sigma in half-size pixels: twice as wide here at full size. Values are YUV in
// 0..255 like FFmpeg's planes. (Prefixed with yuv.wgsl.)

struct Params {
    // Per channel (V, U, Y, A): the filter's nu, its boundary scale, and the final scale.
    nu: vec4<f32>,
    boundary: vec4<f32>,
    post: vec4<f32>,
    size: vec2<u32>,
    _pad: vec2<u32>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> buf: array<vec4<f32>>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;

@compute @workgroup_size(16, 16)
fn load_yuv(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.size.x || id.y >= p.size.y) {
        return;
    }
    let c = textureLoad(src, id.xy, 0);
    buf[id.y * p.size.x + id.x] = clamp(rgb_to_vuya(c), vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0;
}

@compute @workgroup_size(64)
fn rows(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.size.y) {
        return;
    }
    let w = p.size.x;
    let base = id.x * w;
    buf[base] *= p.boundary;
    for (var x = 1u; x < w; x++) {
        buf[base + x] += p.nu * buf[base + x - 1u];
    }
    buf[base + w - 1u] *= p.boundary;
    for (var x = w - 1u; x > 0u; x--) {
        buf[base + x - 1u] += p.nu * buf[base + x];
    }
}

@compute @workgroup_size(64)
fn columns(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.size.x) {
        return;
    }
    let w = p.size.x;
    let h = p.size.y;
    let col = id.x;
    buf[col] *= p.boundary;
    for (var y = 1u; y < h; y++) {
        buf[y * w + col] += p.nu * buf[(y - 1u) * w + col];
    }
    buf[(h - 1u) * w + col] *= p.boundary;
    for (var y = h - 1u; y > 0u; y--) {
        buf[(y - 1u) * w + col] += p.nu * buf[y * w + col];
    }
}

@compute @workgroup_size(16, 16)
fn store_rgb(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.size.x || id.y >= p.size.y) {
        return;
    }
    let v = clamp(buf[id.y * p.size.x + id.x] * p.post, vec4<f32>(0.0), vec4<f32>(255.0)) / 255.0;
    textureStore(dst, id.xy, vuya_to_rgb(v));
}
