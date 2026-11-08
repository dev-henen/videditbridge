// Effects that read a few pixels of one picture, each following its FFmpeg filter: a moving crop
// sampled between pixels (perspective, as the motion effects use it), vignette, letterbox bars,
// fades toward a color, channel shifts (rgbashift) and noise. (Prefixed with yuv.wgsl.)

struct Params {
    // 0 crop, 1 vignette, 2 bars, 3 fade, 4 shift, 5 noise, 6 eq, 7 rounded corners (radius in `bar`), 8 tint (gains in `color`), 9 lens (k1, k2 in `rect`), 10 warp (map in `rect` and `color`, cubic in `uniform`), 11 camera move window (x, y, angle in `rect`, rotate in `uniform`), 12 flip, 13 grid, 14 dilation, 15 area down, 16 nearest.
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

// perspective's cubic weights for a sub-pixel position of `sub` / 256: get_coeff (A = -0.6) at the
// four taps, normalized to 2048 and rounded, as its table holds them.
fn cubic_coeff(d0: f32) -> f32 {
    let a = -0.6;
    let d = abs(d0);
    if (d < 1.0) {
        return 1.0 - (a + 3.0) * d * d + (a + 2.0) * d * d * d;
    }
    if (d < 2.0) {
        return -4.0 * a + 8.0 * a * d - 5.0 * a * d * d + a * d * d * d;
    }
    return 0.0;
}

fn cubic_weights(sub: i32) -> array<i32, 4> {
    let d = f32(sub) / 256.0;
    var t: array<f32, 4>;
    var sum = 0.0;
    for (var j = 0; j < 4; j++) {
        t[j] = cubic_coeff(f32(j) - d - 1.0);
        sum += t[j];
    }
    var out: array<i32, 4>;
    for (var j = 0; j < 4; j++) {
        out[j] = i32(round(2048.0 * t[j] / sum));
    }
    return out;
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

// lenscorrection's bilinear read at the radius scaled by `mult` (see the lens mode), with black
// (0 on every RGB plane) outside: for the per-channel lens, each channel takes its own component.
fn lens_rgb(center: vec2<i32>, off: vec2<f32>, mult: f32, w: i32, h: i32) -> vec4<f32> {
    let pos = vec2<f32>(center) + off * mult + 0.5;
    let i = vec2<i32>(floor(pos));
    if (i.x < 0 || i.x > w - 1 || i.y < 0 || i.y > h - 1) {
        return vec4<f32>(0.0);
    }
    let f = pos - floor(pos);
    let n = min(i + 1, vec2<i32>(w - 1, h - 1));
    let top = mix(load(i.x, i.y), load(n.x, i.y), f.x);
    let bottom = mix(load(i.x, n.y), load(n.x, n.y), f.x);
    return mix(top, bottom, f.y);
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
        case 9u: {
            // lenscorrection: the radius scaled by 1 + k1 r^2 + k2 r^4 (r^2 against the diagonal,
            // 4 (dx^2 + dy^2) / (w^2 + h^2)), about a whole-pixel center. Its fixed-point bilinear
            // reads half a pixel past the point; what falls outside is black.
            let w = i32(size.x);
            let h = i32(size.y);
            let center = vec2<i32>(w / 2, h / 2);
            let off = vec2<f32>(vec2<i32>(x, y) - center);
            let r2 = 4.0 * dot(off, off) / f32(w * w + h * h);
            if (p.uniform == 1u) {
                // Each RGB plane on its own (8-bit gbrp planes), k1 per channel in `color`, black
                // (0) outside per plane.
                let red = lens_rgb(center, off, 1.0 + p.color.x * r2, w, h).r;
                let green = lens_rgb(center, off, 1.0 + p.color.y * r2, w, h).g;
                let blue = lens_rgb(center, off, 1.0 + p.color.z * r2, w, h).b;
                c = vec4<f32>(red, green, blue, c.a);
            } else {
                let mult = 1.0 + p.rect.x * r2 + p.rect.y * r2 * r2;
                let pos = vec2<f32>(center) + off * mult + 0.5;
                let i = vec2<i32>(floor(pos));
                if (i.x < 0 || i.x > w - 1 || i.y < 0 || i.y > h - 1) {
                    c = vuya_to_rgb(vec4<f32>(128.0 / 255.0, 128.0 / 255.0, 16.0 / 255.0, c.a));
                } else {
                    let f = pos - floor(pos);
                    let n = min(i + 1, vec2<i32>(w - 1, h - 1));
                    let top = mix(load(i.x, i.y), load(n.x, i.y), f.x);
                    let bottom = mix(load(i.x, n.y), load(n.x, n.y), f.x);
                    c = vec4<f32>(mix(top, bottom, f.y).rgb, c.a);
                }
            }
        }
        case 10u: {
            // perspective (sense=source): the source point in 1/256 pixels, then its cubic with
            // 11-bit weights (A = -0.6) on 8-bit YUV values, or linear in 1/256 steps.
            let fx = f32(x);
            let fy = f32(y);
            let d = p.color.z * fx + p.color.w * fy + 1.0;
            let u = i32(round(256.0 * (p.rect.x * fx + p.rect.y * fy + p.rect.z) / d));
            let v = i32(round(256.0 * (p.rect.w * fx + p.color.x * fy + p.color.y) / d));
            let su = u & 255;
            let sv = v & 255;
            let iu = u >> 8u;
            let iv = v >> 8u;
            if (p.uniform == 1u) {
                let cu = cubic_weights(su);
                let cv = cubic_weights(sv);
                var sum = vec4<i32>(0);
                for (var dy = 0; dy < 4; dy++) {
                    for (var dx = 0; dx < 4; dx++) {
                        let s = vec4<i32>(round(clamp(rgb_to_vuya(load(iu + dx - 1, iv + dy - 1)), vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0));
                        sum += cu[dx] * cv[dy] * s;
                    }
                }
                let o = clamp((sum + vec4<i32>(1 << 21)) >> vec4<u32>(22u), vec4<i32>(0), vec4<i32>(255));
                c = vec4<f32>(vuya_to_rgb(vec4<f32>(o) / 255.0).rgb, c.a);
            } else {
                let f = vec2<f32>(f32(su), f32(sv)) / 256.0;
                let top = mix(load(iu, iv), load(iu + 1, iv), f.x);
                let bottom = mix(load(iu, iv + 1), load(iu + 1, iv + 1), f.x);
                c = vec4<f32>(mix(top, bottom, f.y).rgb, c.a);
            }
        }
        case 11u: {
            // A camera move's window: (x, y) of the scaled picture (the source here), turned by
            // the angle about the picture's center first as FFmpeg's rotate turns it: bilinear,
            // and black where the turned point falls outside.
            let S = vec2<i32>(textureDimensions(src));
            var q = vec2<f32>(f32(x) + p.rect.x, f32(y) + p.rect.y);
            if (p.uniform == 1u) {
                let half = (vec2<f32>(S) - 1.0) / 2.0;
                let d = q - half;
                let cs = cos(p.rect.z);
                let sn = sin(p.rect.z);
                q = vec2<f32>(d.x * cs + d.y * sn, -d.x * sn + d.y * cs) + half;
                let i = vec2<i32>(floor(q));
                if (i.x < -1 || i.x > S.x || i.y < -1 || i.y > S.y) {
                    c = vuya_to_rgb(vec4<f32>(128.0 / 255.0, 128.0 / 255.0, 16.0 / 255.0, c.a));
                } else {
                    let f = q - floor(q);
                    let a0 = clamp(i, vec2<i32>(0), S - 1);
                    let a1 = min(a0 + 1, S - 1);
                    let top = mix(load(a0.x, a0.y), load(a1.x, a0.y), f.x);
                    let bottom = mix(load(a0.x, a1.y), load(a1.x, a1.y), f.x);
                    c = vec4<f32>(mix(top, bottom, f.y).rgb, c.a);
                }
            } else {
                c = vec4<f32>(load(i32(q.x), i32(q.y)).rgb, c.a);
            }
        }
        case 12u: {
            // hflip (`backward` 0) or vflip (1).
            let s = vec2<i32>(textureDimensions(src));
            c = select(load(s.x - 1 - x, y), load(x, s.y - 1 - y), p.backward == 1u);
        }
        case 13u: {
            // drawgrid (draw_region in vf_drawbox.c): lines `bar` thick every rect.x pixels across
            // and rect.y down (from 0, 0), each grid pixel blended toward black (Y 16, U and V 128)
            // at the color's alpha byte / 255 (`factor`), truncated to 8 bits. Chroma is written
            // through every grid pixel of its 4:2:0 block, so a sample is blended once for each.
            let cell = vec2<i32>(i32(p.rect.x), i32(p.rect.y));
            let t = i32(p.bar);
            let size = vec2<i32>(textureDimensions(src));
            var n = 0;
            for (var dy = 0; dy < 2; dy++) {
                for (var dx = 0; dx < 2; dx++) {
                    let bx = (x / 2) * 2 + dx;
                    let by = (y / 2) * 2 + dy;
                    if (bx < size.x && by < size.y && (bx % cell.x < t || by % cell.y < t)) {
                        n++;
                    }
                }
            }
            if (n > 0) {
                let alpha = round(p.factor * 255.0);
                let yuv = round(clamp(rgb_to_vuya(c), vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0);
                var out = yuv;
                // (1 - alpha) v + alpha target, as whole numbers over 255.
                if (x % cell.x < t || y % cell.y < t) {
                    out.z = floor((yuv.z * (255.0 - alpha) + 16.0 * alpha) / 255.0);
                }
                for (var k = 0; k < n; k++) {
                    out.x = floor((out.x * (255.0 - alpha) + 128.0 * alpha) / 255.0);
                    out.y = floor((out.y * (255.0 - alpha) + 128.0 * alpha) / 255.0);
                }
                c = vuya_to_rgb(vec4<f32>(out.xyz / 255.0, c.a));
            }
        }
        case 14u: {
            // dilation: the largest of the 3 x 3 neighbors on each plane (8-bit YUV, or RGB with `backward` 1).
            var m = vec4<f32>(0.0);
            for (var dy = -1; dy <= 1; dy++) {
                for (var dx = -1; dx <= 1; dx++) {
                    let n = load(x + dx, y + dy);
                    m = max(m, select(rgb_to_vuya(n), n, p.backward == 1u));
                }
            }
            if (p.backward == 1u) {
                c = vec4<f32>(m.rgb, load(x, y).a);
            } else {
                // 4:2:0 chroma is dilated on its half-size planes: the 3 x 3 neighboring 2 x 2
                // blocks, each block one chroma sample (its mean here).
                let bx = (x / 2) * 2;
                let by = (y / 2) * 2;
                var mc = vec2<f32>(0.0);
                for (var dy = -1; dy <= 1; dy++) {
                    for (var dx = -1; dx <= 1; dx++) {
                        let ox = bx + 2 * dx;
                        let oy = by + 2 * dy;
                        let b = (rgb_to_vuya(load(ox, oy)) + rgb_to_vuya(load(ox + 1, oy)) + rgb_to_vuya(load(ox, oy + 1)) + rgb_to_vuya(load(ox + 1, oy + 1))) / 4.0;
                        mc = max(mc, b.xy);
                    }
                }
                c = vec4<f32>(vuya_to_rgb(vec4<f32>(mc, m.z, 1.0)).rgb, load(x, y).a);
            }
        }
        case 15u: {
            // swscale's area scaling down: each output pixel the mean of the source area it covers.
            let s = vec2<f32>(textureDimensions(src));
            let k = s / vec2<f32>(size);
            let a0 = vec2<f32>(f32(x), f32(y)) * k;
            let a1 = a0 + k;
            var sum = vec4<f32>(0.0);
            for (var sy = i32(floor(a0.y)); sy < i32(ceil(a1.y)); sy++) {
                let wy = min(a1.y, f32(sy + 1)) - max(a0.y, f32(sy));
                for (var sx = i32(floor(a0.x)); sx < i32(ceil(a1.x)); sx++) {
                    let wx = min(a1.x, f32(sx + 1)) - max(a0.x, f32(sx));
                    sum += wx * wy * load(sx, sy);
                }
            }
            c = sum / (k.x * k.y);
        }
        case 16u: {
            // scale with flags=neighbor: the source pixel under each output pixel's center.
            let s = vec2<f32>(textureDimensions(src));
            let q = vec2<i32>(floor((vec2<f32>(f32(x), f32(y)) + 0.5) * s / vec2<f32>(size)));
            c = load(q.x, q.y);
        }
        case 8u: {
            // tint: red, green and blue multiplied (colorchannelmixer's diagonal).
            c = vec4<f32>(c.rgb * p.color.rgb, c.a);
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
            // Every plane gets its own noise; 4:2:0 chroma shares one value per 2 x 2 block. With
            // `bar` 1 only luma gets it (noise's c0s, as film grain uses it).
            var n = vec4<f32>(noise(ux / 2u, uy / 2u, 2u), noise(ux / 2u, uy / 2u, 1u), noise(ux, uy, 0u), 0.0) / 255.0;
            if (p.bar == 1u) {
                n = vec4<f32>(0.0, 0.0, n.z, 0.0);
            }
            c = vuya_to_rgb(clamp(rgb_to_vuya(c) + n, vec4<f32>(0.0), vec4<f32>(1.0)));
        }
    }
    textureStore(dst, id.xy, c);
}
