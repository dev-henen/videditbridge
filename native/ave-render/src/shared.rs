//! Frames for the app's viewer through a memory-mapped file instead of picture files: the engine
//! writes each finished frame as BGRA, the app maps the same file and copies the pixels out. The
//! layout is read by ui/Preview/SharedFrame.cs (keep the two in step):
//!
//! | Bytes  | Field                                                             |
//! |--------|-------------------------------------------------------------------|
//! | 0..4   | `AVEF`                                                            |
//! | 4..8   | layout version (1), little-endian u32                             |
//! | 8..16  | sequence, u64: odd while a frame is being written, even when done |
//! | 16..20 | width, u32                                                        |
//! | 20..24 | height, u32                                                       |
//! | 24..32 | reserved                                                          |
//! | 32..   | width x height BGRA pixels, rows packed, opaque                   |

use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::sync::atomic::{fence, Ordering};

pub const HEADER: usize = 32;
const MAGIC: &[u8; 4] = b"AVEF";
const LAYOUT: u32 = 1;

/// Planar 8-bit 4:2:0 (yuv420p, BT.601 limited range, as the engine gives frames) to BGRA, each
/// chroma sample over its 2 x 2 block. For looking at, not for parity: exports go through ffmpeg.
pub fn yuv420p_to_bgra(yuv: &[u8], width: u32, height: u32, out: &mut [u8]) {
    let (w, h) = (width as usize, height as usize);
    let cw = w.div_ceil(2);
    let chroma = cw * h.div_ceil(2);
    let (y_plane, rest) = yuv.split_at(w * h);
    let (u_plane, v_plane) = rest.split_at(chroma);
    for row in 0..h {
        let crow = (row / 2) * cw;
        for col in 0..w {
            let y = (y_plane[row * w + col] as f32 - 16.0) / 219.0;
            let u = (u_plane[crow + col / 2] as f32 - 128.0) / 224.0;
            let v = (v_plane[crow + col / 2] as f32 - 128.0) / 224.0;
            let byte = |x: f32| (x * 255.0).round().clamp(0.0, 255.0) as u8;
            let i = (row * w + col) * 4;
            out[i] = byte(y + 1.772 * u);
            out[i + 1] = byte(y - 0.344136 * u - 0.714136 * v);
            out[i + 2] = byte(y + 1.402 * v);
            out[i + 3] = 255;
        }
    }
}

/// Write a yuv420p frame into the shared file at `path` (made or grown as needed) as BGRA, and
/// return its sequence number. The sequence is odd while the pixels are being written, so a reader
/// that sees it change, or odd, copies again.
pub fn write(path: &str, width: u32, height: u32, yuv: &[u8]) -> Result<u64, String> {
    let size = HEADER + (width * height * 4) as usize;
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|e| format!("shared frame {path}: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() < size as u64 {
        file.set_len(size as u64).map_err(|e| format!("shared frame {path}: {e}"))?;
    }
    // Safety: the app only reads this file, and readers check the sequence around their copy.
    let mut map = unsafe { MmapMut::map_mut(&file) }.map_err(|e| format!("mapping {path}: {e}"))?;
    let mut sequence = if &map[0..4] == MAGIC { u64::from_le_bytes(map[8..16].try_into().unwrap()) } else { 0 };
    sequence += sequence % 2 + 1; // odd: writing
    map[0..4].copy_from_slice(MAGIC);
    map[4..8].copy_from_slice(&LAYOUT.to_le_bytes());
    map[8..16].copy_from_slice(&sequence.to_le_bytes());
    fence(Ordering::Release);
    yuv420p_to_bgra(yuv, width, height, &mut map[HEADER..size]);
    map[16..20].copy_from_slice(&width.to_le_bytes());
    map[20..24].copy_from_slice(&height.to_le_bytes());
    fence(Ordering::Release);
    sequence += 1; // even: done
    map[8..16].copy_from_slice(&sequence.to_le_bytes());
    map.flush_async().map_err(|e| e.to_string())?;
    Ok(sequence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_frame_and_counts_up() {
        let dir = std::env::temp_dir().join(format!("ave-shared-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("frame.bin");
        let path = path.to_str().unwrap();
        // 2 x 2: video white (235) luma, neutral chroma.
        let yuv = [235, 235, 235, 235, 128, 128];
        assert_eq!(write(path, 2, 2, &yuv).unwrap(), 2);
        assert_eq!(write(path, 2, 2, &yuv).unwrap(), 4);
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(&bytes[0..4], b"AVEF");
        assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 2);
        assert_eq!(&bytes[HEADER..HEADER + 4], &[255, 255, 255, 255]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
