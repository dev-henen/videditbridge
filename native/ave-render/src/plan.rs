//! The engine plan: what to draw on every output frame, made by `planProject` in
//! engine/tools/render/plan.ts (keep the two in step). Times are seconds, sizes and positions are
//! output pixels, colors are 0..1 RGB(A) in the display-referred space of the FFmpeg backend.

use serde::Deserialize;

pub const PLAN_VERSION: u32 = 1;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Output frames.
    pub frames: u32,
    pub background: [f32; 3],
    /// The ffmpeg binary for decoders and the encoder.
    pub ffmpeg: String,
    /// Working directory of every ffmpeg process (where the encoder finds overlay.ass).
    #[serde(default)]
    pub cwd: Option<String>,
    pub items: Vec<Item>,
    /// The primary track, in order.
    pub clips: Vec<ClipUse>,
    /// Media overlays, bottom to top.
    pub layers: Vec<LayerUse>,
    pub output: Output,
}

/// A picture fitted to a box: the source scaled to `scaled` and placed at `offset` (negative for a
/// crop) inside an image of `width` x `height`; the rest of the image is `fill`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub source: Source,
    pub width: u32,
    pub height: u32,
    pub scaled: [u32; 2],
    pub offset: [i32; 2],
    pub fill: [f32; 4],
    /// Drop the source's alpha (clips on the primary track).
    #[serde(default)]
    pub opaque: bool,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// Frames from ffmpeg: `args` write `width` x `height` RGBA frames to stdout, one per output frame.
    #[serde(rename_all = "camelCase")]
    Decode { width: u32, height: u32, args: Vec<String>, #[serde(default)] still: bool },
    /// A flat color.
    Color { color: [f32; 4] },
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipUse {
    pub item: usize,
    /// Output frame showing the clip's frame 0.
    pub first: i64,
    /// Frames the clip shows.
    pub frames: i64,
    pub duration: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// The transition into this clip from the previous one.
    #[serde(default)]
    pub transition: Option<Transition>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// fade, fadeblack or fadewhite (FFmpeg xfade's formulas).
    pub kind: String,
    /// Output seconds where it starts (xfade's offset).
    pub offset: f64,
    pub duration: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LayerUse {
    pub item: usize,
    /// Shown while start <= t <= end (output seconds).
    pub start: f64,
    pub end: f64,
    /// Frames the source has; after them the layer is gone. None: a still, shown throughout.
    #[serde(default)]
    pub frames: Option<i64>,
    /// Top-left corner, output pixels.
    pub x: i32,
    pub y: i32,
    pub opacity: f32,
    pub blend: String,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    pub duration: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    /// ffmpeg arguments of the encoder; it reads RGBA frames from stdin (`-i pipe:0`).
    pub args: Vec<String>,
}

/// Blend mode numbers shared with layer.wgsl.
pub fn blend_mode(name: &str) -> Result<u32, String> {
    Ok(match name {
        "normal" => 0,
        "screen" => 1,
        "add" => 2,
        "multiply" => 3,
        "overlay" => 4,
        "softlight" => 5,
        "lighten" => 6,
        "darken" => 7,
        "colordodge" => 8,
        "difference" => 9,
        _ => return Err(format!("unknown blend mode {name}")),
    })
}

/// Transition numbers shared with primary.wgsl.
pub fn transition_kind(name: &str) -> Result<u32, String> {
    Ok(match name {
        "fade" => 0,
        "fadeblack" => 1,
        "fadewhite" => 2,
        _ => return Err(format!("unknown transition {name}")),
    })
}
