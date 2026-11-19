import type { Box } from "./faces.js";
import { decodeFrames } from "./objects.js";
import { PERSON_INPUT, PersonSegmenter, type PersonSegmenterOptions } from "./segment.js";

/**
 * Where the people are in a clip, from the person cutout model rather than faces: for footage where
 * faces are not found (dancers seen from behind, silhouettes, small figures, game avatars). Boxes are
 * frame fractions of the source picture.
 */
/** A person's box with how sure the model is of it (its mean probability inside the box, 0..1). */
export type PersonBox = Box & { sure?: number };

export interface ClipPeople {
  /** Each sampled frame: its source time and the box around everyone in it (undefined: nobody). */
  frames: { time: number; box?: PersonBox }[];
  /** Median certainty of the frames' boxes (0 when nobody was found). */
  confidence: number;
  /** The box around every frame's box: the people's whole path. Only when the model is sure (confidentPeople). */
  extent?: Box;
  /** The median box: where the people usually are. */
  box?: Box;
}

/**
 * The box around the main subject in a person mask (probability per pixel, `n` square): the largest
 * connected region of person pixels, so a bystander at the edge, or something the model half takes
 * for a person, does not stretch the box. Regions are joined across a gap of `join` pixels (a couple
 * dancing close, an arm the mask breaks off). Undefined when the region is too small to be a person
 * (`minShare` of the frame). `aspect` is the source picture's width over height (the mask is square).
 */
export function personBox(mask: Float32Array, n = PERSON_INPUT, threshold = 0.5, minShare = 0.003, join = 2, aspect = 1): PersonBox | undefined {
  const on = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) on[i] = mask[i]! > threshold ? 1 : 0;
  const label = new Int32Array(n * n).fill(-1);
  let best: { count: number; sure: number; score: number; x0: number; y0: number; x1: number; y1: number } | undefined;
  const queue = new Int32Array(n * n);
  for (let start = 0; start < n * n; start++) {
    if (!on[start] || label[start]! >= 0) continue;
    const r = { count: 0, sure: 0, x0: n, y0: n, x1: -1, y1: -1 };
    let [head, tail] = [0, 0];
    queue[tail++] = start;
    label[start] = start;
    while (head < tail) {
      const i = queue[head++]!;
      const [x, y] = [i % n, Math.floor(i / n)];
      r.count++;
      r.sure += mask[i]!;
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
      for (let dy = -join; dy <= join; dy++)
        for (let dx = -join; dx <= join; dx++) {
          const [nx, ny] = [x + dx, y + dy];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          if (on[j] && label[j]! < 0) {
            label[j] = start;
            queue[tail++] = j;
          }
        }
    }
    if (r.count < minShare * n * n) continue;
    // The subject is usually whole and toward the middle; someone cut off by the side of the frame
    // (or a game's buttons) is a bystander.
    const side = r.x0 === 0 || r.x1 === n - 1 ? 0.3 : 1;
    const off = Math.abs((r.x0 + r.x1 + 1) / 2 / n - 0.5);
    // Far wider than tall in the picture is rarely a person: a car, a sofa.
    const wide = ((r.x1 - r.x0 + 1) / (r.y1 - r.y0 + 1)) * aspect > 2.2 ? 0.35 : 1;
    const score = r.count * side * wide * (1 - Math.min(0.8, off));
    if (!best || score > best.score) best = { ...r, score };
  }
  if (!best) return undefined;
  return { x0: best.x0 / n, y0: best.y0 / n, x1: (best.x1 + 1) / n, y1: (best.y1 + 1) / n, sure: Math.round((best.sure / best.count) * 1000) / 1000 };
}

/**
 * How sure a clip's people must be to frame on them: the median of the model's mean probability
 * inside each frame's box. Measured on real footage: people 0.95 to 0.99 in every frame; cars,
 * buildings and stones the model half takes for people 0.67 to 0.93 per clip. Below it, nothing is
 * reported and the crop stays as it was, which is no worse than before.
 */
export const PEOPLE_SURE = 0.95;

const median = (l: number[]) => {
  const s = [...l].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** The extent and the median of a list of boxes. */
export function summarizeBoxes(boxes: Box[]): { extent?: Box; box?: Box } {
  if (!boxes.length) return {};
  const extent = { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
  const box = { x0: median(boxes.map((b) => b.x0)), y0: median(boxes.map((b) => b.y0)), x1: median(boxes.map((b) => b.x1)), y1: median(boxes.map((b) => b.y1)) };
  return { extent, box };
}

/** Find the people in `samples` frames spread over a source range of `src`. */
export async function findPeople(src: string, range: { start: number; end: number }, opts: PersonSegmenterOptions & { samples?: number; aspect?: number; sure?: number; signal?: AbortSignal } = {}): Promise<ClipPeople> {
  const span = Math.max(0.05, range.end - range.start);
  const samples = Math.max(1, Math.min(24, opts.samples ?? 8));
  // Frames stretched to the model's square: the box comes back as fractions of the whole frame.
  const frames = await decodeFrames(src, range, samples / span, { w: PERSON_INPUT, h: PERSON_INPUT }, "rgb24", { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  const model = new PersonSegmenter(opts);
  const out: ClipPeople["frames"] = [];
  for (const [k, rgb] of frames.entries()) {
    const box = personBox(await model.segmentSquare(rgb), PERSON_INPUT, 0.5, 0.003, 2, opts.aspect ?? 1);
    out.push({ time: Math.round((range.start + (k * span) / Math.max(1, frames.length)) * 1000) / 1000, ...(box ? { box } : {}) });
  }
  return confidentPeople(out, opts.sure);
}

/**
 * The clip's people from its frames, only when the model is sure of them: found in at least 60% of
 * the frames, with a median certainty of `needed` (default PEOPLE_SURE) or more. Otherwise the frames alone.
 */
export function confidentPeople(frames: ClipPeople["frames"], needed = PEOPLE_SURE): ClipPeople {
  const found = frames.flatMap((f) => (f.box ? [f.box] : []));
  const sure = found.length ? median(found.map((b) => b.sure ?? 1)) : 0;
  const confidence = Math.round(sure * 1000) / 1000;
  if (found.length < Math.max(1, Math.ceil(frames.length * 0.6)) || sure < needed) return { frames, confidence };
  return { frames, confidence, ...summarizeBoxes(found) };
}
