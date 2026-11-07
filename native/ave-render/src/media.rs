//! ffmpeg processes: decoders that write YUV frames to a pipe, read on their own threads a few
//! frames ahead, and the encoder that takes the finished frames on its stdin.

use crate::plan::PixelFormat;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// Frames a decoder reads ahead of the renderer.
const READ_AHEAD: usize = 3;

fn command(ffmpeg: &str, args: &[String], cwd: Option<&str>) -> Command {
    let mut c = Command::new(ffmpeg);
    c.args(args).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Keep the last part of a process's stderr, for error messages.
fn collect_stderr(child: &mut Child) -> Arc<Mutex<String>> {
    let log = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut s = log.lock().unwrap();
                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                if s.len() > 20_000 {
                    let cut = s.len() - 10_000;
                    let cut = (cut..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(0);
                    s.drain(..cut);
                }
            }
        });
    }
    log
}

fn tail(log: &Arc<Mutex<String>>) -> String {
    let s = log.lock().unwrap();
    s.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

pub struct Decoder {
    child: Child,
    frames: Receiver<Vec<u8>>,
    log: Arc<Mutex<String>>,
    /// The latest frame read and its index, and the one before it.
    pub current: Option<(i64, Vec<u8>)>,
    pub previous: Option<(i64, Vec<u8>)>,
    pub ended: bool,
    /// The index of the first frame it gives (0, or where it was started for a seek).
    pub base: i64,
}

impl Decoder {
    /// Start ffmpeg with `args`, which write `width` x `height` frames in `format`; frames are
    /// rearranged for upload (`PixelFormat::for_upload`) on the reading thread.
    pub fn start(ffmpeg: &str, args: &[String], cwd: Option<&str>, format: PixelFormat, (width, height): (u32, u32), base: i64) -> Result<Decoder, String> {
        let mut child = command(ffmpeg, args, cwd).stdout(Stdio::piped()).stdin(Stdio::null()).spawn().map_err(|e| format!("cannot start ffmpeg ({ffmpeg}): {e}"))?;
        let log = collect_stderr(&mut child);
        let mut out = child.stdout.take().unwrap();
        let (tx, rx) = sync_channel::<Vec<u8>>(READ_AHEAD);
        let frame_bytes = format.frame_bytes(width, height);
        std::thread::spawn(move || loop {
            let mut frame = vec![0u8; frame_bytes];
            if out.read_exact(&mut frame).is_err() || tx.send(format.for_upload(frame, width, height)).is_err() {
                break;
            }
        });
        Ok(Decoder { child, frames: rx, log, current: None, previous: None, ended: false, base })
    }

    /// Advance to frame `k` (never back). Returns whether the current frame changed; after the last
    /// frame the current one stays (check `current`'s index).
    pub fn seek(&mut self, k: i64) -> Result<bool, String> {
        let mut changed = false;
        while !self.ended && self.current.as_ref().map_or(true, |(i, _)| *i < k) {
            match self.frames.recv() {
                Ok(frame) => {
                    let next = self.current.as_ref().map_or(self.base, |(i, _)| i + 1);
                    self.previous = self.current.replace((next, frame));
                    changed = true;
                }
                Err(_) => {
                    self.ended = true;
                    let status = self.child.wait().map_err(|e| e.to_string())?;
                    if self.current.is_none() {
                        return Err(format!("ffmpeg gave no frames ({status}):\n{}", tail(&self.log)));
                    }
                }
            }
        }
        Ok(changed)
    }

    /// The index of the next frame it would read.
    pub fn next(&self) -> i64 {
        self.current.as_ref().map_or(self.base, |(i, _)| i + 1)
    }

    /// Frame `k`, when it is the current or the previous one.
    pub fn frame(&self, k: i64) -> Option<&Vec<u8>> {
        [&self.current, &self.previous].into_iter().flatten().find(|(i, _)| *i == k).map(|(_, f)| f)
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Encoder {
    child: Child,
    frames: Option<SyncSender<Vec<u8>>>,
    writer: Option<JoinHandle<Result<(), String>>>,
    log: Arc<Mutex<String>>,
}

impl Encoder {
    pub fn start(ffmpeg: &str, args: &[String], cwd: Option<&str>) -> Result<Encoder, String> {
        let mut child = command(ffmpeg, args, cwd).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().map_err(|e| format!("cannot start ffmpeg ({ffmpeg}): {e}"))?;
        let log = collect_stderr(&mut child);
        let mut stdin: ChildStdin = child.stdin.take().unwrap();
        let (tx, rx) = sync_channel::<Vec<u8>>(READ_AHEAD);
        let writer = std::thread::spawn(move || {
            for frame in rx {
                stdin.write_all(&frame).map_err(|e| e.to_string())?;
            }
            Ok(())
        });
        Ok(Encoder { child, frames: Some(tx), writer: Some(writer), log })
    }

    pub fn write(&mut self, frame: Vec<u8>) -> Result<(), String> {
        let sent = self.frames.as_ref().map(|tx| tx.send(frame).is_ok()).unwrap_or(false);
        if sent {
            Ok(())
        } else {
            // The writer stopped: the encoder failed.
            self.frames = None;
            let _ = self.writer.take().map(|w| w.join());
            let status = self.child.wait().map_err(|e| e.to_string())?;
            Err(format!("the encoder stopped ({status}):\n{}", tail(&self.log)))
        }
    }

    /// Close the encoder's input and wait for it to finish the file.
    pub fn finish(mut self) -> Result<(), String> {
        self.frames = None;
        let written = self.writer.take().map(|w| w.join().unwrap_or_else(|_| Err("writer panicked".into()))).unwrap_or(Ok(()));
        let status = self.child.wait().map_err(|e| e.to_string())?;
        if !status.success() || written.is_err() {
            return Err(format!("the encoder failed ({status}):\n{}", tail(&self.log)));
        }
        Ok(())
    }

    pub fn abort(mut self) {
        self.frames = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
