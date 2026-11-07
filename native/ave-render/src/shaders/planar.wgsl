// A planar 4:2:0 source fitted plane by plane (luma at full size, chroma at half size, as FFmpeg's
// scale does), joined into float RGB: each chroma sample covers its 2 x 2 block of luma. Luma
// holds Y in red and, for sources with alpha, A in green. (Prefixed with yuv.wgsl.)

struct Params {
    // 1 drops the source's alpha (clips on the primary track).
    opaque: u32,
    // 1 when the luma image holds alpha in green; otherwise its own alpha (1 inside the picture,
    // the fill's outside) is used.
    alpha: u32,
    // 1 keeps Y, U and V (in red, green and blue) instead of turning them into RGB.
    yuv_out: u32,
    _pad: u32,
}

@group(0) @binding(0) var luma: texture_2d<f32>;
@group(0) @binding(1) var chroma: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let l = textureLoad(luma, id.xy, 0);
    let c = textureLoad(chroma, id.xy / 2u, 0);
    // Luma's own alpha is 1 inside the picture and the fill's outside, so an opaque clip keeps a
    // transparent fill around a contained picture (fit blur shows its backdrop there).
    var a = l.a;
    if (p.alpha == 1u && p.opaque == 0u) {
        a = l.g;
    }
    if (p.yuv_out == 1u) {
        textureStore(dst, id.xy, vec4<f32>(l.r, c.r, c.g, a));
        return;
    }
    textureStore(dst, id.xy, vuya_to_rgb(vec4<f32>(c.g, c.r, l.r, a)));
}
