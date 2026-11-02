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
  ): Promise<Float32Array>;
  /** Draws particles, smoke, fog and lens flares into RGBA frames (see ParticleSpec). */
  ParticleRenderer: new (spec: ParticleSpec) => { frames(count: number): Promise<Uint8Array> };
  version(): string;
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
  return { pkg: `@ai-video-editor/native-${triple}`, file: `ave-native.${triple}.node` };
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
