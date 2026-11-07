//! ave-render: the GPU render engine of ai-video-editor (docs/design/cinematic-grade-and-vfx.md,
//! section 3.4). A separate process speaking JSON-RPC 2.0 over stdio, one message per line:
//!
//! - `info` opens the graphics device and describes it.
//! - `render` takes an engine plan (engine/tools/render/plan.ts) and writes the video; it sends
//!   `progress` notifications ({ frame, frames }) a few times a second.
//! - `cancel` (a notification) stops the render in progress.
//! - `open` keeps a plan ready for drawing single frames (previews, scrubbing) and returns a session
//!   id; `frame` ({ session, frame, args }) draws one and hands it to ffmpeg with `args`, which read
//!   yuv420p frames on stdin (to write a picture), or with `shared` (a path) writes it as BGRA into
//!   that memory-mapped file for the app's viewer (shared.rs); `close` ends a session. A
//!   session keeps its decoders, so nearby frames come quickly.
//! - `shutdown` ends the process.
//!
//! stdout carries protocol messages only. A failure, panics included, is an error reply; the
//! process keeps serving.

mod effects;
mod gpu;
mod media;
mod plan;
mod render;
mod shared;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

fn send(out: &Mutex<std::io::Stdout>, message: Value) {
    let mut out = out.lock().unwrap();
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

fn panic_text(e: Box<dyn std::any::Any + Send>) -> String {
    e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "unknown panic".into())
}

fn main() {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = channel::<Value>();
    {
        let cancel = cancel.clone();
        let out = out.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(m) if m["method"] == "cancel" => cancel.store(true, Ordering::Relaxed),
                    Ok(m) => {
                        if tx.send(m).is_err() {
                            break;
                        }
                    }
                    Err(e) => send(&out, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } })),
                }
            }
        });
    }
    // The device lives as long as the process (sessions hold it); after a panic a new one is opened
    // and the old one, with its sessions, is dropped.
    let mut gpu: Option<&'static gpu::Gpu> = None;
    let mut sessions: HashMap<u64, render::Composer<'static>> = HashMap::new();
    let mut next_session = 1u64;
    for message in rx {
        let id = message["id"].clone();
        let method = message["method"].as_str().unwrap_or("").to_string();
        let reply = |result: Result<Value, String>| match result {
            Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": 1, "message": e } }),
        };
        if method == "shutdown" {
            send(&out, reply(Ok(Value::Null)));
            break;
        }
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<Value, String> {
            if gpu.is_none() {
                gpu = Some(Box::leak(Box::new(gpu::Gpu::new()?)));
            }
            let g: &'static gpu::Gpu = gpu.unwrap();
            let params = &message["params"];
            match method.as_str() {
                "info" => Ok(g.describe()),
                "render" => {
                    let plan: plan::Plan = serde_json::from_value(params.clone()).map_err(|e| format!("invalid plan: {e}"))?;
                    cancel.store(false, Ordering::Relaxed);
                    let out = out.clone();
                    render::render(g, Arc::new(plan), &cancel, &mut |frame, frames| {
                        send(&out, json!({ "jsonrpc": "2.0", "method": "progress", "params": { "frame": frame, "frames": frames } }))
                    })
                }
                "open" => {
                    let plan: plan::Plan = serde_json::from_value(params.clone()).map_err(|e| format!("invalid plan: {e}"))?;
                    let id = next_session;
                    next_session += 1;
                    sessions.insert(id, render::Composer::new(g, Arc::new(plan))?);
                    Ok(json!({ "session": id }))
                }
                "frame" => {
                    let id = params["session"].as_u64().ok_or("frame needs a session")?;
                    let c = sessions.get_mut(&id).ok_or_else(|| format!("no session {id}"))?;
                    let n = params["frame"].as_i64().unwrap_or(0);
                    match params["shared"].as_str() {
                        Some(path) => render::frame_shared(c, n, path),
                        None => {
                            let args: Vec<String> = serde_json::from_value(params["args"].clone()).map_err(|e| format!("invalid args: {e}"))?;
                            render::frame(c, n, &args)
                        }
                    }
                }
                "close" => {
                    sessions.remove(&params["session"].as_u64().unwrap_or(0));
                    Ok(Value::Null)
                }
                _ => Err(format!("unknown method {method}")),
            }
        }));
        let result = outcome.unwrap_or_else(|e| {
            // The device may be unusable after a panic: open it again on the next call.
            gpu = None;
            sessions.clear();
            Err(format!("ave-render panicked: {}", panic_text(e)))
        });
        send(&out, reply(result));
    }
}
