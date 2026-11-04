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
    /// Whole-video effects on the primary track, before the layers; time counts in output frames.
    #[serde(default)]
    pub effects: Vec<Op>,
    /// Transitions run on RGB in the FFmpeg backend: plain black and white, full-size chroma.
    #[serde(default)]
    pub rgb_transitions: bool,
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
    /// Effects on the fitted picture, in order; time counts in frames of the piece.
    #[serde(default)]
    pub effects: Vec<Op>,
    /// fit blur: the same source fitted again behind the picture, through its own effects.
    #[serde(default)]
    pub backdrop: Option<Backdrop>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Backdrop {
    pub scaled: [u32; 2],
    pub offset: [i32; 2],
    pub effects: Vec<Op>,
}

/// An effect step (engine/tools/render/plan-effects.ts), following its FFmpeg filter.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// A per-pixel color chain baked into a table: ffmpeg `args` write a 512x512 rgb24 Hald image (level 8).
    Lut { args: Vec<String> },
    /// Show a rectangle (x, y, width, height) at full size, per frame (the last holds): "linear" or "bicubic".
    Crop { rects: Vec<[f32; 4]>, filter: String },
    Vignette { angle: f32, #[serde(default)] backward: bool },
    /// Black bars at the top and bottom.
    Bars { height: u32 },
    /// Fade toward `color`: in from it, or out to it.
    Fade { color: [f32; 3], out: bool, start: f64, duration: f64 },
    /// Red, green and blue moved by whole pixels, [across, down] each.
    Shift { red: [i32; 2], green: [i32; 2], blue: [i32; 2] },
    /// FFmpeg's noise on every YUV plane, new each frame: uniform over `strength` levels, or gaussian.
    Noise { strength: f32, uniform: bool, #[serde(default)] rgb: bool },
    /// FFmpeg's gblur.
    Blur { sigma: f32 },
    /// FFmpeg's eq on the YUV planes as they are, with its integer math.
    #[serde(rename_all = "camelCase")]
    Eq { brightness: f32, contrast: f32, saturation: f32, gamma: f32, gamma_weight: f32 },
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
    /// An FFmpeg xfade transition (see transition_kind), or circlereveal (the catalog's custom one).
    pub kind: String,
    /// Output seconds where it starts (xfade's offset).
    pub offset: f64,
    pub duration: f64,
    /// circlereveal: where the circle starts (frame fractions), how far it reaches (frame heights), and the frame's width / height.
    #[serde(default)]
    pub origin: Option<[f32; 2]>,
    #[serde(default)]
    pub reach: f32,
    #[serde(default)]
    pub aspect: f32,
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
    /// A moving layer: its corner on each output frame from `frame0` (the last holds).
    #[serde(default)]
    pub frame0: i64,
    #[serde(default)]
    pub positions: Vec<[i32; 2]>,
    /// Opacity keyframes: a factor on each frame of the layer (the last holds).
    #[serde(default)]
    pub opacities: Vec<f32>,
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
pub const TRANSITIONS: [&str; 33] = [
    "fade", "fadeblack", "fadewhite", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown",
    "smoothleft", "smoothright", "smoothup", "smoothdown", "circleopen", "circleclose", "horzopen", "horzclose", "vertopen", "vertclose",
    "diagtl", "zoomin", "circlecrop", "rectcrop", "coverleft", "coverright", "revealleft", "revealright", "fadegrays", "circlereveal", "pixelize",
    "hblur",
];

/// The transition number of hblur, which needs its row sums before the primary pass.
pub const HBLUR: u32 = 32;

pub fn transition_kind(name: &str) -> Result<u32, String> {
    TRANSITIONS.iter().position(|t| *t == name).map(|i| i as u32).ok_or_else(|| format!("unknown transition {name}"))
}
