import { describe, expect, it } from "vitest";
import { parseProject, splitClip, cutTimelineRanges, type Project } from "../src/core/index.js";
import { buildCaptions, chunkWords, chunksToSRT, chunksToVTT, exportCaptions, timelineWords } from "../src/tools/captions/index.js";
import { compileProject } from "../src/tools/render/index.js";

const words = ["Hello", "there,", "this", "is", "a", "caption", "test.", "Second", "sentence", "here."].map((text, i) => ({
  text,
  start: 1 + i * 0.4,
  end: 1 + i * 0.4 + 0.35,
}));

function project(extra: Record<string, unknown> = {}): Project {
  return parseProject({
    settings: { width: 1080, height: 1920, fps: 30 },
    assets: [
      { type: "video", id: "v", src: "v.mp4", duration: 10, hasAudio: true },
      { type: "image", id: "img", src: "i.png", width: 100, height: 50 },
      { type: "audio", id: "m", src: "m.mp3", duration: 30 },
    ],
    clips: [{ id: "c", assetId: "v" }],
    transcripts: { v: { words } },
    captions: { style: "bold-pop" },
    ...extra,
  });
}

describe("captions", () => {
  it("chunks by line limits and sentence ends", () => {
    const chunks = chunkWords(words, { maxWordsPerLine: 3, maxCharsPerLine: 20, maxLines: 2, maxDuration: 5 });
    expect(chunks.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["Hello there, this is a caption", "test.", "Second sentence here."]);
    expect(chunks[0]!.lines).toHaveLength(2);
  });

  it("maps transcript words through cuts and speed", () => {
    let p = project();
    p = cutTimelineRanges(p, [{ start: 0, end: 1 }]);
    const tw = timelineWords(p);
    expect(tw[0]).toMatchObject({ text: "Hello", start: 0, end: 0.35 });
    const fast = parseProject({ ...project(), clips: [{ id: "c", assetId: "v", speed: 2 }] });
    expect(timelineWords(fast)[0]).toMatchObject({ start: 0.5, end: 0.675 });
  });

  it("drops words from removed parts and muted clips", () => {
    const { project: split } = splitClip(project(), "c", 3);
    const p = { ...split, clips: [split.clips[1]!] };
    expect(timelineWords(p)[0]!.text).toBe("caption");
    const muted = parseProject({ ...project(), clips: [{ id: "c", assetId: "v", muted: true }] });
    expect(timelineWords(muted)).toEqual([]);
  });

  it("exports SRT, VTT and ASS", () => {
    const caps = buildCaptions(project())!;
    expect(chunksToSRT(caps.chunks)).toMatch(/^1\n00:00:01,000 --> /);
    expect(chunksToVTT(caps.chunks)).toMatch(/^WEBVTT/);
    const ass = exportCaptions(project(), "ass");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("HELLO"); // bold-pop is uppercase
    expect(ass).toMatch(/\\1c&H00/); // highlighted active word
  });

  it("supports manual segments", () => {
    const p = project({ captions: { style: "classic", segments: [{ text: "Manual caption", start: 0, end: 2 }] } });
    expect(buildCaptions(p)!.chunks[0]!.words.map((w) => w.text)).toEqual(["Manual", "caption"]);
  });

  it("renders karaoke as \\kf sweeps", () => {
    const ass = exportCaptions(project({ captions: { style: "karaoke" } }), "ass");
    expect(ass).toMatch(/\{\\kf\d+\}Hello/);
  });
});

describe("compiler", () => {
  it("chains xfade with correct offsets and acrossfade", () => {
    const p = parseProject({
      ...project({ captions: undefined }),
      clips: [
        { id: "a", assetId: "v", duration: 4 },
        { id: "b", assetId: "v", in: 4, duration: 3, transition: { type: "slideleft", duration: 1 } },
        { id: "c", assetId: "img", duration: 2 },
      ],
    });
    const c = compileProject(p, { output: "out.mp4" });
    expect(c.duration).toBe(8);
    expect(c.filterGraph).toContain("xfade=transition=slideleft:duration=1:offset=3");
    expect(c.filterGraph).toContain("acrossfade=d=1");
    expect(c.filterGraph).toMatch(/concat=n=2:v=1:a=1/);
    expect(c.filterGraph).toContain("anullsrc"); // image clip has no audio
    expect(c.args).toContain("-filter_complex_script");
    expect(c.args.slice(-1)[0]).toMatch(/out\.mp4$/);
  });

  it("ducks music under speech with a sidechain compressor", () => {
    const p = project({ audio: [{ id: "music", assetId: "m", loop: true, volume: 0.3 }] });
    const c = compileProject(p, { output: "o.mp4" });
    expect(c.filterGraph).toContain("sidechaincompress");
    expect(c.filterGraph).toContain("volume=0.3");
  });

  it("does not duck when duck=false", () => {
    const p = project({ audio: [{ id: "music", assetId: "m", duck: false }] });
    expect(compileProject(p, { output: "o.mp4" }).filterGraph).not.toContain("sidechaincompress");
  });

  it("composites media overlays, text and captions", () => {
    const p = project({
      layers: [
        { type: "media", id: "pip", assetId: "img", start: 1, duration: 2, position: { x: 0.8, y: 0.2 }, size: { width: 0.3 }, animationIn: { type: "slide-left" } },
        { type: "text", id: "t", text: "Title {x}", start: 0, duration: 3, animationIn: { type: "pop" }, animationOut: { type: "fade" } },
      ],
    });
    const c = compileProject(p, { output: "o.mp4" });
    expect(c.filterGraph).toContain("overlay=x='main_w*0.8-overlay_w/2+W*0.1*");
    expect(c.filterGraph).toContain("setpts=PTS+1/TB");
    expect(c.filterGraph).toContain("ass=filename=overlay.ass");
    const ass = c.files.find((f) => f.name === "overlay.ass")!.content;
    expect(ass).toContain("Title \\{x\\}"); // braces escaped
    expect(ass.match(/Dialogue: 11,/g)).toHaveLength(3); // enter / hold / exit phases
    expect(ass).toMatch(/Dialogue: 1000,.*\\q2/); // captions on top, no-wrap
  });

  it("renders a background when there is no primary track", () => {
    const p = parseProject({ layers: [{ type: "text", id: "t", text: "Only text", start: 0, duration: 3 }] });
    const c = compileProject(p, { output: "o.mp4" });
    expect(c.duration).toBe(3);
    expect(c.filterGraph).toMatch(/^color=c=0x000000:s=1080x1920:r=30:d=3/);
  });

  it("supports range renders, frames and contact sheets", () => {
    const p = project();
    expect(compileProject(p, { output: "o.mp4", range: { start: 2, end: 4 } }).duration).toBe(2);
    const frame = compileProject(p, { output: "f.png", frameAt: 1.5 });
    expect(frame.args).toContain("-frames:v");
    expect(frame.filterGraph).toContain("anullsink");
    const sheet = compileProject(p, { output: "s.png", contactSheet: { columns: 3, rows: 2, thumbWidth: 200 } });
    expect(sheet.filterGraph).toContain("tile=3x2");
  });

  it("renders previews at reduced size while keeping text layout", () => {
    const c = compileProject(project(), { output: "o.mp4", scale: 0.5 });
    expect(c.filterGraph).toContain("scale=540:960:force_original_aspect_ratio=increase");
    expect(c.files.find((f) => f.name === "overlay.ass")!.content).toContain("PlayResX: 1080");
  });

  it("keeps every primary segment on one timebase so xfade works after concat", () => {
    const p = parseProject({
      ...project({ captions: undefined }),
      clips: [
        { id: "a", assetId: "v", duration: 2 },
        { id: "b", assetId: "v", in: 2, duration: 2 },
        { id: "c", assetId: "v", in: 4, duration: 2, transition: { type: "fade", duration: 0.5 } },
      ],
    });
    expect(compileProject(p, { output: "o.mp4" }).filterGraph.match(/settb=AVTB/g)).toHaveLength(3);
  });

  it("throws on empty projects", () => {
    expect(() => compileProject(parseProject({}), { output: "o.mp4" })).toThrow(/empty/);
  });
});
