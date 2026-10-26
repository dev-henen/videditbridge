import type { Transcript, Word } from "../../core/schema.js";
import { round3 } from "../../core/util.js";
import { normalizeWord } from "./analyze.js";

export interface WordReplacement {
  /** Word or phrase to find (matched word by word, ignoring case and punctuation). */
  find: string;
  /** Text to put in its place; empty removes the words from the transcript (not from the video). */
  replace: string;
}

export interface TranscriptChange {
  start: number;
  end: number;
  from: string;
  to: string;
}

const LEAD = /^[^\p{L}\p{N}]*/u;
const TRAIL = /[^\p{L}\p{N}]*$/u;

/**
 * Replace words and phrases in a transcript. The new words share the time span of the words they
 * replace (split by length), keep the punctuation around the match, and take a capital letter
 * when the original started with one ("gonna" to "going to" at the start of a sentence).
 */
export function replaceWords(t: Transcript, rules: WordReplacement[]): { transcript: Transcript; changes: TranscriptChange[] } {
  let words = t.words;
  const changes: TranscriptChange[] = [];
  for (const rule of rules) {
    const find = rule.find.split(/\s+/).map(normalizeWord).filter(Boolean);
    if (!find.length) continue;
    const repl = rule.replace.split(/\s+/).filter(Boolean);
    const out: Word[] = [];
    for (let i = 0; i < words.length; ) {
      const match = find.every((f, k) => words[i + k] && normalizeWord(words[i + k]!.text) === f);
      if (!match) {
        out.push(words[i++]!);
        continue;
      }
      const old = words.slice(i, i + find.length);
      i += find.length;
      const first = old[0]!;
      const last = old[old.length - 1]!;
      const lead = LEAD.exec(first.text)![0];
      const trail = TRAIL.exec(last.text)![0];
      const core = first.text.slice(lead.length);
      const capital = /^\p{Lu}/u.test(core) && /^\p{Ll}/u.test(repl[0] ?? "");
      const texts = repl.map((w, k) => `${k === 0 ? lead : ""}${k === 0 && capital ? w[0]!.toUpperCase() + w.slice(1) : w}${k === repl.length - 1 ? trail : ""}`);
      const total = texts.reduce((n, w) => n + w.length, 0);
      let cursor = first.start;
      texts.forEach((text, k) => {
        const end = k === texts.length - 1 ? last.end : round3(cursor + ((last.end - first.start) * text.length) / total);
        out.push({ text, start: cursor, end, ...(first.speaker ? { speaker: first.speaker } : {}) });
        cursor = end;
      });
      changes.push({ start: first.start, end: last.end, from: old.map((w) => w.text).join(" "), to: texts.join(" ") });
    }
    words = out;
  }
  return { transcript: { ...t, words }, changes: changes.sort((a, b) => a.start - b.start) };
}

export interface VocabularySuggestion {
  /** The vocabulary term the words may be a mishearing of. */
  term: string;
  /** What the transcript says. */
  heard: string;
  start: number;
  end: number;
  /** 0..1, how close the words are in spelling and sound. */
  score: number;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

const similarity = (a: string, b: string) => (a || b ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 1);

/** A rough sound key: similar-sounding spellings collapse, and vowels after the first letter drop. */
function soundKey(s: string): string {
  const k = s
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/x/g, "ks")
    .replace(/(.)\1+/g, "$1");
  return k[0]! + k.slice(1).replace(/[aeiouyhw']/g, "");
}

/**
 * Words in a transcript that look like a speech recognizer's mishearing of a name or term
 * ("cloud" for "Claude", "cooper netties" for "Kubernetes"). Phrases of one word more or fewer
 * than the term are compared too, since recognizers often split or merge unfamiliar words.
 */
export function vocabularySuggestions(t: Transcript, vocabulary: string[], opts: { minScore?: number } = {}): VocabularySuggestion[] {
  const minScore = opts.minScore ?? 0.6;
  const norm = t.words.map((w) => normalizeWord(w.text));
  const found: VocabularySuggestion[] = [];
  for (const term of vocabulary) {
    const parts = term.split(/\s+/).map(normalizeWord).filter(Boolean);
    const target = parts.join("");
    if (target.length < 3) continue;
    const key = soundKey(target);
    for (const n of new Set([parts.length - 1, parts.length, parts.length + 1])) {
      if (n < 1) continue;
      for (let i = 0; i + n <= norm.length; i++) {
        const heard = norm.slice(i, i + n).join("");
        if (heard.length < 3 || heard === target) continue;
        const spelled = similarity(heard, target);
        const sounded = similarity(soundKey(heard), key);
        // Sound keys alone match too much ("could" and "Claude"); require some spelling likeness as well.
        const score = spelled >= 0.75 ? spelled : spelled >= 0.5 && sounded >= 0.75 ? (spelled + sounded) / 2 : 0;
        if (score < minScore) continue;
        const ws = t.words.slice(i, i + n);
        found.push({ term, heard: ws.map((w) => w.text).join(" "), start: ws[0]!.start, end: ws[ws.length - 1]!.end, score: round3(score) });
      }
    }
  }
  // Where suggestions overlap, keep the best one.
  found.sort((a, b) => b.score - a.score);
  const kept: VocabularySuggestion[] = [];
  for (const s of found) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}
