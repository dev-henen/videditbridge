import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultFontsDir } from "../appdirs.js";
import { scriptFontsFor, type FontFallback } from "./scripts.js";

export * from "./scripts.js";

/**
 * Fonts beyond the ones installed on the system: a folder the renderer always passes to libass
 * (the fonts folder in the app's data folder, or $AVE_FONTS_DIR). Google Fonts are downloaded into
 * it by family name, the Lucide icon font lives there too, and the bundled fonts are copied into it.
 */
export { defaultFontsDir };

/**
 * Open fonts shipped with the engine, so text looks the same on every system: assets/fonts at
 * the package root, or $AVE_BUNDLED_FONTS_DIR (a packaged app puts them next to the host).
 */
export function bundledFontsDir(): string {
  return process.env.AVE_BUNDLED_FONTS_DIR ?? fileURLToPath(new URL("../../../assets/fonts/", import.meta.url));
}

/** Default text font (bundled; metric-compatible with Arial). */
export const DEFAULT_FONT = "Arimo";
/** Default heading font (bundled; a heavy face in place of Arial Black). */
export const DEFAULT_HEADING_FONT = "Archivo Black";

/**
 * System fonts older projects and styles name, and the bundled open font used when one is not
 * installed (Linux has none of them, macOS lacks some). Arimo, Gelasio and Cousine keep the
 * original's widths, so lines wrap the same way.
 */
export const FONT_REPLACEMENTS: Readonly<Record<string, string>> = {
  Arial: "Arimo",
  "Arial Black": "Archivo Black",
  Georgia: "Gelasio",
  Impact: "Anton",
  "Courier New": "Cousine",
  "Comic Sans MS": "Comic Neue",
};

export interface FontFile {
  family: string;
  /** Subfamily as the font names it, e.g. "Regular", "Bold Italic". */
  style: string;
  file: string;
}

/** Family and style names from a TTF/OTF (or the first font of a TTC), read from its name table. */
export async function readFontNames(file: string): Promise<{ family: string; style: string } | undefined> {
  const h = await open(file, "r");
  try {
    const read = async (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      const { bytesRead } = await h.read(b, 0, len, pos);
      return b.subarray(0, bytesRead);
    };
    let base = 0;
    const head = await read(0, 12);
    if (head.length < 12) return undefined;
    if (head.toString("latin1", 0, 4) === "ttcf") base = (await read(12, 4)).readUInt32BE(0);
    const offset = await read(base, 12);
    const tables = offset.readUInt16BE(4);
    const dir = await read(base + 12, tables * 16);
    let nameAt = -1;
    for (let k = 0; k < tables; k++) if (dir.toString("latin1", k * 16, k * 16 + 4) === "name") nameAt = dir.readUInt32BE(k * 16 + 8);
    if (nameAt < 0) return undefined;
    const nh = await read(nameAt, 6);
    const count = nh.readUInt16BE(2);
    const strings = nameAt + nh.readUInt16BE(4);
    const recs = await read(nameAt + 6, count * 12);
    const names = new Map<number, string>();
    for (let k = 0; k < count; k++) {
      const r = recs.subarray(k * 12, k * 12 + 12);
      const [platform, , lang, id, len, off] = [r.readUInt16BE(0), r.readUInt16BE(2), r.readUInt16BE(4), r.readUInt16BE(6), r.readUInt16BE(8), r.readUInt16BE(10)];
      // Typographic names (16, 17) beat the legacy ones (1, 2); prefer Windows English.
      if (![1, 2, 16, 17].includes(id) || (names.has(id) && !(platform === 3 && lang === 0x409))) continue;
      const raw = await read(strings + off, len);
      const text = platform === 3 || platform === 0 ? decodeUtf16be(raw) : raw.toString("latin1");
      if (text.trim()) names.set(id, text.trim());
    }
    const family = names.get(16) ?? names.get(1);
    return family ? { family, style: names.get(17) ?? names.get(2) ?? "Regular" } : undefined;
  } catch {
    return undefined;
  } finally {
    await h.close();
  }
}

function decodeUtf16be(b: Buffer): string {
  let s = "";
  for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode(b.readUInt16BE(k));
  return s;
}

const FONT_EXT = /\.(ttf|otf|ttc)$/i;

/** Fonts in one folder; with `recursive`, in its subfolders too (Linux sorts system fonts into them). */
export async function fontsIn(dir: string, opts: { recursive?: boolean } = {}): Promise<FontFile[]> {
  const entries = await readdir(dir, { recursive: opts.recursive }).catch(() => [] as string[]);
  const out: FontFile[] = [];
  for (const f of entries.filter((e) => FONT_EXT.test(e))) {
    const n = await readFontNames(path.join(dir, f));
    if (n) out.push({ ...n, file: path.join(dir, f) });
  }
  return out;
}

/** System font folders (Windows, macOS, Linux), including the user's own. */
export function systemFontDirs(): string[] {
  const xdgData = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(homedir(), ".local", "share");
  const dirs =
    process.platform === "win32"
      ? [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"), path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts")]
      : process.platform === "darwin"
        ? ["/System/Library/Fonts", "/Library/Fonts", path.join(homedir(), "Library", "Fonts")]
        : ["/usr/share/fonts", "/usr/local/share/fonts", path.join(xdgData, "fonts"), path.join(homedir(), ".fonts")];
  return [...new Set(dirs)].filter((d) => d && existsSync(d));
}

let systemFiles: Promise<FontFile[]> | undefined;

/** Fonts installed on the system, read once per process. */
export function systemFonts(): Promise<FontFile[]> {
  systemFiles ??= (async () => (await Promise.all(systemFontDirs().map((d) => fontsIn(d, { recursive: true })))).flat())();
  return systemFiles;
}

/** Lowercase family names installed on the system. */
export async function systemFontFamilies(): Promise<Set<string>> {
  return new Set((await systemFonts()).map((f) => f.family.toLowerCase()));
}

/** The code points a TTF/OTF (or the first font of a TTC) has glyphs for, from its cmap table. */
export async function readFontCoverage(file: string): Promise<Set<number>> {
  const b = await readFile(file);
  const cps = new Set<number>();
  const base = b.toString("latin1", 0, 4) === "ttcf" ? b.readUInt32BE(12) : 0;
  const tables = b.readUInt16BE(base + 4);
  let cmap = -1;
  for (let k = 0; k < tables; k++) if (b.toString("latin1", base + 12 + k * 16, base + 16 + k * 16) === "cmap") cmap = b.readUInt32BE(base + 12 + k * 16 + 8);
  if (cmap < 0) return cps;
  // Prefer the full Unicode subtable (format 12), then the BMP one (format 4).
  const subs: { format: number; at: number }[] = [];
  for (let k = 0; k < b.readUInt16BE(cmap + 2); k++) {
    const rec = cmap + 4 + k * 8;
    const [platform, encoding] = [b.readUInt16BE(rec), b.readUInt16BE(rec + 2)];
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
      const at = cmap + b.readUInt32BE(rec + 4);
      subs.push({ format: b.readUInt16BE(at), at });
    }
  }
  const sub = subs.find((s) => s.format === 12) ?? subs.find((s) => s.format === 4);
  if (sub?.format === 12) {
    const groups = b.readUInt32BE(sub.at + 12);
    for (let g = 0; g < groups; g++) {
      const at = sub.at + 16 + g * 12;
      for (let cp = b.readUInt32BE(at); cp <= b.readUInt32BE(at + 4); cp++) cps.add(cp);
    }
  } else if (sub?.format === 4) {
    const segs = b.readUInt16BE(sub.at + 6) / 2;
    const ends = sub.at + 14;
    const starts = ends + segs * 2 + 2;
    for (let s = 0; s < segs; s++) {
      const end = b.readUInt16BE(ends + s * 2);
      for (let cp = b.readUInt16BE(starts + s * 2); cp <= end && cp !== 0xffff; cp++) cps.add(cp);
    }
  }
  return cps;
}

/**
 * Copy the bundled fonts (and their licenses) into a fonts folder where they are missing, so libass
 * and resvg find them in the one folder they are given. Returns the folder.
 */
export async function ensureBundledFonts(dir = defaultFontsDir(), from = bundledFontsDir()): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(from).catch(() => [] as string[])) {
    if (!FONT_EXT.test(f) && !/\.txt$/i.test(f)) continue;
    const to = path.join(dir, f);
    const src = path.join(from, f);
    const [a, b] = await Promise.all([stat(src), stat(to).catch(() => undefined)]);
    if (b?.size === a.size) continue;
    await copyFile(src, `${to}.part`);
    await rename(`${to}.part`, to);
  }
  return dir;
}

/**
 * The replacements (lowercase name to family) for FONT_REPLACEMENTS names that are neither installed
 * on the system nor in the fonts folder. A project made on Windows with Arial keeps Arial there and
 * gets Arimo on Linux.
 */
export async function missingFontReplacements(fontsDir = defaultFontsDir()): Promise<Record<string, string>> {
  const have = new Set([...(await systemFontFamilies()), ...(await fontsIn(fontsDir)).map((f) => f.family.toLowerCase())]);
  return Object.fromEntries(Object.entries(FONT_REPLACEMENTS).filter(([name]) => !have.has(name.toLowerCase())).map(([name, to]) => [name.toLowerCase(), to]));
}

/** Text and font names in a project (or any JSON): the values of `text`, `fontFamily` and `headingFont` keys. */
export function textsAndFonts(value: unknown): { texts: string[]; families: string[] } {
  const texts: string[] = [];
  const families = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string") {
        if (k === "text") texts.push(x);
        else if (k === "fontFamily" || k === "headingFont") families.add(x);
      } else walk(x);
    }
  };
  walk(value);
  return { texts, families: [...families] };
}

const coverage = new Map<string, Promise<Set<number>>>();
const coverageOf = (file: string) => {
  let c = coverage.get(file);
  if (!c) coverage.set(file, (c = readFontCoverage(file).catch(() => new Set<number>())));
  return c;
};

/**
 * Fallback fonts for the scripts in `texts` (see SCRIPT_FONTS): downloads the Noto fonts they need
 * into the fonts folder, once, and reads which characters the named families have. Offline, a
 * missing Noto font is skipped and libass falls back as the system does.
 */
export async function prepareFontFallback(texts: string[], families: string[], fontsDir: string): Promise<FontFallback | undefined> {
  const needed = scriptFontsFor(texts);
  if (!needed.length) return undefined;
  const have = new Set((await fontsIn(fontsDir)).map((f) => f.family.toLowerCase()));
  for (const s of needed) {
    if (have.has(s.family.toLowerCase())) continue;
    await installGoogleFont(s.family, { dir: fontsDir, weights: s.script === "Emoji" ? [400] : [400, 700] }).catch(() => undefined);
  }
  const files = [...(await fontsIn(fontsDir)), ...(await systemFonts())];
  const fileOf = (family: string) => {
    const all = files.filter((f) => f.family.toLowerCase() === family.toLowerCase());
    return (all.find((f) => /^(regular|normal|book|roman)$/i.test(f.style)) ?? all[0])?.file;
  };
  const known = new Map<string, Set<number>>();
  for (const family of new Set([...families, DEFAULT_FONT, DEFAULT_HEADING_FONT, ...Object.values(FONT_REPLACEMENTS)])) {
    const file = fileOf(family);
    if (file) known.set(family.toLowerCase(), await coverageOf(file));
  }
  return { covers: (family, cp) => known.get(family.trim().toLowerCase())?.has(cp) };
}

/**
 * Everything a render needs for text: the fonts folder (with the bundled fonts in it), the
 * replacements to apply, and with a project, fallback fonts for the scripts its text uses.
 */
export async function prepareFonts(
  fontsDir?: string,
  project?: unknown,
): Promise<{ fontsDir: string; fontMap: Record<string, string>; fontFallback?: FontFallback }> {
  const dir = await ensureBundledFonts(path.resolve(fontsDir ?? defaultFontsDir()));
  const fontMap = await missingFontReplacements(dir);
  if (project === undefined) return { fontsDir: dir, fontMap };
  const { texts, families } = textsAndFonts(project);
  const fontFallback = await prepareFontFallback(texts, families.map((f) => replaceFont(f, fontMap)), dir);
  return { fontsDir: dir, fontMap, ...(fontFallback ? { fontFallback } : {}) };
}

/** A family name after replacement (`fontMap` keys are lowercase). */
export const replaceFont = (family: string, fontMap?: Record<string, string>): string => fontMap?.[family.trim().toLowerCase()] ?? family;

/** Font families available to the renderer: the system's and the fonts folder's, with where each comes from. */
export async function listFontFamilies(fontsDir = defaultFontsDir()): Promise<{ family: string; styles: string[]; source: "system" | "installed" }[]> {
  const byFamily = new Map<string, { styles: Set<string>; source: "system" | "installed" }>();
  const add = (fonts: FontFile[], source: "system" | "installed") => {
    for (const f of fonts) {
      const e = byFamily.get(f.family) ?? { styles: new Set<string>(), source };
      e.styles.add(f.style);
      if (source === "installed") e.source = source;
      byFamily.set(f.family, e);
    }
  };
  for (const d of systemFontDirs()) add(await fontsIn(d, { recursive: true }), "system");
  add(await fontsIn(fontsDir), "installed");
  return [...byFamily.entries()].map(([family, e]) => ({ family, styles: [...e.styles].sort(), source: e.source })).sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Download a Google Fonts family (open-licensed) into the fonts folder as TTF files, in the given
 * weights (and their italics when asked). Returns the files written.
 */
export async function installGoogleFont(family: string, opts: { dir?: string; weights?: number[]; italic?: boolean } = {}): Promise<FontFile[]> {
  const dir = opts.dir ?? defaultFontsDir();
  await mkdir(dir, { recursive: true });
  const weights = [...new Set(opts.weights?.length ? opts.weights : [400, 700])].sort((a, b) => a - b);
  const axes = opts.italic ? `ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(";")}` : `wght@${weights.join(";")}`;
  // Without a browser user agent the API answers with plain TTF links, which libass reads.
  let res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:${axes}`);
  // Families with a single weight reject a weight list; ask for the family alone.
  if (!res.ok) res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`);
  if (!res.ok) throw new Error(`Google Fonts has no family "${family}" (HTTP ${res.status}). Check the spelling at fonts.google.com.`);
  const css = await res.text();
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => ({
    style: /font-style:\s*(\w+)/.exec(m[1]!)?.[1] ?? "normal",
    weight: /font-weight:\s*(\d+)/.exec(m[1]!)?.[1] ?? "400",
    url: /url\(([^)]+)\)/.exec(m[1]!)?.[1],
  }));
  const written: FontFile[] = [];
  const seen = new Set<string>();
  for (const f of faces) {
    if (!f.url || seen.has(f.url)) continue;
    seen.add(f.url);
    const file = path.join(dir, `${family.replace(/[^\w-]+/g, "")}-${f.weight}${f.style === "italic" ? "-italic" : ""}${path.extname(new URL(f.url).pathname) || ".ttf"}`);
    const data = Buffer.from(await (await fetch(f.url)).arrayBuffer());
    await writeFile(`${file}.part`, data);
    await rename(`${file}.part`, file);
    const n = await readFontNames(file);
    written.push({ family: n?.family ?? family, style: n?.style ?? `${f.weight}${f.style === "italic" ? " Italic" : ""}`, file });
  }
  if (!written.length) throw new Error(`Google Fonts returned no font files for "${family}"`);
  return written;
}

/** Curated Google Fonts families for video, by style. All open-licensed. */
export const FONT_PACKS = {
  sans: ["Inter", "Montserrat", "Poppins", "Roboto", "Open Sans", "Lato", "Raleway", "Nunito", "Work Sans", "DM Sans", "Manrope", "Plus Jakarta Sans", "Outfit", "Figtree", "Rubik", "Kanit", "Barlow", "Archivo", "Space Grotesk", "Sora", "Urbanist", "Lexend", "IBM Plex Sans", "Source Sans 3", "Josefin Sans", "Quicksand", "Mulish", "Karla", "Barlow Condensed", "Exo 2"],
  display: ["Bebas Neue", "Anton", "Oswald", "Archivo Black", "Black Ops One", "Bungee", "Righteous", "Russo One", "Alfa Slab One", "Bowlby One", "Passion One", "Titan One", "Luckiest Guy", "Bangers", "Fredoka", "Lilita One", "Staatliches", "Teko", "Big Shoulders Display", "Monoton", "Audiowide", "Orbitron", "Press Start 2P", "Rubik Mono One", "Chakra Petch", "Syne", "Unbounded", "Dela Gothic One", "Abril Fatface", "Ultra", "Bungee Shade", "Rampart One", "Zen Dots", "Michroma", "Bricolage Grotesque"],
  serif: ["Playfair Display", "Merriweather", "Lora", "DM Serif Display", "Cormorant Garamond", "EB Garamond", "Libre Baskerville", "Crimson Text", "Bodoni Moda", "Cinzel", "Prata", "Fraunces", "Spectral", "Noto Serif", "Roboto Slab", "Zilla Slab", "Arvo", "Bitter", "Instrument Serif", "Young Serif"],
  script: ["Pacifico", "Lobster", "Dancing Script", "Great Vibes", "Satisfy", "Sacramento", "Kaushan Script", "Yellowtail", "Allura", "Parisienne", "Alex Brush", "Cookie", "Courgette", "Tangerine", "Pinyon Script", "Mr Dafoe", "Marck Script", "Damion", "Monsieur La Doulaise", "Birthstone"],
  handwriting: ["Caveat", "Permanent Marker", "Shadows Into Light", "Indie Flower", "Amatic SC", "Patrick Hand", "Gloria Hallelujah", "Rock Salt", "Kalam", "Architects Daughter", "Covered By Your Grace", "Reenie Beanie", "Gochi Hand", "Nothing You Could Do", "Homemade Apple"],
  mono: ["JetBrains Mono", "Fira Code", "Roboto Mono", "Space Mono", "IBM Plex Mono", "Source Code Pro", "Inconsolata", "DM Mono", "Courier Prime", "VT323", "Share Tech Mono", "Major Mono Display"],
} as const;
export type FontPack = keyof typeof FONT_PACKS;

/**
 * Install many Google Fonts families at once (a few downloads at a time), skipping families already
 * in the fonts folder. Returns what was installed, skipped and what failed (with the reason).
 */
export async function installGoogleFonts(
  families: string[],
  opts: { dir?: string; weights?: number[]; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ installed: string[]; skipped: string[]; failed: { family: string; error: string }[] }> {
  const dir = opts.dir ?? defaultFontsDir();
  const have = new Set((await fontsIn(dir).catch(() => [] as FontFile[])).map((f) => f.family.toLowerCase()));
  const todo = [...new Set(families)].filter((f) => !have.has(f.toLowerCase()));
  const result = { installed: [] as string[], skipped: families.filter((f) => have.has(f.toLowerCase())), failed: [] as { family: string; error: string }[] };
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (let k = next++; k < todo.length; k = next++) {
      const family = todo[k]!;
      try {
        await installGoogleFont(family, { dir, weights: opts.weights });
        result.installed.push(family);
      } catch (e) {
        result.failed.push({ family, error: (e as Error).message });
      }
      opts.onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  return result;
}

// ---------------------------------------------------------------------------
// Icons: the Lucide icon font (ISC license), downloaded once.
// ---------------------------------------------------------------------------

const LUCIDE_VERSION = "1.61.0";
/** Font family name to use for icon text. */
export const ICON_FONT = "lucide";

let iconMap: Promise<Map<string, string>> | undefined;

/** Icon names mapped to their characters in the icon font, downloading the font on first use. */
export function iconGlyphs(dir = defaultFontsDir()): Promise<Map<string, string>> {
  iconMap ??= (async () => {
    await mkdir(dir, { recursive: true });
    const font = path.join(dir, "lucide.ttf");
    const info = path.join(dir, "lucide-info.json");
    const base = `https://cdn.jsdelivr.net/npm/lucide-static@${LUCIDE_VERSION}/font`;
    for (const [file, url] of [
      [font, `${base}/lucide.ttf`],
      [info, `${base}/info.json`],
    ] as const) {
      if (existsSync(file)) continue;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download the icon font (${url}: HTTP ${res.status})`);
      await writeFile(`${file}.part`, Buffer.from(await res.arrayBuffer()));
      await rename(`${file}.part`, file);
    }
    const map = JSON.parse(await readFile(info, "utf8")) as Record<string, { encodedCode: string }>;
    return new Map(Object.entries(map).map(([name, v]) => [name, String.fromCodePoint(parseInt(v.encodedCode.replace(/^\\/, ""), 16))]));
  })();
  iconMap.catch(() => (iconMap = undefined));
  return iconMap;
}

/** Names closest in spelling to a misspelled one (edit distance up to 3). */
export function closestIcons(names: Iterable<string>, name: string, limit = 6): string[] {
  const dist = (a: string, b: string) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length]!;
  };
  const scored: [number, string][] = [];
  for (const n of names) {
    // Compare with the whole name and with its first word, so "baterry" finds "battery-charging" too.
    const d = Math.min(dist(name, n), dist(name, n.split("-")[0]!) + 0.5);
    if (d <= 3) scored.push([d, n]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, limit).map(([, n]) => n);
}

/** Icon names matching a query (words in any order), best first: exact, then prefix, then contains. */
export function searchIcons(names: Iterable<string>, query: string, limit = 40): string[] {
  const words = query.toLowerCase().split(/[\s,-]+/).filter(Boolean);
  const q = words.join("-");
  const scored: [number, string][] = [];
  for (const n of names) {
    if (!words.every((w) => n.includes(w))) continue;
    scored.push([n === q ? 0 : n.startsWith(q) ? 1 : n.split("-").includes(words[0]!) ? 2 : 3, n]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1])).slice(0, limit).map(([, n]) => n);
}

/** prepareFonts results for previews, by fonts folder and the project's texts and families. */
const recentFonts = new Map<string, { at: number; value: Promise<Awaited<ReturnType<typeof prepareFonts>>> }>();

/**
 * prepareFonts for previews, which ask for frame after frame of the same edit: a result is reused
 * for `maxAgeMs` while the fonts folder, texts and families are the same (checking the folder takes
 * about 150 ms on a laptop). Fonts added to the folder show up once the result is that old.
 */
export function prepareFontsRecent(fontsDir: string | undefined, project: unknown, maxAgeMs = 30_000): ReturnType<typeof prepareFonts> {
  const key = JSON.stringify([path.resolve(fontsDir ?? defaultFontsDir()), textsAndFonts(project)]);
  const hit = recentFonts.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = prepareFonts(fontsDir, project);
  recentFonts.set(key, { at: Date.now(), value });
  value.catch(() => recentFonts.delete(key));
  if (recentFonts.size > 16) recentFonts.delete(recentFonts.keys().next().value!);
  return value;
}
