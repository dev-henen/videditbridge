import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { round3 } from "../../core/util.js";
import { DEFAULT_FONT, fontsIn, prepareFonts, replaceFont, scriptFontsFor } from "../fonts/index.js";
import { resolveFfmpegPath, type FfmpegOptions } from "../render/ffmpeg.js";

/**
 * Custom graphics drawn from SVG: any design (cards, lower thirds, UI mockups, charts, badges,
 * logos, styled text with gradients, strokes, shadows and glows), still or animated. Animated SVG
 * uses {{ expression }} placeholders evaluated on every frame (see GRAPHIC_EXPRESSIONS), so a value
 * can move, grow, count, rotate or fade over time. Rendered with resvg (an optional package), with
 * the fonts folder's fonts available by family name.
 */

/** What placeholders can use, for tool descriptions. */
export const GRAPHIC_EXPRESSIONS =
  "Variables: t (seconds from the graphic's start), p (progress 0..1 over its duration), d (duration), n (frame number), w and h (canvas size in pixels), PI. " +
  "Operators: + - * / % ** and parentheses, comparisons < <= > >= == != (1 or 0), and cond ? a : b. " +
  "Functions: sin cos tan asin acos atan atan2 abs min max pow sqrt exp log floor ceil round sign clamp(x,a,b) lerp(a,b,u) step(edge,x) smooth(a,b,x) " +
  "ease(u) easeIn(u) easeOut(u) easeInOut(u) back(u) elastic(u) bounce(u) (easings take 0..1), seg(t,a,b) (0..1 progress of t from a to b), wave(t,period) (0..1 sine), rad(deg), deg(rad).";

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, sqrt: Math.sqrt, exp: Math.exp, log: Math.log,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  clamp: (x, a, b) => Math.min(Math.max(x, a), b),
  lerp: (a, b, u) => a + (b - a) * u,
  step: (e, x) => (x >= e ? 1 : 0),
  smooth: (a, b, x) => {
    const u = Math.min(Math.max((x - a) / (b - a || 1), 0), 1);
    return u * u * (3 - 2 * u);
  },
  ease: (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(u)),
  easeIn: (u) => clamp01(u) ** 3,
  easeOut: (u) => 1 - (1 - clamp01(u)) ** 3,
  easeInOut: (u) => (clamp01(u) < 0.5 ? 4 * clamp01(u) ** 3 : 1 - (-2 * clamp01(u) + 2) ** 3 / 2),
  back: (u) => {
    const x = clamp01(u) - 1;
    return 1 + 2.70158 * x ** 3 + 1.70158 * x ** 2;
  },
  elastic: (u) => {
    const x = clamp01(u);
    return x === 0 || x === 1 ? x : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  bounce: (u) => {
    let x = clamp01(u);
    const [n, d] = [7.5625, 2.75];
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  },
  seg: (t, a, b) => clamp01((t - a) / (b - a || 1)),
  wave: (t, period) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / (period || 1)),
  rad: (d) => (d * Math.PI) / 180,
  deg: (r) => (r * 180) / Math.PI,
};

function clamp01(u: number): number {
  return Math.min(Math.max(u, 0), 1);
}

/** Evaluate a math expression with the given variables. Throws on anything outside the small grammar. */
export function evalExpression(src: string, vars: Record<string, number>): number {
  const tokens = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]\w*|\*\*|[<>=!]=|[-+*/%^(),?:<>]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    const x = tokens[i++];
    if (t !== undefined && x !== t) throw new Error(`Expected "${t}" in "${src}"`);
    return x;
  };
  const ternary = (): number => {
    const c = compare();
    if (peek() !== "?") return c;
    take("?");
    const a = ternary();
    take(":");
    const b = ternary();
    return c ? a : b;
  };
  const compare = (): number => {
    let a = additive();
    for (let op = peek(); op && ["<", "<=", ">", ">=", "==", "!="].includes(op); op = peek()) {
      take();
      const b = additive();
      a = Number(op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b);
    }
    return a;
  };
  const additive = (): number => {
    let a = term();
    for (let op = peek(); op === "+" || op === "-"; op = peek()) {
      take();
      a = op === "+" ? a + term() : a - term();
    }
    return a;
  };
  const term = (): number => {
    let a = unary();
    for (let op = peek(); op === "*" || op === "/" || op === "%"; op = peek()) {
      take();
      const b = unary();
      a = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return a;
  };
  const unary = (): number => {
    if (peek() === "-") return take(), -unary();
    if (peek() === "+") return take(), unary();
    return power();
  };
  const power = (): number => {
    const a = atom();
    if (peek() === "**" || peek() === "^") {
      take();
      return a ** unary();
    }
    return a;
  };
  const atom = (): number => {
    const x = take();
    if (x === undefined) throw new Error(`Unexpected end of "${src}"`);
    if (x === "(") {
      const v = ternary();
      take(")");
      return v;
    }
    if (/^[\d.]/.test(x)) return Number(x);
    if (/^[A-Za-z_]/.test(x)) {
      if (peek() === "(") {
        const fn = Object.hasOwn(FUNCS, x) ? FUNCS[x] : undefined;
        if (!fn) throw new Error(`Unknown function "${x}" in "${src}"`);
        take("(");
        const args: number[] = [];
        if (peek() !== ")") for (args.push(ternary()); peek() === ","; take(), args.push(ternary()));
        take(")");
        return fn(...args);
      }
      if (x === "PI") return Math.PI;
      if (Object.hasOwn(vars, x)) return vars[x]!;
      throw new Error(`Unknown name "${x}" in "${src}"`);
    }
    throw new Error(`Unexpected "${x}" in "${src}"`);
  };
  const v = ternary();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i]}" in "${src}"`);
  return v;
}

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** The SVG with every {{ expression }} replaced by its value for these variables. */
export function fillGraphic(svg: string, vars: Record<string, number>): string {
  return svg.replace(PLACEHOLDER, (_, e: string) => {
    const v = evalExpression(e, vars);
    if (!Number.isFinite(v)) throw new Error(`{{${e}}} is not a finite number at t=${round3(vars.t ?? 0)}`);
    return String(round3(v));
  });
}

/** Whether the SVG changes over time. */
export function isAnimatedGraphic(svg: string): boolean {
  return /\{\{[^{}]+\}\}/.test(svg);
}

type Resvg = new (svg: string, opts: object) => { render(): { width: number; height: number; pixels: Uint8Array; asPng(): Uint8Array } };

async function loadResvg(): Promise<Resvg> {
  try {
    return ((await import("@resvg/resvg-js" as string)) as { Resvg: Resvg }).Resvg;
  } catch {
    throw new Error("Custom graphics need the optional package @resvg/resvg-js (npm install @resvg/resvg-js).");
  }
}

export interface GraphicOptions extends FfmpegOptions {
  /** Canvas size in pixels; the SVG is scaled to this width. */
  width: number;
  height: number;
  /** Seconds, for animated graphics. */
  duration?: number;
  fps?: number;
  /** Fonts folder whose fonts the SVG can use by family name (default: the shared fonts folder). */
  fontsDir?: string;
  signal?: AbortSignal;
}

const FONT_FAMILY = /(font-family\s*[:=]\s*["']?)([^"';>]+)/gi;
const familyName = (f: string) => f.trim().replace(/^["']|["']$/g, "");

/** The SVG with the font families in `fontMap` (lowercase name to family) replaced, see prepareFonts. */
export function replaceSvgFonts(svg: string, fontMap: Record<string, string>): string {
  return svg.replace(FONT_FAMILY, (_, pre: string, list: string) =>
    pre +
    list
      .split(",")
      .map((f) => {
        const name = familyName(f);
        const to = replaceFont(name, fontMap);
        return to === name ? f : f.replace(name, to);
      })
      .join(","),
  );
}

async function renderer(svgSource: string, opts: GraphicOptions) {
  const Resvg = await loadResvg();
  // Fonts missing on this system become the bundled ones, as in text layers.
  // Text between tags may need script fallback fonts (CJK, Arabic, emoji...), downloaded once.
  const svgText = svgSource.replace(/<[^>]*>/g, " ");
  const { fontsDir, fontMap } = await prepareFonts(opts.fontsDir, { text: svgText });
  // Only the installed families the SVG names: resvg reads every font file it is given on every frame.
  const named = new Set([...replaceSvgFonts(svgSource, fontMap).matchAll(FONT_FAMILY)].flatMap((m) => m[2]!.split(",").map((f) => familyName(f).toLowerCase())));
  named.add(DEFAULT_FONT.toLowerCase());
  for (const s of scriptFontsFor([svgText])) named.add(s.family.toLowerCase());
  const fontFiles = (await fontsIn(fontsDir).catch(() => [])).filter((f) => named.has(f.family.toLowerCase())).map((f) => f.file);
  const settings = { fitTo: { mode: "original" }, font: { fontFiles, loadSystemFonts: true, defaultFontFamily: DEFAULT_FONT, sansSerifFamily: DEFAULT_FONT }, background: "rgba(0,0,0,0)" };
  // The root's own size becomes exactly the canvas (even, for video); the viewBox is fitted inside it,
  // so a canvas rounded by a pixel never changes the render size.
  const sized = (svg: string) =>
    svg.replace(/<svg\b[^>]*>/i, (tag) => tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/^<svg/i, `<svg width="${opts.width}" height="${opts.height}"`));
  return (svg: string) => {
    const img = new Resvg(sized(replaceSvgFonts(svg, fontMap)), settings).render();
    if (img.width !== opts.width || img.height !== opts.height)
      throw new Error(`The SVG renders at ${img.width}x${img.height}, not the canvas ${opts.width}x${opts.height}: give the <svg> a viewBox with the canvas's shape`);
    return img;
  };
}

/**
 * Render a graphic to `output`: a PNG for a still SVG, or a lossless video with transparency (.mkv)
 * for one with placeholders. Returns the file written.
 */
export async function renderGraphic(svg: string, output: string, opts: GraphicOptions): Promise<{ file: string; animated: boolean; frames: number }> {
  const draw = await renderer(svg, opts);
  const base = { w: opts.width, h: opts.height, d: opts.duration ?? 0 };
  await mkdir(path.dirname(output), { recursive: true });
  if (!isAnimatedGraphic(svg)) {
    const file = output.replace(/\.[^.]+$/, "") + ".png";
    await writeFile(file, draw(svg).asPng());
    return { file, animated: false, frames: 1 };
  }
  const fps = opts.fps ?? 30;
  const duration = opts.duration ?? 3;
  const frames = Math.max(1, Math.round(duration * fps));
  const vars = (n: number) => ({ ...base, d: duration, n, t: n / fps, p: frames > 1 ? n / (frames - 1) : 1 });
  // Check every placeholder before starting the encoder, so mistakes come back as clear errors.
  fillGraphic(svg, vars(0));
  const file = output.replace(/\.[^.]+$/, "") + ".mkv";
  const part = `${file}.${process.pid}.part.mkv`;
  const enc = spawn(
    resolveFfmpegPath(opts),
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${opts.width}x${opts.height}`, "-r", String(fps), "-i", "-", "-c:v", "ffv1", "-pix_fmt", "yuva420p", part],
    { windowsHide: true, signal: opts.signal },
  );
  let err = "";
  enc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const closed = new Promise<void>((resolve, reject) => {
    enc.on("error", reject);
    enc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (writing the graphic) failed: ${err.trim().split("\n").pop()}`))));
  });
  try {
    for (let n = 0; n < frames; n++) {
      const img = draw(fillGraphic(svg, vars(n)));
      if (!enc.stdin.write(img.pixels)) await new Promise((r) => enc.stdin.once("drain", r));
    }
    enc.stdin.end();
    await closed;
    await rename(part, file);
  } catch (e) {
    enc.kill();
    throw e;
  } finally {
    await rm(part, { force: true });
  }
  return { file, animated: true, frames };
}
