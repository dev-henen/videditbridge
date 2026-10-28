import { describe, expect, it } from "vitest";
import { findRetakes, sentenceCutRanges } from "../../engine/tools/transcript/takes.js";
import type { Transcript } from "../../engine/core/index.js";

/** Words laid out one per 0.3 s, with a 1.5 s pause after each sentence. */
function transcript(lines: string[]): Transcript {
  const words: Transcript["words"] = [];
  let t = 0;
  for (const line of lines) {
    for (const text of line.split(" ")) {
      words.push({ text, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.25) * 1000) / 1000 });
      t += 0.3;
    }
    t += 1.5;
  }
  return { words };
}

describe("retakes and repeats", () => {
  const t = transcript([
    "This is a test video record for the editor app.",
    "This video is recorded for testing the editor tool that edits video for you.",
    "This video is meant to test cinematic edits.",
    "Yes, this is a nice video to edit.",
    "This is a nice video to post.",
    "And this is a nice video to experiment with.",
  ]);
  const r = findRetakes(t);

  it("keeps the corrected take of a line said again", () => {
    const retake = r.groups.find((g) => g.kind === "retake")!;
    expect(retake.sentences).toEqual([0, 1]);
    expect(retake.keep).toBe(1);
  });

  it("groups three look-alike sentences and keeps the most complete", () => {
    const repeat = r.groups.find((g) => g.kind === "repeat")!;
    expect(repeat.sentences).toEqual([3, 4, 5]);
    expect(repeat.keep).toBe(5);
    expect(r.remove).toEqual([0, 3, 4]);
  });

  it("leaves different sentences alone", () => {
    expect(r.remove).not.toContain(2);
  });

  it("cuts removed sentences from after the previous kept word to before the next one", () => {
    const ranges = sentenceCutRanges(t, r.sentences, r.remove);
    const kept = t.words.filter((_, k) => !r.remove.some((s) => k >= r.sentences[s]!.wordStart && k < r.sentences[s]!.wordEnd));
    for (const w of kept) for (const c of ranges) expect(w.end <= c.start || w.start >= c.end).toBe(true);
    // Sentences 3 and 4 are next to each other, so they go in one cut.
    expect(ranges).toHaveLength(2);
  });
});
