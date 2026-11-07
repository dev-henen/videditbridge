// The small gray light canvas of lightLeak and bokehLights (helpers.ts lightCanvas), drawn as the
// FFmpeg backend draws it: values 0..1 (gray 0..255) in red, green and blue.
//
// - mode 0, lightLeak: two soft blobs moving over the canvas, its geq expression with X and Y in
//   canvas pixels and T the frame's time, truncated to 8 bits as geq stores it.
// - mode 1, bokehLights: soft discs (64 px sprites of clip((32 - r) / 9), scaled to their size)
//   put on black one after another with their own alpha (disc x a factor), at whole positions
//   kept even, as overlay places them on a 4:2:0 canvas.

struct Params {
    mode: u32,
    count: u32,
    t: f32,
    _pad: f32,
    // lightLeak: the speeds s, 0.7 s, 0.8 s, 0.6 s (each rounded as the expression has them), and 1.7 s.
    speeds: vec4<f32>,
    speed5: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32,
}

@group(0) @binding(0) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> p: Params;
// bokehLights: per orb its left, top, size (2R) and alpha factor, for this frame.
@group(0) @binding(2) var<storage, read> orbs: array<vec4<f32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let X = f32(id.x);
    let Y = f32(id.y);
    let W = f32(size.x);
    let H = f32(size.y);
    var v = 0.0;
    if (p.mode == 0u) {
        let T = p.t;
        let r = 0.32 * max(W, H);
        let s = p.speeds;
        let b1 = exp(-(pow(X - W * (0.0 + 0.25 * sin(T * s.x)), 2.0) + pow(Y - H * (0.15 + 0.25 * cos(T * s.y)), 2.0)) / pow(r, 2.0));
        let b2 = exp(-(pow(X - W * (1.0 - 0.25 * sin(T * s.z + 1.0)), 2.0) + pow(Y - H * (0.85 - 0.2 * sin(T * s.w + 2.0)), 2.0)) / pow(r, 2.0));
        v = floor(255.0 * min(1.0, (b1 + 0.8 * b2) * (0.75 + 0.25 * sin(T * p.speed5)))) / 255.0;
    } else {
        for (var i = 0u; i < p.count; i++) {
            let o = orbs[i];
            let k = 64.0 / o.z;
            // The sprite pixel this canvas pixel shows, in the 64 px disc's coordinates.
            let u = (X - o.x + 0.5) * k - 0.5;
            let w = (Y - o.y + 0.5) * k - 0.5;
            if (X < o.x || Y < o.y || X >= o.x + o.z || Y >= o.y + o.z) {
                continue;
            }
            let d = clamp((32.0 - length(vec2<f32>(u - 31.5, w - 31.5))) / 9.0, 0.0, 1.0);
            let a = d * o.w;
            v = v * (1.0 - a) + d * a;
        }
    }
    textureStore(dst, id.xy, vec4<f32>(v, v, v, 1.0));
}
