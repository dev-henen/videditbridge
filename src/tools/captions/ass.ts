import { toAssColor } from "../../core/util.js";
import { escapeAssChar } from "../../library/animations/index.js";
import type { CaptionStyle } from "../../library/caption-styles/index.js";
import type { CaptionChunk } from "./chunk.js";
import type { Word } from "../../core/schema.js";

/** Minimal ASS (Advanced SubStation Alpha) document builder. Rendered by libass inside FFmpeg. */

export interface AssStyle {
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  secondaryColor: string;
  outlineColor: string;
  backColor: string;
  bold: boolean;
  italic: boolean;
  spacing: number;
  /** 1 = outline + shadow, 3 = opaque box. */
  borderStyle: 1 | 3;
  outline: number;
  shadow: number;
  /** Numpad alignment (5 = center). */
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

export interface AssEvent {
  layer: number;
  start: number;
  end: number;
  style: string;
  text: string;
}

export class AssDocument {
  private styles = new Map<string, AssStyle>();
  private styleKeys = new Map<string, string>();
  readonly events: AssEvent[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    /** 0 = smart wrap, 2 = no wrapping (explicit \N only). */
    readonly wrapStyle: 0 | 2 = 0,
  ) {}

  /** Register a style, reusing an identical one. Returns its name. */
  addStyle(style: AssStyle, hint = "S"): string {
    const key = JSON.stringify(style);
    const existing = this.styleKeys.get(key);
    if (existing) return existing;
    const name = `${hint.replace(/[^A-Za-z0-9]/g, "")}${this.styles.size + 1}`;
    this.styles.set(name, style);
    this.styleKeys.set(key, name);
    return name;
  }

  addEvent(ev: AssEvent): void {
    // Centisecond precision; skip events that would vanish after rounding.
    if (Math.round(ev.end * 100) <= Math.round(ev.start * 100)) return;
    this.events.push(ev);
  }

  get isEmpty(): boolean {
    return this.events.length === 0;
  }

  toString(): string {
    const styleLines = [...this.styles].map(([name, s]) =>
      [
        `Style: ${name}`,
        s.fontFamily,
        Math.round(s.fontSize),
        toAssColor(s.primaryColor),
        toAssColor(s.secondaryColor),
        toAssColor(s.outlineColor),
        toAssColor(s.backColor),
        s.bold ? -1 : 0,
        s.italic ? -1 : 0,
        0,
        0,
        100,
        100,
        s.spacing,
        0,
        s.borderStyle,
        s.outline,
        s.shadow,
        s.alignment,
        s.marginL,
        s.marginR,
        s.marginV,
        1,
      ].join(","),
    );
    const eventLines = this.events.map(
      (e) => `Dialogue: ${e.layer},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`,
    );
    return [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${this.width}`,
      `PlayResY: ${this.height}`,
      `WrapStyle: ${this.wrapStyle}`,
      "ScaledBorderAndShadow: yes",
      "YCbCr Matrix: TV.709",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      ...styleLines,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...eventLines,
      "",
    ].join("\n");
  }
}

/** Seconds → `H:MM:SS.cc`. */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

export function escapeAssText(text: string): string {
  return [...text].map(escapeAssChar).join("").replace(/\r?\n/g, "\\N");
}

// ---------------------------------------------------------------------------
// Captions → ASS events
// ---------------------------------------------------------------------------

export interface CaptionRenderOptions {
  width: number;
  height: number;
  /** ASS layer index (higher draws on top). */
  layer?: number;
}

/** Scale factor for sizes authored at a 1080px short side. */
export function sizeScale(width: number, height: number): number {
  return Math.min(width, height) / 1080;
}

export function captionAssStyle(style: CaptionStyle, width: number, height: number): AssStyle {
  const k = sizeScale(width, height);
  const box = !!style.background;
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize * k,
    // Karaoke: primary = sung color, secondary = not yet sung.
    primaryColor: style.mode === "karaoke" ? style.highlightColor : style.color,
    secondaryColor: style.color,
    outlineColor: box ? style.background! : style.outlineColor,
    backColor: style.shadowColor,
    bold: style.bold,
    italic: style.italic,
    spacing: style.letterSpacing,
    borderStyle: box ? 3 : 1,
    outline: Math.round(style.outlineWidth * k * 10) / 10,
    shadow: Math.round(style.shadow * k * 10) / 10,
    alignment: 5,
    marginL: Math.round(width * 0.05),
    marginR: Math.round(width * 0.05),
    marginV: 0,
  };
}

const displayText = (w: Word, style: CaptionStyle) => escapeAssText(style.uppercase ? w.text.toUpperCase() : w.text);

function entranceTags(style: CaptionStyle, x: number, y: number, height: number): string {
  switch (style.animation) {
    case "pop":
      return `\\pos(${x},${y})\\fscx70\\fscy70\\t(0,90,\\fscx108\\fscy108)\\t(90,160,\\fscx100\\fscy100)`;
    case "zoom":
      return `\\pos(${x},${y})\\fad(120,0)\\fscx40\\fscy40\\t(0,150,0.5,\\fscx100\\fscy100)`;
    case "fade":
      return `\\pos(${x},${y})\\fad(150,0)`;
    case "slide-up": {
      const off = Math.round(height * 0.02);
      return `\\move(${x},${y + off},${x},${y},0,150)\\fad(120,0)`;
    }
    default:
      return `\\pos(${x},${y})`;
  }
}

/** Add caption chunks to an ASS document according to the caption style. */
export function addCaptionEvents(doc: AssDocument, chunks: CaptionChunk[], style: CaptionStyle, opts: CaptionRenderOptions): void {
  const styleName = doc.addStyle(captionAssStyle(style, opts.width, opts.height), "Caption");
  const layer = opts.layer ?? 100;
  const x = Math.round(opts.width / 2);
  const y = Math.round(opts.height * style.position);
  const hl = toAssColor(style.highlightColor);
  const scale = Math.round(style.highlightScale * 100);

  for (const chunk of chunks) {
    const flat = chunk.lines.flat();
    switch (style.mode) {
      case "static": {
        const text = chunk.lines.map((l) => l.map((w) => displayText(w, style)).join(" ")).join("\\N");
        doc.addEvent({ layer, start: chunk.start, end: chunk.end, style: styleName, text: `{${entranceTags(style, x, y, opts.height)}}${text}` });
        break;
      }
      case "karaoke": {
        let cursor = chunk.start;
        const text = chunk.lines
          .map((line) =>
            line
              .map((w) => {
                // Fold any gap before the word into its sweep so timing stays aligned.
                const cs = Math.max(1, Math.round((w.end - cursor) * 100));
                cursor = w.end;
                return `{\\kf${cs}}${displayText(w, style)}`;
              })
              .join(" "),
          )
          .join("\\N");
        doc.addEvent({ layer, start: chunk.start, end: chunk.end, style: styleName, text: `{${entranceTags(style, x, y, opts.height)}}${text}` });
        break;
      }
      case "highlight":
      case "reveal":
      case "word": {
        flat.forEach((active, i) => {
          const start = i === 0 ? chunk.start : active.start;
          const end = i === flat.length - 1 ? chunk.end : flat[i + 1]!.start;
          const first = i === 0;
          const pos = first ? entranceTags(style, x, y, opts.height) : `\\pos(${x},${y})`;
          let text: string;
          if (style.mode === "word") {
            const pop = style.animation === "pop" && !first ? `\\fscx80\\fscy80\\t(0,80,\\fscx100\\fscy100)` : "";
            text = `{${pos}${pop}}${displayText(active, style)}`;
          } else {
            let idx = 0;
            text =
              `{${pos}}` +
              chunk.lines
                .map((line) =>
                  line
                    .map((w) => {
                      const j = idx++;
                      const t = displayText(w, style);
                      if (style.mode === "reveal") return j <= i ? t : `{\\alpha&HFF&}${t}{\\alpha&H00&}`;
                      if (j !== i) return t;
                      const grow = scale !== 100 ? `\\fscx${scale}\\fscy${scale}` : "";
                      return `{\\1c${hl}${grow}}${t}{\\1c${toAssColor(style.color)}\\fscx100\\fscy100}`;
                    })
                    .join(" "),
                )
                .join("\\N");
          }
          doc.addEvent({ layer, start, end, style: styleName, text });
        });
        break;
      }
    }
  }
}
