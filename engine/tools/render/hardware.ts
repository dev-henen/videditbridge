import { runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/** Graphics-card H.264 encoders: NVIDIA, Intel Quick Sync, AMD, Apple VideoToolbox, Linux VAAPI. */
export type HardwareEncoder = "nvenc" | "qsv" | "amf" | "videotoolbox" | "vaapi";

/** The encoders each system can have, in the order they are tried. */
export function hardwareCandidates(platform: NodeJS.Platform = process.platform): HardwareEncoder[] {
  if (platform === "darwin") return ["videotoolbox"];
  if (platform === "linux") return ["nvenc", "qsv", "vaapi"];
  return ["nvenc", "qsv", "amf"];
}

/** The VAAPI device: $AVE_VAAPI_DEVICE, or the first render node. */
export const vaapiDevice = () => process.env.AVE_VAAPI_DEVICE || "/dev/dri/renderD128";

/**
 * Encoder arguments matching x264's `crf` quality. The offsets were set by comparing SSIM and
 * file size against libx264 medium on real footage (Quick Sync at quality 22 matched crf 20).
 * VideoToolbox's constant quality (Apple silicon) runs the other way, 1 to 100: crf 20 is about 66.
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
    case "videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-q:v", String(Math.max(1, Math.min(100, Math.round(118 - 2.6 * crf)))), "-pix_fmt", "yuv420p"];
    case "vaapi":
      // Frames arrive on the device (hardwareUpload); constant quantizer like AMF's.
      return ["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", q];
  }
}

/** Options the whole command needs for an encoder (VAAPI: open the device for the filters). */
export function hardwareGlobalArgs(encoder: HardwareEncoder | undefined): string[] {
  return encoder === "vaapi" ? ["-init_hw_device", `vaapi=va:${vaapiDevice()}`, "-filter_hw_device", "va"] : [];
}

/** Filters that end the picture's chain for an encoder (VAAPI: upload the frames to the device), or undefined. */
export function hardwareUpload(encoder: HardwareEncoder | undefined): string | undefined {
  return encoder === "vaapi" ? "format=nv12,hwupload" : undefined;
}

/** A tiny test encode with an encoder: global options, the test picture, its upload and its arguments. */
export function hardwareTestArgs(encoder: HardwareEncoder): string[] {
  const upload = hardwareUpload(encoder);
  return [
    "-hide_banner", "-loglevel", "error",
    ...hardwareGlobalArgs(encoder),
    "-f", "lavfi", "-i", "color=c=gray:s=256x256:r=30:d=0.2",
    ...(upload ? ["-vf", upload] : []),
    ...hardwareEncoderArgs(encoder, 20),
    "-f", "null", "-",
  ];
}

const detected = new Map<string, Promise<HardwareEncoder | undefined>>();

/**
 * The first hardware H.264 encoder that works on this machine, or undefined. Each candidate for this
 * system is tried with a tiny test encode, since a build can list an encoder whose driver or device
 * is missing (VideoToolbox's constant quality also needs Apple silicon). The answer is kept for the
 * rest of the process.
 */
export function detectHardwareEncoder(opts: FfmpegOptions = {}): Promise<HardwareEncoder | undefined> {
  const key = opts.ffmpegPath ?? "";
  let found = detected.get(key);
  if (!found) {
    found = (async () => {
      for (const enc of hardwareCandidates()) {
        const r = await runFfmpeg(hardwareTestArgs(enc), opts).catch(() => undefined);
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
