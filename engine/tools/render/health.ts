import type { Project } from "../../core/index.js";
import { computeTimeline } from "../../core/index.js";
import { probe, runFfmpeg, type FfmpegOptions } from "./ffmpeg.js";

/**
 * A finished render read back cheaply (a small copy at 10 frames a second) to catch what a render can
 * get wrong without failing: a picture that stops moving (a filter that ended early leaves the other
 * streams repeating its last frame), black stretches, and a length that is not the edit's.
 */
export interface RenderHealth {
  /** Seconds of the file. */
  duration: number;
  /** Seconds the edit (or the rendered range) should last. */
  expected: number;
  /** Stretches where the picture does not change while the edit has moving footage there (file seconds). */
  frozen: { start: number; end: number }[];
  /** Stretches of black the edit does not ask for (file seconds). */
  black: { start: number; end: number }[];
  /** One line per problem, for the tool's answer; empty when the render looks right. */
  warnings: string[];
}

/** Shortest frozen or black stretch reported, in seconds. */
const MIN_STRETCH = 1.5;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Pairs of start/end values from freezedetect or blackdetect lines on stderr; an open stretch ends at `end`. */
export function parseStretches(stderr: string, kind: "freeze" | "black", end: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | undefined;
  const re = kind === "freeze" ? /freeze_(start|end):\s*([\d.]+)/g : /black_(start|end):\s*([\d.]+)/g;
  for (const m of stderr.matchAll(re)) {
    const t = Number(m[2]);
    if (m[1] === "start") open = t;
    else if (open !== undefined) {
      out.push({ start: open, end: t });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ start: open, end });
  return out.filter((s) => s.end - s.start >= MIN_STRETCH);
}

/**
 * Where the edit itself shows a still or black picture (timeline seconds, shifted by `offset` into
 * file seconds): image, color and gradient clips, freeze-frames (image clips) and very slow footage.
 */
export function stillSpans(project: Project, offset = 0): { start: number; end: number }[] {
  const timeline = computeTimeline(project);
  return timeline.clips
    .filter((c) => c.asset.type !== "video" || (c.clip.speed ?? 1) <= 0.3)
    .map((c) => ({ start: c.start - offset, end: c.end - offset }));
}

/** The part of a stretch not covered by any of `spans`, in seconds. */
function uncovered(s: { start: number; end: number }, spans: { start: number; end: number }[]): number {
  let left = s.end - s.start;
  for (const c of spans) left -= Math.max(0, Math.min(s.end, c.end) - Math.max(s.start, c.start));
  return left;
}

/** Read a rendered video back and report frozen and black stretches and a wrong length. */
export async function checkRender(
  file: string,
  project: Project,
  opts: FfmpegOptions & { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<RenderHealth> {
  const total = computeTimeline(project).duration;
  const start = opts.range ? Math.max(0, opts.range.start) : 0;
  const expected = round2((opts.range ? Math.min(total, opts.range.end) : total) - start);
  const info = await probe(file, { ffmpegPath: opts.ffmpegPath });
  const duration = round2(info.duration ?? 0);
  const warnings: string[] = [];
  if (Math.abs(duration - expected) > 0.25) warnings.push(`The file lasts ${duration}s but the edit${opts.range ? "'s range" : ""} lasts ${expected}s.`);
  if (!info.hasVideo) return { duration, expected, frozen: [], black: [], warnings };

  // Small and at 10 frames a second: enough to see a picture stop, a fraction of the decode.
  const graph = `fps=10,scale=160:-2,freezedetect=n=0.002:d=${MIN_STRETCH},blackdetect=d=${MIN_STRETCH}:pix_th=0.06`;
  const res = await runFfmpeg(["-hide_banner", "-nostdin", "-i", file, "-map", "0:v:0", "-vf", graph, "-f", "null", "-"], { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  const still = stillSpans(project, start);
  const frozen = parseStretches(res.stderr, "freeze", duration).filter((s) => uncovered(s, still) >= MIN_STRETCH);
  const black = parseStretches(res.stderr, "black", duration).filter((s) => uncovered(s, still) >= MIN_STRETCH);
  const span = (s: { start: number; end: number }) => `${round2(s.start + start)}s to ${round2(s.end + start)}s`;
  for (const s of frozen) warnings.push(`The picture does not move from ${span(s)} although the edit has moving footage there: a clip's effects may have failed. Check it with render_frame.`);
  for (const s of black) warnings.push(`The picture is black from ${span(s)}.`);
  return { duration, expected, frozen, black, warnings };
}
