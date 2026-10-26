import { describe, expect, it } from "vitest";
import { parseProject, type Transcript } from "../src/core/index.js";
import { replaceWords, vocabularySuggestions } from "../src/tools/transcript/index.js";
import { backdropContrast, compileProject, contrastRatio, contrastSeverity, structuralChecks, textBackdrop, textLayerBox } from "../src/tools/index.js";
import { EditorSession, executeTool } from "../src/claude/index.js";

const words = (spec: [string, number, number][]): Transcript => ({ words: spec.map(([text, start, end]) => ({ text, start, end })) });

describe("fixing transcripts", () => {
  const t = words([
    ["I", 0, 0.2],
    ["love", 0.2, 0.5],
    ["cloud", 0.5, 0.9],
    ["code,", 0.9, 1.3],
    ["Gonna", 2, 2.4],
    ["try", 2.4, 2.6],
    ["cooper", 3, 3.3],
    ["netties.", 3.3, 3.8],
  ]);

  it("replaces words and phrases, keeping times, punctuation and capitals", () => {
    const r = replaceWords(t, [
      { find: "cloud code", replace: "Claude Code" },
      { find: "gonna", replace: "going to" },
      { find: "Cooper Netties", replace: "Kubernetes" },
    ]);
    expect(r.transcript.words.map((w) => w.text)).toEqual(["I", "love", "Claude", "Code,", "Going", "to", "try", "Kubernetes."]);
    const claude = r.transcript.words[2]!;
    const code = r.transcript.words[3]!;
    expect(claude.start).toBe(0.5);
    expect(code.end).toBe(1.3);
    expect(claude.end).toBe(code.start);
    expect(r.transcript.words[7]).toMatchObject({ start: 3, end: 3.8 });
    expect(r.changes).toHaveLength(3);
  });

  it("removes words with an empty replacement and leaves non-matches alone", () => {
    const r = replaceWords(t, [{ find: "love", replace: "" }, { find: "nothing here", replace: "x" }]);
    expect(r.transcript.words.map((w) => w.text)).not.toContain("love");
    expect(r.transcript.words).toHaveLength(t.words.length - 1);
    expect(r.changes).toEqual([{ start: 0.2, end: 0.5, from: "love", to: "" }]);
  });

  it("suggests likely mishearings of vocabulary terms", () => {
    const s = vocabularySuggestions(t, ["Claude", "Kubernetes"]);
    expect(s.map((x) => [x.term, x.heard])).toEqual([
      ["Claude", "cloud"],
      ["Kubernetes", "cooper netties."],
    ]);
    // Correct spellings, and ordinary words that only sound alike, are not suggested.
    expect(vocabularySuggestions(words([["Claude", 0, 1], ["could", 1, 2]]), ["Claude"])).toEqual([]);
  });

  it("fix_transcript saves vocabulary, lists suspects and replaces words", async () => {
    const s = new EditorSession(parseProject({ assets: [{ type: "video", id: "talk", src: "talk.mp4", duration: 10 }], transcripts: { talk: t } }));
    const v = await executeTool(s, "fix_transcript", { vocabulary: ["Claude"] });
    expect(v.text).toMatch(/"cloud" may be "Claude"/);
    expect(s.project.metadata.vocabulary).toEqual(["Claude"]);
    const r = await executeTool(s, "fix_transcript", { assetId: "talk", replace: [{ find: "cloud", replace: "Claude" }] });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/No likely mishearings/);
    expect(s.project.transcripts.talk!.words[2]!.text).toBe("Claude");
    expect((await executeTool(s, "fix_transcript", { assetId: "nope", replace: [] })).isError).toBe(true);
  });
});

describe("review checks without rendering", () => {
  const base = {
    settings: { width: 1080, height: 1920 },
    assets: [{ type: "video" as const, id: "talk", src: "talk.mp4", duration: 10, hasAudio: true }],
  };

  it("estimates text boxes from alignment and size", () => {
    const p = parseProject({ ...base, layers: [{ type: "text", id: "t", text: "Hello", start: 0, duration: 1, position: { x: 0.5, y: 0.5 }, style: { fontSize: 100 } }] });
    const b = textLayerBox(p.layers[0] as never, 1080, 1920);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(0.5);
    expect(b.x1 - b.x0).toBeGreaterThan(0.2);
    expect(b.y1 - b.y0).toBeCloseTo(120 / 1920 + 6 / 1920, 2);
  });

  it("flags safe zones, off-frame text, collisions with captions and low-contrast boxes", () => {
    const p = parseProject({
      ...base,
      clips: [{ id: "c1", assetId: "talk", duration: 4 }],
      transcripts: { talk: words([["hello", 0.5, 1], ["there", 1, 1.5]]) },
      captions: { enabled: true, style: "classic" },
      layers: [
        { type: "text", id: "low", text: "Follow for more", start: 0, duration: 2, position: { x: 0.5, y: 0.86 } },
        { type: "text", id: "edge", text: "A very long headline that runs off", start: 2, duration: 1, position: { x: 0.95, y: 0.5 }, style: { align: "left" } },
        { type: "text", id: "box", text: "Gray on gray", start: 3, duration: 1, position: { x: 0.5, y: 0.4 }, style: { color: "#888888", background: "#777777" } },
      ],
    });
    const issues = structuralChecks(p);
    const find = (target: string, check: string) => issues.filter((i) => i.target === target && i.check === check);
    expect(find("low", "safe-zones")).toHaveLength(1);
    expect(find("captions", "safe-zones")[0]!.message).toMatch(/position 0.86/);
    expect(find("low", "text")[0]!.message).toMatch(/collides with the captions/);
    expect(find("edge", "text")[0]!.message).toMatch(/runs off the frame/);
    expect(find("box", "text")[0]!.message).toMatch(/contrast with its own box/);
    // Landscape: no safe zones unless asked.
    expect(structuralChecks({ ...p, settings: { ...p.settings, width: 1920, height: 1080 } }).some((i) => i.check === "safe-zones")).toBe(false);
    expect(structuralChecks(p, { platform: "none" }).some((i) => i.check === "safe-zones")).toBe(false);
  });

  it("finds words cut at edits, doubled caption words and repeated footage", () => {
    const p = parseProject({
      ...base,
      transcripts: { talk: words([["one", 0.2, 0.6], ["two", 0.8, 1.4], ["three", 2, 2.5]]) },
      clips: [
        { id: "a", assetId: "talk", in: 0, duration: 1.1 }, // ends inside "two"
        { id: "b", assetId: "talk", in: 1.1, duration: 2 }, // continues the same footage: not a cut
        { id: "c", assetId: "talk", in: 2.2, duration: 1 }, // starts inside "three", repeats b's footage
      ],
    });
    const issues = structuralChecks(p, { checks: ["speech", "frames"] });
    const msgs = issues.map((i) => `${i.target}: ${i.message}`);
    expect(msgs.filter((m) => /middle of the word/.test(m))).toEqual([expect.stringMatching(/^c: Clip c starts in the middle of the word "three"/)]);
    expect(msgs.some((m) => /^c: .*repeats footage already shown in b/.test(m))).toBe(true);
    // The split between a and b keeps playing "two", so it is not reported.
    expect(msgs.some((m) => /"two"/.test(m))).toBe(false);
  });

  it("finds a word doubled by overlapping clips", () => {
    const p = parseProject({
      ...base,
      assets: [...base.assets, { type: "audio", id: "vo", src: "vo.wav", duration: 3 }],
      transcripts: { talk: words([["hello", 0.2, 0.6]]), vo: words([["hello", 0.25, 0.65]]) },
      clips: [{ id: "a", assetId: "talk", duration: 2 }],
      audio: [{ id: "n", assetId: "vo", role: "voiceover", start: 0 }],
    });
    expect(structuralChecks(p, { checks: ["speech"] }).map((i) => i.message)).toEqual([expect.stringMatching(/"hello" appears twice/)]);
  });

  it("measures contrast of text against a backdrop", () => {
    expect(contrastRatio(1, 0)).toBe(21);
    expect(textBackdrop({ color: "#FFFFFF", fontSize: 64, outlineColor: "#000000", outlineWidth: 3, shadow: 0, shadowColor: "#00000080" })).toBe("outline");
    expect(textBackdrop({ color: "#FFFFFF", fontSize: 64, outlineColor: "#000000", outlineWidth: 0, shadow: 0, shadowColor: "#00000080" })).toBeUndefined();
    const frame = (v: number) => ({ width: 10, height: 10, rgb: Buffer.alloc(300, v) });
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(contrastSeverity(backdropContrast(frame(250), box, 1)!)).toBe("problem"); // white on white
    expect(contrastSeverity(backdropContrast(frame(150), box, 1)!)).toBe("warning"); // white on mid gray, about 2.9:1
    expect(contrastSeverity(backdropContrast(frame(20), box, 1)!)).toBeUndefined(); // white on black
  });

  it("compiles an analysis render with frame selection and audio parts", () => {
    const p = parseProject({
      ...base,
      assets: [...base.assets, { type: "audio", id: "music", src: "m.mp3", duration: 10 }],
      clips: [{ id: "a", assetId: "talk", duration: 4 }],
      audio: [{ id: "m", assetId: "music", role: "music" }],
    });
    const c = compileProject(p, { output: "", scale: 0.25, analysis: { framesAt: [1, 1.001, 9], audio: { mix: "mix.wav", voice: "voice.wav", music: "music.wav" } } });
    expect(c.frameTimes).toEqual([1, 3.967]);
    expect(c.filterGraph).toMatch(/select='lt\(abs\(t-1\),0.017\)\+lt\(abs\(t-3.967\),0.017\)'/);
    expect(c.args).toContain("pipe:1");
    expect(c.args.filter((a) => /\.wav$/.test(a))).toHaveLength(3);
    expect(c.width).toBe(270);
  });
});
