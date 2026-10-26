import type { Project, Word } from "../../core/schema.js";
import { computeTimeline, sourceToTimeline, type Timeline } from "../../core/timeline.js";
import { round3 } from "../../core/util.js";
import { chunkWords, segmentsToChunks, type CaptionChunk } from "./chunk.js";
import { AssDocument, addCaptionEvents } from "./ass.js";
import { resolveCaptionStyle, type CaptionStyle } from "../../library/caption-styles/index.js";

/**
 * Words on the output timeline, derived from asset transcripts through the edit.
 * Because captions are recomputed from source transcripts at render time, they stay in sync
 * after any trim, cut, reorder or speed change.
 */
export function timelineWords(project: Project, timeline: Timeline = computeTimeline(project)): Word[] {
  const words: Word[] = [];
  for (const tc of timeline.clips) {
    const transcript = project.transcripts[tc.clip.assetId];
    if (!transcript || tc.clip.muted || tc.clip.volume === 0 || tc.clip.reverse) continue;
    const prev = timeline.clips[tc.index - 1];
    const next = timeline.clips[tc.index + 1];
    // During a transition, words belong to whichever clip is more visible. With J and L cuts they
    // follow the sound instead: a lead or tail adds words, a neighbor's lead or tail takes them.
    const lead = tc.audioLead ?? 0;
    const tail = tc.audioTail ?? 0;
    const visStart = lead ? tc.start - lead : prev?.audioTail ? tc.start + prev.audioTail : tc.start + tc.transitionDuration / 2;
    const visEnd = tail ? tc.end + tail : next?.audioLead ? tc.end - next.audioLead : tc.end - (next ? next.transitionDuration / 2 : 0);
    const inStart = tc.clip.in;
    const inEnd = tc.clip.in + tc.sourceDuration;
    const srcStart = inStart - lead * tc.clip.speed;
    const srcEnd = inEnd + tail * tc.clip.speed;
    // Source time to timeline time, including the sound just outside the clip.
    const toTimeline = (s: number) =>
      s < inStart ? tc.start - (inStart - s) / tc.clip.speed : s > inEnd ? tc.end + (s - inEnd) / tc.clip.speed : sourceToTimeline(tc, s);
    const overlap = (c: (typeof timeline.clips)[number], w: Word) => Math.min(w.end, c.clip.in + c.sourceDuration) - Math.max(w.start, c.clip.in);
    const siblings = timeline.clips.filter((c) => c !== tc && c.clip.assetId === tc.clip.assetId);
    for (const w of transcript.words) {
      if (w.end <= srcStart || w.start >= srcEnd) continue;
      // A word stretched across a cut (common with recognizer timings over a removed pause) would
      // show in both clips; it belongs to the one holding most of it.
      const mine = overlap(tc, w);
      if (mine < w.end - w.start - 1e-6 && siblings.some((c) => overlap(c, w) > mine + 1e-6)) continue;
      const start = toTimeline(Math.max(w.start, srcStart));
      const end = toTimeline(Math.min(w.end, srcEnd));
      const mid = (start + end) / 2;
      if (mid < visStart || mid >= visEnd) continue;
      words.push({ ...w, start: round3(start), end: round3(end) });
    }
  }
  for (const ta of timeline.audio) {
    const transcript = project.transcripts[ta.clip.assetId];
    if (!transcript || ta.clip.role !== "voiceover") continue;
    const speed = ta.clip.speed;
    for (const w of transcript.words) {
      if (w.end <= ta.clip.in || w.start >= ta.clip.in + ta.duration * speed) continue;
      const start = ta.start + Math.max(0, w.start - ta.clip.in) / speed;
      const end = ta.start + Math.min(ta.duration, (w.end - ta.clip.in) / speed);
      words.push({ ...w, start: round3(start), end: round3(end) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

export interface ProjectCaptions {
  style: CaptionStyle;
  chunks: CaptionChunk[];
}

/** Resolve the project's caption configuration into styled, timed chunks (or null if disabled). */
export function buildCaptions(project: Project, timeline: Timeline = computeTimeline(project)): ProjectCaptions | null {
  const cfg = project.captions;
  if (!cfg || !cfg.enabled) return null;
  const style = resolveCaptionStyle(cfg.style, cfg.overrides);
  const opts = {
    maxWordsPerLine: style.maxWordsPerLine,
    maxCharsPerLine: style.maxCharsPerLine,
    maxLines: style.maxLines,
    maxDuration: style.maxDuration,
  };
  const chunks = cfg.segments?.length ? segmentsToChunks(cfg.segments, opts) : chunkWords(timelineWords(project, timeline), opts);
  return chunks.length ? { style, chunks } : null;
}

const chunkText = (c: CaptionChunk, upper: boolean) =>
  c.lines.map((l) => l.map((w) => (upper ? w.text.toUpperCase() : w.text)).join(" ")).join("\n");

function srtTime(s: number, sep: "," | "."): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
}

export function chunksToSRT(chunks: CaptionChunk[], uppercase = false): string {
  return chunks
    .map((c, i) => `${i + 1}\n${srtTime(c.start, ",")} --> ${srtTime(c.end, ",")}\n${chunkText(c, uppercase)}\n`)
    .join("\n");
}

export function chunksToVTT(chunks: CaptionChunk[], uppercase = false): string {
  return `WEBVTT\n\n${chunks.map((c) => `${srtTime(c.start, ".")} --> ${srtTime(c.end, ".")}\n${chunkText(c, uppercase)}\n`).join("\n")}`;
}

export type CaptionExportFormat = "srt" | "vtt" | "ass";

/** Export the project's captions as a sidecar subtitle file (for YouTube uploads, players, etc.). */
export function exportCaptions(project: Project, format: CaptionExportFormat): string {
  const caps = buildCaptions(project);
  if (!caps) return format === "vtt" ? "WEBVTT\n" : "";
  if (format === "srt") return chunksToSRT(caps.chunks, caps.style.uppercase);
  if (format === "vtt") return chunksToVTT(caps.chunks, caps.style.uppercase);
  const doc = new AssDocument(project.settings.width, project.settings.height, 2);
  addCaptionEvents(doc, caps.chunks, caps.style, { width: project.settings.width, height: project.settings.height });
  return doc.toString();
}

