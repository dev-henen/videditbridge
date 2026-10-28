import { describe, expect, it } from "vitest";
import {
  cleanupSpeech,
  findFillers,
  findRepetitions,
  findSilences,
  formatTranscript,
  fromAssemblyAI,
  fromDeepgram,
  fromSRT,
  fromVTT,
  fromWhisper,
  parseTimestamp,
  parseTranscript,
  planCleanup,
  searchTranscript,
  sentences,
  transcriptStats,
} from "../../engine/tools/transcript/index.js";
import { computeTimeline, invertRanges, mergeRanges, parseProject, type Transcript } from "../../engine/core/index.js";

const words = (spec: [string, number, number][]): Transcript => ({ words: spec.map(([text, start, end]) => ({ text, start, end })) });

const talk = words([
  ["So", 0.5, 0.7],
  ["um", 0.8, 1.0],
  ["today", 1.1, 1.4],
  ["I", 1.5, 1.6],
  ["I", 1.7, 1.8],
  ["want", 1.9, 2.1],
  ["to", 2.1, 2.2],
  ["talk.", 2.2, 2.6],
  ["Uh", 4.0, 4.2],
  ["video", 4.3, 4.7],
  ["editing", 4.7, 5.2],
  ["is", 5.3, 5.4],
  ["fun!", 5.4, 5.8],
]);

describe("parsing", () => {
  it("parses timestamps", () => {
    expect(parseTimestamp("00:01:02,345")).toBe(62.345);
    expect(parseTimestamp("01:02.5")).toBe(62.5);
  });

  it("parses SRT with estimated word timings", () => {
    const t = fromSRT("1\n00:00:01,000 --> 00:00:03,000\nHello big world\n\n2\n00:00:04,000 --> 00:00:05,000\n<i>Bye</i>\n");
    expect(t.estimated).toBe(true);
    expect(t.words.map((w) => w.text)).toEqual(["Hello", "big", "world", "Bye"]);
    expect(t.words[0]!.start).toBe(1);
    expect(t.words[2]!.end).toBe(3);
  });

  it("parses VTT", () => {
    const t = fromVTT("WEBVTT\n\n00:00.500 --> 00:01.500 align:center\nHi there\n");
    expect(t.words).toHaveLength(2);
    expect(t.words[0]!.start).toBe(0.5);
  });

  it("parses Whisper verbose_json and restores punctuation from segments", () => {
    const t = fromWhisper({
      language: "en",
      words: [
        { word: "Hello", start: 0, end: 0.4 },
        { word: "world", start: 0.5, end: 0.9 },
      ],
      segments: [{ text: " Hello, world!", start: 0, end: 0.9 }],
    });
    expect(t.words.map((w) => w.text)).toEqual(["Hello,", "world!"]);
    expect(t.language).toBe("en");
  });

  it("parses Deepgram and AssemblyAI", () => {
    const dg = fromDeepgram({ results: { channels: [{ alternatives: [{ words: [{ word: "hi", punctuated_word: "Hi.", start: 1, end: 1.2, speaker: 0 }] }] }] } });
    expect(dg.words[0]).toMatchObject({ text: "Hi.", speaker: "S0" });
    const aai = fromAssemblyAI({ language_code: "en", words: [{ text: "Yo", start: 1000, end: 1500, speaker: "A" }] });
    expect(aai.words[0]).toMatchObject({ text: "Yo", start: 1, end: 1.5, speaker: "A" });
  });

  it("auto-detects formats", () => {
    expect(parseTranscript("1\n00:00:00,000 --> 00:00:01,000\nhey\n").words[0]!.text).toBe("hey");
    expect(parseTranscript("WEBVTT\n\n00:00.000 --> 00:01.000\nhey\n").words[0]!.text).toBe("hey");
    expect(parseTranscript(JSON.stringify({ words: [{ text: "a", start: 0, end: 1 }] })).words).toHaveLength(1);
  });
});

describe("analysis", () => {
  it("splits sentences", () => {
    const s = sentences(talk);
    expect(s.map((x) => x.text)).toEqual(["So um today I I want to talk.", "Uh video editing is fun!"]);
    expect(formatTranscript(talk)).toContain("[00:00.5-00:02.6] So um today");
  });

  it("searches phrases ignoring case and punctuation", () => {
    const m = searchTranscript(talk, "VIDEO editing");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ start: 4.3, end: 5.2 });
  });

  it("finds fillers, repetitions and silences", () => {
    expect(findFillers(talk).map((f) => f.text)).toEqual(["um", "Uh"]);
    expect(findFillers(talk, ["so"]).map((f) => f.text)).toEqual(["So"]);
    expect(findRepetitions(talk).map((r) => r.text)).toEqual(["I"]);
    const sil = findSilences(talk, { minDuration: 1, mediaDuration: 8 });
    expect(sil.map((s) => [s.start, s.end])).toEqual([
      [2.6, 4],
      [5.8, 8],
    ]);
  });

  it("computes stats", () => {
    expect(transcriptStats(talk)).toMatchObject({ words: 13, fillerCount: 2 });
  });

  it("merges and inverts ranges", () => {
    expect(mergeRanges([{ start: 3, end: 4 }, { start: 1, end: 2 }, { start: 1.5, end: 3.2 }])).toEqual([{ start: 1, end: 4 }]);
    expect(invertRanges([{ start: 1, end: 2 }], 0, 3)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });
});

describe("cleanup", () => {
  it("plans filler, repetition and pause cuts", () => {
    const plan = planCleanup(talk, { fillers: true, repetitions: true, maxPause: 1, keepPause: 0.2, mediaDuration: 8 });
    const reasons = plan.remove.map((r) => r.reason);
    expect(reasons).toContain("filler");
    expect(reasons).toContain("repetition");
    expect(reasons).toContain("pause");
    expect(plan.removedDuration).toBeGreaterThan(2);
  });

  it("applies cleanup to a project and keeps captions synced", () => {
    const p = parseProject({
      assets: [{ type: "video", id: "v", src: "v.mp4", duration: 8, hasAudio: true }],
      clips: [{ id: "c", assetId: "v" }],
      transcripts: { v: talk },
      captions: { style: "classic" },
    });
    const r = cleanupSpeech(p, "v", { fillers: true, maxPause: 1, mediaDuration: 8 });
    const t = computeTimeline(r.project);
    expect(t.duration).toBeLessThan(8);
    expect(r.project.clips.length).toBeGreaterThan(1);
    expect(r.removed.some((x) => x.text === "um")).toBe(true);
  });
});
