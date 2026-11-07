// The finished float picture as planar 4:2:0 for the encoder, rounded to nearest: 8-bit (yuv420p,
// dithered for footage in a color space) or 10-bit in 16-bit samples (yuv420p10le, 10-bit exports):
// the Y plane, then U and V at half size (rounded up), each plane starting on a 32-bit word (the
// readback joins them). Chroma that came in at half size is the same over its 2 x 2 block and goes
// out as it was; other chroma goes down as swscale takes RGB to 4:2:0 (`downsample`). YUV keeps
// what lies past video black and white, as the FFmpeg backend does. Each invocation writes one
// word of Y (`luma`), or one word each of U and V (`chroma`). (Prefixed with yuv.wgsl.)

@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
// The text (engine sessions): libass's drawing over black (Y 16, U and V 128) on top and over
// (235, 240, 240) below, as Y, U, V in red, green, blue, each chroma sample on its 2 x 2 block.
@group(0) @binding(2) var text: texture_2d<f32>;
@group(0) @binding(3) var<uniform> text_on: vec4<u32>;

// The text over `under` on one plane: libass blends each plane linearly, so its drawings over the
// two backgrounds (`low` and `high`, `span` apart) give the blend factor and what it adds.
fn over(under: f32, on_low: f32, on_high: f32, low: f32, span: f32) -> f32 {
    let keep = (on_high - on_low) / span;
    return under * keep + on_low - low * keep;
}

fn text_luma(x: u32, y: u32, under: f32) -> f32 {
    if (text_on.x == 0u) {
        return under;
    }
    let h = textureDimensions(picture).y;
    return over(under, textureLoad(text, vec2<u32>(x, y), 0).r, textureLoad(text, vec2<u32>(x, y + h), 0).r, 16.0 / 255.0, 219.0 / 255.0);
}

// V and U of chroma sample (cx, cy) with the text over them.
fn text_chroma(cx: u32, cy: u32, under: vec2<f32>) -> vec2<f32> {
    if (text_on.x == 0u) {
        return under;
    }
    let h = textureDimensions(picture).y;
    let low = textureLoad(text, vec2<u32>(cx * 2u, cy * 2u), 0);
    let high = textureLoad(text, vec2<u32>(cx * 2u, cy * 2u + h), 0);
    let k = 128.0 / 255.0;
    let span = 112.0 / 255.0;
    return vec2<f32>(over(under.x, low.b, high.b, k, span), over(under.y, low.g, high.g, k, span));
}

// text_on: x text on, y 10-bit output, z bit 0 dither (8-bit) and bit 1 chroma from 4:4:4 YUV (a
// transition's frame, see downsample_planar), w the frame (the dither's seed).
fn ten_bit() -> bool {
    return text_on.y == 1u;
}

// Samples per 32-bit word, and bits per sample.
fn per_word() -> u32 {
    return select(4u, 2u, ten_bit());
}

fn hash(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

// Uniform noise of half a step either way, different for each sample, plane and frame: enough to
// break 8-bit steps into fine grain, at half the noise of a triangular dither.
fn dither(seed: u32) -> f32 {
    return f32(hash(seed ^ (text_on.w * 0x9e3779b9u)) >> 8u) / 16777216.0 - 0.5;
}

// One output sample: 8-bit (dithered when asked), or 10-bit on the decoders' scale (x1020, so 16/255
// is 64 and 235/255 is 940).
fn sample(v: f32, seed: u32) -> u32 {
    if (ten_bit()) {
        return u32(clamp(round(v * 1020.0), 0.0, 1023.0));
    }
    var s = v * 255.0;
    if ((text_on.z & 1u) == 1u) {
        s += dither(seed);
    }
    return u32(clamp(round(s), 0.0, 255.0));
}

fn yuv(x: u32, y: u32) -> vec4<f32> {
    return rgb_to_vuya(vec4<f32>(textureLoad(picture, vec2<u32>(x, y), 0).rgb, 1.0));
}

// Words of a plane of `samples` samples.
fn words(samples: u32) -> u32 {
    return (samples + per_word() - 1u) / per_word();
}

// The invocation's index, from a grid of rows of workgroups of 256.
fn index(id: vec3<u32>, groups: vec3<u32>) -> u32 {
    return id.y * groups.x * 256u + id.x;
}

@compute @workgroup_size(256)
fn luma(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let size = textureDimensions(picture);
    let total = size.x * size.y;
    let word = index(id, groups);
    if (word >= words(total)) {
        return;
    }
    var packed = 0u;
    let bits = 32u / per_word();
    for (var k = 0u; k < per_word(); k++) {
        let b = word * per_word() + k;
        if (b < total) {
            let x = b % size.x;
            let y = b / size.x;
            packed |= sample(text_luma(x, y, yuv(x, y).z), b * 3u) << (bits * k);
        }
    }
    out[word] = packed;
}

fn bicubic(d: f32) -> f32 {
    let x = abs(d);
    if (x < 1.0) {
        return (1.4 * x - 2.4) * x * x + 1.0;
    }
    if (x < 2.0) {
        return ((-0.6 * x + 3.0) * x - 4.8) * x + 2.4;
    }
    return 0.0;
}

// Chroma that differs within its 2 x 2 block went through full-size RGB; FFmpeg brings such
// pictures back to 4:2:0 with swscale, which averages each horizontal pair and scales the rows
// down with its bicubic (widened by 2, centered). Measured against swscale's own output this is
// within its fixed-point rounding; a plain 2 x 2 mean was half a level further off.
fn downsample(x0: u32, x1: u32, cy: u32, size: vec2<u32>) -> vec2<f32> {
    let s = 2.0 * f32(cy) + 0.5;
    var acc = vec2<f32>(0.0);
    var total = 0.0;
    for (var j = i32(floor(s - 4.0)) + 1; j <= i32(floor(s + 4.0)); j++) {
        let w = bicubic((f32(j) - s) / 2.0);
        let y = u32(clamp(j, 0, i32(size.y) - 1));
        acc += w * (yuv(x0, y).xy + yuv(x1, y).xy) * 0.5;
        total += w;
    }
    return acc / total;
}

// xfade works on yuv444p, and FFmpeg scales its frames to 4:2:0 as planes: the chroma planes go
// down with swscale's bicubic (widened by 2, centered) both across and down.
fn downsample_planar(cx: u32, cy: u32, size: vec2<u32>) -> vec2<f32> {
    let sx = 2.0 * f32(cx) + 0.5;
    let sy = 2.0 * f32(cy) + 0.5;
    var acc = vec2<f32>(0.0);
    var total = 0.0;
    for (var j = i32(floor(sy - 4.0)) + 1; j <= i32(floor(sy + 4.0)); j++) {
        let wy = bicubic((f32(j) - sy) / 2.0);
        let y = u32(clamp(j, 0, i32(size.y) - 1));
        for (var i = i32(floor(sx - 4.0)) + 1; i <= i32(floor(sx + 4.0)); i++) {
            let w = wy * bicubic((f32(i) - sx) / 2.0);
            acc += w * yuv(u32(clamp(i, 0, i32(size.x) - 1)), y).xy;
            total += w;
        }
    }
    return acc / total;
}

// V and U of chroma sample (cx, cy).
fn chroma_sample(cx: u32, cy: u32, size: vec2<u32>) -> vec2<f32> {
    let x0 = cx * 2u;
    let y0 = cy * 2u;
    let x1 = min(x0 + 1u, size.x - 1u);
    let y1 = min(y0 + 1u, size.y - 1u);
    let q00 = yuv(x0, y0).xy;
    let q10 = yuv(x1, y0).xy;
    let q01 = yuv(x0, y1).xy;
    let q11 = yuv(x1, y1).xy;
    let spread = max(max(abs(q00 - q10), abs(q00 - q01)), abs(q00 - q11));
    if (max(spread.x, spread.y) > 0.25 / 255.0) {
        if ((text_on.z & 2u) == 2u) {
            return downsample_planar(cx, cy, size);
        }
        return downsample(x0, x1, cy, size);
    }
    return (q00 + q10 + q01 + q11) * 0.25;
}

@compute @workgroup_size(256)
fn chroma(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
    let size = textureDimensions(picture);
    let cw = (size.x + 1u) / 2u;
    let plane = cw * ((size.y + 1u) / 2u);
    let word = index(id, groups);
    if (word >= words(plane)) {
        return;
    }
    var u = 0u;
    var v = 0u;
    let bits = 32u / per_word();
    for (var k = 0u; k < per_word(); k++) {
        let i = word * per_word() + k;
        if (i < plane) {
            let c = text_chroma(i % cw, i / cw, chroma_sample(i % cw, i / cw, size));
            v |= sample(c.x, i * 3u + 1u) << (bits * k);
            u |= sample(c.y, i * 3u + 2u) << (bits * k);
        }
    }
    let base = words(size.x * size.y);
    out[base + word] = u;
    out[base + words(plane) + word] = v;
}
