import { runFfmpegOrThrow, runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/** Measured color statistics of one image (all values 0..1 unless noted). */
export interface ColorStats {
  /** Average luma. */
  luma: number;
  /** Luma at the 10th / 90th percentile. */
  lumaLow: number;
  lumaHigh: number;
  lumaMin: number;
  lumaMax: number;
  /** Average saturation (0 = grey, ~0.25+ = vivid). */
  saturation: number;
  /** Average color of the whole frame. */
  averageRgb: { r: number; g: number; b: number };
  /** Dominant cast from the average color, or "neutral". */
  cast: string;
  /** Plain-language observations for an editor (or an AI) to act on. */
  notes: string[];
}

const META = /lavfi\.signalstats\.(\w+)=([\d.]+)/g;

/** Measure exposure, contrast, saturation and color cast of an image file (e.g. a rendered frame). */
export async function analyzeColor(imagePath: string, opts: FfmpegOptions = {}): Promise<ColorStats> {
  // Ignore letterbox/pillarbox bars: they are not part of the picture and would skew every reading.
  const crop = await detectPictureArea(imagePath, opts);
  const pre = crop ? `${crop},` : "";
  const stats = await runFfmpeg(
    ["-hide_banner", "-i", imagePath, "-vf", `${pre}signalstats,metadata=print:file=-`, "-frames:v", "1", "-f", "null", "-"],
    opts,
  );
  const m: Record<string, number> = {};
  for (const [, k, v] of (stats.stdout + stats.stderr).matchAll(META)) m[k!] = Number(v);
  if (m.YAVG === undefined) throw new Error(`Could not analyze ${imagePath}`);

  // Average color: downscale to one pixel and read it back as raw RGB.
  const px = await runFfmpegOrThrow(
    ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-vf", `${pre}scale=1:1:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"],
    { ...opts, binaryStdout: true },
  );
  const bytes = px.stdoutBuffer ?? Buffer.alloc(3);
  const averageRgb = { r: (bytes[0] ?? 0) / 255, g: (bytes[1] ?? 0) / 255, b: (bytes[2] ?? 0) / 255 };

  // signalstats reports 8-bit limited-range values; normalize to 0..1.
  const norm = (v: number) => Math.max(0, Math.min(1, (v - 16) / 219));
  const result: ColorStats = {
    luma: round(norm(m.YAVG)),
    lumaLow: round(norm(m.YLOW ?? m.YMIN ?? 16)),
    lumaHigh: round(norm(m.YHIGH ?? m.YMAX ?? 235)),
    lumaMin: round(norm(m.YMIN ?? 16)),
    lumaMax: round(norm(m.YMAX ?? 235)),
    saturation: round((m.SATAVG ?? 0) / 181),
    averageRgb: { r: round(averageRgb.r), g: round(averageRgb.g), b: round(averageRgb.b) },
    cast: "neutral",
    notes: [],
  };
  result.cast = describeCast(averageRgb);
  result.notes = observations(result);
  return result;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * `crop=w:h:x:y` for the picture area inside letterbox/pillarbox bars, or undefined when there are none.
 * Rows and columns are averaged, so bars that contain a little text (subtitles) still count as bars.
 */
export async function detectPictureArea(imagePath: string, opts: FfmpegOptions): Promise<string | undefined> {
  const probe = await runFfmpeg(["-hide_banner", "-i", imagePath], opts);
  const size = /, (\d{2,5})x(\d{2,5})[, [\r\n]/.exec(probe.stderr.split("\n").find((l) => l.includes("Video:")) ?? "");
  if (!size) return undefined;
  const [W, H] = [Number(size[1]), Number(size[2])];
  const profile = async (filter: string) =>
    (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", "-i", imagePath, "-vf", `${filter},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { ...opts, binaryStdout: true }))
      .stdoutBuffer ?? Buffer.alloc(0);
  const rows = await profile(`scale=1:${H}:flags=area`);
  const cols = await profile(`scale=${W}:1:flags=area`);
  // A line is picture when its average is clearly above black (bars average ~16 even with captions).
  const span = (line: Buffer) => {
    const isPicture = (v: number) => v > 34;
    let a = 0;
    let b = line.length - 1;
    while (a < b && !isPicture(line[a]!)) a++;
    while (b > a && !isPicture(line[b]!)) b--;
    return [a, b] as const;
  };
  let [top, bottom] = span(rows);
  let [left, right] = span(cols);
  // Real letterbox/pillarbox bars come in matching pairs. A dark night sky on top only is picture.
  const matched = (a: number, b: number, size: number) => a > size * 0.02 && b > size * 0.02 && Math.abs(a - b) <= size * 0.03;
  if (!matched(top, H - 1 - bottom, H)) [top, bottom] = [0, H - 1];
  if (!matched(left, W - 1 - right, W)) [left, right] = [0, W - 1];
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < 16 || h < 16) return undefined;
  if (w >= W - 4 && h >= H - 4) return undefined;
  return `crop=${w}:${h}:${left}:${top}`;
}

function describeCast({ r, g, b }: { r: number; g: number; b: number }): string {
  const avg = (r + g + b) / 3;
  if (avg < 0.04) return "neutral";
  const dr = (r - avg) / avg;
  const dg = (g - avg) / avg;
  const db = (b - avg) / avg;
  const max = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
  if (max < 0.06) return "neutral";
  if (dr > 0 && db < 0) return dg > 0 ? "warm (yellow)" : "warm (orange/red)";
  if (db > 0 && dr < 0) return dg > 0 ? "cool (cyan)" : "cool (blue)";
  if (dg > 0) return "green";
  if (dg < 0) return "magenta";
  return "neutral";
}

function observations(s: ColorStats): string[] {
  const notes: string[] = [];
  if (s.luma < 0.25) notes.push("Underexposed: raise exposure or shadows.");
  else if (s.luma > 0.7) notes.push("Very bright: lower exposure or highlights.");
  if (s.lumaHigh > 0.97) notes.push("Highlights near clipping: pull highlights or whites down.");
  if (s.lumaLow < 0.02 && s.luma < 0.4) notes.push("Shadows crushed: lift shadows or blacks.");
  const range = s.lumaHigh - s.lumaLow;
  if (range < 0.45) notes.push("Flat, low contrast: add contrast or an S-curve.");
  else if (range > 0.85) notes.push("Very contrasty: consider softening contrast or adding fade.");
  if (s.saturation < 0.08) notes.push("Muted colors: add vibrance or saturation (or it is intentionally desaturated).");
  else if (s.saturation > 0.35) notes.push("Very saturated: reduce saturation to avoid an artificial look.");
  if (s.cast !== "neutral") notes.push(`Overall tint leans ${s.cast}. Fine if it comes from the subject; if whites and greys look tinted, correct with temperature/tint.`);
  if (!notes.length) notes.push("Exposure, contrast and color look balanced.");
  return notes;
}

export type Scope = "histogram" | "waveform" | "vectorscope" | "parade";

/**
 * Render video scopes for an image: histogram, luma waveform, RGB parade and vectorscope,
 * side by side, for judging exposure and color at a glance.
 */
export async function renderScopes(imagePath: string, output: string, scopes: Scope[] = ["histogram", "waveform", "parade", "vectorscope"], opts: FfmpegOptions = {}): Promise<string> {
  const H = 256;
  const graphs: Record<Scope, string> = {
    histogram: `format=yuv444p,histogram=display_mode=overlay:level_height=${H}:components=7:fgopacity=0.8:bgopacity=0.1,scale=320:${H}`,
    waveform: `format=yuv444p,waveform=mode=column:intensity=0.08:display=overlay:components=1:graticule=green:flags=numbers+dots,scale=320:${H}`,
    parade: `format=gbrp,waveform=mode=column:intensity=0.08:display=parade:components=7:graticule=green,scale=480:${H}`,
    vectorscope: `format=yuv444p,vectorscope=mode=color3:graticule=green:flags=name,scale=${H}:${H}`,
  };
  const chosen = scopes.length ? scopes : (["histogram", "waveform", "parade", "vectorscope"] as Scope[]);
  const split = chosen.map((_, i) => `[s${i}]`).join("");
  const parts = chosen.map((sc, i) => `[s${i}]${graphs[sc]},pad=iw+8:ih:4:0:color=black[o${i}]`);
  const stack = chosen.length > 1 ? `${chosen.map((_, i) => `[o${i}]`).join("")}hstack=inputs=${chosen.length}[out]` : `[o0]null[out]`;
  const graph = `[0:v]split=${chosen.length}${split};${parts.join(";")};${stack}`;
  await runFfmpegOrThrow(["-y", "-hide_banner", "-loglevel", "error", "-i", imagePath, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-update", "1", output], opts);
  return output;
}

/** Brightness levels (0..1) at these percentiles, per channel. */
export const MATCH_PERCENTILES = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98] as const;

export interface ChannelLevels {
  r: number[];
  g: number[];
  b: number[];
}

/** Per-channel percentile levels of an image (letterbox bars ignored), for matching one shot to another. */
export async function channelLevels(imagePath: string, opts: FfmpegOptions = {}): Promise<ChannelLevels> {
  const crop = await detectPictureArea(imagePath, opts);
  const res = await runFfmpegOrThrow(
    ["-hide_banner", "-loglevel", "error", "-i", imagePath, "-vf", `${crop ? `${crop},` : ""}scale=192:-2:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"],
    { ...opts, binaryStdout: true },
  );
  const px = res.stdoutBuffer ?? Buffer.alloc(0);
  const n = Math.floor(px.length / 3);
  const levels = (c: number) => {
    const hist = new Array<number>(256).fill(0);
    for (let k = c; k < n * 3; k += 3) hist[px[k]!]!++;
    return MATCH_PERCENTILES.map((q) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v]!;
        if (acc >= q * n) return round(v / 255);
      }
      return 1;
    });
  };
  return { r: levels(0), g: levels(1), b: levels(2) };
}

/**
 * Curves that move a shot's channel levels onto a reference's (an approximate histogram match).
 * strength 1 matches fully; lower values blend toward no change.
 */
export function matchingCurves(shot: ChannelLevels, reference: ChannelLevels, strength = 1): { red: [number, number][]; green: [number, number][]; blue: [number, number][] } {
  const curve = (from: number[], to: number[]): [number, number][] => {
    const target = (k: number, x: number) => round(Math.min(1, Math.max(0, x + (to[k]! - x) * strength)));
    // Levels measured at pure black or white pin the curve's ends; the rest are points between.
    let low: number | undefined;
    let high: number | undefined;
    const mid: [number, number][] = [];
    from.forEach((x, k) => {
      const y = target(k, x);
      if (x <= 0.01) return void (low = low === undefined ? y : Math.max(low, y));
      if (x >= 0.99) return void (high ??= y);
      const last = mid[mid.length - 1];
      // Keep the curve increasing: skip points too close to the last one or that would bend it back.
      if (last && (x - last[0] < 0.02 || y < last[1])) return;
      mid.push([round(x), y]);
    });
    // Unmeasured ends keep the offset of the nearest point (black and white levels move with it).
    const first = mid[0];
    const last = mid[mid.length - 1];
    const y0 = low ?? (first ? Math.max(0, Math.min(first[1], first[1] - first[0])) : 0);
    const y1 = high ?? (last ? Math.min(1, Math.max(last[1], last[1] + (1 - last[0]))) : 1);
    return [[0, round(y0)], ...mid.filter(([, y]) => y >= y0 && y <= y1), [1, round(Math.max(y0, y1))]];
  };
  return { red: curve(shot.r, reference.r), green: curve(shot.g, reference.g), blue: curve(shot.b, reference.b) };
}
