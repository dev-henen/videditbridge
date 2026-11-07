// The primary track's picture for one frame: the background, one clip, or two clips in a
// transition, each with its fade to black. Transitions follow FFmpeg xfade's formulas (a is the
// outgoing clip, b the incoming one, `progress` runs from 1 to 0), and the custom circlereveal
// expression of the transitions catalog. (Prefixed with yuv.wgsl.)

struct Params {
    // 0 background only, 1 clip a, 2 a transition from a to b.
    mode: u32,
    // Transition number, see plan.rs transition_kind.
    kind: u32,
    // Fade-to-black factors of a and b (1 = no fade).
    fade_a: f32,
    fade_b: f32,
    progress: f32,
    // circlereveal: how far the circle reaches (frame heights), and the frame's width / height.
    reach: f32,
    aspect: f32,
    // 1 when the FFmpeg backend runs its transitions on RGB (plan.rs rgb_transitions).
    rgb: u32,
    background: vec4<f32>,
    // circlereveal: where the circle starts (frame fractions).
    origin: vec2<f32>,
    _pad1: vec2<f32>,
}

@group(0) @binding(0) var a: texture_2d<f32>;
@group(0) @binding(1) var b: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> p: Params;
// hblur: running sums of both clips along every row (hblur.wgsl); a small placeholder otherwise.
@group(0) @binding(4) var<storage, read> sums: array<vec4<f32>>;
// xfade's frand(x, y) for every pixel, worked out on the processor (its sinf of large angles, which
// the GPU's sin does not match); dissolve and the winds read it. A small placeholder otherwise.
@group(0) @binding(5) var<storage, read> noise: array<f32>;

fn frand(x: i32, y: i32) -> f32 {
    return noise[u32(y) * u32(textureDimensions(dst).x) + u32(x)];
}

// xfade's smoothstep, also for edges given high to low (the winds).
fn xsmooth(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// xfade's slices: the share of b at position u (0..1 across or down), in ten bands.
// `bands` is the value whose fraction makes the ten bands, worked out as xfade does for each kind.
fn slice(u: f32, bands: f32, t: f32) -> f32 {
    let s = xsmooth(-0.5, 0.0, u - t * 1.5);
    return select(1.0, 0.0, s <= fract(bands));
}

// xfade's mix: m of x, 1 - m of y.
fn mixf(x: vec3<f32>, y: vec3<f32>, m: f32) -> vec3<f32> {
    return x * m + y * (1.0 - m);
}

// A clip's pixel as the transition sees it: in RGB mode FFmpeg converts its YUV frames to 8-bit
// RGB first, which clips values past video black and white (eq can leave them there).
fn as_input(c: vec3<f32>) -> vec3<f32> {
    if (p.rgb == 1u) {
        return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    return c;
}

fn load_a(x: i32, y: i32) -> vec3<f32> {
    let size = vec2<i32>(textureDimensions(a));
    return as_input(textureLoad(a, vec2<i32>(clamp(x, 0, size.x - 1), clamp(y, 0, size.y - 1)), 0).rgb * p.fade_a);
}

fn load_b(x: i32, y: i32) -> vec3<f32> {
    let size = vec2<i32>(textureDimensions(b));
    return as_input(textureLoad(b, vec2<i32>(clamp(x, 0, size.x - 1), clamp(y, 0, size.y - 1)), 0).rgb * p.fade_b);
}

// xfade's black and white are luma 0 and 255 in YUV, past video black (16) and white (235), with
// chroma 127 (its max / 2): in RGB below 0 and above 1.
fn flat(white: bool) -> vec3<f32> {
    if (p.rgb == 1u) {
        return vec3<f32>(select(0.0, 1.0, white));
    }
    return vuya_to_rgb(vec4<f32>(127.0 / 255.0, 127.0 / 255.0, select(0.0, 1.0, white), 1.0)).rgb;
}

// A wrapped offset, as xfade's slides take it.
fn wrap(v: i32, n: i32) -> i32 {
    return ((v % n) + n) % n;
}

// xfade moves each YUV plane by its own whole-pixel offset, and 4:2:0 chroma planes are half size:
// a slide is worked out twice, at full size for luma and in two-pixel steps for chroma (`step`),
// and the two are joined here.
fn planes(luma: vec3<f32>, chroma: vec3<f32>) -> vec3<f32> {
    if (p.rgb == 1u) {
        return luma;
    }
    let l = rgb_to_vuya(vec4<f32>(luma, 1.0));
    let c = rgb_to_vuya(vec4<f32>(chroma, 1.0));
    return vuya_to_rgb(vec4<f32>(c.x, c.y, l.z, 1.0)).rgb;
}

// A sideways slide at offset `z` (already a multiple of `step`): 0 slide (b inside, both wrapped),
// 1 cover (b wrapped inside, a still outside), 2 reveal (b still inside, a wrapped outside).
fn slide_h(x: i32, y: i32, w: i32, z: i32, step: i32, mode: u32) -> vec3<f32> {
    let px = x - x % step;
    let zx = z + px;
    let zz = wrap(zx, w) + x % step;
    let inside = zx >= 0 && zx < w;
    switch mode {
        case 1u: { return select(load_a(x, y), load_b(zz, y), inside); }
        case 2u: { return select(load_a(zz, y), load_b(x, y), inside); }
        default: { return select(load_a(zz, y), load_b(zz, y), inside); }
    }
}

fn slide_v(x: i32, y: i32, h: i32, z: i32, step: i32) -> vec3<f32> {
    let py = y - y % step;
    let zy = z + py;
    let zz = wrap(zy, h) + y % step;
    return select(load_a(x, zz), load_b(x, zz), zy >= 0 && zy < h);
}

// The luma of a picture as a gray (xfade's fadegrays on YUV keeps luma, chroma at the middle).
fn gray(c: vec3<f32>) -> vec3<f32> {
    if (p.rgb == 1u) {
        return vec3<f32>((c.r + c.g + c.b) / 3.0);
    }
    return vec3<f32>(0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
}

fn transition(x: i32, y: i32, w: i32, h: i32) -> vec3<f32> {
    let t = p.progress;
    let ca = load_a(x, y);
    let cb = load_b(x, y);
    let fw = f32(w);
    let fh = f32(h);
    switch p.kind {
        case 0u: { return mixf(ca, cb, t); }
        case 1u, 2u: {
            let f = flat(p.kind == 2u);
            return mixf(mixf(ca, f, smoothstep(0.8, 1.0, t)), mixf(f, cb, smoothstep(0.2, 1.0, t)), t);
        }
        case 3u: { return select(ca, cb, x > i32(fw * t)); }
        case 4u: { return select(cb, ca, x > i32(fw * (1.0 - t))); }
        case 5u: { return select(ca, cb, y > i32(fh * t)); }
        case 6u: { return select(cb, ca, y > i32(fh * (1.0 - t))); }
        case 7u, 8u: {
            let s = select(t, -t, p.kind == 7u);
            return planes(slide_h(x, y, w, i32(s * fw), 1, 0u), slide_h(x, y, w, i32(s * f32(w / 2)) * 2, 2, 0u));
        }
        case 9u, 10u: {
            let s = select(t, -t, p.kind == 9u);
            return planes(slide_v(x, y, h, i32(s * fh), 1), slide_v(x, y, h, i32(s * f32(h / 2)) * 2, 2));
        }
        case 11u: { return mixf(cb, ca, smoothstep(0.0, 1.0, 1.0 + f32(x) / fw - t * 2.0)); }
        case 12u: { return mixf(cb, ca, smoothstep(0.0, 1.0, 1.0 + (fw - 1.0 - f32(x)) / fw - t * 2.0)); }
        case 13u: { return mixf(cb, ca, smoothstep(0.0, 1.0, 1.0 + f32(y) / fh - t * 2.0)); }
        case 14u: { return mixf(cb, ca, smoothstep(0.0, 1.0, 1.0 + (fh - 1.0 - f32(y)) / fh - t * 2.0)); }
        case 15u, 16u: {
            let z = length(vec2<f32>(f32(w / 2), f32(h / 2)));
            let d = length(vec2<f32>(f32(x - w / 2), f32(y - h / 2))) / z;
            if (p.kind == 15u) {
                return mixf(ca, cb, smoothstep(0.0, 1.0, d + (t - 0.5) * 3.0));
            }
            return mixf(cb, ca, smoothstep(0.0, 1.0, d + (0.5 - t) * 3.0));
        }
        case 17u, 18u: {
            let h2 = fh / 2.0;
            let e = abs((f32(y) - h2) / h2);
            return mixf(cb, ca, smoothstep(0.0, 1.0, select(1.0 + e, 2.0 - e, p.kind == 17u) - t * 2.0));
        }
        case 19u, 20u: {
            let w2 = fw / 2.0;
            let e = abs((f32(x) - w2) / w2);
            return mixf(cb, ca, smoothstep(0.0, 1.0, select(1.0 + e, 2.0 - e, p.kind == 19u) - t * 2.0));
        }
        case 21u: { return mixf(cb, ca, smoothstep(0.0, 1.0, 1.0 + f32(x) / fw * f32(y) / fh - t * 2.0)); }
        case 22u: {
            // zoomin: a zooms in from its center during the second half, while b fades in.
            let zf = smoothstep(0.5, 1.0, t);
            let u = 0.5 + (f32(x) / fw - 0.5) * zf;
            let v = 0.5 + (f32(y) / fh - 0.5) * zf;
            let zv = load_a(i32(ceil(u * (fw - 1.0))), i32(ceil(v * (fh - 1.0))));
            // Chroma comes from xfade's half-size plane: the 2 x 2 block its sample covers. At the
            // middle of the transition one sample fills the frame, so this shows.
            let cx = 2 * i32(ceil(u * (f32(w / 2) - 1.0)));
            let cy = 2 * i32(ceil(v * (f32(h / 2) - 1.0)));
            let block = (load_a(cx, cy) + load_a(cx + 1, cy) + load_a(cx, cy + 1) + load_a(cx + 1, cy + 1)) / 4.0;
            return mixf(planes(zv, block), cb, smoothstep(0.0, 0.5, t));
        }
        case 23u: {
            let z = pow(2.0 * abs(t - 0.5), 3.0) * length(vec2<f32>(f32(w / 2), f32(h / 2)));
            let d = length(vec2<f32>(f32(x - w / 2), f32(y - h / 2)));
            return select(select(ca, cb, t < 0.5), flat(false), z < d);
        }
        case 24u: {
            let zh = i32(abs(t - 0.5) * fh);
            let zw = i32(abs(t - 0.5) * fw);
            let inside = abs(x - w / 2) < zw && abs(y - h / 2) < zh;
            return select(flat(false), select(ca, cb, t < 0.5), inside);
        }
        case 25u, 26u, 27u, 28u: {
            // cover: b slides over a; reveal: a slides away from over b.
            let s = select(t, -t, p.kind == 25u || p.kind == 27u);
            let mode = select(2u, 1u, p.kind <= 26u);
            return planes(slide_h(x, y, w, i32(s * fw), 1, mode), slide_h(x, y, w, i32(s * f32(w / 2)) * 2, 2, mode));
        }
        case 29u: {
            return mixf(mixf(ca, gray(ca), smoothstep(0.8, 1.0, t)), mixf(gray(cb), cb, smoothstep(0.2, 1.0, t)), t);
        }
        case 31u: {
            // pixelize: both clips in blocks that grow to the middle of the transition and shrink.
            let d = min(t, 1.0 - t);
            let dist = ceil(d * 50.0) / 50.0;
            let sq = 2.0 * dist * f32(min(w, h)) / 20.0;
            var sx = x;
            var sy = y;
            if (dist > 0.0) {
                sx = i32(min((floor(f32(x) / sq) + 0.5) * sq, fw - 1.0));
                sy = i32(min((floor(f32(y) / sq) + 0.5) * sq, fh - 1.0));
            }
            return mixf(load_a(sx, sy), load_b(sx, sy), t);
        }
        case 33u: {
            // dissolve: each pixel switches from a to b at its own random moment.
            return select(cb, ca, frand(x, y) * 2.0 + t * 2.0 - 1.5 >= 0.5);
        }
        case 34u: {
            // radial: a clock hand sweeping round the center (whole-pixel center, as xfade's ints).
            let sweep = atan2(f32(x - w / 2), f32(y - h / 2)) - (t - 0.5) * (3.14159265358979 * 2.5);
            return mixf(cb, ca, smoothstep(0.0, 1.0, sweep));
        }
        case 35u: {
            // distance: pixels where the two pictures are close switch first. xfade measures on its
            // planes (Y, U and V, or R, G and B), each over 255.
            var da = ca;
            var db = cb;
            if (p.rgb == 0u) {
                da = rgb_to_vuya(vec4<f32>(ca, 1.0)).xyz;
                db = rgb_to_vuya(vec4<f32>(cb, 1.0)).xyz;
            }
            let near = select(0.0, 1.0, length(da - db) <= t);
            return mixf(mixf(ca, cb, near), cb, t);
        }
        case 36u: {
            // squeezeh: a squeezed toward the middle row, b around it.
            let z = 0.5 + (f32(y) / fh - 0.5) / t;
            if (z < 0.0 || z > 1.0) {
                return cb;
            }
            return load_a(x, i32(round(z * (fh - 1.0))));
        }
        case 37u: {
            let z = 0.5 + (f32(x) / fw - 0.5) / t;
            if (z < 0.0 || z > 1.0) {
                return cb;
            }
            return load_a(i32(round(z * (fw - 1.0))), y);
        }
        // hlslice and vuslice band 10.f * x / w (10x first), the others 10.f * xx of their own xx.
        // 10x / w lands exactly on whole numbers every w / 10 pixels, where the GPU's division can
        // fall just under: its fraction comes from integers (exact where xfade's is exact).
        case 38u: { return mixf(cb, ca, slice(f32(x) / fw, f32((10 * x) % w) / fw, t)); }
        case 39u: { let u = (fw - 1.0 - f32(x)) / fw; return mixf(cb, ca, slice(u, 10.0 * u, t)); }
        case 40u: { return mixf(cb, ca, slice(f32(y) / fh, f32((10 * y) % h) / fh, t)); }
        case 41u: { let u = (fh - 1.0 - f32(y)) / fh; return mixf(cb, ca, slice(u, 10.0 * u, t)); }
        case 42u, 43u: {
            // hlwind, hrwind: streaks of random length per row.
            let fx = select(f32(x) / fw, 1.0 - f32(x) / fw, p.kind == 42u);
            let m = xsmooth(0.0, -0.2, fx * (1.0 - 0.2) + 0.2 * frand(0, y) - (1.0 - t) * (1.0 + 0.2));
            return mixf(cb, ca, m);
        }
        case 32u: {
            // hblur: each pixel averages a window running right from it, widest in the middle.
            let prog = select(2.0 * (1.0 - t), 2.0 * t, t <= 0.5);
            let size = 1 + i32(f32(w / 2) * prog);
            let end = min(x + size, w);
            let row = u32(y) * u32(w + 1) * 2u;
            let cnt = f32(end - x);
            let avg_a = (sums[row + u32(end) * 2u] - sums[row + u32(x) * 2u]).rgb / cnt;
            let avg_b = (sums[row + u32(end) * 2u + 1u] - sums[row + u32(x) * 2u + 1u]).rgb / cnt;
            return mixf(avg_a, avg_b, t);
        }
        default: {
            // circlereveal: b inside a circle growing from the origin (P is 1 - progress there).
            let d = length(vec2<f32>((f32(x) / fw - p.origin.x) * p.aspect, f32(y) / fh - p.origin.y));
            let m = clamp((p.reach * pow(1.0 - t, 1.6) - d) / 0.02 + 0.5, 0.0, 1.0);
            return ca * (1.0 - m) + cb * m;
        }
    }
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(dst);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var c = p.background.rgb;
    if (p.mode == 1u) {
        c = load_a(i32(id.x), i32(id.y));
    } else if (p.mode == 2u) {
        c = transition(i32(id.x), i32(id.y), i32(size.x), i32(size.y));
    }
    textureStore(dst, id.xy, vec4<f32>(c, 1.0));
}
