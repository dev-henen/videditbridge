/**
 * The shape of a song on its bar grid: how loud each bar is, sections (intro, build, drop, chorus,
 * verse, breakdown, outro) in phrases of 4 bars, where the drop lands, and the best stretch of a given
 * length to cut a video to. Loudness here is the RMS level in dB of each bar, which follows the
 * arrangement (instruments coming in and out) closely enough to find its sections.
 */

export interface MusicSection {
  kind: "intro" | "build" | "drop" | "chorus" | "verse" | "breakdown" | "outro";
  start: number;
  end: number;
  bars: number;
  /** Mean level of its bars, dB below the loudest phrase (0 = as loud as the song gets). */
  level: number;
}

export interface MusicWindow {
  start: number;
  end: number;
  bars: number;
  /** The drop's time when it falls inside, at least two bars in. */
  drop?: number;
  /** Mean level, dB below the loudest phrase. */
  level: number;
}

export interface MusicStructure {
  /** Seconds per bar. */
  barLength: number;
  /** Level of each bar (dB below the loudest phrase), from each downbeat. */
  bars: { start: number; level: number }[];
  sections: MusicSection[];
  /** Start of the first jump of 2 dB or more into one of the loudest phrases, if there is one. */
  drop?: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round1 = (v: number) => Math.round(v * 10) / 10;
const mean = (l: number[]) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);

/** RMS level in dB of each bar: from each downbeat to the next (the last to `end`). */
export function barLevels(samples: Float32Array, rate: number, downbeats: number[], end: number): number[] {
  return downbeats.map((t, k) => {
    const [a, b] = [Math.floor(t * rate), Math.min(samples.length, Math.floor((downbeats[k + 1] ?? end) * rate))];
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i]! * samples[i]!;
    return b > a ? 10 * Math.log10(sum / (b - a) + 1e-12) : -120;
  });
}

/** Sections and the drop from the bars' levels (dB) and downbeats. Phrases are 4 bars from the first downbeat. */
export function musicStructure(levels: number[], downbeats: number[], duration: number, phrase = 4): MusicStructure {
  const barLength = downbeats.length > 1 ? (downbeats.at(-1)! - downbeats[0]!) / (downbeats.length - 1) : 0;
  const phrases: { first: number; count: number; level: number }[] = [];
  for (let k = 0; k < levels.length; k += phrase) phrases.push({ first: k, count: Math.min(phrase, levels.length - k), level: mean(levels.slice(k, k + phrase)) });
  const top = Math.max(...phrases.map((p) => p.level), -120);
  const rel = (v: number) => round1(v - top);
  const bars = downbeats.map((start, k) => ({ start: round2(start), level: rel(levels[k] ?? -120) }));
  // Loud, quiet or between, against the loudest phrase.
  const tier = (v: number) => (v >= top - 2.5 ? "high" : v <= top - 8 ? "low" : "mid");
  // The drop is the first jump of 2 dB or more into one of the loudest phrases (a jump out of a quiet
  // intro into a middling verse is not a drop; a later chorus coming back is not the drop either).
  let drop: number | undefined;
  for (let k = 1; k < phrases.length && drop === undefined; k++) {
    if (tier(phrases[k]!.level) === "high" && phrases[k]!.level - phrases[k - 1]!.level >= 2) drop = downbeats[phrases[k]!.first];
  }
  const runs: { tier: string; first: number; last: number }[] = [];
  phrases.forEach((p, k) => {
    const t = tier(p.level);
    if (runs.at(-1)?.tier === t) runs.at(-1)!.last = k;
    else runs.push({ tier: t, first: k, last: k });
  });
  const sections = runs.map((r, k): MusicSection => {
    const firstBar = phrases[r.first]!.first;
    const lastBar = phrases[r.last]!.first + phrases[r.last]!.count - 1;
    const start = downbeats[firstBar]!;
    const end = downbeats[lastBar + 1] ?? duration;
    const kind: MusicSection["kind"] =
      r.tier === "high"
        ? drop !== undefined && Math.abs(start - drop) < 0.05 ? "drop" : "chorus"
        : r.tier === "low"
          ? k === 0 ? "intro" : k === runs.length - 1 ? "outro" : "breakdown"
          : runs[k + 1]?.tier === "high" ? "build" : k === 0 ? "intro" : k === runs.length - 1 ? "outro" : "verse";
    return { kind, start: round2(start), end: round2(end), bars: lastBar - firstBar + 1, level: rel(mean(levels.slice(firstBar, lastBar + 1))) };
  });
  return { barLength: round2(barLength), bars, sections, ...(drop !== undefined ? { drop: round2(drop) } : {}) };
}

/**
 * The best stretch of about `seconds` to cut to: whole bars, starting on a phrase, as loud as
 * possible, preferring one with the drop inside after a little build (two bars or more).
 */
export function bestWindow(s: MusicStructure, seconds: number, phrase = 4): MusicWindow | undefined {
  if (!s.barLength || !s.bars.length) return undefined;
  const n = Math.max(1, Math.round(seconds / s.barLength));
  let best: (MusicWindow & { score: number }) | undefined;
  for (let first = 0; first + n <= s.bars.length; first += phrase) {
    const start = s.bars[first]!.start;
    const end = s.bars[first + n]?.start ?? round2(start + n * s.barLength);
    const level = round1(mean(s.bars.slice(first, first + n).map((b) => b.level)));
    const drop = s.drop !== undefined && s.drop >= start + 2 * s.barLength - 0.05 && s.drop < end ? s.drop : undefined;
    const score = level + (drop !== undefined ? 3 : 0);
    if (!best || score > best.score) best = { start, end, bars: n, level, score, ...(drop !== undefined ? { drop } : {}) };
  }
  if (!best) return undefined;
  const { score: _, ...w } = best;
  return w;
}

/**
 * Where a run of shots cuts on a song's beat grid. `beats` are source seconds of the music, `start`
 * the source second the video starts at, `lengths` each shot's length in beats. Returns each shot's
 * timeline start and end (seconds from `start`). Past the last detected beat the grid goes on at
 * `beatLength`.
 */
export function placeOnBeats(beats: number[], start: number, lengths: number[], beatLength: number): { start: number; end: number }[] {
  // Timeline beat times from the video's start: 0, then every beat after it.
  const grid = [0, ...beats.map((b) => b - start).filter((t) => t > 0.05)];
  const at = (k: number) => (k < grid.length ? grid[k]! : grid.at(-1)! + (k - grid.length + 1) * beatLength);
  const out: { start: number; end: number }[] = [];
  let k = 0;
  for (const n of lengths) {
    const from = at(k);
    k += Math.max(1, Math.round(n));
    out.push({ start: Math.round(from * 1000) / 1000, end: Math.round(at(k) * 1000) / 1000 });
  }
  return out;
}
