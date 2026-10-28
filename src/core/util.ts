let counter = 0;

/** Short, readable, collision-resistant id: `clip_k3x9_4`. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${rand}${counter}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to millisecond precision to avoid float noise in generated filters. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Format seconds as `mm:ss.s` (or `h:mm:ss.s`) for human/AI-readable summaries. */
export function formatTime(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}:${sec}` : `${sign}${String(m).padStart(2, "0")}:${sec}`;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 = transparent, 1 = opaque */
  a: number;
}

export function parseColor(hex: string): Rgba {
  const h = hex.replace(/^#/, "");
  if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h)) throw new Error(`Invalid color: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();

/** `#RRGGBB[AA]` → FFmpeg color `0xRRGGBB[@alpha]`. */
export function toFfmpegColor(hex: string): string {
  const c = parseColor(hex);
  const base = `0x${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a < 1 ? `${base}@${c.a.toFixed(2)}` : base;
}

/** `#RRGGBB[AA]` → ASS color `&HAABBGGRR` (ASS alpha is inverted: 00 = opaque). */
export function toAssColor(hex: string): string {
  const c = parseColor(hex);
  return `&H${hex2(255 - c.a * 255)}${hex2(c.b)}${hex2(c.g)}${hex2(c.r)}`;
}

export const ASPECT_RATIOS = {
  "9:16": { width: 1080, height: 1920, label: "Vertical (TikTok, Reels, Shorts)" },
  "16:9": { width: 1920, height: 1080, label: "Landscape (YouTube, web)" },
  "1:1": { width: 1080, height: 1080, label: "Square (Instagram feed, LinkedIn)" },
  "4:5": { width: 1080, height: 1350, label: "Portrait (Instagram/Facebook feed)" },
  "21:9": { width: 2560, height: 1080, label: "Cinematic ultrawide" },
} as const;

export type AspectRatio = keyof typeof ASPECT_RATIOS;

export function dimensionsFor(aspect: AspectRatio, scale = 1): { width: number; height: number } {
  const d = ASPECT_RATIOS[aspect];
  const even = (n: number) => Math.round((n * scale) / 2) * 2;
  return { width: even(d.width), height: even(d.height) };
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** A URL (http://, https://, file://...) rather than a file path. */
export const isUrl = (src: string): boolean => /^[a-z][a-z0-9+.-]+:\/\//i.test(src);

/** An absolute file path on any system: /x, C:\x, C:/x or \server\share. */
export const isAbsolutePath = (src: string): boolean => /^([a-z]:)?[\\/]/i.test(src);

/**
 * A file as a project path: relative to the project folder `dir` when it is inside it, always with
 * forward slashes, so a project opens on any system and after being moved. Files outside the folder
 * stay absolute (with forward slashes) and URLs are kept as they are.
 */
export function toProjectPath(file: string, dir: string): string {
  if (isUrl(file)) return file;
  const p = file.replace(/\\/g, "/");
  if (!isAbsolutePath(p)) return p.replace(/^(\.\/)+/, "");
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  // Drive-letter paths compare without case, like Windows does.
  const same = (a: string, b: string) => (/^[a-z]:/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(p.slice(0, d.length + 1), `${d}/`) ? p.slice(d.length + 1) : p;
}
