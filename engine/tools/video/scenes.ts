import { round3 } from "../../core/util.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";

export interface SceneChange {
  /** Source time of the first frame of the new shot. */
  time: number;
  /** 0..1, how different the frame is from the one before. */
  score: number;
}

/**
 * Find shot changes (hard cuts between camera angles or scenes) in a video file.
 * Frames are compared at low resolution, so this is fast even on long footage.
 * `threshold` 0.3 finds clear cuts; lower it (0.15-0.2) to also catch gentle ones.
 */
export async function detectScenes(
  src: string,
  opts: FfmpegOptions & { threshold?: number; start?: number; duration?: number; minGap?: number } = {},
): Promise<SceneChange[]> {
  const threshold = opts.threshold ?? 0.3;
  const res = await runFfmpegOrThrow(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(opts.start ? ["-ss", String(opts.start)] : []),
      ...(opts.duration ? ["-t", String(opts.duration)] : []),
      "-i",
      src,
      "-an",
      "-vf",
      `scale=160:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
      "-f",
      "null",
      "-",
    ],
    opts,
  );
  const out: SceneChange[] = [];
  let time: number | undefined;
  for (const line of res.stdout.split(/\r?\n/)) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) time = Number(t[1]) + (opts.start ?? 0);
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s && time !== undefined) {
      const prev = out[out.length - 1];
      // A flash or fast whip can trigger on several frames in a row: keep the strongest.
      if (prev && time - prev.time < (opts.minGap ?? 0.5)) {
        if (Number(s[1]) > prev.score) Object.assign(prev, { time: round3(time), score: round3(Number(s[1])) });
      } else out.push({ time: round3(time), score: round3(Number(s[1])) });
      time = undefined;
    }
  }
  return out;
}
