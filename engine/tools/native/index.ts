import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ParticleSystemSpec } from "../../library/particles/index.js";

/**
 * The Rust kernels (native/ave-native, see docs/design/cinematic-grade-and-vfx.md section 3.5).
 * Every call takes a whole buffer and returns a promise; the work runs off the JavaScript thread.
 */
export interface NativeKernels {
  /** Per-frame level (dBFS), zero-crossing rate, spectral flux and flatness of 16 kHz mono samples. */
  frameFeatures(samples: Float32Array): Promise<{ level: Float32Array; zcr: Float32Array; flux: Float32Array; flatness: Float32Array }>;
  /**
   * Follow a region (non-zero bytes of `region` on the first frame) through `count` gray frames
   * packed in `frames`: one 3x3 row-major transform per frame, from the first frame's pixels.
   */
  trackRegion(
    frames: Uint8Array,
    width: number,
    height: number,
    count: number,
    region: Uint8Array,
    options?: { model?: "translation" | "similarity" | "affine" | "homography"; maxPoints?: number; inset?: number },
    control?: TaskControl,
  ): Promise<{ matrices: Float64Array; inliers: Uint32Array; errors: Float32Array; redetected: Uint8Array }>;
  /** Snap mask edges (0..255) to a gray guide of the same size; several frames may be packed back to back. */
  guidedFilter(guide: Uint8Array, mask: Uint8Array, width: number, height: number, radius: number, eps: number): Promise<Uint8Array>;
  /** Warp a mask by each transform (9 numbers each, from the mask's pixels): one mask per transform, back to back. */
  warpMasks(mask: Uint8Array, width: number, height: number, matrices: Float64Array): Promise<Uint8Array>;
  /**
   * Depth for every frame of a chunk from the model's disparity on keyframes (`keys`, from 0 to
   * count - 1, one map per key): fitted keyframe to keyframe, carried along the camera's `motion`
   * (9 numbers per frame, from frame 0's pixels), edges snapped to the gray frames, blended over time.
   * Distance 0 (near) .. 1 (far), frame after frame.
   */
  depthSequence(
    gray: Uint8Array,
    width: number,
    height: number,
    count: number,
    keys: Uint32Array,
    disparity: Float32Array,
    motion: Float64Array,
    options?: { radius?: number; eps?: number; keep?: number; previous?: Float32Array },
    control?: TaskControl,
  ): Promise<Float32Array>;
  /** Cancelling and progress for `trackRegion` and `depthSequence` (see `controlled`). */
  TaskControl: new () => TaskControl;
  /** Draws particles, smoke, fog and lens flares into RGBA frames (see ParticleSpec). */
  ParticleRenderer: new (spec: ParticleSpec) => { frames(count: number): Promise<Uint8Array> };
  /**
   * Fills the area under an object with what other frames of the clip show there (object removal):
   * `motion` is 9 numbers per frame of the clip, from frame 0's pixels to that frame's.
   */
  Remover: new (width: number, height: number, motion: Float64Array, options?: RemoverOptions) => NativeRemover;
  version(): string;
}

/** Cancels a kernel at its next frame, and counts its steps while it runs. */
export interface TaskControl {
  cancel(): void;
  readonly done: number;
  readonly total: number;
}

/**
 * Run a kernel call with a `TaskControl` tied to `signal` (aborting cancels the kernel at its next
 * frame and rejects with the signal's reason) and to `onProgress` (the kernel's fraction done, a few
 * times a second). Without either, the call gets no control.
 */
export async function controlled<T>(opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void }, run: (control?: TaskControl) => Promise<T>): Promise<T> {
  const { signal, onProgress } = opts;
  signal?.throwIfAborted();
  if (!signal && !onProgress) return run();
  const control = new (native().TaskControl)();
  const abort = () => control.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  const report = () => {
    if (control.total > 0) onProgress?.(control.done / control.total);
  };
  const timer = onProgress ? setInterval(report, 250) : undefined;
  try {
    const out = await run(control);
    report();
    return out;
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw e;
  } finally {
    if (timer) clearInterval(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export interface RemoverOptions {
  /** Grow the mask by this many pixels, then fade out over `feather`. */
  grow?: number;
  feather?: number;
  /** Ring around the hole where each pool frame's exposure is matched, pixels. */
  ring?: number;
  /** The camera does not move: the median of the whole pool, without exposure matching. */
  locked?: boolean;
  /** Pool frames a moving camera's fill takes the median of: those that line up best around the hole (default 3). */
  nearest?: number;
  /** Leftovers within this many pixels of a filled one are interpolated; thicker ones come back in `residual`. */
  thin?: number;
}

export interface RemovalFill {
  /** Straight-alpha RGBA: the fill inside the hole, fading out over the feather; clear elsewhere. */
  rgba: Uint8Array;
  /** 1 where nothing could fill the hole; `rgba` holds the frame itself there. */
  residual: Uint8Array;
  /** Pixels in the hole; filled from real frames, from layers, interpolated; and left over. */
  hole: number;
  real: number;
  layered: number;
  interpolated: number;
  left: number;
}

export interface NativeRemover {
  /** Frame `index` (RGB) and its object mask (0..255) join the pool. */
  addFrame(index: number, rgb: Uint8Array, mask: Uint8Array): Promise<null>;
  /** Frame `index`'s filled picture (RGB) and where it was generated (1) become a layer later fills take from. */
  addLayer(index: number, rgb: Uint8Array, generated: Uint8Array): Promise<null>;
  /** Fill frame `index` (RGB) under its object mask. */
  fill(index: number, rgb: Uint8Array, mask: Uint8Array): Promise<RemovalFill>;
}

/**
 * A particle generator spec (native/ave-native/src/particles.rs documents every field; the systems
 * are the library's, see engine/library/particles).
 */
export interface ParticleSpec {
  width: number;
  height: number;
  fps: number;
  seed: number;
  /** Seconds simulated before the first frame. */
  preroll: number;
  /** Simulated time per output frame, in frames (the footage's speed); missing frames are 1. */
  timeScale?: number[];
  systems: ParticleSystemSpec[];
}

/** The prebuilt package for this machine, and the file `npm run native` builds. */
export function nativeTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): { pkg: string; file: string } {
  const triple = `${platform}-${arch}${platform === "win32" ? "-msvc" : platform === "linux" ? "-gnu" : ""}`;
  return { pkg: `@videditbridge/native-${triple}`, file: `ave-native.${triple}.node` };
}

let loaded: NativeKernels | undefined;

/**
 * Load the kernels: the prebuilt package for this platform if installed, else a local build in
 * native/ave-native. There is no slow fallback, so a missing build is an error that says what to do.
 */
export function native(): NativeKernels {
  if (loaded) return loaded;
  const require = createRequire(import.meta.url);
  const { pkg, file } = nativeTarget();
  // Same depth from engine/tools/native and dist/tools/native.
  const local = path.resolve(import.meta.dirname, "..", "..", "..", "native", "ave-native", file);
  const tried: string[] = [];
  for (const id of [pkg, local]) {
    if (id === local && !existsSync(local)) {
      tried.push(`${local} (not built)`);
      continue;
    }
    try {
      return (loaded = require(id) as NativeKernels);
    } catch (e) {
      tried.push(`${id} (${(e as Error).message.split("\n")[0]})`);
    }
  }
  throw new Error(
    `The native kernels (ave-native) are not available for ${process.platform}-${process.arch}. Install ${pkg}, or build them from source with "npm run native" (needs Rust, see native/README.md). Tried: ${tried.join("; ")}`,
  );
}
