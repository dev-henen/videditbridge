/**
 * Fallback fonts by writing system. Text in a script the chosen font lacks (CJK, Arabic, emoji...)
 * would otherwise fall back to whatever each system has, so it would look different on Windows,
 * macOS and Linux. Instead the renderer switches to the same open Noto font everywhere.
 */
export interface ScriptFont {
  script: string;
  /** Google Fonts family (open-licensed), downloaded into the fonts folder when a project needs it. */
  family: string;
  test: RegExp;
}

export const SCRIPT_FONTS: readonly ScriptFont[] = [
  { script: "Japanese", family: "Noto Sans JP", test: /[぀-ヿㇰ-ㇿ]/u },
  { script: "Korean", family: "Noto Sans KR", test: /[ᄀ-ᇿ㄰-㆏가-힯]/u },
  { script: "Chinese", family: "Noto Sans SC", test: /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/u },
  { script: "Arabic", family: "Noto Sans Arabic", test: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u },
  { script: "Hebrew", family: "Noto Sans Hebrew", test: /[֐-׿יִ-ﭏ]/u },
  { script: "Devanagari", family: "Noto Sans Devanagari", test: /[ऀ-ॿ]/u },
  { script: "Bengali", family: "Noto Sans Bengali", test: /[ঀ-৿]/u },
  { script: "Tamil", family: "Noto Sans Tamil", test: /[஀-௿]/u },
  { script: "Thai", family: "Noto Sans Thai", test: /[฀-๿]/u },
  // Monochrome: libass and resvg do not draw color emoji fonts.
  { script: "Emoji", family: "Noto Emoji", test: /\p{Extended_Pictographic}/u },
];

const byScript = (script: string) => SCRIPT_FONTS.find((s) => s.script === script)!;

/**
 * The script font for one character of a text, or undefined for scripts the bundled fonts cover
 * (Latin, Greek, Cyrillic). Chinese characters follow the text: Japanese when it has kana, Korean
 * when it has Hangul.
 */
export function scriptFontFor(ch: string, text: string): ScriptFont | undefined {
  const s = SCRIPT_FONTS.find((f) => f.test.test(ch));
  if (s?.script !== "Chinese") return s;
  if (byScript("Japanese").test.test(text)) return byScript("Japanese");
  if (byScript("Korean").test.test(text)) return byScript("Korean");
  return s;
}

/** The script fonts a set of texts may need. */
export function scriptFontsFor(texts: Iterable<string>): ScriptFont[] {
  const found = new Set<ScriptFont>();
  for (const text of texts) for (const ch of text) {
    const s = /[\x00-ɏ]/.test(ch) ? undefined : scriptFontFor(ch, text);
    if (s) found.add(s);
  }
  return [...found];
}

export interface FontFallback {
  /** Whether a family has a glyph for a code point; false or undefined when unknown. */
  covers(family: string, codePoint: number): boolean | undefined;
}

/** Characters that stay in the font around them: spaces, joiners and emoji modifiers. */
const NEUTRAL = /[\s‌‍︎️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;

/**
 * ASS event text with \fn switches to the script font wherever the font in effect (the style's,
 * or one set by an earlier \fn tag) has no glyph. Override blocks and \N, \n, \h pass through.
 */
export function applyFontFallback(text: string, base: string, fallback: FontFallback): string {
  const plain = text.replace(/\{[^}]*\}/g, "");
  let out = "";
  let active = base;
  let emitted = base;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "{") {
      const end = text.indexOf("}", i);
      const block = end < 0 ? text.slice(i) : text.slice(i, end + 1);
      const fn = [...block.matchAll(/\\(fn([^\\}]*)|r)/g)].at(-1);
      if (fn) {
        active = fn[2]?.trim() || base;
        emitted = active;
      }
      out += block;
      i += block.length;
      continue;
    }
    if (text[i] === "\\" && /[Nnh]/.test(text[i + 1] ?? "")) {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (!NEUTRAL.test(ch)) {
      const s = cp > 0x24f ? scriptFontFor(ch, plain) : undefined;
      const target = s && fallback.covers(active, cp) !== true ? s.family : active;
      if (target !== emitted) {
        out += `{\\fn${target}}`;
        emitted = target;
      }
    }
    out += ch;
  }
  return out;
}
