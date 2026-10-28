import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runFfmpeg, runFfmpegOrThrow } from "../../engine/tools/render/ffmpeg.js";

export const OUT_DIR = path.resolve(import.meta.dirname, "..", ".output");

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    return (await runFfmpeg(["-version"])).code === 0;
  } catch {
    return false;
  }
}

export interface Fixtures {
  /** 4s 1280x720 test pattern with a 440Hz tone. */
  talk: string;
  /** 3s 720x1280 pattern, no audio. */
  silentVertical: string;
  /** 640x480 still image. */
  image: string;
  /** 8s music-like tone. */
  music: string;
}

/** Generate synthetic media with lavfi so tests need no binary fixtures. Cached between runs. */
export async function makeFixtures(): Promise<Fixtures> {
  const dir = path.join(OUT_DIR, "fixtures");
  await mkdir(dir, { recursive: true });
  const f: Fixtures = {
    talk: path.join(dir, "talk.mp4"),
    silentVertical: path.join(dir, "silent-vertical.mp4"),
    image: path.join(dir, "image.png"),
    music: path.join(dir, "music.m4a"),
  };
  const base = ["-y", "-hide_banner", "-loglevel", "error"];
  if (!existsSync(f.talk))
    await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f.talk]);
  if (!existsSync(f.silentVertical))
    await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "testsrc=s=720x1280:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", f.silentVertical]);
  if (!existsSync(f.image))
    await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "mandelbrot=s=640x480", "-frames:v", "1", f.image]);
  if (!existsSync(f.music))
    await runFfmpegOrThrow([...base, "-f", "lavfi", "-i", "sine=f=220:d=8,volume=0.5", "-c:a", "aac", f.music]);
  return f;
}
