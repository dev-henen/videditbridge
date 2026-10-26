import { runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/** Graphics-card H.264 encoders, in the order they are tried. */
export type HardwareEncoder = "nvenc" | "qsv" | "amf";

const ORDER: HardwareEncoder[] = ["nvenc", "qsv", "amf"];

/**
 * Encoder arguments matching x264's `crf` quality. The offsets were set by comparing SSIM and
 * file size against libx264 medium on real footage (Quick Sync at quality 22 matched crf 20).
 */
export function hardwareEncoderArgs(encoder: HardwareEncoder, crf: number): string[] {
  const q = String(Math.min(51, crf + 2));
  switch (encoder) {
    case "nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q, "-b:v", "0", "-pix_fmt", "yuv420p"];
    case "qsv":
      return ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", q, "-pix_fmt", "nv12"];
    case "amf":
      return ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", String(crf), "-qp_p", q, "-pix_fmt", "nv12"];
  }
}

const detected = new Map<string, Promise<HardwareEncoder | undefined>>();

/**
 * The first hardware H.264 encoder that works on this machine, or undefined. Each candidate is
 * tried with a tiny test encode, since a build can list an encoder whose driver or device is
 * missing. The answer is kept for the rest of the process.
 */
export function detectHardwareEncoder(opts: FfmpegOptions = {}): Promise<HardwareEncoder | undefined> {
  const key = opts.ffmpegPath ?? "";
  let found = detected.get(key);
  if (!found) {
    found = (async () => {
      for (const enc of ORDER) {
        const r = await runFfmpeg(
          ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=256x256:r=30:d=0.2", ...hardwareEncoderArgs(enc, 20), "-f", "null", "-"],
          opts,
        ).catch(() => undefined);
        if (r?.code === 0) return enc;
      }
      return undefined;
    })();
    detected.set(key, found);
  }
  return found;
}

/** x264 presets slower than these gain from a hardware encoder; faster ones are already quicker in software. */
const FAST_PRESETS = ["ultrafast", "superfast", "veryfast"];

export function wantsHardware(codec: string, preset: string): boolean {
  return codec === "libx264" && !FAST_PRESETS.includes(preset);
}
