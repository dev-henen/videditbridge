import { runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/**
 * Everything the renderer and its effects ask of FFmpeg. FFmpeg builds differ per platform (the
 * static builds come from different builders), so a build can lack a library such as libass or zimg.
 */
export const REQUIRED_FFMPEG = {
  filters: [
    // Timeline, layers and text
    "ass", "concat", "xfade", "overlay", "scale", "zscale", "crop", "pad", "fps", "format", "setsar", "settb", "setpts", "trim", "split", "tpad", "rotate", "perspective",
    "alphamerge", "alphaextract", "maskedmerge", "blend", "geq", "colorkey", "chromakey", "despill", "zoompan", "tile", "select", "fade",
    // Color and looks
    "haldclut", "lut3d", "curves", "eq", "colorbalance", "colorchannelmixer", "colortemperature", "hue", "vibrance", "vignette", "lutrgb", "lutyuv", "selectivecolor", "colorlevels",
    // Blur, sharpen, cleanup
    "gblur", "boxblur", "avgblur", "unsharp", "cas", "hqdn3d", "deband", "noise", "lenscorrection", "deshake", "framerate",
    // Measurement
    "signalstats", "blackdetect", "freezedetect", "showwavespic",
    // Audio
    "anullsink", "anullsrc", "aformat", "aresample", "atrim", "asetpts", "adelay", "afade", "amix", "asplit", "atempo", "volume", "loudnorm", "ebur128", "sidechaincompress",
    "acompressor", "alimiter", "equalizer", "highpass", "lowpass", "afftdn", "agate", "deesser", "aecho", "dynaudnorm",
  ],
  encoders: ["libx264", "libx265", "ffv1", "aac", "pcm_s16le", "png", "mjpeg"],
  /** Decoders for media people bring: phone and camera video, WebM, Ogg, common audio. */
  decoders: ["h264", "hevc", "vp8", "vp9", "av1", "theora", "opus", "vorbis", "aac", "mp3", "flac", "png", "mjpeg"],
} as const;

/** Parts with a fallback in the renderer: missing ones are reported, but the build still passes. */
export const OPTIONAL_FFMPEG = { filters: ["rubberband"], encoders: [] as string[], decoders: [] as string[] } as const;

export interface FfmpegCheck {
  /** True when nothing required is missing. */
  ok: boolean;
  version?: string;
  missing: { filters: string[]; encoders: string[]; decoders: string[] };
  /** Optional parts this build lacks (their fallbacks are used). */
  optionalMissing: { filters: string[]; encoders: string[]; decoders: string[] };
}

/** Names in an `ffmpeg -filters`, `-encoders` or `-decoders` listing (the word after the flags column). */
export function parseFfmpegList(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^ ([A-Z.|]{3,8}) +(\S+)/.exec(line);
    if (m && !m[2]!.startsWith("=")) names.add(m[2]!);
  }
  return names;
}

const checks = new Map<string, Promise<FfmpegCheck>>();

/**
 * Confirm this FFmpeg build has every filter, encoder and decoder the renderer uses (see
 * REQUIRED_FFMPEG), like the hardware encoder check. The answer is kept for the process.
 */
export function checkFfmpeg(opts: FfmpegOptions = {}): Promise<FfmpegCheck> {
  const key = opts.ffmpegPath ?? "";
  let check = checks.get(key);
  if (!check) {
    check = (async () => {
      const list = async (flag: string) => parseFfmpegList((await runFfmpeg(["-hide_banner", flag], opts)).stdout);
      const [filters, encoders, decoders, banner] = await Promise.all([list("-filters"), list("-encoders"), list("-decoders"), runFfmpeg(["-version"], opts)]);
      const have = { filters, encoders, decoders };
      const lacking = (want: Record<keyof typeof have, readonly string[]>) =>
        Object.fromEntries((Object.keys(have) as (keyof typeof have)[]).map((k) => [k, want[k].filter((n) => !have[k].has(n))])) as FfmpegCheck["missing"];
      const missing = lacking(REQUIRED_FFMPEG);
      return {
        ok: !missing.filters.length && !missing.encoders.length && !missing.decoders.length,
        version: /ffmpeg version (\S+)/.exec(banner.stdout)?.[1],
        missing,
        optionalMissing: lacking(OPTIONAL_FFMPEG),
      };
    })();
    check.catch(() => checks.delete(key));
    checks.set(key, check);
  }
  return check;
}

/** A readable report of a check, one line per kind of missing part. */
export function describeFfmpegCheck(c: FfmpegCheck): string {
  const lines = [`FFmpeg ${c.version ?? "(unknown version)"}: ${c.ok ? "has everything the renderer uses" : "is missing parts the renderer uses"}`];
  for (const k of ["filters", "encoders", "decoders"] as const) {
    if (c.missing[k].length) lines.push(`Missing ${k}: ${c.missing[k].join(", ")}`);
    if (c.optionalMissing[k].length) lines.push(`Missing optional ${k} (fallbacks used): ${c.optionalMissing[k].join(", ")}`);
  }
  return lines.join("\n");
}
