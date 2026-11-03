//! ave-render: the GPU render engine of ai-video-editor (docs/design/cinematic-grade-and-vfx.md,
//! section 3.4). A separate process speaking JSON-RPC 2.0 over stdio, one message per line:
//!
//! - `info` opens the graphics device and describes it.
//! - `render` takes an engine plan (engine/tools/render/plan.ts) and writes the video; it sends
//!   `progress` notifications ({ frame, frames }) a few times a second.
//! - `cancel` (a notification) stops the render in progress.
//! - `shutdown` ends the process.
//!
//! stdout carries protocol messages only. A failure, panics included, is an error reply; the
//! process keeps serving.

mod gpu;
mod media;
mod plan;
mod render;

use serde_json::{json, Value};
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
    let mut gpu: Option<gpu::Gpu> = None;
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
                gpu = Some(gpu::Gpu::new()?);
            }
            let g = gpu.as_ref().unwrap();
            match method.as_str() {
                "info" => Ok(g.describe()),
                "render" => {
                    let plan: plan::Plan = serde_json::from_value(message["params"].clone()).map_err(|e| format!("invalid plan: {e}"))?;
                    cancel.store(false, Ordering::Relaxed);
                    let out = out.clone();
                    render::render(g, &plan, &cancel, &mut |frame, frames| {
                        send(&out, json!({ "jsonrpc": "2.0", "method": "progress", "params": { "frame": frame, "frames": frames } }))
                    })
                }
                _ => Err(format!("unknown method {method}")),
            }
        }));
        let result = outcome.unwrap_or_else(|e| {
            // The device may be unusable after a panic: open it again on the next call.
            gpu = None;
            Err(format!("ave-render panicked: {}", panic_text(e)))
        });
        send(&out, reply(result));
    }
}
