//! Cancelling and progress for kernels that work through many frames (see
//! docs/design/cinematic-grade-and-vfx.md, section 3.5). The JavaScript side holds the same
//! `Control` (a `TaskControl`): an AbortSignal sets the cancel flag, and progress is read from it a
//! few times a second. Kernels count a step per unit of work and stop at the next step once
//! cancelled.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

#[derive(Default, Debug)]
pub struct Control {
    cancelled: AtomicBool,
    done: AtomicU32,
    total: AtomicU32,
}

/// A kernel stopped because its control was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl Control {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// A kernel starts: `total` steps to go.
    pub fn start(&self, total: u32) {
        self.done.store(0, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
    }

    /// Stop here if cancelled.
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.is_cancelled() { Err(Cancelled) } else { Ok(()) }
    }

    /// One step done (safe from several threads); stop here if cancelled.
    pub fn step(&self) -> Result<(), Cancelled> {
        self.done.fetch_add(1, Ordering::Relaxed);
        self.check()
    }

    /// Steps done and the total of the kernel running.
    pub fn progress(&self) -> (u32, u32) {
        (self.done.load(Ordering::Relaxed).min(self.total.load(Ordering::Relaxed)), self.total.load(Ordering::Relaxed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_steps_and_stops_once_cancelled() {
        let c = Control::default();
        c.start(3);
        assert_eq!(c.step(), Ok(()));
        assert_eq!(c.progress(), (1, 3));
        c.cancel();
        assert_eq!(c.step(), Err(Cancelled));
        assert_eq!(c.check(), Err(Cancelled));
        // Done never reads past the total.
        c.step().ok();
        c.step().ok();
        assert_eq!(c.progress(), (3, 3));
    }
}
