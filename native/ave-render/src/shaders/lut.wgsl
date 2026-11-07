// A color effect baked into a 64-point table (FFmpeg's Hald level 8, red fastest), applied with
// tetrahedral interpolation as FFmpeg's haldclut does. Input clipped to 0..1, as its RGB24 frames are.
// The same pass applies .cube tables (color space transforms), over their own input range.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var table: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
// The table's input range: from x to y (0 and 1 for Hald tables).
@group(0) @binding(3) var<uniform> domain: vec4<f32>;

fn at(i: vec3<u32>) -> vec3<f32> {
    return textureLoad(table, i, 0).rgb;
}

fn apply(rgb: vec3<f32>) -> vec3<f32> {
    let top = f32(textureDimensions(table).x - 1u);
    let s = clamp((rgb - domain.x) / (domain.y - domain.x), vec3<f32>(0.0), vec3<f32>(1.0)) * top;
    let lo = vec3<u32>(floor(s));
    let hi = min(lo + vec3<u32>(1u), vec3<u32>(u32(top)));
    let d = s - floor(s);
    let c000 = at(lo);
    let c111 = at(hi);
    var out: vec3<f32>;
    if (d.r > d.g) {
        if (d.g > d.b) {
            out = (1.0 - d.r) * c000 + (d.r - d.g) * at(vec3<u32>(hi.r, lo.g, lo.b)) + (d.g - d.b) * at(vec3<u32>(hi.r, hi.g, lo.b)) + d.b * c111;
        } else if (d.r > d.b) {
            out = (1.0 - d.r) * c000 + (d.r - d.b) * at(vec3<u32>(hi.r, lo.g, lo.b)) + (d.b - d.g) * at(vec3<u32>(hi.r, lo.g, hi.b)) + d.g * c111;
        } else {
            out = (1.0 - d.b) * c000 + (d.b - d.r) * at(vec3<u32>(lo.r, lo.g, hi.b)) + (d.r - d.g) * at(vec3<u32>(hi.r, lo.g, hi.b)) + d.g * c111;
        }
    } else {
        if (d.b > d.g) {
            out = (1.0 - d.b) * c000 + (d.b - d.g) * at(vec3<u32>(lo.r, lo.g, hi.b)) + (d.g - d.r) * at(vec3<u32>(lo.r, hi.g, hi.b)) + d.r * c111;
        } else if (d.b > d.r) {
            out = (1.0 - d.g) * c000 + (d.g - d.b) * at(vec3<u32>(lo.r, hi.g, lo.b)) + (d.b - d.r) * at(vec3<u32>(lo.r, hi.g, hi.b)) + d.r * c111;
        } else {
            out = (1.0 - d.g) * c000 + (d.g - d.r) * at(vec3<u32>(lo.r, hi.g, lo.b)) + (d.r - d.b) * at(vec3<u32>(hi.r, hi.g, lo.b)) + d.b * c111;
        }
    }
    return out;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let c = textureLoad(src, id.xy, 0);
    textureStore(dst, id.xy, vec4<f32>(apply(c.rgb), c.a));
}
