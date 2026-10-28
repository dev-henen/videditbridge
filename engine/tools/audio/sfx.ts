import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getSoundEffect } from "../../library/sound-effects/index.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";

/**
 * Render a synthesized sound effect to a WAV file in `dir`. Files are named by effect and
 * params, so the same sound is rendered once and reused.
 */
export async function renderSoundEffect(
  id: string,
  params: Record<string, unknown> = {},
  dir: string,
  opts: FfmpegOptions = {},
): Promise<{ path: string; duration: number; peak: number }> {
  const def = getSoundEffect(id);
  if (!def) throw new Error(`Unknown sound effect "${id}"`);
  const p = def.params.parse(params);
  const hash = createHash("sha1").update(JSON.stringify(p)).digest("hex").slice(0, 8);
  const file = path.join(dir, `${id}-${hash}.wav`);
  if (!existsSync(file)) {
    await mkdir(dir, { recursive: true });
    await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-filter_complex", def.graph(p), "-map", "[sfx]", "-ac", "1", "-c:a", "pcm_s16le", file], opts);
  }
  return { path: file, duration: def.duration(p), peak: def.peak?.(p) ?? 0 };
}
