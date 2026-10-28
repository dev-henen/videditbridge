import type { Transcript, Word } from "../../core/schema.js";
import { round3 } from "../../core/util.js";

/** Parse `00:01:02,345`, `01:02.345` or `62.345` into seconds. */
export function parseTimestamp(ts: string): number {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) throw new Error(`Invalid timestamp: ${ts}`);
  return round3(parts.reduce((acc, p) => acc * 60 + p, 0));
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Spread a cue's words across its duration, weighted by word length. */
function cueToWords(cue: Cue): Word[] {
  const tokens = cue.text.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const total = tokens.reduce((s, t) => s + t.length + 1, 0);
  const span = cue.end - cue.start;
  let t = cue.start;
  return tokens.map((text) => {
    const d = (span * (text.length + 1)) / total;
    const w = { text, start: round3(t), end: round3(t + d) };
    t += d;
    return w;
  });
}

function parseCues(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    const [a, b] = lines[timeIdx]!.split("-->");
    const end = b!.trim().split(/\s+/)[0]!;
    cues.push({ start: parseTimestamp(a!), end: parseTimestamp(end), text: lines.slice(timeIdx + 1).join(" ") });
  }
  return cues;
}

/** SRT → transcript. Word timings are estimated within each cue. */
export function fromSRT(content: string): Transcript {
  return { words: parseCues(content).flatMap(cueToWords), estimated: true };
}

/** WebVTT → transcript. Word timings are estimated within each cue. */
export function fromVTT(content: string): Transcript {
  return { words: parseCues(content.replace(/^WEBVTT[^\n]*\n/, "")).flatMap(cueToWords), estimated: true };
}

/** Plain text with a known duration → evenly estimated transcript (e.g. a voice-over script). */
export function fromPlainText(text: string, duration: number, start = 0): Transcript {
  return { words: cueToWords({ start, end: start + duration, text }), estimated: true };
}

/**
 * OpenAI Whisper / gpt-4o-transcribe `verbose_json` (with `timestamp_granularities: ["word"]`),
 * or whisper.cpp / faster-whisper style output with segments[].words[].
 */
export function fromWhisper(json: unknown): Transcript {
  const data = json as {
    language?: string;
    words?: { word: string; start: number; end: number; probability?: number }[];
    segments?: { text: string; start: number; end: number; words?: { word: string; start: number; end: number; probability?: number }[] }[];
  };
  const toWord = (w: { word: string; start: number; end: number; probability?: number }): Word => ({
    text: w.word.trim(),
    start: round3(w.start),
    end: round3(w.end),
    ...(w.probability !== undefined ? { confidence: w.probability } : {}),
  });
  if (data.words?.length) {
    return { language: data.language, words: attachPunctuation(data.words.map(toWord), data.segments) };
  }
  if (data.segments?.some((s) => s.words?.length)) {
    return { language: data.language, words: data.segments.flatMap((s) => (s.words ?? []).map(toWord)).filter((w) => w.text) };
  }
  if (data.segments) {
    return { language: data.language, words: data.segments.flatMap((s) => cueToWords(s)), estimated: true };
  }
  throw new Error("Unrecognized Whisper JSON: expected `words` or `segments`");
}

/**
 * The OpenAI top-level `words` array has no punctuation; borrow it from segment text
 * so caption chunking can break on sentences.
 */
function attachPunctuation(words: Word[], segments?: { text: string }[]): Word[] {
  if (!segments?.length) return words;
  const tokens = segments.flatMap((s) => s.text.split(/\s+/).filter(Boolean));
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  let j = 0;
  return words.map((w) => {
    const target = norm(w.text);
    for (let k = j; k < Math.min(tokens.length, j + 4); k++) {
      if (norm(tokens[k]!) === target) {
        j = k + 1;
        return { ...w, text: tokens[k]! };
      }
    }
    return w;
  });
}

/** Deepgram pre-recorded response. */
export function fromDeepgram(json: unknown): Transcript {
  const data = json as {
    results: { channels: { alternatives: { words: { word: string; punctuated_word?: string; start: number; end: number; confidence?: number; speaker?: number }[] }[]; detected_language?: string }[] };
  };
  const ch = data.results.channels[0];
  const words = ch?.alternatives[0]?.words ?? [];
  return {
    language: ch?.detected_language,
    words: words.map((w) => ({
      text: w.punctuated_word ?? w.word,
      start: round3(w.start),
      end: round3(w.end),
      ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
      ...(w.speaker !== undefined ? { speaker: `S${w.speaker}` } : {}),
    })),
  };
}

/** AssemblyAI transcript (times in milliseconds). */
export function fromAssemblyAI(json: unknown): Transcript {
  const data = json as { language_code?: string; words: { text: string; start: number; end: number; confidence?: number; speaker?: string | null }[] };
  return {
    language: data.language_code,
    words: data.words.map((w) => ({
      text: w.text,
      start: round3(w.start / 1000),
      end: round3(w.end / 1000),
      ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
      ...(w.speaker ? { speaker: w.speaker } : {}),
    })),
  };
}

export type TranscriptFormat = "srt" | "vtt" | "whisper" | "deepgram" | "assemblyai" | "transcript";

/** Detect the format of a transcript string/object and parse it. */
export function parseTranscript(input: string | object, format?: TranscriptFormat): Transcript {
  let data: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (format === "srt" || (!format && /^\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(trimmed))) return fromSRT(input);
    if (format === "vtt" || (!format && trimmed.startsWith("WEBVTT"))) return fromVTT(input);
    if (!format && /-->/.test(trimmed) && !trimmed.startsWith("{")) return fromSRT(input);
    data = JSON.parse(trimmed);
  }
  const obj = data as Record<string, unknown>;
  if (format === "deepgram" || (!format && obj.results && typeof obj.results === "object")) return fromDeepgram(obj);
  if (format === "assemblyai" || (!format && "language_code" in obj && Array.isArray(obj.words))) return fromAssemblyAI(obj);
  if (format === "transcript" || (!format && Array.isArray(obj.words) && (obj.words as { text?: unknown }[])[0]?.text !== undefined)) {
    return obj as unknown as Transcript;
  }
  return fromWhisper(obj);
}
