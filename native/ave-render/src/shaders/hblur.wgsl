// Running sums along every row of the two clips of an hblur transition (xfade's motion blur):
// with them, primary.wgsl averages any window of a row in two reads. Row y holds width + 1 sums
// per clip, sums[(y * (width + 1) + x) * 2 + clip] = the sum of the row's first x pixels.

struct Params {
    fade_a: f32,
    fade_b: f32,
    width: u32,
    height: u32,
}

@group(0) @binding(0) var a: texture_2d<f32>;
@group(0) @binding(1) var b: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> sums: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> p: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let y = id.x;
    if (y >= p.height) {
        return;
    }
    let base = y * (p.width + 1u) * 2u;
    var sa = vec4<f32>(0.0);
    var sb = vec4<f32>(0.0);
    sums[base] = sa;
    sums[base + 1u] = sb;
    for (var x = 0u; x < p.width; x++) {
        sa += vec4<f32>(textureLoad(a, vec2<u32>(x, y), 0).rgb * p.fade_a, 0.0);
        sb += vec4<f32>(textureLoad(b, vec2<u32>(x, y), 0).rgb * p.fade_b, 0.0);
        sums[base + (x + 1u) * 2u] = sa;
        sums[base + (x + 1u) * 2u + 1u] = sb;
    }
}
