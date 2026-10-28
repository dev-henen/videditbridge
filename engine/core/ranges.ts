import { round3 } from "./util.js";

export interface TimeRange {
  start: number;
  end: number;
}

/** Sort and merge overlapping/adjacent ranges. */
export function mergeRanges(ranges: TimeRange[], tolerance = 0.001): TimeRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + tolerance) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** Complement of `remove` within [start, end]. */
export function invertRanges(remove: TimeRange[], start: number, end: number): TimeRange[] {
  const keep: TimeRange[] = [];
  let cursor = start;
  for (const r of mergeRanges(remove)) {
    if (r.end <= start || r.start >= end) continue;
    if (r.start > cursor) keep.push({ start: round3(cursor), end: round3(r.start) });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < end) keep.push({ start: round3(cursor), end: round3(end) });
  return keep;
}
