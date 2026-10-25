import { writeFile } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import type { SoundKind, SoundMap } from "./analyze.js";

/** Band colors in the sound map picture (the picture is for Claude, not the app UI). */
export const SOUND_MAP_COLORS: Record<SoundKind, string> = { speech: "0x3FBF5F", music: "0x4C7DFF", sound: "0xF0A030", silence: "0x2A2A2A" };

/**
 * Draw a sound map as a PNG: the waveform on top, a colored band per segment below
 * (speech green, music blue, other sound orange, silence dark), a tick every 10% of the
 * duration, and red marks at loud moments and white marks at beats when given.
 */
export async function renderSoundMapImage(
  src: string,
  map: SoundMap,
  output: string,
  opts: FfmpegOptions & { start?: number; beats?: number[]; width?: number } = {},
): Promise<string> {
  const W = opts.width ?? 1600;
  const waveH = 200;
  const bandY = waveH + 6;
  const bandH = 34;
  const H = bandY + bandH + 4;
  const x = (t: number) => Math.round((t / Math.max(0.001, map.duration)) * W);
  const boxes: string[] = [];
  for (const s of map.segments) {
    const w = Math.max(1, x(s.end) - x(s.start));
    boxes.push(`drawbox=x=${x(s.start)}:y=${bandY}:w=${w}:h=${bandH}:color=${SOUND_MAP_COLORS[s.kind]}:t=fill`);
  }
  for (let i = 1; i < 10; i++) boxes.push(`drawbox=x=${Math.round((i * W) / 10)}:y=0:w=1:h=${H}:color=0x606060@0.6:t=fill`);
  for (const b of opts.beats ?? []) boxes.push(`drawbox=x=${x(b)}:y=${bandY + bandH - 8}:w=1:h=8:color=white:t=fill`);
  for (const m of map.loudMoments) boxes.push(`drawbox=x=${Math.max(0, x(m.time) - 1)}:y=0:w=3:h=${waveH}:color=0xFF3030@0.8:t=fill`);
  const graph = [
    `[0:a]aformat=channel_layouts=mono,showwavespic=s=${W}x${waveH}:colors=0xB8B8B8:scale=sqrt[w]`,
    `[w]pad=${W}:${H}:0:0:color=0x101010,format=rgb24${boxes.length ? `,${boxes.join(",")}` : ""}[out]`,
  ].join(";\n");
  const script = `${output}.graph.txt`;
  await writeFile(script, graph, "utf8");
  await runFfmpegOrThrow(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...(opts.start ? ["-ss", String(round3(opts.start))] : []),
      "-t",
      String(round3(map.duration)),
      "-i",
      src,
      "-filter_complex_script",
      path.basename(script),
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-update",
      "1",
      path.resolve(output),
    ],
    { ...opts, cwd: path.dirname(script) },
  );
  return output;
}
