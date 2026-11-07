import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export interface FfmpegOptions {
  /** Explicit path to the ffmpeg binary. Falls back to $FFMPEG_PATH, the `ffmpeg-static` package, then `ffmpeg` on PATH. */
  ffmpegPath?: string;
}

let cachedPath: string | undefined;

export function resolveFfmpegPath(opts: FfmpegOptions = {}): string {
  if (opts.ffmpegPath) return opts.ffmpegPath;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (cachedPath) return cachedPath;
  try {
    const require = createRequire(import.meta.url);
    const p = require("ffmpeg-static") as string | null;
    if (p) return (cachedPath = p);
  } catch {
    // optional dependency not installed
  }
  return (cachedPath = "ffmpeg");
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes, when `binaryStdout` was requested. */
  stdoutBuffer?: Buffer;
}

export interface RunOptions extends FfmpegOptions {
  cwd?: string;
  /** Called with progress in seconds of output rendered. */
  onProgress?: (seconds: number) => void;
  signal?: AbortSignal;
  /** Collect stdout as raw bytes (e.g. rawvideo pixels) in `stdoutBuffer`. */
  binaryStdout?: boolean;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
    readonly args: string[],
  ) {
    super(message);
  }
}

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const bin = resolveFfmpegPath(opts);
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd: opts.cwd, signal: opts.signal, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => (opts.binaryStdout ? chunks.push(d) : (stdout += d.toString())));
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (opts.onProgress) {
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (m) opts.onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
      // Keep memory bounded on long renders.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    proc.on("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`ffmpeg not found at "${bin}". Install ffmpeg, set FFMPEG_PATH, or add the ffmpeg-static package.`)
          : err,
      ),
    );
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr, ...(opts.binaryStdout ? { stdoutBuffer: Buffer.concat(chunks) } : {}) }));
  });
}

/** Run ffmpeg and throw a FfmpegError with the tail of stderr on failure. */
export async function runFfmpegOrThrow(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await runFfmpeg(args, opts);
  if (res.code !== 0) {
    const tail = res.stderr.split("\n").slice(-25).join("\n");
    throw new FfmpegError(`ffmpeg exited with code ${res.code}:\n${tail}`, res.code, res.stderr, args);
  }
  return res;
}

const filterLists = new Map<string, Promise<string>>();

/** Whether this FFmpeg build has a filter (builds differ, e.g. in rubberband). Checked once per binary. */
export async function hasFilter(name: string, opts: FfmpegOptions = {}): Promise<boolean> {
  const bin = resolveFfmpegPath(opts);
  let list = filterLists.get(bin);
  if (!list) {
    list = runFfmpeg(["-hide_banner", "-filters"], opts).then((r) => r.stdout, () => "");
    filterLists.set(bin, list);
  }
  return new RegExp("^ \\S+ " + name + " ", "m").test(await list);
}

export interface ProbeResult {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Pixel format of the video, e.g. "yuv420p10le" (10-bit). */
  pixelFormat?: string;
  /** Color primaries and transfer the file is tagged with, e.g. "bt2020" and "arib-std-b67" (HLG) or "smpte2084" (PQ). */
  colorPrimaries?: string;
  colorTransfer?: string;
  /** True for still images (single frame, no duration). */
  isImage: boolean;
}

/** Inspect a media file using `ffmpeg -i` (no ffprobe needed). */
export async function probe(src: string, opts: FfmpegOptions = {}): Promise<ProbeResult> {
  const { stderr } = await runFfmpeg(["-hide_banner", "-i", src], opts);
  if (/No such file or directory|Invalid data found/i.test(stderr)) {
    throw new Error(`Cannot probe "${src}": ${stderr.split("\n").filter(Boolean).pop()}`);
  }
  return parseProbeOutput(stderr);
}

export function parseProbeOutput(stderr: string): ProbeResult {
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const videoLine = stderr.split("\n").find((l) => /Stream #.*: Video:/.test(l));
  const hasAudio = /Stream #.*: Audio:/.test(stderr);
  const size = videoLine ? /, (\d{2,5})x(\d{2,5})[, \[]/.exec(videoLine) : null;
  const fps = videoLine ? /(\d+(?:\.\d+)?) fps/.exec(videoLine) : null;
  const imageCodec = videoLine ? /Video: (png|mjpeg|webp|bmp|tiff|gif|jpegls)/.test(videoLine) : false;
  const isImageContainer = /Input #0, (png_pipe|image2|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|svg_pipe)/.test(stderr);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : undefined;
  const isImage = isImageContainer || (imageCodec && (duration === undefined || duration <= 0.05) && !hasAudio);
  // Phone video is often stored sideways with a rotation flag; ffmpeg turns it upright when
  // decoding, so report the size as it is shown.
  const turned = /displaymatrix: rotation of -?(90|270)(\.0+)? degrees/.test(stderr);
  const [w, h] = size ? [Number(size[1]), Number(size[2])] : [undefined, undefined];
  // "Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67, progressive), ...": the
  // pixel format, then matrix/primaries/transfer (one name when all three are the same).
  const pixel = videoLine ? /, ((?:yuva?|rgba?|bgra?|gbra?|gray|nv|argb|abgr|p0)[a-z0-9]*)(?:\(|,|$)/.exec(videoLine) : null;
  const tags = videoLine ? /\((?:tv|pc), ([a-z0-9-]+)(?:\/([a-z0-9-]+)\/([a-z0-9-]+))?[,)]/.exec(videoLine) : null;
  const format = pixel ? [pixel[0], pixel[1], tags?.[1], tags?.[2] ?? tags?.[1], tags?.[3] ?? tags?.[1]] : null;
  return {
    duration: isImage ? undefined : duration,
    width: turned ? h : w,
    height: turned ? w : h,
    fps: fps ? Number(fps[1]) : undefined,
    hasVideo: !!videoLine && !isImage,
    hasAudio,
    isImage,
    ...(format?.[1] ? { pixelFormat: format[1] } : {}),
    ...(format?.[3] ? { colorPrimaries: format[3] } : {}),
    ...(format?.[4] ? { colorTransfer: format[4] } : {}),
  };
}
