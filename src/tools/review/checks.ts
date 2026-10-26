import type { Project, TextLayer } from "../../core/schema.js";
import { computeTimeline, sourceToTimeline, type Timeline } from "../../core/timeline.js";
import { formatTime, parseColor, round3 } from "../../core/util.js";
import { buildCaptions, timelineWords } from "../captions/build.js";
import { sizeScale } from "../captions/ass.js";
import type { CaptionStyle } from "../../library/caption-styles/index.js";
import { normalizeWord } from "../transcript/analyze.js";

export type ReviewCheck = "text" | "safe-zones" | "frames" | "speech" | "audio" | "key";

export const REVIEW_CHECKS: ReviewCheck[] = ["text", "safe-zones", "frames", "speech", "audio", "key"];

export interface ReviewIssue {
  check: ReviewCheck;
  /** problem: a viewer will notice; warning: worth a look, may be intended. */
  severity: "problem" | "warning";
  /** Timeline seconds. */
  start: number;
  end: number;
  /** Layer, clip or audio clip id, "captions" or "mix". */
  target?: string;
  message: string;
}

/** A rectangle in frame fractions (0..1). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const intersect = (a: Box, b: Box): Box => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const t = (s: number) => formatTime(s);

/** Approximate on-screen extent of text, from its length and font size (no font metrics needed). */
function measureText(
  lines: string[],
  s: { fontSize: number; bold: boolean; uppercase: boolean; letterSpacing: number; outlineWidth: number; background?: string },
  width: number,
): { w: number; h: number } {
  const charWidth = s.fontSize * (0.5 + (s.bold ? 0.05 : 0) + (s.uppercase ? 0.1 : 0)) + s.letterSpacing;
  const maxW = width * 0.9;
  let rows = 0;
  let w = 0;
  for (const line of lines) {
    const lw = line.length * charWidth;
    rows += Math.max(1, Math.ceil(lw / maxW));
    w = Math.max(w, Math.min(lw, maxW));
  }
  const pad = s.background ? s.fontSize * 0.25 : s.outlineWidth;
  return { w: w + 2 * pad, h: rows * s.fontSize * 1.2 + 2 * pad };
}

/** Estimated box of a text layer, following its alignment (ASS \pos is the left, center or right middle). */
export function textLayerBox(layer: TextLayer, width: number, height: number): Box {
  const { w, h } = measureText(layer.text.split(/\n|\\N/), layer.style, width);
  const x = layer.position.x * width;
  const y = layer.position.y * height;
  const left = layer.style.align === "left" ? x : layer.style.align === "right" ? x - w : x - w / 2;
  return { x0: left / width, y0: (y - h / 2) / height, x1: (left + w) / width, y1: (y + h / 2) / height };
}

/** Caption font and outline in output pixels, as the renderer scales them. */
export function captionTextStyle(style: CaptionStyle, width: number, height: number) {
  const k = sizeScale(width, height);
  return { ...style, fontSize: style.fontSize * k, outlineWidth: style.outlineWidth * k, shadow: style.shadow * k };
}

export interface CaptionBox {
  start: number;
  end: number;
  text: string;
  box: Box;
}

/** Each caption on screen with its estimated box. */
export function captionBoxes(project: Project, timeline: Timeline = computeTimeline(project)): { style: CaptionStyle; boxes: CaptionBox[] } | null {
  const caps = buildCaptions(project, timeline);
  if (!caps) return null;
  const { width: W, height: H } = project.settings;
  const s = captionTextStyle(caps.style, W, H);
  const boxes = caps.chunks.map((c) => {
    const lines = c.lines.map((l) => l.map((w) => w.text).join(" "));
    const { w, h } = measureText(lines, s, W);
    const y = caps.style.position * H;
    return { start: c.start, end: c.end, text: lines.join(" "), box: { x0: 0.5 - w / W / 2, y0: (y - h / 2) / H, x1: 0.5 + w / W / 2, y1: (y + h / 2) / H } };
  });
  return { style: caps.style, boxes };
}

// ---------------------------------------------------------------------------
// Platform safe zones
// ---------------------------------------------------------------------------

export type Platform = "tiktok" | "reels" | "shorts" | "vertical" | "none";

interface Zones {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** The right-side buttons start this far down the frame. */
  rightFrom: number;
}

/** Approximate areas that each app covers with its own interface on a 9:16 video. */
const PLATFORM_ZONES: Record<Exclude<Platform, "vertical" | "none">, Zones> = {
  tiktok: { top: 0.08, bottom: 0.2, left: 0.04, right: 0.13, rightFrom: 0.4 },
  reels: { top: 0.1, bottom: 0.2, left: 0.04, right: 0.12, rightFrom: 0.5 },
  shorts: { top: 0.08, bottom: 0.2, left: 0.04, right: 0.13, rightFrom: 0.45 },
};

const PLATFORM_NAMES: Record<Platform, string> = { tiktok: "TikTok", reels: "Reels", shorts: "Shorts", vertical: "TikTok, Reels and Shorts", none: "" };

function zonesFor(platform: Platform): Zones | undefined {
  if (platform === "none") return undefined;
  if (platform !== "vertical") return PLATFORM_ZONES[platform];
  const all = Object.values(PLATFORM_ZONES);
  return {
    top: Math.max(...all.map((z) => z.top)),
    bottom: Math.max(...all.map((z) => z.bottom)),
    left: Math.max(...all.map((z) => z.left)),
    right: Math.max(...all.map((z) => z.right)),
    rightFrom: Math.min(...all.map((z) => z.rightFrom)),
  };
}

/** Which covered areas a box falls into (more than a tenth of it). */
function zoneHits(box: Box, z: Zones): string[] {
  const rects: [string, Box][] = [
    ["top", { x0: 0, y0: 0, x1: 1, y1: z.top }],
    ["bottom", { x0: 0, y0: 1 - z.bottom, x1: 1, y1: 1 }],
    ["left edge", { x0: 0, y0: 0, x1: z.left, y1: 1 }],
    ["right-side buttons", { x0: 1 - z.right, y0: z.rightFrom, x1: 1, y1: 1 - z.bottom }],
  ];
  const a = area(box);
  return a > 0 ? rects.filter(([, r]) => area(intersect(box, r)) / a > 0.1).map(([name]) => name) : [];
}

// ---------------------------------------------------------------------------
// Checks that need only the project
// ---------------------------------------------------------------------------

export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two luminances (1 to 21). */
export const contrastRatio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export const colorLuminance = (hex: string) => {
  const c = parseColor(hex);
  return relativeLuminance(c.r, c.g, c.b);
};

/** When text has a backdrop of its own (box, outline or shadow) that keeps it readable anywhere. */
export function textBackdrop(s: { color: string; fontSize: number; outlineColor: string; outlineWidth: number; shadow: number; shadowColor: string; background?: string }): "box" | "outline" | "shadow" | undefined {
  const fill = colorLuminance(s.color);
  if (s.background && parseColor(s.background).a >= 0.6) return "box";
  if (s.outlineWidth >= Math.max(1.5, s.fontSize * 0.03) && contrastRatio(fill, colorLuminance(s.outlineColor)) >= 3) return "outline";
  if (s.shadow >= s.fontSize * 0.05 && parseColor(s.shadowColor).a >= 0.5 && contrastRatio(fill, colorLuminance(s.shadowColor)) >= 3) return "shadow";
  return undefined;
}

export interface StructuralOptions {
  checks?: ReviewCheck[];
  /** Safe zones to check; "auto" means "vertical" for portrait projects and none otherwise. */
  platform?: Platform | "auto";
}

/** Checks that read the project alone: layout, safe zones, cuts against the transcript, repeated footage. */
export function structuralChecks(project: Project, opts: StructuralOptions = {}): ReviewIssue[] {
  const checks = new Set(opts.checks ?? REVIEW_CHECKS);
  const timeline = computeTimeline(project);
  const { width: W, height: H } = project.settings;
  const issues: ReviewIssue[] = [];
  const texts = project.layers.filter((l): l is TextLayer => l.type === "text" && l.text.trim() !== "");
  const boxes = new Map(texts.map((l) => [l.id, textLayerBox(l, W, H)]));
  const caps = captionBoxes(project, timeline);
  const quote = (s: string) => `"${s.length > 40 ? `${s.slice(0, 39)}…` : s}"`;

  if (checks.has("text")) {
    for (const l of texts) {
      const b = boxes.get(l.id)!;
      const out = Math.max(-b.x0, b.x1 - 1, -b.y0, b.y1 - 1);
      if (out > 0.02)
        issues.push({ check: "text", severity: "problem", start: l.start, end: l.start + l.duration, target: l.id, message: `Text ${quote(l.text)} runs off the frame: move it inward or make it smaller.` });
      if (l.style.background && textBackdrop(l.style) === "box") {
        const ratio = contrastRatio(colorLuminance(l.style.color), colorLuminance(l.style.background));
        if (ratio < 3)
          issues.push({ check: "text", severity: "problem", start: l.start, end: l.start + l.duration, target: l.id, message: `Text ${quote(l.text)} has too little contrast with its own box (${ratio.toFixed(1)}:1, aim for 4.5:1): change style.color or style.background.` });
      }
    }
    // Text over text, and text under captions.
    for (const [i, a] of texts.entries()) {
      for (const b of texts.slice(i + 1)) {
        const start = Math.max(a.start, b.start);
        const end = Math.min(a.start + a.duration, b.start + b.duration);
        if (end - start < 0.1) continue;
        const [ba, bb] = [boxes.get(a.id)!, boxes.get(b.id)!];
        if (area(intersect(ba, bb)) > 0.3 * Math.min(area(ba), area(bb)))
          issues.push({ check: "text", severity: "warning", start, end, target: `${a.id}, ${b.id}`, message: `Text ${quote(a.text)} and ${quote(b.text)} overlap on screen from ${t(start)} to ${t(end)}.` });
      }
      for (const c of caps?.boxes ?? []) {
        const start = Math.max(a.start, c.start);
        const end = Math.min(a.start + a.duration, c.end);
        const ba = boxes.get(a.id)!;
        if (end - start < 0.1 || area(intersect(ba, c.box)) <= 0.15 * Math.min(area(ba), area(c.box))) continue;
        issues.push({ check: "text", severity: "problem", start, end, target: a.id, message: `Text ${quote(a.text)} collides with the captions from ${t(start)} to ${t(end)}: move the text or the captions (set_captions overrides position).` });
        break;
      }
    }
    if (caps && textBackdrop(captionTextStyle(caps.style, W, H)) === "box") {
      const ratio = contrastRatio(colorLuminance(caps.style.color), colorLuminance(caps.style.background!));
      if (ratio < 3)
        issues.push({ check: "text", severity: "problem", start: 0, end: timeline.duration, target: "captions", message: `Captions have too little contrast with their box (${ratio.toFixed(1)}:1): change the caption color or background.` });
    }
  }

  if (checks.has("safe-zones")) {
    const platform = opts.platform === undefined || opts.platform === "auto" ? (H > W ? "vertical" : "none") : opts.platform;
    const zones = zonesFor(platform);
    if (zones) {
      const where = PLATFORM_NAMES[platform];
      for (const l of texts) {
        const hits = zoneHits(boxes.get(l.id)!, zones);
        if (hits.length)
          issues.push({ check: "safe-zones", severity: "warning", start: l.start, end: l.start + l.duration, target: l.id, message: `Text ${quote(l.text)} is in the ${hits.join(" and ")} area that ${where} cover with buttons and captions: move it toward the middle.` });
      }
      const covered = (caps?.boxes ?? []).filter((c) => zoneHits(c.box, zones).length);
      if (covered.length) {
        const hits = [...new Set(covered.flatMap((c) => zoneHits(c.box, zones)))];
        issues.push({
          check: "safe-zones",
          severity: "warning",
          start: covered[0]!.start,
          end: covered[covered.length - 1]!.end,
          target: "captions",
          message: `${covered.length} of ${caps!.boxes.length} captions are in the ${hits.join(" and ")} area that ${where} cover (caption position ${caps!.style.position}): move them up, e.g. set_captions overrides {position: 0.7}.`,
        });
      }
    }
  }

  if (checks.has("speech")) {
    // Words cut by an edit: a clip starts or ends inside a word that it only partly keeps.
    for (const tc of timeline.clips) {
      const tr = project.transcripts[tc.clip.assetId];
      if (!tr || tc.clip.muted || tc.clip.volume === 0) continue;
      const prev = timeline.clips[tc.index - 1];
      const next = timeline.clips[tc.index + 1];
      const srcIn = tc.clip.in;
      const srcOut = tc.clip.in + tc.sourceDuration;
      // A split that keeps playing the same footage is not a cut.
      const continuesFrom = prev && prev.clip.assetId === tc.clip.assetId && Math.abs(prev.clip.in + prev.sourceDuration - srcIn) < 0.02;
      const continuesInto = next && next.clip.assetId === tc.clip.assetId && Math.abs(next.clip.in - srcOut) < 0.02;
      for (const w of tr.words) {
        if (!continuesFrom && w.start < srcIn - 0.04 && w.end > srcIn + 0.04)
          issues.push({ check: "speech", severity: "problem", start: tc.start, end: round3(tc.start + 0.3), target: tc.clip.id, message: `Clip ${tc.clip.id} starts in the middle of the word "${w.text}" (source ${w.start}-${w.end}s, cut at ${round3(srcIn)}s): trim to ${round3(Math.max(0, w.start - 0.05))}s or ${round3(w.end + 0.03)}s.` });
        if (!continuesInto && w.start < srcOut - 0.04 && w.end > srcOut + 0.04)
          issues.push({ check: "speech", severity: "problem", start: round3(tc.end - 0.3), end: tc.end, target: tc.clip.id, message: `Clip ${tc.clip.id} ends in the middle of the word "${w.text}" (source ${w.start}-${w.end}s, cut at ${round3(srcOut)}s): end it at ${round3(w.end + 0.05)}s or before ${round3(w.start)}s.` });
      }
    }
    // The same word shown twice at once in the captions (a word stretched across a cut, or overlapping narration).
    const words = timelineWords(project, timeline);
    for (let i = 1; i < words.length; i++) {
      const [a, b] = [words[i - 1]!, words[i]!];
      if (normalizeWord(a.text) && normalizeWord(a.text) === normalizeWord(b.text) && b.start < a.end - 0.02)
        issues.push({ check: "speech", severity: "problem", start: a.start, end: b.end, message: `The word "${b.text}" appears twice at ${t(a.start)}: it is in two overlapping clips or voice-overs, so captions double it.` });
    }
    if (project.captions?.enabled) {
      if (project.captions.segments?.length && Object.keys(project.transcripts).length)
        issues.push({ check: "speech", severity: "warning", start: 0, end: timeline.duration, target: "captions", message: "Captions use fixed manual segments although transcripts exist: they will not follow later edits. Remove segments to caption from the transcripts." });
      for (const [id, tr] of Object.entries(project.transcripts))
        if (tr.estimated && timeline.clips.some((c) => c.clip.assetId === id))
          issues.push({ check: "speech", severity: "warning", start: 0, end: timeline.duration, target: id, message: `The transcript of ${id} has estimated word timings (from subtitles), so captions may run early or late. Transcribe it for measured timings.` });
    }
  }

  if (checks.has("frames")) {
    // The same source footage used twice.
    for (const [i, a] of timeline.clips.entries()) {
      if (a.asset.type !== "video") continue;
      for (const b of timeline.clips.slice(i + 1)) {
        if (b.clip.assetId !== a.clip.assetId) continue;
        const from = Math.max(a.clip.in, b.clip.in);
        const to = Math.min(a.clip.in + a.sourceDuration, b.clip.in + b.sourceDuration);
        if (to - from < 0.5) continue;
        issues.push({ check: "frames", severity: "warning", start: round3(sourceToTimeline(b, from)), end: round3(sourceToTimeline(b, to)), target: b.clip.id, message: `Clip ${b.clip.id} repeats footage already shown in ${a.clip.id} (source ${round3(from)}-${round3(to)}s of ${a.clip.assetId}). Fine for a deliberate replay.` });
      }
    }
  }
  return issues;
}
