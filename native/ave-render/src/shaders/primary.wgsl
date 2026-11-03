// The primary track's picture for one frame: the background, one clip, or two clips in a
// transition (FFmpeg xfade's fade, fadeblack and fadewhite), each with its fade to black.
// (Prefixed with yuv.wgsl.)

struct Params {
    // 0 background only, 1 clip a, 2 a transition from a to b.
    mode: u32,
    // 0 fade, 1 fadeblack, 2 fadewhite.
    kind: u32,
    // Fade-to-black factors of a and b (1 = no fade).
    fade_a: f32,
    fade_b: f32,
    // xfade's progress: 1 at the start of the transition (all a), 0 at its end.
    progress: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
    background: vec4<f32>,
}

@group(0) @binding(0) var a: texture_2d<f32>;
@group(0) @binding(1) var b: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;

// xfade's mix: m of x, 1 - m of y.
fn mixf(x: vec3<f32>, y: vec3<f32>, m: f32) -> vec3<f32> {
    return x * m + y * (1.0 - m);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var c = p.background.rgb;
    if (p.mode >= 1u) {
        let ca = textureLoad(a, id.xy, 0).rgb * p.fade_a;
        c = ca;
        if (p.mode == 2u) {
            let cb = textureLoad(b, id.xy, 0).rgb * p.fade_b;
            let t = p.progress;
            if (p.kind == 0u) {
                c = mixf(ca, cb, t);
            } else {
                // xfade's black and white are luma 0 and 255 in YUV, past video black (16) and
                // white (235), with chroma 127 (its max / 2): in RGB below 0 and above 1.
                let luma = select(0.0, 1.0, p.kind == 2u);
                let flat = vuya_to_rgb(vec4<f32>(127.0 / 255.0, 127.0 / 255.0, luma, 1.0)).rgb;
                c = mixf(mixf(ca, flat, smoothstep(0.8, 1.0, t)), mixf(flat, cb, smoothstep(0.2, 1.0, t)), t);
            }
        }
    }
    textureStore(dst, id.xy, vec4<f32>(c, 1.0));
}
