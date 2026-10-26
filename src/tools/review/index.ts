import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Asset, Effect, Project, TextLayer } from "../../core/schema.js";
import { clipAtTime, computeTimeline, sourceToTimeline, type Timeline } from "../../core/timeline.js";
import { formatTime, parseColor, round3 } from "../../core/util.js";
import { invertRanges, mergeRanges, type TimeRange } from "../../core/ranges.js";
import { getEffect } from "../../library/effects/index.js";
import { ANALYSIS_RATE, analyzeSamples, decodeAudio } from "../audio/analyze.js";
import { timelineWords } from "../captions/build.js";
import { runFfmpeg, runFfmpegOrThrow, type FfmpegOptions } from "../render/ffmpeg.js";
import { probeAssets, renderForAnalysis, type AnalysisFrame } from "../render/render.js";
import { FaceDetector, type Face } from "../vision/faces.js";
import {
  REVIEW_CHECKS,
  captionBoxes,
  captionTextStyle,
  colorLuminance,
  contrastRatio,
  relativeLuminance,
  structuralChecks,
  textBackdrop,
  textLayerBox,
  type Box,
  type ReviewIssue,
  type StructuralOptions,
} from "./checks.js";

export * from "./checks.js";

export interface ReviewOptions extends FfmpegOptions, StructuralOptions {
  /** Directory relative asset paths resolve against. */
  baseDir?: string;
  fontsDir?: string;
  /** Render cache folder (see RenderOptions.cacheDir). */
  cacheDir?: string;
  /** Folder for the measured audio files (the mix and its voice and music parts). */
  workDir: string;
  /** Detector for the text-over-face check (default: the local one); false skips that check. */
  faces?: FaceDetector | false;
  /** Integrated loudness to aim for, in LUFS (default -14, right for social video and YouTube). */
  loudnessTarget?: number;
  onProgress?: (progress: number) => void;
}

export interface ReviewReport {
  issues: ReviewIssue[];
  /** Measured loudness of the final mix. */
  loudness?: { integrated: number; truePeak: number; target: number };
  /** What could not be checked, and why. */
  notes: string[];
}

const t = (s: number) => formatTime(s);

/**
 * Check an edit for what a viewer notices first, with timeline times: unreadable or misplaced
 * text, black and frozen footage, words cut at edits, captions out of step with the speech,
 * loudness, music over the voice, and green left by a chroma key. Read-only.
 */
export async function reviewEdit(project: Project, opts: ReviewOptions): Promise<ReviewReport> {
  const checks = new Set(opts.checks ?? REVIEW_CHECKS);
  const p = await probeAssets(project, opts);
  const timeline = computeTimeline(p);
  const notes: string[] = [];
  if (timeline.duration <= 0) return { issues: [], notes: ["The project is empty."] };
  const issues = structuralChecks(p, opts);
  const { width: W, height: H } = p.settings;

  // Frames to measure, rendered without text and captions so the backdrop behind them shows.
  const samples: { time: number; measure: (f: AnalysisFrame & { width: number; height: number }) => void }[] = [];
  const faceChecks: { time: number; box: Box; target: string; start: number; end: number; what: string }[] = [];
  const detector = opts.faces === false ? undefined : (opts.faces ?? new FaceDetector({ ffmpegPath: opts.ffmpegPath }));
  if (checks.has("text")) {
    for (const l of p.layers) {
      if (l.type !== "text" || !l.text.trim() || textBackdrop(l.style)) continue;
      const dIn = l.animationIn && l.animationIn.type !== "none" ? l.animationIn.duration : 0;
      const dOut = l.animationOut && l.animationOut.type !== "none" ? l.animationOut.duration : 0;
      const time = l.start + Math.min(dIn, l.duration) + Math.max(0, l.duration - dIn - dOut) / 2;
      samples.push({ time, measure: (f) => readability(f, l, textLayerBox(l, W, H, time - l.start), issues) });
    }
    const caps = captionBoxes(p, timeline);
    // Text over a face, readable or not: three moments of each text layer, and captions spread over the video.
    for (const l of p.layers) {
      if (l.type !== "text" || !l.text.trim()) continue;
      for (const k of [0.25, 0.5, 0.75]) faceChecks.push({ time: l.start + l.duration * k, box: textLayerBox(l, W, H, l.duration * k), target: l.id, start: l.start, end: l.start + l.duration, what: `Text "${l.text.length > 40 ? `${l.text.slice(0, 39)}…` : l.text}"` });
    }
    const spread = caps ? Math.min(8, caps.boxes.length) : 0;
    for (let k = 0; k < spread; k++) {
      const c = caps!.boxes[Math.floor(((k + 0.5) * caps!.boxes.length) / spread)]!;
      faceChecks.push({ time: (c.start + c.end) / 2, box: c.box, target: "captions", start: c.start, end: c.end, what: `The caption "${c.text}"` });
    }
    if (caps && !textBackdrop(captionTextStyle(caps.style, W, H))) {
      const fill = colorLuminance(caps.style.color);
      const n = Math.min(6, caps.boxes.length);
      const results: ({ time: number } & BackdropContrast)[] = [];
      for (let k = 0; k < n; k++) {
        const c = caps.boxes[Math.floor(((k + 0.5) * caps.boxes.length) / n)]!;
        samples.push({
          time: (c.start + c.end) / 2,
          measure: (f) => {
            const r = backdropContrast(f, c.box, fill);
            if (r) results.push({ time: f.time, ...r });
            // Report once, after the last caption sample.
            if (results.length !== n) return;
            const bad = results.filter((x) => contrastSeverity(x));
            if (bad.length)
              issues.push({
                check: "text",
                severity: bad.some((x) => contrastSeverity(x) === "problem") && bad.length > n / 2 ? "problem" : "warning",
                start: bad[0]!.time,
                end: bad[bad.length - 1]!.time,
                target: "captions",
                message: `Captions are hard to read against the picture at ${bad.map((x) => t(x.time)).join(", ")} (contrast down to ${Math.min(...bad.map((x) => x.ratio)).toFixed(1)}:1): give the caption style an outline (outlineWidth 3+) or a background box.`,
              });
          },
        });
      }
    }
  }

  const audible =
    timeline.clips.some((c) => c.asset.type === "video" && c.asset.hasAudio !== false && !c.clip.muted && c.clip.volume > 0) ||
    timeline.audio.some((a) => a.clip.volume > 0) ||
    p.layers.some((l) => l.type === "media" && l.volume > 0);
  const wantAudio = (checks.has("audio") || checks.has("speech")) && audible;
  if ((checks.has("audio") || checks.has("speech")) && !audible) notes.push("The edit has no sound, so audio and caption sync were not checked.");

  let audioFiles: { mix: string; voice: string; music: string } | undefined;
  if (!detector) faceChecks.length = 0;
  if (samples.length || faceChecks.length || wantAudio) {
    await mkdir(opts.workDir, { recursive: true });
    audioFiles = wantAudio ? { mix: path.join(opts.workDir, "review-mix.wav"), voice: path.join(opts.workDir, "review-voice.wav"), music: path.join(opts.workDir, "review-music.wav") } : undefined;
    const backdrop: Project = { ...p, layers: p.layers.filter((l) => l.type !== "text"), ...(p.captions ? { captions: { ...p.captions, enabled: false } } : {}) };
    const r = await renderForAnalysis(backdrop, {
      framesAt: [...samples.map((s) => s.time), ...faceChecks.map((c) => c.time)],
      audio: audioFiles,
      scale: Math.min(1, 360 / Math.min(W, H)),
      probe: false,
      baseDir: opts.baseDir,
      fontsDir: opts.fontsDir,
      cacheDir: opts.cacheDir,
      ffmpegPath: opts.ffmpegPath,
      onProgress: (x) => opts.onProgress?.(x * 0.6),
    });
    const nearest = (time: number) => r.frames.reduce<AnalysisFrame | undefined>((best, f) => (!best || Math.abs(f.time - time) < Math.abs(best.time - time) ? f : best), undefined);
    for (const s of samples) {
      const frame = nearest(s.time);
      if (frame) s.measure({ ...frame, width: r.width, height: r.height });
    }
    if (faceChecks.length && detector) {
      try {
        const found = new Map<AnalysisFrame, Face[]>();
        for (const c of faceChecks) {
          const frame = nearest(c.time);
          if (!frame) continue;
          if (!found.has(frame)) found.set(frame, await detector.detectRgb(frame.rgb, r.width, r.height));
          textOverFaces(c, frame.time, found.get(frame)!, issues);
        }
      } catch (e) {
        notes.push(`Text over faces was not checked: ${(e as Error).message}`);
      }
    }
  }

  let loudness: ReviewReport["loudness"];
  if (audioFiles) {
    if (checks.has("audio")) loudness = await audioChecks(p, audioFiles, opts, issues);
    if (checks.has("speech")) await speechSync(p, timeline, audioFiles.voice, opts, issues);
  }
  opts.onProgress?.(0.75);
  if (checks.has("frames")) await footageChecks(p, timeline, opts, issues);
  opts.onProgress?.(0.9);
  if (checks.has("key")) await keyChecks(p, timeline, opts, issues);
  opts.onProgress?.(1);
  issues.sort((a, b) => a.start - b.start || (a.severity === b.severity ? 0 : a.severity === "problem" ? -1 : 1));
  return { issues, ...(loudness ? { loudness } : {}), notes };
}

// ---------------------------------------------------------------------------
// Text readability
// ---------------------------------------------------------------------------

export interface BackdropContrast {
  /** Share of the backdrop under 2:1 contrast with the text (nearly the same brightness). */
  poor: number;
  /** Share under 3:1, the minimum for large text. */
  low: number;
  /** Contrast against the median backdrop brightness. */
  ratio: number;
}

/** How the text's fill color stands out from the picture inside `box`. */
export function backdropContrast(f: { width: number; height: number; rgb: Buffer }, box: Box, fill: number): BackdropContrast | undefined {
  const x0 = Math.max(0, Math.floor(box.x0 * f.width));
  const x1 = Math.min(f.width, Math.ceil(box.x1 * f.width));
  const y0 = Math.max(0, Math.floor(box.y0 * f.height));
  const y1 = Math.min(f.height, Math.ceil(box.y1 * f.height));
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined;
  const lums: number[] = [];
  let poor = 0;
  let low = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * f.width + x) * 3;
      const l = relativeLuminance(f.rgb[i]!, f.rgb[i + 1]!, f.rgb[i + 2]!);
      lums.push(l);
      const c = contrastRatio(fill, l);
      if (c < 2) poor++;
      if (c < 3) low++;
    }
  lums.sort((a, b) => a - b);
  return { poor: poor / lums.length, low: low / lums.length, ratio: contrastRatio(fill, lums[Math.floor(lums.length / 2)]!) };
}

/** problem: most of the backdrop is about as bright as the text; warning: low contrast, or a busy backdrop in places. */
export function contrastSeverity(r: BackdropContrast): "problem" | "warning" | undefined {
  return r.poor > 0.5 ? "problem" : r.low > 0.25 ? "warning" : undefined;
}

function contrastFinding(r: BackdropContrast): string {
  if (r.poor > 0.5) return `${Math.round(r.poor * 100)}% of the picture behind it is about as bright as the text (contrast ${r.ratio.toFixed(1)}:1)`;
  if (r.low > 0.9) return `contrast with the backdrop is ${r.ratio.toFixed(1)}:1, under the 3:1 minimum for large text`;
  return `${Math.round(r.low * 100)}% of the picture behind it is under 3:1 contrast with the text`;
}

function readability(f: AnalysisFrame & { width: number; height: number }, l: TextLayer, box: Box, issues: ReviewIssue[]): void {
  const r = backdropContrast(f, box, colorLuminance(l.style.color));
  const severity = r && contrastSeverity(r);
  if (!r || !severity) return;
  const text = l.text.length > 40 ? `${l.text.slice(0, 39)}…` : l.text;
  issues.push({
    check: "text",
    severity,
    start: l.start,
    end: l.start + l.duration,
    target: l.id,
    message: `Text "${text}" ${severity === "problem" ? "is hard to read" : "has low contrast"} at ${t(f.time)}: ${contrastFinding(r)}. Add an outline (style.outlineWidth 3+), a background box (style.background), a darker shape behind it, or change its color.`,
  });
}

/** Report text or a caption covering a face (once per layer, and once for all captions). */
function textOverFaces(c: { box: Box; target: string; start: number; end: number; what: string }, time: number, faces: Face[], issues: ReviewIssue[]): void {
  const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const covered = Math.max(0, ...faces.map((f) => area({ x0: Math.max(f.x0, c.box.x0), y0: Math.max(f.y0, c.box.y0), x1: Math.min(f.x1, c.box.x1), y1: Math.min(f.y1, c.box.y1) }) / Math.max(area(f), 1e-9)));
  if (covered < 0.08 || issues.some((i) => i.target === c.target && /covers|touches/.test(i.message))) return;
  issues.push({
    check: "text",
    severity: covered >= 0.25 ? "problem" : "warning",
    start: round3(c.start),
    end: round3(c.end),
    target: c.target,
    message: `${c.what} ${covered >= 0.25 ? "covers" : "touches"} a face at ${t(time)} (${Math.round(covered * 100)}% of it). Move it into empty space: detect_faces shows where faces are.`,
  });
}

// ---------------------------------------------------------------------------
// Audio: loudness, peaks, music under the voice
// ---------------------------------------------------------------------------

/** Integrated loudness (LUFS) and true peak (dBTP) of an audio file, by EBU R128. */
export async function measureLoudness(file: string, opts: FfmpegOptions = {}): Promise<{ integrated: number; truePeak: number }> {
  const { stderr } = await runFfmpeg(["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], opts);
  const last = (re: RegExp) => {
    const m = [...stderr.matchAll(re)].pop();
    return !m ? NaN : m[1] === "-inf" ? -Infinity : Number(m[1]);
  };
  return { integrated: last(/I:\s+(-?[\d.]+|-inf) LUFS/g), truePeak: last(/Peak:\s+(-?[\d.]+|-inf) dBFS/g) };
}

async function audioChecks(p: Project, files: { mix: string; voice: string; music: string }, opts: ReviewOptions, issues: ReviewIssue[]): Promise<ReviewReport["loudness"]> {
  const target = opts.loudnessTarget ?? -14;
  const end = computeTimeline(p).duration;
  const mix = await measureLoudness(files.mix, opts);
  if (!(mix.integrated > -45)) {
    issues.push({ check: "audio", severity: "problem", start: 0, end, target: "mix", message: "The finished video is nearly silent. Check clip volumes and mutes." });
    return { integrated: mix.integrated, truePeak: mix.truePeak, target };
  }
  const off = mix.integrated - target;
  if (Math.abs(off) > 2)
    issues.push({
      check: "audio",
      severity: Math.abs(off) > 4 ? "problem" : "warning",
      start: 0,
      end,
      target: "mix",
      message: `Loudness is ${mix.integrated} LUFS, ${Math.abs(off).toFixed(1)} dB ${off < 0 ? "below" : "above"} the ${target} LUFS target${off < 0 ? ", so it will sound quiet next to other videos" : ""}. Add the normalize audio effect to "master" with target ${target}.`,
    });
  if (mix.truePeak > -1)
    issues.push({ check: "audio", severity: "warning", start: 0, end, target: "mix", message: `True peak is ${mix.truePeak} dBTP; platforms ask for -1 dBTP or lower to avoid distortion after their encoding. A master normalize fixes it.` });
  if (existsSync(files.voice)) {
    const voice = await measureLoudness(files.voice, opts);
    if (voice.truePeak > 0.5)
      issues.push({ check: "audio", severity: "warning", start: 0, end, target: "mix", message: `The voice peaks at +${voice.truePeak} dB, past full scale, before the final limiter squashes it: lower clip or voice-over volumes and normalize the master instead.` });
    if (existsSync(files.music)) await musicBalance(files.voice, files.music, opts, issues);
  }
  return { integrated: mix.integrated, truePeak: mix.truePeak, target };
}

const WINDOW = 0.4;

function windowLevels(x: Float32Array): number[] {
  const n = Math.round(ANALYSIS_RATE * WINDOW);
  const out: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) s += x[k]! * x[k]!;
    out.push(10 * Math.log10(s / n + 1e-12));
  }
  return out;
}

/** Where the music sits less than 10 dB under someone speaking. */
async function musicBalance(voiceFile: string, musicFile: string, opts: FfmpegOptions, issues: ReviewIssue[]): Promise<void> {
  const [voice, music] = await Promise.all([decodeAudio(voiceFile, opts), decodeAudio(musicFile, opts)]);
  const speech = analyzeSamples(voice).segments.filter((s) => s.kind === "speech");
  const v = windowLevels(voice);
  const m = windowLevels(music);
  const flagged: (TimeRange & { diff: number })[] = [];
  for (let i = 0; i < Math.min(v.length, m.length); i++) {
    const mid = (i + 0.5) * WINDOW;
    if (v[i]! < -40 || !speech.some((s) => mid >= s.start && mid < s.end)) continue;
    const diff = v[i]! - m[i]!;
    if (diff < 10) flagged.push({ start: i * WINDOW, end: (i + 1) * WINDOW, diff });
  }
  const ranges = mergeRanges(flagged.map((f) => ({ start: f.start, end: f.end + WINDOW }))).map((r) => ({ start: round3(r.start), end: round3(Math.max(r.start, r.end - WINDOW)) })).filter((r) => r.end - r.start >= 1.2);
  for (const r of ranges.slice(0, 5)) {
    const inside = flagged.filter((f) => f.start >= r.start && f.end <= r.end + 1e-6);
    const diff = inside.reduce((s, f) => s + f.diff, 0) / inside.length;
    issues.push({
      check: "audio",
      severity: diff < 4 ? "problem" : "warning",
      start: r.start,
      end: r.end,
      target: "music",
      message: `Music is only ${diff.toFixed(1)} dB under the voice from ${t(r.start)} to ${t(r.end)} (aim for 12 dB or more): lower the music volume, and keep duck on.`,
    });
  }
  if (ranges.length > 5) issues.push({ check: "audio", severity: "warning", start: ranges[5]!.start, end: ranges[ranges.length - 1]!.end, target: "music", message: `Music competes with the voice in ${ranges.length - 5} more places.` });
}

// ---------------------------------------------------------------------------
// Captions against the speech actually heard
// ---------------------------------------------------------------------------

async function speechSync(p: Project, timeline: Timeline, voiceFile: string, opts: FfmpegOptions, issues: ReviewIssue[]): Promise<void> {
  if (!existsSync(voiceFile) || p.captions?.segments?.length) return;
  const words = timelineWords(p, timeline);
  if (!words.length) return;
  const map = analyzeSamples(await decodeAudio(voiceFile, opts));
  const sound = map.segments.filter((s) => s.kind !== "silence");
  const heard = (a: number, b: number) => sound.reduce((s, g) => s + Math.max(0, Math.min(b, g.end) - Math.max(a, g.start)), 0);
  // Words shown while nothing is heard, grouped into runs.
  const runs: { start: number; end: number; text: string[] }[] = [];
  for (const w of words) {
    if (w.end - w.start < 0.1 || heard(w.start, w.end) > 0.1 * (w.end - w.start)) continue;
    const last = runs[runs.length - 1];
    if (last && w.start - last.end < 0.6) {
      last.end = w.end;
      last.text.push(w.text);
    } else runs.push({ start: w.start, end: w.end, text: [w.text] });
  }
  const offs = runs.filter((r) => r.text.length >= 2 || r.end - r.start >= 0.5);
  const severity = p.captions?.enabled ? "problem" : "warning";
  for (const r of offs.slice(0, 5))
    issues.push({ check: "speech", severity, start: round3(r.start), end: round3(r.end), target: "captions", message: `Captions show "${r.text.join(" ")}" from ${t(r.start)} to ${t(r.end)}, but nothing is heard there: the transcript timing is off. Re-transcribe that asset or fix the word times.` });
  if (offs.length > 5) issues.push({ check: "speech", severity, start: round3(offs[5]!.start), end: round3(offs[offs.length - 1]!.end), target: "captions", message: `${offs.length - 5} more stretches of caption words over silence.` });

  // Speech that the transcript skipped (quiet or fast speech the recognizer dropped).
  const transcribedAt = (time: number) => {
    const tc = clipAtTime(timeline, time);
    if (tc && p.transcripts[tc.clip.assetId] && !tc.clip.muted) return true;
    return timeline.audio.some((a) => a.clip.role === "voiceover" && p.transcripts[a.clip.assetId] && time >= a.start && time < a.end);
  };
  const covered = mergeRanges(words.map((w) => ({ start: w.start - 0.25, end: w.end + 0.25 })));
  const missed = map.segments
    .filter((s) => s.kind === "speech" && s.confidence >= 0.6)
    .flatMap((s) => invertRanges(covered, s.start, s.end))
    .filter((r) => r.end - r.start >= 1.5 && transcribedAt((r.start + r.end) / 2));
  for (const s of missed.slice(0, 5))
    issues.push({ check: "speech", severity: "warning", start: round3(s.start), end: round3(s.end), message: `Someone seems to speak from ${t(s.start)} to ${t(s.end)}, but the transcript has no words there, so it has no captions. The recognizer may have skipped it: check it, and transcribe again or add the words with set_transcript.` });
}

// ---------------------------------------------------------------------------
// Footage: black and frozen picture
// ---------------------------------------------------------------------------

/** Black and frozen stretches in a source range (source seconds). */
export async function scanFootage(file: string, range: TimeRange, opts: FfmpegOptions = {}): Promise<{ black: TimeRange[]; frozen: TimeRange[] }> {
  const { stderr } = await runFfmpeg(
    [
      "-hide_banner",
      "-ss", String(round3(range.start)),
      "-t", String(round3(range.end - range.start)),
      "-i", file,
      "-an",
      "-vf", "setpts=PTS-STARTPTS,fps=10,scale=160:-2,blackdetect=d=0.4:pix_th=0.10,freezedetect=n=0.003:d=1.5",
      "-f", "null", "-",
    ],
    opts,
  );
  const at = (v: string) => round3(range.start + Number(v));
  const black = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: at(m[1]!), end: at(m[2]!) }));
  const starts = [...stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => at(m[1]!));
  const ends = [...stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => at(m[1]!));
  const frozen = starts.map((s, i) => ({ start: s, end: ends[i] ?? range.end }));
  return { black, frozen };
}

async function footageChecks(p: Project, timeline: Timeline, opts: ReviewOptions, issues: ReviewIssue[]): Promise<void> {
  const byAsset = new Map<string, typeof timeline.clips>();
  for (const tc of timeline.clips) if (tc.asset.type === "video") byAsset.set(tc.asset.id, [...(byAsset.get(tc.asset.id) ?? []), tc]);
  for (const [, clips] of byAsset) {
    const asset = clips[0]!.asset as Extract<Asset, { type: "video" }>;
    // Scan the used footage once, joining clips that are close together in the source.
    const spans = mergeRanges(clips.map((c) => ({ start: Math.max(0, c.clip.in - 2.5), end: c.clip.in + c.sourceDuration + 2.5 })));
    for (const span of spans) {
      const file = /^[a-z]+:\/\//i.test(asset.src) ? asset.src : path.resolve(opts.baseDir ?? process.cwd(), asset.src);
      const found = await scanFootage(file, { start: span.start, end: Math.min(span.end, asset.duration ?? span.end) }, opts);
      for (const tc of clips) {
        const [a, b] = [tc.clip.in, tc.clip.in + tc.sourceDuration];
        // A zoom or shake on a locked-off shot gives it movement, so a still source is fine there.
        const moves = tc.clip.effects.some((e) => ["motion", "shake"].includes(getEffect(e.type)?.category ?? ""));
        for (const [kind, list, min] of [["black", found.black, 0.4], ["frozen", found.frozen, 1.5]] as const) {
          for (const r of list) {
            const from = Math.max(a, r.start);
            const to = Math.min(b, r.end);
            if (to - from < min || (kind === "frozen" && moves)) continue;
            const [start, end] = [round3(sourceToTimeline(tc, from)), round3(sourceToTimeline(tc, to))];
            issues.push(
              kind === "black"
                ? { check: "frames", severity: "problem", start, end, target: tc.clip.id, message: `Black picture from ${t(start)} to ${t(end)} in clip ${tc.clip.id} (source ${from}-${to}s): trim it out unless it is a deliberate pause.` }
                : { check: "frames", severity: "warning", start, end, target: tc.clip.id, message: `The picture is frozen from ${t(start)} to ${t(end)} in clip ${tc.clip.id} (source ${from}-${to}s). Fine for a still shot or screen recording; otherwise cut it or cover it with b-roll.` },
            );
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Chroma key: screen color left behind
// ---------------------------------------------------------------------------

function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max ? d / max : 0, v: max / 255 };
}

/**
 * Share of a frame the key removed, and share still close to the screen's hue after keying
 * (unkeyed screen that despill would turn gray or leave green).
 */
export async function keyResidue(file: string, time: number | undefined, params: { color: string; similarity: number; blend: number }, opts: FfmpegOptions = {}): Promise<{ keyed: number; residue: number }> {
  const read = async (vf: string) =>
    (await runFfmpegOrThrow(["-hide_banner", "-loglevel", "error", ...(time !== undefined ? ["-ss", String(round3(time))] : []), "-i", file, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-"], { ...opts, binaryStdout: true })).stdoutBuffer ?? Buffer.alloc(0);
  const hex = params.color.replace(/^#/, "").slice(0, 6);
  const rgb = await read("scale=240:-2,format=rgb24");
  const alpha = await read(`scale=240:-2,format=rgba,colorkey=color=0x${hex}:similarity=${params.similarity}:blend=${params.blend},alphaextract,format=gray`);
  const k = parseColor(`#${hex}`);
  const key = hsv(k.r, k.g, k.b);
  let keyed = 0;
  let residue = 0;
  const n = Math.min(alpha.length, rgb.length / 3);
  for (let i = 0; i < n; i++) {
    if (alpha[i]! < 128) {
      keyed++;
      continue;
    }
    const c = hsv(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!);
    const dh = Math.abs(((c.h - key.h + 540) % 360) - 180);
    if (dh < 30 && c.s >= 0.25 && c.v >= 0.2) residue++;
  }
  return n ? { keyed: keyed / n, residue: residue / n } : { keyed: 0, residue: 0 };
}

async function keyChecks(p: Project, timeline: Timeline, opts: ReviewOptions, issues: ReviewIssue[]): Promise<void> {
  const targets: { id: string; asset: Asset; time?: number; start: number; end: number; effect: Effect }[] = [];
  for (const tc of timeline.clips)
    for (const e of tc.clip.effects) if (e.type === "chromaKey") targets.push({ id: tc.clip.id, asset: tc.asset, time: tc.asset.type === "video" ? tc.clip.in + tc.sourceDuration / 2 : undefined, start: tc.start, end: tc.end, effect: e });
  for (const l of p.layers) {
    if (l.type !== "media") continue;
    const asset = p.assets.find((a) => a.id === l.assetId);
    if (asset) for (const e of l.effects) if (e.type === "chromaKey") targets.push({ id: l.id, asset, time: asset.type === "video" ? l.in + l.duration / 2 : undefined, start: l.start, end: l.start + l.duration, effect: e });
  }
  for (const x of targets) {
    if (x.asset.type !== "video" && x.asset.type !== "image") continue;
    const params = getEffect("chromaKey")!.params.parse(x.effect.params ?? {}) as { color: string; similarity: number; blend: number };
    const file = /^[a-z]+:\/\//i.test(x.asset.src) ? x.asset.src : path.resolve(opts.baseDir ?? process.cwd(), x.asset.src);
    const r = await keyResidue(file, x.time, params, opts);
    if (r.residue < 0.004 || r.residue < 0.03 * (r.keyed + r.residue)) continue;
    const mid = round3((x.start + x.end) / 2);
    issues.push({
      check: "key",
      severity: r.residue > 0.02 ? "problem" : "warning",
      start: x.start,
      end: x.end,
      target: x.id,
      message: `The chroma key on ${x.id} leaves ${(r.residue * 100).toFixed(1)}% of the frame unkeyed in the screen's color around ${t(mid)} (it keys ${(r.keyed * 100).toFixed(0)}%). It shows as green or gray patches: measure the screen with sample_color and set that color, or raise similarity a little (now ${params.similarity}).${r.residue > 0.02 ? "" : " Ignore it if the frame has real green objects."}`,
    });
  }
}
