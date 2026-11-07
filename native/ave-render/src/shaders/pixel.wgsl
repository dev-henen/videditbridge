// Effects that read a few pixels of one picture, each following its FFmpeg filter: a moving crop
// sampled between pixels (perspective, as the motion effects use it), vignette, letterbox bars,
// fades toward a color, channel shifts (rgbashift) and noise. (Prefixed with yuv.wgsl.)

struct Params {
    // 0 crop, 1 vignette, 2 bars, 3 fade, 4 shift, 5 noise, 6 eq, 7 rounded corners (radius in `bar`).
    mode: u32,
    backward: u32,
    // shift: [across, down] per channel.
    shift_red: vec2<i32>,
    shift_green: vec2<i32>,
    shift_blue: vec2<i32>,
    // crop: x, y, width, height of the part shown; eq: brightness, contrast, saturation, gamma.
    rect: vec4<f32>,
    // fade: the color faded toward.
    color: vec4<f32>,
    // vignette: angle in radians; eq: gamma weight; fade: how much of the picture shows (1 = all). backward: vignette
    // brightens the edges; noise goes on R, G and B instead of the YUV planes.
    angle: f32,
    factor: f32,
    bar: u32,
    // noise: the frame (noise changes every frame), its strength in levels, uniform or gaussian.
    frame: u32,
    strength: f32,
    uniform: u32,
    _pad: vec2<u32>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: Params;

// The PCG hash of one 32-bit value.
fn pcg(n: u32) -> u32 {
    let state = n * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// A random number in 0..1 from a position, frame and plane, each input through its own round of
// the hash so that planes and neighbors are independent.
fn random(x: u32, y: u32, frame: u32, plane: u32) -> f32 {
    let v = pcg(x ^ pcg(y ^ pcg(frame ^ pcg(plane))));
    return (f32(v) + 0.5) / 4294967296.0;
}

// FFmpeg's noise value: uniform over `strength` levels, or gaussian with deviation strength / sqrt(3).
fn noise(x: u32, y: u32, plane: u32) -> f32 {
    let a = random(x, y, p.frame, plane);
    if (p.uniform == 1u) {
        return (a - 0.5) * p.strength;
    }
    let b = random(x, y, p.frame, plane + 8u);
    return sqrt(-2.0 * log(a)) * cos(6.2831853 * b) * p.strength / sqrt(3.0);
}

// One plane through FFmpeg's eq: an 8-bit value, its contrast, brightness, gamma and gamma weight.
// Without gamma it uses eq's fixed-point process_c, with gamma its lookup table (create_lut).
fn eq_plane(v: f32, contrast: f32, brightness: f32, gamma: f32, weight: f32) -> f32 {
    let src = i32(round(clamp(v, 0.0, 255.0)));
    if (contrast == 1.0 && brightness == 0.0 && gamma == 1.0) {
        return f32(src);
    }
    if (gamma == 1.0 && abs(contrast) < 7.9) {
        let c = i32(contrast * 4096.0);
        let b = (i32(100.0 * brightness + 100.0) * 511) / 200 - 128 - c / 32;
        return f32(clamp(((src * c) >> 12u) + b, 0, 255));
    }
    var x = contrast * (f32(src) / 255.0 - 0.5) + 0.5 + brightness;
    if (x <= 0.0) {
        return 0.0;
    }
    x = x * (1.0 - weight) + pow(x, 1.0 / gamma) * weight;
    return select(floor(256.0 * x), 255.0, x >= 1.0);
}

fn load(x: i32, y: i32) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(src));
    return textureLoad(src, vec2<i32>(clamp(x, 0, size.x - 1), clamp(y, 0, size.y - 1)), 0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let x = i32(id.x);
    let y = i32(id.y);
    var c = load(x, y);
    switch p.mode {
        case 0u: {
            // perspective with corners on a rectangle: each output pixel maps linearly into it.
            let u = p.rect.x + f32(x) * p.rect.z / f32(size.x);
            let v = p.rect.y + f32(y) * p.rect.w / f32(size.y);
            let i = vec2<i32>(floor(vec2<f32>(u, v)));
            let f = vec2<f32>(u, v) - floor(vec2<f32>(u, v));
            let top = mix(load(i.x, i.y), load(i.x + 1, i.y), f.x);
            let bottom = mix(load(i.x, i.y + 1), load(i.x + 1, i.y + 1), f.x);
            c = mix(top, bottom, f.y);
        }
        case 1u: {
            // FFmpeg's vignette: cos(angle * distance)^4 from the center, distances truncated to
            // whole pixels, applied in YUV (luma scaled, chroma pulled toward 127).
            let center = vec2<f32>(size) / 2.0;
            let d = length(vec2<f32>(vec2<i32>(vec2<f32>(f32(x), f32(y)) - center))) / length(center);
            var k = 0.0;
            if (d <= 1.0) {
                let cs = cos(p.angle * d);
                k = cs * cs * cs * cs;
            }
            if (p.backward == 1u) {
                k = 1.0 / max(k, 1e-6);
            }
            let yuv = rgb_to_vuya(c);
            let mid = 127.0 / 255.0;
            let out = vec4<f32>((yuv.x - mid) * k + mid, (yuv.y - mid) * k + mid, yuv.z * k, yuv.w);
            c = vuya_to_rgb(clamp(out, vec4<f32>(0.0), vec4<f32>(1.0)));
        }
        case 2u: {
            if (id.y < p.bar || id.y >= size.y - p.bar) {
                c = vec4<f32>(0.0, 0.0, 0.0, c.a);
            }
        }
        case 3u: {
            c = vec4<f32>(c.rgb * p.factor + p.color.rgb * (1.0 - p.factor), c.a);
        }
        case 4u: {
            c = vec4<f32>(load(x - p.shift_red.x, y - p.shift_red.y).r, load(x - p.shift_green.x, y - p.shift_green.y).g, load(x - p.shift_blue.x, y - p.shift_blue.y).b, c.a);
        }
        case 7u: {
            // compile.ts's rounded corners: alpha cleared outside a rounded rectangle, a hard edge.
            let r = i32(p.bar);
            let dx = max(r - x, x - (i32(size.x) - 1 - r));
            let dy = max(r - y, y - (i32(size.y) - 1 - r));
            if (length(vec2<f32>(f32(max(dx, 0)), f32(max(dy, 0)))) > f32(r)) {
                c = vec4<f32>(c.rgb, 0.0);
            }
        }
        case 6u: {
            // eq on the YUV planes: luma by contrast, brightness and gamma, chroma by saturation.
            let yuv = rgb_to_vuya(c) * 255.0;
            let s = clamp(p.rect.z, 0.0, 3.0);
            let out = vec4<f32>(eq_plane(yuv.x, s, 0.0, 1.0, 1.0), eq_plane(yuv.y, s, 0.0, 1.0, 1.0), eq_plane(yuv.z, p.rect.y, p.rect.x, p.rect.w, p.angle), yuv.w);
            c = vuya_to_rgb(out / 255.0);
        }
        default: {
            let ux = u32(x);
            let uy = u32(y);
            if (p.backward == 1u) {
                let n = vec3<f32>(noise(ux, uy, 0u), noise(ux, uy, 1u), noise(ux, uy, 2u)) / 255.0;
                c = vec4<f32>(clamp(c.rgb + n, vec3<f32>(0.0), vec3<f32>(1.0)), c.a);
                textureStore(dst, id.xy, c);
                return;
            }
            // Every plane gets its own noise; 4:2:0 chroma shares one value per 2 x 2 block.
            let n = vec4<f32>(noise(ux / 2u, uy / 2u, 2u), noise(ux / 2u, uy / 2u, 1u), noise(ux, uy, 0u), 0.0) / 255.0;
            c = vuya_to_rgb(clamp(rgb_to_vuya(c) + n, vec4<f32>(0.0), vec4<f32>(1.0)));
        }
    }
    textureStore(dst, id.xy, c);
}
