import type { Transcript } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { mergeRanges, type TimeRange } from "../../core/ranges.js";
import { DEFAULT_FILLERS, findFillers, findRepetitions, findSilences } from "./analyze.js";


export interface CleanupOptions {
  /** Remove filler words. `true` uses the default list. */
  fillers?: boolean | string[];
  /** Remove stutters / immediately repeated words. */
  repetitions?: boolean;
  /** Shorten pauses longer than this many seconds. */
  maxPause?: number;
  /** Pause length to leave behind when shortening (seconds). */
  keepPause?: number;
  /** Media length, to trim leading/trailing silence too. */
  mediaDuration?: number;
  /** Ignore resulting cuts shorter than this (avoids choppy micro-cuts). */
  minCut?: number;
}

export interface CleanupPlan {
  /** Source-time ranges to remove. */
  remove: (TimeRange & { reason: string; text?: string })[];
  /** Total seconds removed. */
  removedDuration: number;
}

/** Plan which source ranges to cut to tighten up a talking-head recording. */
export function planCleanup(t: Transcript, opts: CleanupOptions = {}): CleanupPlan {
  const keepPause = opts.keepPause ?? 0.25;
  const minCut = opts.minCut ?? 0.12;
  const remove: CleanupPlan["remove"] = [];

  if (opts.fillers) {
    const list = Array.isArray(opts.fillers) ? opts.fillers : DEFAULT_FILLERS;
    for (const f of findFillers(t, list)) {
      // Extend the cut into the surrounding gap so it doesn't clip neighbouring words.
      const prev = t.words[f.wordStart - 1];
      const next = t.words[f.wordEnd];
      const start = prev ? Math.max(prev.end, f.start - 0.05) : f.start;
      const end = next ? Math.min(next.start, f.end + 0.05) : f.end;
      remove.push({ start: round3(start), end: round3(end), reason: "filler", text: f.text });
    }
  }
  if (opts.repetitions) {
    for (const r of findRepetitions(t)) remove.push({ start: r.start, end: r.end, reason: "repetition", text: r.text });
  }
  if (opts.maxPause !== undefined) {
    for (const s of findSilences(t, { minDuration: opts.maxPause, mediaDuration: opts.mediaDuration })) {
      const edge = s.start === 0 || (opts.mediaDuration !== undefined && s.end >= opts.mediaDuration);
      const pad = edge ? Math.min(0.15, keepPause) : keepPause / 2;
      const start = s.start === 0 ? 0 : s.start + pad;
      const end = opts.mediaDuration !== undefined && s.end >= opts.mediaDuration ? s.end : s.end - pad;
      remove.push({ start: round3(start), end: round3(end), reason: "pause" });
    }
  }
  const filtered = remove.filter((r) => r.end - r.start >= minCut).sort((a, b) => a.start - b.start);
  const removedDuration = round3(mergeRanges(filtered).reduce((s, r) => s + (r.end - r.start), 0));
  return { remove: filtered, removedDuration };
}
