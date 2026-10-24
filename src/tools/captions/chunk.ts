import type { CaptionSegment, Word } from "../../core/schema.js";
import { round3 } from "../../core/util.js";

export interface CaptionChunk {
  start: number;
  end: number;
  words: Word[];
  /** Words split into display lines. */
  lines: Word[][];
}

export interface ChunkOptions {
  maxWordsPerLine: number;
  maxCharsPerLine: number;
  maxLines: number;
  maxDuration: number;
  /** A pause longer than this starts a new chunk. */
  breakOnGap?: number;
}

const lineLength = (ws: Word[]) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);

/** Group timed words into on-screen caption chunks with line breaks. */
export function chunkWords(words: Word[], opts: ChunkOptions): CaptionChunk[] {
  const gap = opts.breakOnGap ?? 0.6;
  const chunks: CaptionChunk[] = [];
  let lines: Word[][] = [[]];

  const flush = () => {
    const ws = lines.flat();
    if (ws.length) chunks.push({ start: ws[0]!.start, end: ws[ws.length - 1]!.end, words: ws, lines: lines.filter((l) => l.length) });
    lines = [[]];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    let line = lines[lines.length - 1]!;
    const all = lines.flat();
    const prev = all[all.length - 1];
    if (prev && (w.start - prev.end > gap || w.end - all[0]!.start > opts.maxDuration)) {
      flush();
      line = lines[0]!;
    } else if (line.length && (line.length >= opts.maxWordsPerLine || lineLength([...line, w]) > opts.maxCharsPerLine)) {
      if (lines.length >= opts.maxLines) {
        flush();
      } else {
        lines.push([]);
      }
      line = lines[lines.length - 1]!;
    }
    line.push(w);
    // Sentence end closes the chunk so captions don't straddle sentences.
    if (/[.!?…]["')\]]?$/.test(w.text)) flush();
  }
  flush();

  // Keep each chunk on screen until the next starts if the gap is small (less flicker).
  for (let i = 0; i < chunks.length - 1; i++) {
    const c = chunks[i]!;
    const next = chunks[i + 1]!;
    if (next.start - c.end < 0.4) c.end = next.start;
  }
  return chunks.map((c) => ({ ...c, start: round3(c.start), end: round3(c.end) }));
}

/**
 * Turn manual caption segments into chunks (word timings are spread evenly).
 * Segment boundaries are respected; long segments are split further.
 */
export function segmentsToChunks(segments: CaptionSegment[], opts: ChunkOptions): CaptionChunk[] {
  return segments.flatMap((s) => {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const d = (s.end - s.start) / Math.max(1, tokens.length);
    const words: Word[] = tokens.map((text, i) => ({ text, start: round3(s.start + i * d), end: round3(s.start + (i + 1) * d) }));
    const chunks = chunkWords(words, { ...opts, maxDuration: Math.max(opts.maxDuration, s.end - s.start) });
    const last = chunks[chunks.length - 1];
    if (last) last.end = s.end;
    return chunks;
  });
}
