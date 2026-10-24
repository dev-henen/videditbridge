import type { Transcript, Word } from "../../core/schema.js";
import { formatTime, round3 } from "../../core/util.js";

import type { TimeRange } from "../../core/ranges.js";


export interface Sentence extends TimeRange {
  text: string;
  /** Index of the first word in transcript.words. */
  wordStart: number;
  /** Index after the last word. */
  wordEnd: number;
  speaker?: string;
}

/** Strip punctuation and lowercase, for matching. */
export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

export function transcriptText(t: Transcript): string {
  return t.words.map((w) => w.text).join(" ");
}

export function transcriptDuration(t: Transcript): number {
  return t.words.length ? t.words[t.words.length - 1]!.end : 0;
}

/** Split into sentences on terminal punctuation, speaker changes or long pauses. */
export function sentences(t: Transcript, opts: { maxGap?: number } = {}): Sentence[] {
  const maxGap = opts.maxGap ?? 1.2;
  const out: Sentence[] = [];
  let startIdx = 0;
  const flush = (endIdx: number) => {
    if (endIdx <= startIdx) return;
    const ws = t.words.slice(startIdx, endIdx);
    out.push({
      text: ws.map((w) => w.text).join(" "),
      start: ws[0]!.start,
      end: ws[ws.length - 1]!.end,
      wordStart: startIdx,
      wordEnd: endIdx,
      ...(ws[0]!.speaker ? { speaker: ws[0]!.speaker } : {}),
    });
    startIdx = endIdx;
  };
  t.words.forEach((w, i) => {
    const next = t.words[i + 1];
    const terminal = /[.!?…]["')\]]?$/.test(w.text);
    const gap = next ? next.start - w.end > maxGap : false;
    const speakerChange = next ? next.speaker !== w.speaker : false;
    if (terminal || gap || speakerChange || !next) flush(i + 1);
  });
  return out;
}

/** Transcript as readable lines with timestamps, for an AI to read. */
export function formatTranscript(t: Transcript, opts: { maxGap?: number } = {}): string {
  return sentences(t, opts)
    .map((s) => `[${formatTime(s.start)}-${formatTime(s.end)}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`)
    .join("\n");
}

export interface SearchMatch extends TimeRange {
  text: string;
  wordStart: number;
  wordEnd: number;
  /** Surrounding words for context. */
  context: string;
}

/** Find a phrase (case/punctuation-insensitive) and return its time ranges. */
export function searchTranscript(t: Transcript, query: string): SearchMatch[] {
  const q = query.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (q.length === 0) return [];
  const norm = t.words.map((w) => normalizeWord(w.text));
  const matches: SearchMatch[] = [];
  for (let i = 0; i + q.length <= norm.length; i++) {
    if (q.every((qw, k) => norm[i + k] === qw)) {
      const ws = t.words.slice(i, i + q.length);
      matches.push({
        text: ws.map((w) => w.text).join(" "),
        start: ws[0]!.start,
        end: ws[ws.length - 1]!.end,
        wordStart: i,
        wordEnd: i + q.length,
        context: t.words
          .slice(Math.max(0, i - 6), i + q.length + 6)
          .map((w) => w.text)
          .join(" "),
      });
    }
  }
  return matches;
}

export function wordsInRange(t: Transcript, start: number, end: number): Word[] {
  return t.words.filter((w) => w.end > start && w.start < end);
}

export const DEFAULT_FILLERS = ["um", "uh", "uhm", "umm", "uhh", "er", "erm", "ah", "hmm", "mm", "mhm"];
/** Phrases that are usually filler but can be meaningful, opt in explicitly. */
export const EXTENDED_FILLERS = ["like", "you know", "i mean", "basically", "actually", "literally", "sort of", "kind of", "right", "so"];

export interface FillerMatch extends TimeRange {
  text: string;
  wordStart: number;
  wordEnd: number;
}

/** Find filler words/phrases. Multi-word fillers (e.g. "you know") are supported. */
export function findFillers(t: Transcript, fillers: string[] = DEFAULT_FILLERS): FillerMatch[] {
  const phrases = fillers.map((f) => f.split(/\s+/).map(normalizeWord)).sort((a, b) => b.length - a.length);
  const norm = t.words.map((w) => normalizeWord(w.text));
  const out: FillerMatch[] = [];
  for (let i = 0; i < norm.length; i++) {
    const hit = phrases.find((p) => p.every((pw, k) => norm[i + k] === pw));
    if (hit) {
      const ws = t.words.slice(i, i + hit.length);
      out.push({ text: ws.map((w) => w.text).join(" "), start: ws[0]!.start, end: ws[ws.length - 1]!.end, wordStart: i, wordEnd: i + hit.length });
      i += hit.length - 1;
    }
  }
  return out;
}

/** Immediately repeated words/phrases ("I I think", "we went we went"). Returns the earlier copy. */
export function findRepetitions(t: Transcript, maxPhrase = 3): FillerMatch[] {
  const norm = t.words.map((w) => normalizeWord(w.text));
  const out: FillerMatch[] = [];
  for (let i = 0; i < norm.length; i++) {
    for (let n = maxPhrase; n >= 1; n--) {
      if (i + 2 * n > norm.length) continue;
      const a = norm.slice(i, i + n);
      const b = norm.slice(i + n, i + 2 * n);
      if (a.every(Boolean) && a.join(" ") === b.join(" ")) {
        const ws = t.words.slice(i, i + n);
        out.push({ text: ws.map((w) => w.text).join(" "), start: ws[0]!.start, end: t.words[i + n]!.start, wordStart: i, wordEnd: i + n });
        i += n - 1;
        break;
      }
    }
  }
  return out;
}

export interface Silence extends TimeRange {
  duration: number;
}

/**
 * Gaps with no speech longer than `minDuration`.
 * Pass `mediaDuration` to also detect leading/trailing silence.
 */
export function findSilences(t: Transcript, opts: { minDuration?: number; mediaDuration?: number } = {}): Silence[] {
  const min = opts.minDuration ?? 0.7;
  const out: Silence[] = [];
  const push = (start: number, end: number) => {
    if (end - start >= min) out.push({ start: round3(start), end: round3(end), duration: round3(end - start) });
  };
  if (t.words.length === 0) {
    if (opts.mediaDuration) push(0, opts.mediaDuration);
    return out;
  }
  push(0, t.words[0]!.start);
  for (let i = 1; i < t.words.length; i++) push(t.words[i - 1]!.end, t.words[i]!.start);
  if (opts.mediaDuration !== undefined) push(t.words[t.words.length - 1]!.end, opts.mediaDuration);
  return out;
}

export interface TranscriptStats {
  words: number;
  duration: number;
  speakingTime: number;
  wordsPerMinute: number;
  fillerCount: number;
  speakers: string[];
}

export function transcriptStats(t: Transcript): TranscriptStats {
  const speakingTime = t.words.reduce((s, w) => s + (w.end - w.start), 0);
  const duration = transcriptDuration(t);
  return {
    words: t.words.length,
    duration,
    speakingTime: round3(speakingTime),
    wordsPerMinute: duration > 0 ? Math.round((t.words.length / duration) * 60) : 0,
    fillerCount: findFillers(t).length,
    speakers: [...new Set(t.words.map((w) => w.speaker).filter((s): s is string => !!s))],
  };
}

/** Shift and optionally slice a transcript (e.g. after trimming the source). */
export function sliceTranscript(t: Transcript, start: number, end: number, shift = -start): Transcript {
  return {
    ...t,
    words: wordsInRange(t, start, end).map((w) => ({
      ...w,
      start: round3(Math.max(start, w.start) + shift),
      end: round3(Math.min(end, w.end) + shift),
    })),
  };
}
