//! The engine plan: what to draw on every output frame, made by `planProject` in
//! engine/tools/render/plan.ts (keep the two in step). Times are seconds, sizes and positions are
//! output pixels, colors are 0..1 RGB(A) in the display-referred space of the FFmpeg backend.

use serde::Deserialize;

pub const PLAN_VERSION: u32 = 2;

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
    /// Frames from ffmpeg: `args` write `width` x `height` frames in `format` to stdout, one per output frame.
    #[serde(rename_all = "camelCase")]
    Decode {
        width: u32,
        height: u32,
        args: Vec<String>,
        #[serde(default)]
        format: PixelFormat,
        #[serde(default)]
        still: bool,
        /// How to start the decoder at a later frame (previews that jump around).
        #[serde(default)]
        seek: Option<Seek>,
    },
    /// A flat color.
    Color { color: [f32; 4] },
}

/// How a decoder's frames are laid out on its pipe.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PixelFormat {
    /// Packed 8-bit V, U, Y, A per pixel (stills, which may have alpha).
    #[default]
    Vuya,
    /// Planar 8-bit 4:2:0 (video on the primary track): chroma planes of half the size, rounded up.
    Yuv420p,
    /// Planar 4:2:0 with a full-size alpha plane after the chroma (video layers).
    Yuva420p,
}

impl PixelFormat {
    /// Bytes of one `width` x `height` frame on the pipe.
    pub fn frame_bytes(self, width: u32, height: u32) -> usize {
        let (w, h) = (width as usize, height as usize);
        let chroma = w.div_ceil(2) * h.div_ceil(2);
        match self {
            PixelFormat::Vuya => w * h * 4,
            PixelFormat::Yuv420p => w * h + 2 * chroma,
            PixelFormat::Yuva420p => 2 * w * h + 2 * chroma,
        }
    }

    /// Rearrange a frame from the pipe for upload (on the decoder's reading thread): planar frames
    /// become the luma (Y, or Y and A interleaved) followed by U and V interleaved, the layouts of
    /// the r8 or rg8 luma texture and the rg8 chroma texture.
    pub fn for_upload(self, frame: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
        let (w, h) = (width as usize, height as usize);
        let chroma = w.div_ceil(2) * h.div_ceil(2);
        let interleave = |out: &mut Vec<u8>, a: &[u8], b: &[u8]| {
            for (x, y) in a.iter().zip(b) {
                out.push(*x);
                out.push(*y);
            }
        };
        match self {
            PixelFormat::Vuya => frame,
            PixelFormat::Yuv420p => {
                let mut out = Vec::with_capacity(frame.len());
                out.extend_from_slice(&frame[..w * h]);
                let (u, v) = frame[w * h..].split_at(chroma);
                interleave(&mut out, u, v);
                out
            }
            PixelFormat::Yuva420p => {
                let mut out = Vec::with_capacity(frame.len());
                let (y, rest) = frame.split_at(w * h);
                let (u, rest) = rest.split_at(chroma);
                let (v, a) = rest.split_at(chroma);
                interleave(&mut out, y, a);
                interleave(&mut out, u, v);
                out
            }
        }
    }

    pub fn planar(self) -> bool {
        self != PixelFormat::Vuya
    }

    /// Bytes per pixel of the luma texture (r8, or rg8 with alpha).
    pub fn luma_bytes(self) -> u32 {
        if self == PixelFormat::Yuva420p { 2 } else { 1 }
    }
}

/// Bytes of an output frame as the engine gives it: planar 8-bit 4:2:0 (yuv420p).
pub fn output_bytes(width: u32, height: u32) -> usize {
    PixelFormat::Yuv420p.frame_bytes(width, height)
}

/// A video source restarted at frame `k`: from in_point + k / fps x speed seconds, with the
/// timing filters of the plan's decoder (held and cut to `frames` for clips), then `tail`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Seek {
    pub src: String,
    pub in_point: f64,
    pub speed: f64,
    pub source_duration: f64,
    #[serde(default)]
    pub frames: Option<i64>,
    pub tail: Vec<String>,
}

impl Seek {
    /// ffmpeg arguments that decode the source from frame `k` on, writing `format`.
    pub fn args(&self, k: i64, fps: f64, format: PixelFormat) -> Vec<String> {
        let skipped = k as f64 / fps * self.speed;
        let mut filters = vec!["setpts=PTS-STARTPTS".to_string()];
        if self.speed != 1.0 {
            filters.push(format!("setpts=PTS/{}", self.speed));
        }
        filters.push(format!("fps={fps}"));
        if let Some(frames) = self.frames {
            filters.push("tpad=stop_mode=clone:stop=-1".into());
            filters.push(format!("trim=end_frame={}", (frames - k).max(1)));
        }
        filters.extend(self.tail.iter().cloned());
        let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin"].map(String::from).into();
        if self.in_point + skipped > 0.0 {
            args.extend(["-ss".into(), format!("{:.6}", self.in_point + skipped)]);
        }
        args.extend(["-t".into(), format!("{:.6}", (self.source_duration - skipped).max(1.0 / fps)), "-i".into(), self.src.clone()]);
        args.extend(["-an", "-sn", "-vf"].map(String::from));
        args.push(filters.join(","));
        let pix_fmt = match format {
            PixelFormat::Vuya => "vuya",
            PixelFormat::Yuv420p => "yuv420p",
            PixelFormat::Yuva420p => "yuva420p",
        };
        args.extend(["-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1"].map(String::from));
        args
    }
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

#[cfg(test)]
mod tests {
    use super::PixelFormat;

    #[test]
    fn planar_frames_are_laid_out_for_upload() {
        // 3 x 3: chroma planes of 2 x 2, rounded up.
        let (w, h) = (3, 3);
        assert_eq!(PixelFormat::Yuv420p.frame_bytes(w, h), 9 + 2 * 4);
        assert_eq!(PixelFormat::Yuva420p.frame_bytes(w, h), 18 + 2 * 4);
        let y: Vec<u8> = (0..9).collect();
        let (u, v, a) = ([20, 21, 22, 23], [30, 31, 32, 33], [40u8; 9]);
        let frame = [&y[..], &u, &v].concat();
        let out = PixelFormat::Yuv420p.for_upload(frame, w, h);
        assert_eq!(&out[..9], &y[..]);
        assert_eq!(&out[9..], &[20, 30, 21, 31, 22, 32, 23, 33]);
        let frame = [&y[..], &u, &v, &a].concat();
        let out = PixelFormat::Yuva420p.for_upload(frame, w, h);
        assert_eq!(&out[..4], &[0, 40, 1, 40]);
        assert_eq!(&out[18..], &[20, 30, 21, 31, 22, 32, 23, 33]);
    }
}
