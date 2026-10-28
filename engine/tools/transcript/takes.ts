import type { Transcript } from "../../core/schema.js";
import type { TimeRange } from "../../core/ranges.js";
import { round3 } from "../../core/util.js";
import { normalizeWord, sentences, type Sentence } from "./analyze.js";

/**
 * Find retakes and repeats in talking footage by comparing whole sentences:
 *  - retake: a line said again shortly after, usually because the first attempt had a slip
 *    ("This is a test video record for..." then "This video is recorded for testing..."), or
 *    a sentence abandoned midway and restarted. Editors keep the last take.
 *  - repeat: consecutive complete sentences built the same way ("a nice video to edit",
 *    "a nice video to post", "a nice video to experiment with"), which feel repetitive in a short edit.
 */

export interface TakeGroup {
  kind: "retake" | "repeat";
  /** Sentence indexes in the group, in order. */
  sentences: number[];
  /** Suggested sentence to keep; the others are suggested for removal. */
  keep: number;
  /** 0..1, how alike the sentences are. */
  similarity: number;
  reason: string;
}

export interface TakeAnalysis {
  sentences: Sentence[];
  groups: TakeGroup[];
  /** Sentence indexes suggested for removal (all groups). */
  remove: number[];
}

const tokens = (s: Sentence) => s.text.split(/\s+/).map(normalizeWord).filter(Boolean);

/** Length of the longest common subsequence of two word lists. */
function lcs(a: string[], b: string[]): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Same word with a different ending ("record" / "recorded", "test" / "tested") counts as shared. */
function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
}

export function findRetakes(t: Transcript, opts: { lookahead?: number; retakeThreshold?: number; repeatThreshold?: number } = {}): TakeAnalysis {
  // Sentences from punctuation, not short pauses: a slip often comes mid-sentence after a pause.
  const sents = sentences(t, { maxGap: 2.5 });
  const toks = sents.map((s) => tokens(s).map(stem));
  const lookahead = opts.lookahead ?? 2;
  const retakeAt = opts.retakeThreshold ?? 0.6;
  const repeatAt = opts.repeatThreshold ?? 0.6;
  const groups: TakeGroup[] = [];
  const grouped = new Set<number>();

  /** Chains of consecutive look-alike complete sentences, at least `minLength` long. */
  const repeats = (minLength: number) => {
    for (let i = 0; i < sents.length - 1; i++) {
      if (grouped.has(i) || toks[i]!.length < 3) continue;
      const chain = [i];
      let sim = 1;
      for (let j = i + 1; j < sents.length && !grouped.has(j) && toks[j]!.length >= 3; j++) {
        const prev = toks[chain[chain.length - 1]!]!;
        const s = lcs(prev, toks[j]!) / Math.max(prev.length, toks[j]!.length);
        if (s < repeatAt) break;
        chain.push(j);
        sim = Math.min(sim, s);
      }
      if (chain.length < minLength) continue;
      chain.forEach((k) => grouped.add(k));
      // Keep the most complete version.
      const keep = chain.reduce((best, k) => (toks[k]!.length > toks[best]!.length ? k : best), chain[0]!);
      groups.push({
        kind: "repeat",
        sentences: chain,
        keep,
        similarity: round3(sim),
        reason: `${chain.length} sentences in a row say nearly the same thing (${Math.round(sim * 100)}% alike); one is usually enough, suggested: the most complete`,
      });
    }
  };

  // Three or more look-alikes in a row are a pattern of repetition, not a correction.
  repeats(3);

  for (let i = 0; i < sents.length; i++) {
    if (grouped.has(i) || toks[i]!.length < 3) continue;
    // Retake: a later sentence close by covers most of this one.
    for (let j = i + 1; j <= Math.min(sents.length - 1, i + lookahead); j++) {
      if (grouped.has(j) || toks[j]!.length < 3) continue;
      const common = lcs(toks[i]!, toks[j]!);
      const cover = common / Math.min(toks[i]!.length, toks[j]!.length);
      const sameStart = toks[i]![0] === toks[j]![0] && toks[i]![1] === toks[j]![1];
      const abandoned = !/[.!?…]["')\]]?$/.test(sents[i]!.text);
      if (cover >= retakeAt && (toks[j]!.length >= toks[i]!.length * 0.8 || abandoned || sameStart) && sents[j]!.start - sents[i]!.end < 8) {
        const between = Array.from({ length: j - i - 1 }, (_, k) => i + 1 + k);
        groups.push({
          kind: "retake",
          sentences: [i, ...between, j],
          keep: j,
          similarity: round3(cover),
          reason: `${abandoned ? "Unfinished sentence" : "Sentence"} said again ${j - i > 1 ? `${j - i} sentences later` : "right after"} (${Math.round(cover * 100)}% of its words); the later take is usually the corrected one`,
        });
        [i, ...between].forEach((k) => grouped.add(k));
        grouped.add(j);
        break;
      }
    }
  }

  // Remaining look-alike pairs that were not retakes.
  repeats(2);

  groups.sort((a, b) => a.sentences[0]! - b.sentences[0]!);
  const remove = groups.flatMap((g) => g.sentences.filter((k) => k !== g.keep));
  return { sentences: sents, groups, remove: [...new Set(remove)].sort((a, b) => a - b) };
}

/**
 * Source ranges that remove whole sentences cleanly: from just after the previous kept word to
 * just before the next kept word, so the pause around a removed sentence goes too and no kept
 * word is clipped.
 */
export function sentenceCutRanges(t: Transcript, sents: Sentence[], remove: number[], opts: { margin?: number } = {}): TimeRange[] {
  const margin = opts.margin ?? 0.12;
  const drop = new Set(remove);
  const ranges: TimeRange[] = [];
  for (const k of [...drop].sort((a, b) => a - b)) {
    const s = sents[k];
    if (!s) continue;
    const prevWord = t.words[s.wordStart - 1];
    const nextIdx = sents.slice(k + 1).find((_, n) => !drop.has(k + 1 + n));
    const nextWord = nextIdx ? t.words[nextIdx.wordStart] : undefined;
    const start = prevWord ? Math.max(prevWord.end + margin, s.start - 0.3) : Math.max(0, s.start - 0.3);
    const end = nextWord ? Math.max(start, Math.min(nextWord.start - margin, s.end + 0.6)) : s.end + 0.3;
    // Consecutive removals become one range.
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 0.7) last.end = round3(Math.max(last.end, end));
    else ranges.push({ start: round3(start), end: round3(end) });
  }
  return ranges.filter((r) => r.end > r.start);
}
