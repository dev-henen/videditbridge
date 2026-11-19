import path from "node:path";
import { escapeFilterPath } from "../../library/effects/index.js";
import { bundledFontsDir } from "../fonts/index.js";
import { runFfmpeg, runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";

/** A source file seen before it is cut: a grid of frames with their source times, and how much moves each second. */
export interface MediaLook {
  /** The grid image. */
  output: string;
  /** Source seconds of the frames in the grid, left to right, top to bottom. */
  times: number[];
  /** Mean frame-to-frame change per source second (0 = still; footage with people dancing is often 4 to 15). */
  motion: { second: number; value: number }[];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Motion per second from `signalstats` lines of a difference stream (`metadata=print` on stderr):
 * the mean of each second's frame differences, with times moved by `offset` into source seconds.
 */
export function parseMotion(stderr: string, offset = 0): { second: number; value: number }[] {
  const sums = new Map<number, { total: number; n: number }>();
  let t: number | undefined;
  for (const line of stderr.split("\n")) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) t = Number(pts[1]);
    const v = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (v && t !== undefined) {
      const second = Math.floor(t + offset);
      const s = sums.get(second) ?? { total: 0, n: 0 };
      s.total += Number(v[1]);
      s.n++;
      sums.set(second, s);
    }
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([second, s]) => ({ second, value: round1(s.total / s.n) }));
}

/** Render the grid and measure motion for `src` between `start` and `end` (source seconds). */
export async function lookAtMedia(
  src: string,
  opts: FfmpegOptions & { output: string; duration: number; start?: number; end?: number; frames?: number; columns?: number; thumbWidth?: number; signal?: AbortSignal },
): Promise<MediaLook> {
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(opts.duration, opts.end ?? opts.duration);
  const span = Math.max(0.1, end - start);
  const frames = Math.max(1, Math.min(48, opts.frames ?? 20));
  const columns = Math.max(1, Math.min(frames, opts.columns ?? 5));
  const rows = Math.ceil(frames / columns);
  const every = span / frames;
  const width = opts.thumbWidth ?? Math.max(120, Math.floor(1800 / columns));
  const font = escapeFilterPath(path.join(bundledFontsDir(), "Arimo-700.ttf"));
  // One frame every `every` seconds from the start, each stamped with its source time (pts plus the seek).
  const times = Array.from({ length: frames }, (_, k) => round1(start + every * k));
  const stamp = `drawtext=fontfile='${font}':text='%{pts\\:hms\\:${start}}':x=6:y=6:fontsize=${Math.max(14, Math.round(width / 16))}:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=4`;
  const graph = `fps=${1 / every},scale=${width}:-2,${stamp},tile=${columns}x${rows}:padding=4:color=black`;
  await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-ss", String(start), "-t", String(span), "-i", src, "-vf", graph, "-frames:v", "1", opts.output], {
    ffmpegPath: opts.ffmpegPath,
    signal: opts.signal,
  });
  // Small gray frames at 5 a second, each minus the one before, averaged.
  const motionGraph = "fps=5,scale=96:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG";
  const res = await runFfmpeg(["-hide_banner", "-ss", String(start), "-t", String(span), "-i", src, "-an", "-vf", motionGraph, "-f", "null", "-"], { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  return { output: opts.output, times, motion: parseMotion(res.stderr, start) };
}
