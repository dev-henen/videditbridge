/**
 * review_edit's look checks (docs/design/cinematic-grade-and-vfx.md, section 8): what a grade and the
 * visual effects can do wrong that a viewer notices. `grade`: highlights or shadows the grade clipped,
 * skin pushed off the skin line, banding the grade brought out in smooth areas. `vfx`: model mattes
 * that flicker, tracks that pinned layers and masks follow where they are unsure (drift), and a
 * replaced sky that slides against the scenery. Measurements are pure functions; the checks render
 * the frames they need.
 */
import type { Effect, Mask, Project } from "../../core/schema.js";
import type { Timeline } from "../../core/timeline.js";
import { formatTime, round3 } from "../../core/util.js";
import { mergeRanges } from "../../core/ranges.js";
import { getEffect } from "../../library/effects/index.js";
import { SKIN_LINE, vectorscopeHue } from "../../library/effects/color-match.js";
import { controlled, native } from "../native/index.js";
import { renderForAnalysis, type AnalysisFrame, type RenderOptions } from "../render/render.js";
import type { Box, FaceDetector } from "../vision/faces.js";
import { trackPointsInClips, trackSampler } from "../vision/points.js";
import type { ReviewIssue } from "./checks.js";

type Pixels = Buffer | Uint8Array;
const t = (s: number) => formatTime(s);
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** The picture averaged in 8 px blocks, so film grain on a flat area does not hide it. */
function blocks(rgb: Pixels, w: number, h: number): Pixels {
  const B = 8;
  if (w < B * 2 || h < B * 2) return rgb;
  const [bw, bh] = [Math.floor(w / B), Math.floor(h / B)];
  const out = new Uint8Array(bw * bh * 3);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) sum += rgb[((by * B + y) * w + bx * B + x) * 3 + c]!;
        out[(by * bw + bx) * 3 + c] = Math.round(sum / (B * B));
      }
  return out;
}

const luma = (px: Pixels, k: number) => 0.2126 * px[k * 3]! + 0.7152 * px[k * 3 + 1]! + 0.0722 * px[k * 3 + 2]!;

/**
 * A picture's ceiling and floor: the highest and lowest luma that 0.1% of its pixels reach, with 3
 * levels of room (1 at pure white and black). They are the picture's own because what a grade
 * clips, a later stage (a look's print curve, a fade, a tint) moves off pure white and black, where
 * it is as flat as before. Luma, since a tint gives a flat area a color but leaves it flat.
 */
function limits(px: Pixels): { top: number; bottom: number } {
  const n = Math.floor(px.length / 3);
  const hist = new Uint32Array(256);
  for (let k = 0; k < n; k++) hist[Math.round(luma(px, k))]!++;
  const tail = Math.max(1, Math.floor(n * 0.001));
  let [v, seen] = [255, hist[255]!];
  while (seen < tail && v > 0) seen += hist[--v]!;
  const top = v >= 254 ? 254 : v - 3;
  [v, seen] = [0, hist[0]!];
  while (seen < tail && v < 255) seen += hist[++v]!;
  return { top, bottom: v <= 1 ? 2 : v + 3 };
}

/**
 * Share of pixels at the picture's ceiling (blown out) and at its floor (crushed); see limits. With
 * `w` and `h` the picture is averaged in 8 px blocks first.
 */
export function clippedShare(rgb: Pixels, w?: number, h?: number): { highlights: number; shadows: number } {
  const px = w && h ? blocks(rgb, w, h) : rgb;
  const { top, bottom } = limits(px);
  const n = Math.floor(px.length / 3);
  let [hi, lo] = [0, 0];
  for (let k = 0; k < n; k++) {
    const y = luma(px, k);
    if (y >= top) hi++;
    else if (y <= bottom) lo++;
  }
  return { highlights: hi / n, shadows: lo / n };
}

/**
 * What a grade clipped: the share of the picture that is blown out or crushed in `edit` and held
 * detail in `footage` (the same frame without the grade), where it was more than 12 levels from the
 * footage's own ceiling or floor. A grade that presses near-black or near-white levels closer
 * together loses nothing a viewer sees; one that flattens what was clearly apart does.
 */
export function clippedByGrade(edit: Pixels, footage: Pixels, w: number, h: number): { highlights: number; shadows: number } {
  const [e, f] = [blocks(edit, w, h), blocks(footage, w, h)];
  const [le, lf] = [limits(e), limits(f)];
  const n = Math.floor(Math.min(e.length, f.length) / 3);
  let [hi, lo] = [0, 0];
  for (let k = 0; k < n; k++) {
    const [ye, yf] = [luma(e, k), luma(f, k)];
    if (ye >= le.top) hi += Number(yf < lf.top - 12);
    else if (ye <= le.bottom) lo += Number(yf > lf.bottom + 12);
  }
  return { highlights: hi / n, shadows: lo / n };
}

/**
 * Banding in smooth areas: rows and columns are cut into 32 px windows; a window is smooth when its
 * luma spans 2 to 24 levels and runs one way (no texture or noise), and banded when it holds a flat
 * run of `run` px or more with at least two steps of 2 levels or more on average (single-level steps
 * of a plain 8-bit gradient do not show; a grade that stretches them does). `score` is the banded
 * share of smooth windows, `smooth` the smooth share of all windows (little smooth area means little to band).
 */
export function bandingScore(rgb: Pixels, w: number, h: number, run = 6): { score: number; smooth: number } {
  const N = 32;
  const lum = (x: number, y: number) => {
    const k = (y * w + x) * 3;
    return Math.round(0.2126 * rgb[k]! + 0.7152 * rgb[k + 1]! + 0.0722 * rgb[k + 2]!);
  };
  let [windows, smooth, banded] = [0, 0, 0];
  const scan = (at: (i: number) => number) => {
    windows++;
    let [longest, cur, steps, stepSum, travel] = [1, 1, 0, 0, 0];
    let prev = at(0);
    let [min, max] = [prev, prev];
    for (let i = 1; i < N; i++) {
      const v = at(i);
      const d = Math.abs(v - prev);
      travel += d;
      if (d === 0) longest = Math.max(longest, ++cur);
      else {
        cur = 1;
        steps++;
        stepSum += d;
      }
      [min, max] = [Math.min(min, v), Math.max(max, v)];
      prev = v;
    }
    const span = max - min;
    if (span < 2 || span > 24 || travel > span + 2) return;
    smooth++;
    if (longest >= run && steps >= 2 && stepSum / steps >= 2) banded++;
  };
  for (let y = 0; y < h; y += 2) for (let x0 = 0; x0 + N <= w; x0 += N) scan((i) => lum(x0 + i, y));
  for (let x = 0; x < w; x += 2) for (let y0 = 0; y0 + N <= h; y0 += N) scan((i) => lum(x, y0 + i));
  return { score: smooth ? banded / smooth : 0, smooth: windows ? smooth / windows : 0 };
}

/** The average skin color inside faces (cheeks and forehead), as a vectorscope hue and its chroma (0..1). */
export function skinHue(rgb: Pixels, w: number, h: number, faces: Box[]): { hue: number; chroma: number } | undefined {
  const sum = [0, 0, 0];
  let n = 0;
  for (const f of faces) {
    const [fw, fh] = [f.x1 - f.x0, f.y1 - f.y0];
    const [x0, x1] = [Math.max(0, Math.floor((f.x0 + fw * 0.25) * w)), Math.min(w, Math.ceil((f.x1 - fw * 0.25) * w))];
    const [y0, y1] = [Math.max(0, Math.floor((f.y0 + fh * 0.3) * h)), Math.min(h, Math.ceil((f.y1 - fh * 0.2) * h))];
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        for (let c = 0; c < 3; c++) sum[c]! += rgb[(y * w + x) * 3 + c]! / 255;
        n++;
      }
  }
  if (n < 20) return undefined;
  const mean = sum.map((v) => v / n) as [number, number, number];
  return { hue: vectorscopeHue(mean), chroma: Math.max(...mean) - Math.min(...mean) };
}

/**
 * How much a matte flickers: pixels that switch on, off and back on (or the reverse) over three
 * frames in a row, as a share of the matte's area per frame. Movement moves edges one way and does
 * not do that; a model unsure between frames does.
 */
export function toggleShare(masks: Pixels[]): number {
  if (masks.length < 3) return 0;
  const n = masks[0]!.length;
  let [toggles, area] = [0, 0];
  for (let q = 0; q < n; q++) {
    let on = false;
    for (const m of masks) if (m[q]! >= 128) on = true;
    if (on) area++;
  }
  for (let f = 1; f < masks.length - 1; f++)
    for (let q = 0; q < n; q++) {
      const [a, b, c] = [masks[f - 1]![q]! >= 128, masks[f]![q]! >= 128, masks[f + 1]![q]! >= 128];
      if (a === c && b !== a) toggles++;
    }
  return area ? toggles / area / (masks.length - 2) : 0;
}

/** Effects that grade: the color and grade categories, and a look's effects. */
export const isGrading = (e: Effect) => ["color", "grade"].includes(getEffect(e.type)?.category ?? "") || e.label === "look";

/** Model mattes a mask reads (they come from a model frame by frame, so they can flicker). */
const modelKinds = (m: Mask) => [m, ...(m.combine ?? [])].map((x) => x.kind).filter((k) => ["person", "face", "object", "sky", "depth"].includes(k));

export interface LookOptions extends Omit<RenderOptions, "output" | "range"> {
  checks: Set<string>;
  faces?: FaceDetector;
  onProgress?: (p: number) => void;
}

/** The project as the picture shows it, without text, captions and layers (what grades and effects act on). */
function pictureOnly(p: Project): Project {
  return { ...p, layers: [], ...(p.captions ? { captions: { ...p.captions, enabled: false } } : {}) };
}

/** Pick up to `max` items spread evenly. */
const spread = <T>(xs: T[], max: number): T[] => (xs.length <= max ? xs : Array.from({ length: max }, (_, k) => xs[Math.floor(((k + 0.5) * xs.length) / max)]!));

export async function lookChecks(p: Project, timeline: Timeline, opts: LookOptions, issues: ReviewIssue[], notes: string[]): Promise<void> {
  const { width: W, height: H, fps: F } = p.settings;
  const render = (q: Project, framesAt: number[], longSide: number) =>
    renderForAnalysis(q, { ...opts, framesAt, scale: Math.min(1, longSide / Math.min(W, H)), probe: false, onProgress: undefined });

  if (opts.checks.has("grade")) {
    // One frame in the middle of each graded clip (at most 8), at up to 720p for banding.
    const wholeGraded = p.effects.some(isGrading);
    const graded = spread(timeline.clips.filter((tc) => tc.asset.type !== "audio" && (wholeGraded || tc.clip.effects.some(isGrading))), 8);
    if (graded.length) {
      const times = graded.map((tc) => round3(tc.start + tc.duration / 2));
      const plain: Project = { ...pictureOnly(p), effects: p.effects.filter((e) => !isGrading(e)), clips: p.clips.map((c) => ({ ...c, effects: c.effects.filter((e) => !isGrading(e)) })) };
      const [a, b] = [await render(pictureOnly(p), times, 720), await render(plain, times, 720)];
      opts.onProgress?.(0.4);
      for (const [k, tc] of graded.entries()) {
        const [fa, fb] = [a.frames[k], b.frames[k]];
        if (!fa || !fb) continue;
        const id = tc.clip.id;
        const [ce, cp, added] = [clippedShare(fa.rgb, a.width, a.height), clippedShare(fb.rgb, b.width, b.height), clippedByGrade(fa.rgb, fb.rgb, a.width, a.height)];
        for (const [part, edit, footage, lost, fix] of [
          ["highlights", ce.highlights, cp.highlights, added.highlights, "lower exposure, whites or highlights"],
          ["shadows", ce.shadows, cp.shadows, added.shadows, "raise blacks or shadows, or lower contrast"],
        ] as const) {
          if (lost > 0.005)
            issues.push({ check: "grade", severity: lost > 0.02 ? "problem" : "warning", start: tc.start, end: tc.end, target: id, message: `The grade clips ${part} in clip ${id} at ${t(fa.time)}: ${(lost * 100).toFixed(1)}% of the frame held detail and is now flat (${(edit * 100).toFixed(1)}% of the frame is at the limit, ${(footage * 100).toFixed(1)}% without the grade). Detail is lost there: ${fix}, and check with render_scopes.` });
        }
        const [be, bp] = [bandingScore(fa.rgb, a.width, a.height), bandingScore(fb.rgb, b.width, b.height)];
        if (be.smooth > 0.03 && be.score > 0.2 && be.score - bp.score > 0.1)
          issues.push({ check: "grade", severity: be.score > 0.45 ? "problem" : "warning", start: tc.start, end: tc.end, target: id, message: `Banding in smooth areas (sky, walls, gradients) of clip ${id} at ${t(fa.time)}: the grade stretches the footage's 8-bit steps into visible bands (${Math.round(be.score * 100)}% of smooth areas, ${Math.round(bp.score * 100)}% without the grade). Soften the grade there, add a light filmGrain, or deliver with render_video bitDepth 10.` });
        if (opts.faces) {
          try {
            const faces = (await opts.faces.detectRgb(fa.rgb, a.width, a.height)).filter((f) => f.x1 - f.x0 >= 0.04);
            const [se, sp] = [skinHue(fa.rgb, a.width, a.height, faces), skinHue(fb.rgb, b.width, b.height, faces)];
            if (se && se.chroma > 0.04) {
              const off = Math.abs(wrap180(se.hue - SKIN_LINE));
              const before = sp ? Math.abs(wrap180(sp.hue - SKIN_LINE)) : off;
              if (off > 10)
                issues.push({
                  check: "grade",
                  severity: off > 20 && off - before > 5 ? "problem" : "warning",
                  start: tc.start,
                  end: tc.end,
                  target: id,
                  message: `Skin in clip ${id} at ${t(fa.time)} is ${Math.round(off)}° off the skin line (${Math.round(se.hue)}° against ${SKIN_LINE}°; ${Math.round(before)}° without the grade)${off - before > 5 ? ": the grade pushes it" : ", already in the footage"}. Skin looks ${wrap180(se.hue - SKIN_LINE) > 0 ? "too red or magenta" : "too yellow or green"}: adjust tint and temperature, or grade_region the face (kind face) back toward natural skin.`,
                });
            }
          } catch (e) {
            notes.push(`Skin tones were not checked: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  if (opts.checks.has("vfx")) {
    // Matte flicker: up to 24 frames in a row from the middle of each clip with a model matte (at most 4).
    const masked = spread(
      timeline.clips.flatMap((tc) => tc.clip.effects.filter((e) => e.mask && modelKinds(e.mask).length).map((e) => ({ tc, e }))),
      4,
    );
    for (const { tc, e } of masked) {
      const n = Math.max(0, Math.min(24, Math.floor(tc.duration * F) - 2));
      if (n < 6) continue;
      const first = tc.start + (tc.duration - n / F) / 2;
      const times = Array.from({ length: n }, (_, k) => round3(first + k / F));
      const view = { ...e.mask!, feather: 0, grow: 0 };
      const q: Project = { ...pictureOnly(p), effects: [], clips: p.clips.map((c) => (c.id === tc.clip.id ? { ...c, effects: [{ type: "maskView", params: { mask: view } }] } : c)) };
      try {
        const r = await render(q, times, 360);
        const share = toggleShare(r.frames.map((f) => Uint8Array.from({ length: f.rgb.length / 3 }, (_, k) => f.rgb[k * 3]!)));
        if (share > 0.02) {
          const what = e.label ? `"${e.label}"` : e.type;
          issues.push({ check: "vfx", severity: share > 0.05 ? "problem" : "warning", start: tc.start, end: tc.end, target: tc.clip.id, message: `The ${modelKinds(e.mask!).join(" and ")} matte of ${what} on clip ${tc.clip.id} flickers around ${t(first)}: ${(share * 100).toFixed(1)}% of it switches on and off between frames, which shows as a shimmering edge. Raise the mask's smooth (3 to 5), grow it a little, or select and track the object again from a clearer frame. Check with render_mask.` });
        }
      } catch (err) {
        notes.push(`The matte of ${e.label ?? e.type} on ${tc.clip.id} was not checked for flicker: ${(err as Error).message}`);
      }
    }
    opts.onProgress?.(0.6);

    // Track drift: where a track that layers and masks follow is unsure.
    const users = new Map<string, { what: string; start: number; end: number }[]>();
    const use = (track: string | undefined, what: string, start: number, end: number) => track && users.set(track, [...(users.get(track) ?? []), { what, start, end }]);
    for (const l of p.layers) use(l.track, `Layer ${l.id}`, l.start, l.start + l.duration);
    for (const tc of timeline.clips) for (const e of tc.clip.effects) if (e.mask?.kind === "shape") use(e.mask.shape?.track, `The ${e.label ? `"${e.label}" ` : ""}mask on clip ${tc.clip.id}`, tc.start, tc.end);
    for (const [id, list] of users) {
      if (!p.tracks[id]) {
        notes.push(`Track "${id}" that ${list.map((u) => u.what).join(", ")} follow no longer exists, so its drift was not checked.`);
        continue;
      }
      try {
        const sample = trackSampler(p, await trackPointsInClips(p, id, { ...opts, onProgress: undefined }));
        for (const u of list) {
          const unsure: { start: number; end: number; conf: number }[] = [];
          for (let time = u.start; time <= u.end + 1e-6; time += 0.5 / F) {
            const at = sample(time);
            if (at && at.confidence < 0.5) unsure.push({ start: time, end: time + 1 / F, conf: at.confidence });
          }
          const ranges = mergeRanges(unsure.map((x) => ({ start: x.start, end: x.end + 0.2 }))).filter((r) => r.end - r.start >= 0.2);
          if (!ranges.length) continue;
          const low = Math.min(...unsure.map((x) => x.conf));
          const where = ranges.slice(0, 3).map((r) => `${t(r.start)}-${t(r.end)}`).join(", ");
          issues.push({ check: "vfx", severity: low < 0.2 ? "problem" : "warning", start: round3(ranges[0]!.start), end: round3(ranges[ranges.length - 1]!.end), target: id, message: `${u.what} follows track "${id}", which is unsure at ${where} (confidence down to ${low.toFixed(2)}): it may drift or jump there. Check with render_frame at ${t(ranges[0]!.start)}; mark the track again on a sharper frame with more texture (track_points), or end the layer before it.` });
        }
      } catch (err) {
        notes.push(`Track "${id}" was not checked for drift: ${(err as Error).message}`);
      }
    }
    opts.onProgress?.(0.75);

    // Sky slide: the new sky against the scenery below it, over up to 3 s of each replaced sky (at most 3 clips).
    const skies = spread(timeline.clips.filter((tc) => tc.clip.effects.some((e) => e.type === "skyReplace")), 3);
    for (const tc of skies) {
      const n = Math.min(30, Math.floor(tc.duration * 10));
      if (n < 6) continue;
      const times = Array.from({ length: n }, (_, k) => round3(tc.start + 0.05 + k / 10));
      try {
        const matte: Project = { ...pictureOnly(p), effects: [], clips: p.clips.map((c) => (c.id === tc.clip.id ? { ...c, effects: [{ type: "maskView", params: { mask: { kind: "sky", feather: 0 } } }] } : c)) };
        const [pic, sky] = [await render(pictureOnly(p), times, 540), await render(matte, times, 540)];
        const [w, h] = [pic.width, pic.height];
        const gray = (f: AnalysisFrame) => Uint8Array.from({ length: w * h }, (_, k) => Math.round(0.2126 * f.rgb[k * 3]! + 0.7152 * f.rgb[k * 3 + 1]! + 0.0722 * f.rgb[k * 3 + 2]!));
        const m0 = sky.frames[0]!.rgb;
        const isSky = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m0[(y * w + x) * 3]! > 200;
        // The sky well inside its edge, and the scenery in a band just under the sky.
        const band = Math.round(h * 0.06);
        const skyRegion = new Uint8Array(w * h);
        const scenery = new Uint8Array(w * h);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (isSky(x, y) && isSky(x, y + 8) && isSky(x - 8, y) && isSky(x + 8, y)) skyRegion[y * w + x] = 1;
            else if (!isSky(x, y) && m0[(y * w + x) * 3]! < 40) for (let d = 4; d <= band; d += 4) if (isSky(x, y - d)) scenery[y * w + x] = 1;
          }
        if (skyRegion.reduce((s, v) => s + v, 0) < 0.03 * w * h || scenery.reduce((s, v) => s + v, 0) < 0.01 * w * h) continue;
        const frames = new Uint8Array(n * w * h);
        pic.frames.forEach((f, i) => frames.set(gray(f), i * w * h));
        const k = native();
        const track = (region: Uint8Array) => controlled({ signal: opts.signal }, (c) => k.trackRegion(frames, w, h, pic.frames.length, region, { model: "translation" }, c));
        const [a, b] = [await track(skyRegion), await track(scenery)];
        const last = pic.frames.length - 1;
        if (!a.inliers[last] || !b.inliers[last]) continue;
        const dx = a.matrices[last * 9 + 2]! - b.matrices[last * 9 + 2]!;
        const dy = a.matrices[last * 9 + 5]! - b.matrices[last * 9 + 5]!;
        const per5s = (Math.hypot(dx, dy) * (1080 / Math.min(w, h)) * 5) / (last / 10);
        if (per5s > 2)
          issues.push({ check: "vfx", severity: per5s > 6 ? "problem" : "warning", start: tc.start, end: tc.end, target: tc.clip.id, message: `The new sky in clip ${tc.clip.id} slides against the scenery: about ${per5s.toFixed(1)} px per 5 s at 1080p (it should move with the distant scenery). Call replace_sky again on that clip with follow 1 so it re-measures the camera's motion, unless a lower follow was meant.` });
      } catch (err) {
        notes.push(`The sky in ${tc.clip.id} was not checked for sliding: ${(err as Error).message}`);
      }
    }
  }
}
