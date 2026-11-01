import { clipAtTime, computeTimeline, timelineToSource } from "../../core/timeline.js";
import type { Project } from "../../core/schema.js";
import { getParticlePreset, resolveParticles, type ParticleSettings, type ParticleSystemSpec } from "../../library/particles/index.js";
import { writeAlphaVideo } from "../graphics/index.js";
import { native, type ParticleSpec } from "../native/index.js";
import type { FfmpegOptions } from "../render/ffmpeg.js";
import { renderForAnalysis, type RenderOptions } from "../render/render.js";

/**
 * Atmosphere and light layers (section 6 of docs/design/cinematic-grade-and-vfx.md): particles,
 * smoke, fog and lens flares drawn by the Rust generator into a transparent video, which a media
 * layer places over the picture with a blend mode. Drawn once when the layer is made, so renders
 * only read the file.
 */

/**
 * The playback speed of the footage under each frame from `start` (1 where no clip plays), so rain
 * and snow slow down with slow-motion footage.
 */
export function footageSpeeds(project: Project, start: number, frames: number): number[] {
  const timeline = computeTimeline(project);
  const { fps } = project.settings;
  return Array.from({ length: frames }, (_, f) => {
    const t = start + f / fps;
    const tc = clipAtTime(timeline, t);
    if (!tc) return 1;
    return tc.speedMap ? tc.speedMap.speedAt(timelineToSource(tc, t) - tc.clip.in) : tc.clip.speed;
  });
}

/** The generator spec of a preset with settings, for a layer of `duration` seconds from `start`. */
export function particleSpec(project: Project, preset: string, settings: ParticleSettings, start: number, duration: number, followSpeed: boolean): ParticleSpec {
  const p = getParticlePreset(preset);
  if (!p) throw new Error(`Unknown particle preset "${preset}"`);
  const { width, height, fps } = project.settings;
  const { systems, preroll } = resolveParticles(p, settings);
  const frames = Math.max(1, Math.round(duration * fps));
  return { width, height, fps, seed: settings.seed, preroll, systems, timeScale: followSpeed ? footageSpeeds(project, start, frames) : undefined };
}

/** Draw `frames` frames of a spec into a transparent video (.mkv) at `file`. */
export async function drawParticles(
  spec: ParticleSpec,
  frames: number,
  file: string,
  opts: FfmpegOptions & { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  const renderer = new (native().ParticleRenderer)(spec);
  // About 64 MB of frames per call: coarse enough to keep the generator busy, small enough to stream.
  const batch = Math.max(1, Math.min(32, Math.floor(64e6 / (spec.width * spec.height * 4))));
  let done = 0;
  await writeAlphaVideo(file, { ...opts, width: spec.width, height: spec.height, fps: spec.fps, what: "the particles" }, async () => {
    if (done >= frames) return undefined;
    opts.signal?.throwIfAborted();
    const n = Math.min(batch, frames - done);
    const px = await renderer.frames(n);
    done += n;
    opts.onProgress?.(done / frames);
    return px;
  });
}

/** A lens flare's generator spec: the source and its brightness for each frame. */
export function flareSpec(project: Project, flare: Omit<Extract<ParticleSystemSpec, { flare: unknown }>["flare"], "positions" | "intensity">, positions: [number, number][], intensity: number[]): ParticleSpec {
  const { width, height, fps } = project.settings;
  return { width, height, fps, seed: 1, preroll: 0, systems: [{ flare: { ...flare, positions: positions.flat(), intensity } }] };
}

/**
 * How bright the picture is around a light source at each time (0 = no light there, 1 = a blown-out
 * light), from frames of the finished picture: the 90th percentile of the brightness in a small
 * disc around the source, 0 below mid gray and 1 at clipping.
 */
export async function sourceBrightness(project: Project, samples: { time: number; x: number; y: number }[], opts: Omit<RenderOptions, "output" | "range">): Promise<number[]> {
  if (!samples.length) return [];
  const { frames, width: w, height: h } = await renderForAnalysis(project, { ...opts, scale: 0.25, framesAt: samples.map((s) => s.time), onProgress: undefined });
  return samples.map((s, k) => {
    const rgb = frames[k]?.rgb;
    if (!rgb) return 0;
    // The source may sit just outside the frame (the sun behind an edge): look at the nearest edge.
    const cx = Math.min(w - 1, Math.max(0, s.x * w));
    const cy = Math.min(h - 1, Math.max(0, s.y * h));
    const r = Math.max(2, 0.04 * h);
    const lumas: number[] = [];
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = (y * w + x) * 3;
        lumas.push(0.2126 * rgb[i]! + 0.7152 * rgb[i + 1]! + 0.0722 * rgb[i + 2]!);
      }
    lumas.sort((a, b) => a - b);
    const p90 = (lumas[Math.floor(0.9 * (lumas.length - 1))] ?? 0) / 255;
    const u = Math.min(1, Math.max(0, (p90 - 0.5) / 0.47));
    const outside = Math.hypot(Math.max(0, -s.x, s.x - 1), Math.max(0, -s.y, s.y - 1));
    return u * u * (3 - 2 * u) * Math.exp(-outside / 0.15);
  });
}
