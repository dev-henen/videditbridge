import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Fonts beyond the ones installed on the system: a folder the renderer always passes to libass
 * (default ~/.cache/ai-video-editor/fonts, or $AVE_FONTS_DIR). Google Fonts are downloaded into it
 * by family name, and the Lucide icon font lives there too.
 */
export function defaultFontsDir(): string {
  return process.env.AVE_FONTS_DIR ?? path.join(homedir(), ".cache", "ai-video-editor", "fonts");
}

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

/** Fonts in one folder (not recursive). */
export async function fontsIn(dir: string): Promise<FontFile[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => FONT_EXT.test(f));
  const out: FontFile[] = [];
  for (const f of files) {
    const n = await readFontNames(path.join(dir, f));
    if (n) out.push({ ...n, file: path.join(dir, f) });
  }
  return out;
}

/** System font folders (Windows, macOS, Linux). */
export function systemFontDirs(): string[] {
  const dirs =
    process.platform === "win32"
      ? [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"), path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Windows", "Fonts")]
      : process.platform === "darwin"
        ? ["/System/Library/Fonts", "/Library/Fonts", path.join(homedir(), "Library", "Fonts")]
        : ["/usr/share/fonts", "/usr/local/share/fonts", path.join(homedir(), ".fonts")];
  return dirs.filter((d) => d && existsSync(d));
}

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
  for (const d of systemFontDirs()) add(await fontsIn(d), "system");
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
