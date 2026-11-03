// The finished float picture as packed 8-bit VUYA for the encoder, rounded to nearest. YUV keeps
// what lies past video black and white, as the FFmpeg backend does. (Prefixed with yuv.wgsl.)

@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = textureDimensions(picture);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let c = textureLoad(picture, id.xy, 0);
    out[id.y * size.x + id.x] = pack4x8unorm(rgb_to_vuya(vec4<f32>(c.rgb, 1.0)));
}
