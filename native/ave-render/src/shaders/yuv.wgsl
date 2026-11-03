// BT.601 limited-range YUV, the matrix the FFmpeg backend's untagged conversions use. Pixels come
// in and go out as packed VUYA bytes; in between they are float RGB that may go past 0 and 1 (YUV
// below video black or above white), as the backend's YUV frames do.

fn vuya_to_rgb(c: vec4<f32>) -> vec4<f32> {
    let y = (c.z * 255.0 - 16.0) / 219.0;
    let cb = (c.y * 255.0 - 128.0) / 224.0;
    let cr = (c.x * 255.0 - 128.0) / 224.0;
    return vec4<f32>(y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb, c.w);
}

fn rgb_to_vuya(c: vec4<f32>) -> vec4<f32> {
    let y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    let cb = (c.b - y) / 1.772;
    let cr = (c.r - y) / 1.402;
    return vec4<f32>((128.0 + 224.0 * cr) / 255.0, (128.0 + 224.0 * cb) / 255.0, (16.0 + 219.0 * y) / 255.0, c.a);
}
