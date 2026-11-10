import path from "node:path";
import type { Asset, BlendMode, Clip, Corners, Effect, Fit, Keyframe, MediaLayer, Position, Project } from "../../core/schema.js";
import { numberExpr, positionExpr } from "../../core/keyframes.js";
import { computeTimeline, type SpeedMap, type Timeline, type TimedClip } from "../../core/timeline.js";
import { parseColor, round3, toFfmpegColor } from "../../core/util.js";
import { effectMedia, effectObjects, effectRemovals, effectsToFilter, escapeFilterPath, maskStreams, perClipGlobalEffects, removalKey, type EffectContext } from "../../library/effects/index.js";
import { colorTableFile, convertsColor, gradeTableFile, inputTableFile, outputTableFile, sceneGradeFor } from "./color-space.js";
import type { SceneGrade } from "../../library/color/index.js";
import { buildMatte, maskNeeds } from "../../library/effects/masks.js";
import { getTransition } from "../../library/transitions/index.js";
import { atempoChain, audioEffectsToFilter } from "../../library/audio-effects/index.js";
import { overlayMotion } from "../../library/animations/index.js";
import { AssDocument, addCaptionEvents } from "../captions/ass.js";
import { buildCaptions } from "../captions/build.js";
import { addShapeLayer, addTextLayer } from "./text.js";
import { hardwareEncoderArgs, hardwareGlobalArgs, hardwareUpload, type HardwareEncoder } from "./hardware.js";
import type { FontFallback } from "../fonts/scripts.js";

export interface CompileOptions {
  /** Output file path. */
  output: string;
  /** Directory relative asset paths resolve against (default: cwd). */
  baseDir?: string;
  /** Downscale factor for fast previews, e.g. 0.5. */
  scale?: number;
  /** Directory with extra .ttf/.otf fonts for text and captions. */
  fontsDir?: string;
  /** Font families to use in place of missing ones (lowercase name to family, see prepareFonts). */
  fontMap?: Record<string, string>;
  /** Fallback fonts for scripts the text's fonts lack (see prepareFonts). */
  fontFallback?: FontFallback;
  /** Only render this time range of the timeline. */
  range?: { start: number; end: number };
  /** Encoder preset override (e.g. "ultrafast" for previews). */
  preset?: string;
  /** Extra output args placed before the output path (advanced). */
  extraOutputArgs?: string[];
  /** Produce a single image at this time instead of a video. */
  frameAt?: number;
  /** Produce a single image: a grid of frames sampled evenly across the video. */
  contactSheet?: { columns: number; rows: number; thumbWidth: number };
  /**
   * Render for measurement instead of viewing: raw RGB frames at these timeline times on stdout,
   * and/or the audio mix (plus the voice and music submixes) as WAV files. `output` is ignored.
   */
  analysis?: { framesAt?: number[]; audio?: { mix: string; voice?: string; music?: string } };
  /**
   * Cached clip pictures to use instead of reading and processing the source (clip id to file,
   * from the render cache). Setting it, even empty, applies per-frame global effects to each clip
   * rather than to the joined video, so cached and uncached clips look the same.
   */
  segments?: Record<string, string>;
  /** Compile the picture of the project's only clip for the render cache: video only, at the intermediate quality. */
  segment?: boolean;
  /**
   * Person cutout videos for clips whose effects use one (clip id to file, see PersonSegmenter.writeMask):
   * gray, upright, at the source's shape, in source time from the clip's in point.
   */
  masks?: Record<string, string>;
  /** Face mask videos (soft ellipses following each face), in the same form as `masks`. */
  faceMasks?: Record<string, string>;
  /** Tracked object mask videos (clip id to object id to file), in the same form as `masks`. */
  objectMasks?: Record<string, Record<string, string>>;
  /** Sky mask videos (255 = sky), in the same form as `masks`. */
  skyMasks?: Record<string, string>;
  /** Depth videos (16-bit gray, 0 near .. far), in the same form as `masks`. */
  depthMasks?: Record<string, string>;
  /** Object removal fills (clip id to removalKey to file; RGBA with transparency), in the same form as `masks`. */
  removals?: Record<string, Record<string, string>>;
  /**
   * Interpolated pictures of clips with `interpolate` (clip id to file, see writeInterpolated): the
   * frames the clip shows, in source order at the project frame rate, read in place of the source.
   */
  interpolated?: Record<string, string>;
  /**
   * Person cutout of the finished main picture (clips, transitions and whole-video effects, no layers),
   * in timeline time, for media layers drawn behind the subject. Without it those layers go on top.
   */
  subjectMask?: string;
  /** Sky matte of the finished main picture (255 = sky), in the same form as `subjectMask`, for media layers masked to the sky. */
  skyMatte?: string;
  /** Mattes of tracked objects in timeline time (object id to file, 255 = the object), in the same form as `subjectMask`, for media layers behind an object. */
  objectMattes?: Record<string, string>;
  /** The FFmpeg build has the rubberband filter, used for speed ramps' sound (see rampTempo). */
  rubberband?: boolean;
  /** Encode the video on the graphics card instead of with x264, at matching quality. */
  hardwareEncoder?: HardwareEncoder;
  /**
   * Compile one piece of the picture for the GPU render engine, which reads it as a source where it
   * cannot draw that piece itself (see plan.ts): raw frames on stdout, no sound and no text, the
   * filter graph in the file `script`. `clip`: the project's only clip as the primary track shows it
   * (the caller leaves out its fades and the whole-video effects), `frames` long as the edit shows it. `layer`: the media layer `layerId`
   * placed on a clear frame-size canvas as yuva420p, frames `first` to `first + frames - 1`.
   * `base`: the primary track and the project's media layers (the caller passes those the piece
   * covers), as the picture under the rest. `ss`: start the output at this time instead (previews).
   */
  /**
   * With `analysis.audio`: build the sound only. Pictures become flat frames, so ffmpeg decodes no
   * video and needs no masks or mattes (the GPU engine draws the picture and takes the sound and the
   * text file from here). The text file is still written.
   */
  audioOnly?: boolean;
  piece?: { script: string; ss?: string } & ({ kind: "clip"; frames: number } | { kind: "base"; frames: number } | { kind: "layer"; layerId: string; first: number; frames: number });
}

export interface CompiledRender {
  /** ffmpeg arguments; run with cwd = the work directory holding the files below. */
  args: string[];
  /** Files that must exist in the ffmpeg working directory. */
  files: { name: string; content: string }[];
  filterGraph: string;
  timeline: Timeline;
  /** Output duration in seconds. */
  duration: number;
  /** Rendered frame size (after preview scaling). */
  width: number;
  height: number;
  /** Analysis renders: the timeline times of the frames written to stdout, in order. */
  frameTimes?: number[];
}

export const FILTER_SCRIPT = "graph.txt";
export const ASS_FILE = "overlay.ass";

/** Cached clips: fast to write and read back, and visually lossless (SSIM 0.99 on real footage). */
/** How clips are cached: x264 at high quality, 8-bit, or High 10 for deep renders (10-bit and ProRes exports). */
export const segmentCodec = (deep = false) => ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", deep ? "yuv420p10le" : "yuv420p"];
export const SEGMENT_CODEC = segmentCodec();

/** Exports that keep more than 8 bits: the FFmpeg backend then runs its picture path deep (10-bit YUV, 16-bit mattes and RGB). */
export const isDeepExport = (exp: { bitDepth?: 8 | 10; videoCodec: string }) => exp.bitDepth === 10 || isProRes(exp.videoCodec);
/** ProRes 422 HQ (prores_ks profile 3, 10-bit 4:2:2), for editing and grading elsewhere. */
export const isProRes = (codec: string) => /^prores/.test(codec);

const AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
/** Seconds of crossfade where a J or L cut hands the sound from one clip to the other (no click). */
const SPLIT_FADE = 0.03;

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * FFmpeg blend modes for each layer blend. The picture under the layer is blend's first input, so
 * modes that depend on order (overlay, colordodge) follow the usual definitions with it as the backdrop.
 */
/**
 * Blends in linear light: both values (x the picture, y the layer; M the largest, 255 or 1023 in deep renders) through display gamma 2.4
 * to linear, added or screened there, and back, as one lut2 table per channel (rounded: lut2
 * truncates). A black layer gives x back exactly. Light adds as light does, so glows and flares
 * brighten midtones less than plain add and screen. The engine computes the same (layer.wgsl).
 */
const LIGHT_BLENDS = {
  addlight: "M*pow(min(1,pow(x/M,2.4)+pow(y/M,2.4)),1/2.4)+0.5",
  screenlight: "M*pow(1-(1-pow(x/M,2.4))*(1-pow(y/M,2.4)),1/2.4)+0.5",
} as const;

const BLEND_MODES: Record<Exclude<BlendMode, "normal" | keyof typeof LIGHT_BLENDS>, string> = {
  screen: "screen",
  add: "addition",
  multiply: "multiply",
  overlay: "overlay",
  softlight: "softlight",
  lighten: "lighten",
  darken: "darken",
  colordodge: "dodge",
  difference: "difference",
};

/**
 * A speed ramp as a setpts expression of the input time T (source seconds from the in point): the
 * clip's time map in straight pieces, every 0.1 s of source (at most 150 pieces).
 */
export function rampPts(map: SpeedMap, sourceDuration: number): string {
  const n = Math.min(150, Math.max(8, Math.ceil(sourceDuration / 0.1)));
  const u = (i: number) => (sourceDuration * i) / n;
  const piece = (i: number) => {
    const slope = (map.toTimeline(u(i + 1)) - map.toTimeline(u(i))) / (u(i + 1) - u(i));
    return `${round3(map.toTimeline(u(i)))}+(T-${round3(u(i))})*${Math.round(slope * 1e5) / 1e5}`;
  };
  let expr = piece(n - 1);
  for (let i = n - 2; i >= 0; i--) expr = `if(lt(T,${round3(u(i + 1))}),${piece(i)},${expr})`;
  return expr;
}

/**
 * Commands that change the tempo along a speed ramp (asendcmd file, source time), every 0.1 s.
 * rubberband follows changing tempos closely; atempo loses a few milliseconds at each change (a
 * ramp comes out about 2% short), and below 0.5x two of them share the change, each taking the square root.
 */
function rampTempo(map: SpeedMap, sourceDuration: number, name: string, rubberband: boolean): { filters: string[]; commands: string } {
  if (rubberband) {
    const lines: string[] = [];
    for (let u = 0; u < sourceDuration; u = round3(u + 0.1)) lines.push(`${u} [enter] rubberband@${name} tempo ${round3(map.speedAt(u + 0.05))};`);
    return { filters: [`rubberband@${name}=tempo=${round3(map.speedAt(0.05))}`], commands: lines.join("\n") };
  }
  const twice = map.speedAt(0) < 0.5 || Array.from({ length: 41 }, (_, i) => map.speedAt((sourceDuration * i) / 40)).some((v) => v < 0.5);
  const tempo = (v: number) => round3(twice ? Math.sqrt(v) : v);
  const targets = twice ? [`atempo@${name}a`, `atempo@${name}b`] : [`atempo@${name}a`];
  const lines: string[] = [];
  for (let u = 0; u < sourceDuration; u = round3(u + 0.1)) lines.push(`${u} [enter] ${targets.map((t) => `${t} tempo ${tempo(map.speedAt(u + 0.05))}`).join(", ")};`);
  return { filters: targets.map((t) => `${t}=tempo=${tempo(map.speedAt(0.05))}`), commands: lines.join("\n") };
}
/**
 * A gradient asset as a lavfi source: one frame drawn with geq, the colors evenly spaced along the
 * direction and blended in a straight line between neighbors, then repeated. (FFmpeg's own gradients
 * source starts at a random angle on every run, so the same edit rendered differently each time.)
 */
export function gradientSource(asset: { colors: string[]; direction: "vertical" | "horizontal" | "diagonal" }, W: number, H: number, F: number): string {
  const [dx, dy] = asset.direction === "horizontal" ? [W, 0] : asset.direction === "diagonal" ? [W, H] : [0, H];
  const n = asset.colors.length;
  const cs = asset.colors.map(parseColor);
  // Position along the direction, 0..n-1, kept in variable 0.
  const at = `st(0,clip((X*${dx}+Y*${dy})/${dx * dx + dy * dy},0,1)*${n - 1})`;
  const channel = (pick: (c: (typeof cs)[number]) => number) => {
    let e = String(round3(pick(cs[n - 1]!)));
    for (let i = n - 2; i >= 0; i--) {
      const [a, b] = [pick(cs[i]!), pick(cs[i + 1]!)];
      e = `if(lt(ld(0),${i + 1}),${round3(a)}+${round3(b - a)}*(ld(0)-${i}),${e})`;
    }
    return `'${at};${e}'`;
  };
  const geq = `geq=r=${channel((c) => c.r)}:g=${channel((c) => c.g)}:b=${channel((c) => c.b)}:a=${channel((c) => c.a * 255)}`;
  return `nullsrc=s=${W}x${H}:r=${F},trim=end_frame=1,format=gbrap,${geq},loop=loop=-1:size=1`;
}

const previewScale = (scale?: number) => (scale && scale > 0 && scale !== 1 ? scale : 1);


/** FFmpeg's colorspace filter changing only the YUV matrix (limited range out), exact to a level where swscale's own matrix change is not. */
const matrixFilter = (from: string, to: string) => `colorspace=ispace=${from}:space=${to}:fast=1:range=tv:iprimaries=bt709:primaries=bt709:itrc=bt709:trc=bt709`;

/**
 * Renders work on BT.601 YUV: FFmpeg converts between YUV and RGB with it wherever a filter needs
 * RGB, and the engine does the same. Footage stored with another matrix (BT.709 for HD, BT.2020)
 * is brought to it as it is read, with this filter, so every RGB step sees the colors as recorded;
 * undefined for footage that needs nothing.
 */
export function workingMatrix(asset: Asset): string | undefined {
  if (asset.type !== "video" || !asset.colorMatrix || asset.colorMatrix === "bt601") return undefined;
  return matrixFilter(asset.colorMatrix === "bt2020" ? "bt2020ncl" : "bt709", "smpte170m");
}

/** The finished picture from the working BT.601 to BT.709, which the file is tagged with (OUTPUT_COLOR_TAGS) and players expect of it. */
export const OUTPUT_MATRIX = matrixFilter("smpte170m", "bt709");
export const OUTPUT_COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/**
 * Filters that convert a source in a color space (camera log, HDR) to the edit's Rec.709: its
 * frames read as BT.601 limited range, as the engine reads them, then its .cube table on float RGB.
 * Empty for ordinary video. `alpha` keeps a layer's transparency.
 */
export function colorConversion(asset: Asset, alpha = false, grade?: SceneGrade): string[] {
  if (!convertsColor(asset)) return [];
  const lut = (file: string) => `lut3d=file='${escapeFilterPath(path.resolve(file))}':interp=tetrahedral`;
  // Graded in ACEScct: camera half, the grade, then the output half; otherwise the whole transform at once.
  const tables = grade ? [lut(inputTableFile(asset.colorSpace)), lut(gradeTableFile(grade)), lut(outputTableFile())] : [lut(colorTableFile(asset.colorSpace))];
  return ["setparams=colorspace=smpte170m:range=tv", `format=${alpha ? "gbrapf32le" : "gbrpf32le"}`, ...tables];
}
/** Frame size of a render at a preview scale (even numbers, as the encoder needs). */
export function renderSize(project: Project, scale?: number): { width: number; height: number } {
  const k = previewScale(scale);
  return { width: even(project.settings.width * k), height: even(project.settings.height * k) };
}

class GraphBuilder {
  readonly inputArgs: string[] = [];
  readonly lines: string[] = [];
  private inputCount = 0;
  private labelCount = 0;

  addInput(args: string[]): number {
    this.inputArgs.push(...args);
    return this.inputCount++;
  }

  label(prefix: string): string {
    return `${prefix}${this.labelCount++}`;
  }

  add(line: string): void {
    this.lines.push(line);
  }
}

/** Clear pixels around a corner-pinned layer, so the edges perspective repeats outward stay clear. */
const PIN_PAD = 4;

/** The 3x3 transform (row major) taking the corners of a `w` x `h` rectangle to `q` (top-left, top-right, bottom-right, bottom-left, pixels). */
export function rectToQuad(w: number, h: number, q: [number, number][]): number[] {
  // The unit square to the quad (Heckbert's closed form), then scaled from the rectangle.
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q as [[number, number], [number, number], [number, number], [number, number]];
  const [sx, sy] = [x0 - x1 + x2 - x3, y0 - y1 + y2 - y3];
  let [g, h2] = [0, 0];
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const [dx1, dx2, dy1, dy2] = [x1 - x2, x3 - x2, y1 - y2, y3 - y2];
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h2 = (dx1 * sy - sx * dy1) / den;
  }
  const [a, b, d, e] = [x1 - x0 + g * x1, x3 - x0 + h2 * x3, y1 - y0 + g * y1, y3 - y0 + h2 * y3];
  return [a / w, b / h, x0, d / w, e / h, y0, g / w, h2 / h, 1];
}

/** A corner pin's corners (frame fractions of a `w` x `h` frame) moved outward by `pad` pixels through the same perspective, in pixels. */
export function padCorners(c: Corners, w: number, h: number, pad: number): [number, number][] {
  const m = rectToQuad(w, h, [c.tl, c.tr, c.br, c.bl].map((p): [number, number] => [p.x * w, p.y * h]));
  const at = (x: number, y: number): [number, number] => {
    const z = m[6]! * x + m[7]! * y + m[8]!;
    return [(m[0]! * x + m[1]! * y + m[2]!) / z, (m[3]! * x + m[4]! * y + m[5]!) / z];
  };
  return [at(-pad, -pad), at(w + pad, -pad), at(w + pad, h + pad), at(-pad, h + pad)];
}

/** Compile a project into ffmpeg arguments plus support files. Pure: does not touch the filesystem. */
export function compileProject(project: Project, opts: CompileOptions): CompiledRender {
  const timeline = computeTimeline(project);
  const { fps: F } = project.settings;
  // Previews render the whole graph at reduced size. Text keeps the full-size coordinate
  // space (ASS PlayRes) and libass scales it, so layout is identical to the final render.
  const k = previewScale(opts.scale);
  const { width: W, height: H } = renderSize(project, opts.scale);
  const bg = toFfmpegColor(project.settings.backgroundColor);
  const g = new GraphBuilder();
  // Support files written next to the graph (subtitles, speed-ramp commands).
  const files: CompiledRender["files"] = [];
  const baseDir = opts.baseDir ?? process.cwd();
  const resolveSrc = (src: string) => (/^[a-z]+:\/\//i.test(src) ? src : path.resolve(baseDir, src));
  const total = timeline.duration;
  if (total <= 0) throw new Error("Project is empty: add clips, layers or audio before rendering");
  // With the render cache, per-frame global effects run on each clip so they can be baked into cached clips.
  const perClip = opts.segments || opts.segment ? perClipGlobalEffects(project.effects) : [];
  const joinedEffects = project.effects.slice(perClip.length);

  const sourceInput = (asset: Asset, seek: number, duration: number, loop = false): number => {
    switch (asset.type) {
      case "video":
      case "audio":
        return g.addInput([
          ...(loop ? ["-stream_loop", "-1"] : []),
          ...(seek > 0 ? ["-ss", String(round3(seek))] : []),
          "-t",
          String(round3(duration)),
          "-i",
          resolveSrc(asset.src),
        ]);
      case "image":
        return g.addInput(["-loop", "1", "-framerate", String(F), "-t", String(round3(duration)), "-i", resolveSrc(asset.src)]);
      case "color":
        return g.addInput(["-f", "lavfi", "-t", String(round3(duration)), "-i", `color=c=${toFfmpegColor(asset.color)}:s=${W}x${H}:r=${F}`]);
      case "gradient":
        return g.addInput(["-f", "lavfi", "-t", String(round3(duration)), "-i", gradientSource(asset, W, H, F)]);
    }
  };

  /** Scale/crop/pad to w×h. Returns label of the fitted stream. */
  const fit = (input: string, fitMode: Fit, w: number, h: number, alpha: boolean, focus?: { x: number; y: number }, focusKeys?: Keyframe<Position>[]): string => {
    const out = g.label("fit");
    const padColor = alpha ? "black@0" : bg;
    switch (fitMode) {
      case "cover":
        {
          // Keep the focus point in frame when the crop has to drop part of the source.
          const fx = round3(Math.min(1, Math.max(0, focus?.x ?? 0.5)));
          const fy = round3(Math.min(1, Math.max(0, focus?.y ?? 0.5)));
          // Focus keyframes move the crop over time (t is seconds from the clip's start here).
          const moving = focusKeys?.length ? positionExpr(focusKeys, "t") : undefined;
          const pos = moving
            ? `:'(iw-ow)*clip(${moving.x},0,1)':'(ih-oh)*clip(${moving.y},0,1)'`
            : focus
              ? `:(iw-ow)*${fx}:(ih-oh)*${fy}`
              : "";
          g.add(`[${input}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${pos},setsar=1[${out}]`);
        }
        break;
      case "stretch":
        g.add(`[${input}]scale=${w}:${h},setsar=1[${out}]`);
        break;
      case "contain":
        g.add(
          `[${input}]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1[${out}]`,
        );
        break;
      case "blur": {
        const a = g.label("bga");
        const b = g.label("bgb");
        const back = g.label("back");
        const front = g.label("front");
        g.add(`[${input}]split=2[${a}][${b}]`);
        g.add(`[${a}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=40,eq=brightness=-0.08[${back}]`);
        g.add(`[${b}]scale=${w}:${h}:force_original_aspect_ratio=decrease[${front}]`);
        g.add(`[${back}][${front}]overlay=(W-w)/2:(H-h)/2,setsar=1[${out}]`);
        break;
      }
    }
    return out;
  };

  // Deep renders (10-bit and ProRes exports): 10-bit YUV between stages, 10-bit RGB for layer blends.
  const deep = !opts.piece && opts.frameAt === undefined && !opts.analysis && !opts.contactSheet && isDeepExport(project.export);
  const [Y, YA, GBR, GBRA] = deep ? ["yuv420p10le", "yuva420p10le", "gbrp10le", "gbrap10le"] : ["yuv420p", "yuva420p", "gbrp", "gbrap"];
  const effectCtx = (duration: number, w = W, h = H, alpha = false): EffectContext => ({
    width: w,
    height: h,
    fps: F,
    duration,
    alpha,
    deep,
    label: (p) => g.label(p),
  });
  const chain = (filters: (string | false | 0 | undefined)[]) => filters.filter(Boolean).join(",");

  // -------------------------------------------------------------------------
  // Primary track
  // -------------------------------------------------------------------------
  const clipStream = (tc: TimedClip): { v: string; a: string } => {
    const { clip, asset } = tc;
    const hasAudio = asset.type === "video" && asset.hasAudio !== false && !clip.muted && clip.volume > 0;
    const cached = opts.segments?.[clip.id];
    // A cached clip brings its finished picture, so the source is only read for its sound.
    const k = cached && !hasAudio ? -1 : sourceInput(asset, clip.in, asset.type === "video" ? tc.sourceDuration : tc.duration);
    const v = g.label("v");
    // Give the clip exactly the frames whose times fall inside it on the timeline. The fps filter
    // alone rounds each clip up (a 2.3 s clip of 23.976 fps footage gave 70 frames, not 69), and
    // filters such as blend can drop a last frame, so cuts drifted from captions and overlays.
    // A cache entry keeps its natural frames, so it stays valid wherever the clip moves.
    const frames = opts.piece?.kind === "clip" ? opts.piece.frames : Math.max(1, Math.ceil(tc.end * F - 1e-6) - Math.ceil(tc.start * F - 1e-6));
    const exact = opts.segment ? [] : ["tpad=stop_mode=clone:stop=-1", `trim=end_frame=${frames}`];
    // concat outputs AV_TIME_BASE; keep every segment on it so xfade inputs always match.
    const finish = [`fps=${F}`, `format=${Y}`, "setsar=1", ...exact, "settb=AVTB"];
    if (opts.audioOnly) {
      g.add(`color=c=black:s=${W}x${H}:r=${F}:d=${round3(tc.duration)},${chain(finish)}[${v}]`);
    } else if (cached) {
      g.add(`[${g.addInput(["-i", cached])}:v]${chain(["setpts=PTS-STARTPTS", ...finish])}[${v}]`);
    } else {
      const raw = g.label("raw");
      const speed = asset.type === "video" ? clip.speed : 1;
      // A speed ramp maps each frame's source time through the clip's time map.
      const retime = tc.speedMap ? `setpts='(${rampPts(tc.speedMap, tc.sourceDuration)})/TB'` : speed !== 1 && `setpts=PTS/${speed}`;
      const timing = (input: string) => `[${input}]${chain([clip.reverse && "reverse", "setpts=PTS-STARTPTS", retime, `fps=${F}`])}`;
      const working = workingMatrix(asset);
      // Smooth motion: the prepared frames are the clip's retimed picture already (in source order, so a reversed clip turns them round).
      const smooth = opts.interpolated?.[clip.id];
      // Camera log and HDR become Rec.709 first (the smooth frames are still in the camera's colors).
      const graded = sceneGradeFor(asset, clip.effects);
      const convert = colorConversion(asset, false, graded.grade);
      const converted = convert.length ? `,${convert.join(",")}` : "";
      if (smooth) g.add(`[${g.addInput(["-i", smooth])}:v]${chain([clip.reverse && "reverse", "setpts=PTS-STARTPTS", `fps=${F}`, ...convert])}[${raw}]`);
      else g.add(`${timing(`${k}:v`)}${working ? `,${working}` : ""}${converted}[${raw}]`);
      const fitted = fit(raw, clip.fit, W, H, false, clip.focus, clip.keyframes?.focus);
      // Person cutouts and face masks go through the same timing and fit as the picture, so they line up.
      // A ramped effect runs once per state, and each run (and the effect's mask) takes its own copy.
      const modelMasks = (count: number, file: string | undefined, format = "gray"): string[] => {
        if (!count || !file) return [];
        const mraw = g.label("mraw");
        const input = `${g.addInput(["-i", file])}:v`;
        // A photo's depth or removal is a single frame, held for the clip.
        if (asset.type === "image") g.add(`[${input}]setpts=PTS-STARTPTS,fps=${F},tpad=stop_mode=clone:stop=-1,trim=duration=${round3(tc.duration)},format=${format}[${mraw}]`);
        else g.add(`${timing(input)},format=${format}[${mraw}]`);
        const mfit = fit(mraw, clip.fit, W, H, true, clip.focus, clip.keyframes?.focus);
        const labels = Array.from({ length: count }, () => g.label("mask"));
        g.add(`[${mfit}]format=${format}${count > 1 ? `,split=${count}` : ""}${labels.map((l) => `[${l}]`).join("")}`);
        return labels;
      };
      const streams = (kind: "person" | "face" | "sky" | "depth") => clip.effects.reduce((n, e) => n + maskStreams(e, kind), 0);
      const personLabels = modelMasks(streams("person"), opts.masks?.[clip.id]);
      const faceLabels = modelMasks(streams("face"), opts.faceMasks?.[clip.id]);
      const skyLabels = modelMasks(streams("sky"), opts.skyMasks?.[clip.id]);
      const depthLabels = modelMasks(streams("depth"), opts.depthMasks?.[clip.id]);
      // Pictures effects read (a new sky): one input per use, held or looped over the clip.
      const mediaLabels = new Map<string, string[]>();
      for (const id of clip.effects.flatMap(effectMedia)) {
        const media = project.assets.find((a) => a.id === id);
        if (!media || media.type === "audio") throw new Error(`Clip "${clip.id}" has an effect that shows "${id}", which is not a picture asset`);
        const l = g.label("media");
        g.add(`[${sourceInput(media, 0, tc.duration, media.type === "video")}:v]${chain(["setpts=PTS-STARTPTS", `fps=${F}`, workingMatrix(media), `format=${Y}`])}[${l}]`);
        mediaLabels.set(id, [...(mediaLabels.get(id) ?? []), l]);
      }
      // Tracked objects: one stream per effect that uses each.
      const objectLabels = new Map<string, string[]>();
      for (const id of new Set(clip.effects.flatMap(effectObjects))) {
        const labels = modelMasks(clip.effects.filter((e) => effectObjects(e).includes(id)).length, opts.objectMasks?.[clip.id]?.[id]);
        if (labels.length) objectLabels.set(id, labels);
      }
      // Object removal fills, with their transparency: one stream per use of each.
      const removalLabels = new Map<string, string[]>();
      const removalUses = clip.effects.flatMap(effectRemovals).map(removalKey);
      for (const key of new Set(removalUses)) {
        const labels = modelMasks(removalUses.filter((k) => k === key).length, opts.removals?.[clip.id]?.[key], YA);
        if (labels.length) removalLabels.set(key, labels);
      }
      const clipEffects = effectsToFilter(graded.effects, {
        ...effectCtx(tc.duration),
        ...(personLabels.length ? { personMask: () => personLabels.shift() } : {}),
        ...(faceLabels.length ? { faceMask: () => faceLabels.shift() } : {}),
        ...(objectLabels.size ? { objectMask: (id: string) => objectLabels.get(id)?.shift() } : {}),
        ...(skyLabels.length ? { skyMask: () => skyLabels.shift() } : {}),
        ...(depthLabels.length ? { depthMask: () => depthLabels.shift() } : {}),
        ...(mediaLabels.size ? { media: (id: string) => mediaLabels.get(id)?.shift() } : {}),
        ...(removalLabels.size ? { removal: (key: string) => removalLabels.get(key)?.shift() } : {}),
      });
      // Any mask or picture an effect did not take still has to be consumed.
      for (const l of [...personLabels, ...faceLabels, ...skyLabels, ...depthLabels, ...[...objectLabels.values(), ...mediaLabels.values(), ...removalLabels.values()].flat()]) g.add(`[${l}]nullsink`);
      g.add(
        `[${fitted}]${chain([
          ...clipEffects,
          clip.fadeIn && `fade=t=in:st=0:d=${clip.fadeIn}`,
          clip.fadeOut && `fade=t=out:st=${round3(Math.max(0, tc.duration - clip.fadeOut))}:d=${clip.fadeOut}`,
          ...effectsToFilter(perClip, effectCtx(tc.duration)),
          ...finish,
        ])}[${v}]`,
      );
    }
    const a = g.label("a");
    // J and L cuts: a neighbor's sound plays over this clip's head or tail, so this one is silent there.
    const muteHead = timeline.clips[tc.index - 1]?.audioTail ?? 0;
    const muteTail = timeline.clips[tc.index + 1]?.audioLead ?? 0;
    if (hasAudio) {
      // Speed ramps change the tempo as they go (pitch kept), driven by a command file.
      let tempo = atempoChain(clip.speed);
      if (tc.speedMap) {
        const ramp = rampTempo(tc.speedMap, tc.sourceDuration, `ramp${tc.index}`, !!opts.rubberband);
        const file = `ramp${tc.index}.cmd`;
        files.push({ name: file, content: ramp.commands });
        tempo = [`asendcmd=f=${file}`, ...ramp.filters];
      }
      g.add(
        `[${k}:a]${chain([
          clip.reverse && "areverse",
          "asetpts=PTS-STARTPTS",
          ...tempo,
          ...audioEffectsToFilter(clip.audioEffects),
          clip.volume !== 1 && `volume=${clip.volume}`,
          clip.fadeIn && `afade=t=in:st=0:d=${clip.fadeIn}`,
          clip.fadeOut && `afade=t=out:st=${round3(Math.max(0, tc.duration - clip.fadeOut))}:d=${clip.fadeOut}`,
          muteHead && `afade=t=in:st=${round3(muteHead)}:d=${SPLIT_FADE}`,
          muteTail && `afade=t=out:st=${round3(Math.max(0, tc.duration - muteTail - SPLIT_FADE))}:d=${SPLIT_FADE}`,
          AUDIO_FMT,
          "apad",
          `atrim=duration=${tc.duration}`,
          "asetpts=PTS-STARTPTS",
        ])}[${a}]`,
      );
    } else {
      g.add(`anullsrc=r=48000:cl=stereo,atrim=duration=${tc.duration},${AUDIO_FMT}[${a}]`);
    }
    return { v, a };
  };

  let vCur: string;
  let aCur: string;
  if (timeline.clips.length > 0) {
    const first = clipStream(timeline.clips[0]!);
    vCur = first.v;
    aCur = first.a;
    let curDur = timeline.clips[0]!.duration;
    for (const tc of timeline.clips.slice(1)) {
      const next = clipStream(tc);
      const vo = g.label("vx");
      const ao = g.label("ax");
      if (tc.transitionDuration > 0) {
        const def = getTransition(tc.clip.transition!.type);
        const d = tc.transitionDuration;
        const kind = def?.custom
          ? `custom:expr='${def.custom(tc.clip.transition!.origin ?? { x: 0.5, y: 0.5 }, W / H)}'`
          : (def?.xfade ?? "fade");
        g.add(`[${vCur}][${next.v}]xfade=transition=${kind}:duration=${d}:offset=${round3(curDur - d)}[${vo}]`);
        g.add(`[${aCur}][${next.a}]acrossfade=d=${d}:c1=tri:c2=tri[${ao}]`);
        curDur = round3(curDur + tc.duration - d);
      } else {
        g.add(`[${vCur}][${aCur}][${next.v}][${next.a}]concat=n=2:v=1:a=1[${vo}][${ao}]`);
        curDur = round3(curDur + tc.duration);
      }
      vCur = vo;
      aCur = ao;
    }
  } else {
    vCur = g.label("base");
    aCur = g.label("abase");
    g.add(`color=c=${bg}:s=${W}x${H}:r=${F}:d=${total},format=${Y},setsar=1[${vCur}]`);
    g.add(`anullsrc=r=48000:cl=stereo,atrim=duration=${total},${AUDIO_FMT}[${aCur}]`);
  }

  // J and L cuts: the extra sound from just before (lead) or after (tail) each clip's source range.
  const splitAudio: string[] = [];
  if (!opts.segment) {
    for (const tc of timeline.clips) {
      const { clip, asset } = tc;
      const parts = [
        tc.audioLead && { from: clip.in - tc.audioLead * clip.speed, seconds: tc.audioLead, at: tc.start - tc.audioLead, fade: `afade=t=in:st=0:d=${SPLIT_FADE}` },
        tc.audioTail && { from: clip.in + tc.sourceDuration, seconds: tc.audioTail, at: tc.end, fade: `afade=t=out:st=${round3(Math.max(0, tc.audioTail - SPLIT_FADE))}:d=${SPLIT_FADE}` },
      ];
      for (const part of parts) {
        if (!part) continue;
        const k = sourceInput(asset, round3(Math.max(0, part.from)), round3(part.seconds * clip.speed));
        const out = g.label("split");
        const ms = Math.round(part.at * 1000);
        g.add(
          `[${k}:a]${chain([
            "asetpts=PTS-STARTPTS",
            ...atempoChain(clip.speed),
            ...audioEffectsToFilter(clip.audioEffects),
            clip.volume !== 1 && `volume=${clip.volume}`,
            AUDIO_FMT,
            `atrim=duration=${round3(part.seconds)}`,
            part.fade,
            `adelay=${ms}|${ms}`,
          ])}[${out}]`,
        );
        splitAudio.push(out);
      }
    }
  }

  if (joinedEffects.length && !opts.segment && !opts.audioOnly) {
    const out = g.label("graded");
    g.add(`[${vCur}]${chain(effectsToFilter(joinedEffects, effectCtx(timeline.primaryDuration || total)))}[${out}]`);
    vCur = out;
  }

  // -------------------------------------------------------------------------
  // Media overlays
  // -------------------------------------------------------------------------
  const overlayAudio: string[] = [];
  // Layers behind the subject: after each one, the picture from just before it comes back where the
  // people are, so they stay in front of it (and of nothing else that was not already there).
  const behind = opts.subjectMask && !opts.segment ? project.layers.filter((l) => l.type === "media" && l.behindSubject).map((l) => l.id) : [];
  const subjectLabels = new Map(behind.map((id) => [id, g.label("subj")]));
  const maskedLayers = opts.segment || opts.audioOnly ? [] : project.layers.filter((l): l is MediaLayer => l.type === "media" && !!l.mask);
  // Mattes of the finished picture (person, sky): one copy per layer mask that uses each, and the
  // person cutout for each layer behind the subject.
  const finished = (file: string | undefined, kind: "person" | "sky", grown: string[] = []) => {
    const users = maskedLayers.filter((l) => maskNeeds(l.mask, kind)).length;
    const copies = Array.from({ length: users + grown.length }, () => g.label(kind === "sky" ? "skym" : "subm"));
    if (!copies.length) return [];
    if (!file) throw new Error(`A layer mask of kind ${kind} needs the ${kind} matte of the finished picture, which the renderer makes; render with render() or renderFrame()`);
    g.add(
      `[${g.addInput(["-i", file])}:v]setpts=PTS-STARTPTS,fps=${F},format=gray,scale=${W}:${H},tpad=stop_mode=clone:stop=-1,trim=duration=${round3(total)}` +
        `${copies.length > 1 ? `,split=${copies.length}` : ""}${copies.map((c) => `[${c}]`).join("")}`,
    );
    // A little grown and softened behind the subject: the model's outline runs tight on hands and hair.
    grown.forEach((label, i) => g.add(`[${copies[users + i]}]dilation,dilation,gblur=sigma=${round3(2 * k)}[${label}]`));
    return copies.slice(0, users);
  };
  const personCopies = finished(opts.subjectMask, "person", behind.map((id) => subjectLabels.get(id)!));
  const skyCopies = finished(opts.skyMatte, "sky");
  // Layers behind a tracked object: the same, with the object's matte in place of the person's.
  if (!opts.segment && !opts.audioOnly)
    for (const layer of project.layers) {
      if (layer.type !== "media" || !layer.behindObject) continue;
      const file = opts.objectMattes?.[layer.behindObject];
      if (!file) throw new Error(`Layer "${layer.id}" is behind object "${layer.behindObject}", whose matte the renderer makes; render with render() or renderFrame()`);
      const label = g.label("objm");
      g.add(`[${g.addInput(["-i", file])}:v]setpts=PTS-STARTPTS,fps=${F},format=gray,scale=${W}:${H},tpad=stop_mode=clone:stop=-1,trim=duration=${round3(total)},gblur=sigma=${round3(Math.max(0.5, k))}[${label}]`);
      if (subjectLabels.has(layer.id)) g.add(`[${subjectLabels.get(layer.id)}]nullsink`);
      subjectLabels.set(layer.id, label);
    }
  // A layer piece for the engine: the layer placed on a clear canvas, as the blend path places it.
  let layerPiece: string | undefined;
  const pieceLayer = opts.piece?.kind === "layer" ? opts.piece : undefined;
  project.layers.forEach((layer) => {
    if (layer.type !== "media") return;
    if (opts.audioOnly) {
      // Only the layer's sound.
      const asset = project.assets.find((a) => a.id === layer.assetId);
      if (asset?.type === "video" && asset.hasAudio !== false && layer.volume > 0) overlayAudio.push(layerAudio(layer, sourceInput(asset, layer.in, layer.duration)));
      return;
    }
    if (pieceLayer) {
      if (layer.id !== pieceLayer.layerId) return;
      const asset = project.assets.find((a) => a.id === layer.assetId);
      if (!asset) throw new Error(`Layer "${layer.id}" references unknown asset "${layer.assetId}"`);
      const { v } = mediaLayerStream(layer, asset);
      const end = round3(layer.start + layer.duration);
      const keys = layer.keyframes?.position;
      const moving = keys?.length ? positionExpr(keys, `(t-${layer.start})`) : undefined;
      const motion = layer.keyframes?.corners?.length
        ? { x: String(-PIN_PAD), y: String(-PIN_PAD) }
        : overlayMotion(`main_w*${moving ? `(${moving.x})` : layer.position.x}-overlay_w/2`, `main_h*${moving ? `(${moving.y})` : layer.position.y}-overlay_h/2`, layer.start, end, layer.animationIn, layer.animationOut);
      const [canvas, out] = [g.label("pcv"), g.label("pcl")];
      // On AV_TIME_BASE, as the primary picture the backend overlays layers on, so `enable` sees the same times.
      g.add(`color=c=black@0:s=${W}x${H}:r=${F}:d=${total},format=yuva420p,settb=AVTB[${canvas}]`);
      g.add(
        `[${canvas}][${v}]overlay=x='${motion.x}':y='${motion.y}':enable='between(t,${layer.start},${end})':eof_action=pass:format=auto,` +
          `trim=start_frame=${pieceLayer.first}:end_frame=${pieceLayer.first + pieceLayer.frames},setpts=PTS-STARTPTS,format=yuva420p[${out}]`,
      );
      layerPiece = out;
      return;
    }
    const subject = subjectLabels.get(layer.id);
    const keep = subject && g.label("lsk");
    if (keep) {
      const below = g.label("lsb");
      g.add(`[${vCur}]split=2[${below}][${keep}]`);
      vCur = below;
    }
    const asset = project.assets.find((a) => a.id === layer.assetId);
    if (!asset) throw new Error(`Layer "${layer.id}" references unknown asset "${layer.assetId}"`);
    const { v, a } = mediaLayerStream(layer, asset);
    const out = g.label("ov");
    const end = round3(layer.start + layer.duration);
    // Position keyframes count from the layer's start; overlay's t is timeline time.
    const keys = layer.keyframes?.position;
    const moving = keys?.length ? positionExpr(keys, `(t-${layer.start})`) : undefined;
    // A corner-pinned layer is already drawn in place on a padded frame-size canvas.
    const motion = layer.keyframes?.corners?.length
      ? { x: String(-PIN_PAD), y: String(-PIN_PAD) }
      : overlayMotion(
          `main_w*${moving ? `(${moving.x})` : layer.position.x}-overlay_w/2`,
          `main_h*${moving ? `(${moving.y})` : layer.position.y}-overlay_h/2`,
          layer.start,
          end,
          layer.animationIn,
          layer.animationOut,
        );
    const enable = `enable='between(t,${layer.start},${end})'`;
    if (layer.blend === "normal" && !layer.mask) {
      g.add(`[${vCur}][${v}]overlay=x='${motion.x}':y='${motion.y}':${enable}:eof_action=pass[${out}]`);
    } else {
      // blend ignores alpha and position: place the layer on a clear frame-size canvas, blend the
      // whole frame in RGB, then show the result only through the layer's alpha (opacity and fades
      // included) times its mask.
      const mixing = layer.blend !== "normal";
      const matte = layer.mask
        ? buildMatte({ width: W, height: H, fps: F, duration: total, label: (p) => g.label(p), personMask: () => personCopies.shift(), skyMask: () => skyCopies.shift() }, layer.mask)
        : undefined;
      const [base, under, canvas, placed, color, alpha, top, mixed, cut] = ["lbb", "lbu", "lbc", "lbp", "lbr", "lba", "lbt", "lbm", "lbx"].map((p) => g.label(p));
      const copies = [base, ...(mixing ? [under] : []), ...(matte?.picture ?? [])];
      g.add(`[${vCur}]split=${copies.length}${copies.map((c) => `[${c}]`).join("")}`);
      // Deep renders place the layer in RGB: FFmpeg 6.1's overlay darkens a translucent layer on a
      // clear 10-bit YUV canvas (about a quarter), and is right in RGB (8-bit there; the picture under stays 10-bit).
      g.add(`color=c=black@0:s=${W}x${H}:r=${F}:d=${total},format=${deep ? GBRA : YA}[${canvas}]`);
      g.add(`[${canvas}][${v}]overlay=x='${motion.x}':y='${motion.y}':${enable}:eof_action=pass:format=${deep ? "gbrp" : "auto"},format=${GBRA},split=2[${placed}][${alpha}]`);
      if (layer.blend !== "normal") {
        g.add(`[${placed}]format=${GBR}[${color}]`);
        // Nearest-neighbor chroma both ways makes the round trip exact, so a black screen layer changes nothing.
        g.add(`[${under}]scale=flags=neighbor,format=${GBR}[${top}]`);
        const light = LIGHT_BLENDS[layer.blend as keyof typeof LIGHT_BLENDS]?.replace(/M/g, deep ? "1023" : "255");
        const mix = light ? `lut2=c0='${light}':c1='${light}':c2='${light}'` : `blend=all_mode=${BLEND_MODES[layer.blend as keyof typeof BLEND_MODES]}`;
        g.add(`[${top}][${color}]${mix}:${enable},scale=flags=neighbor,format=${Y}[${mixed}]`);
      } else {
        g.add(`[${placed}]format=${Y}[${mixed}]`);
      }
      g.add(`[${alpha}]alphaextract[${cut}]`);
      let through = cut;
      if (matte) {
        for (const line of matte.lines) g.add(line);
        through = g.label("lbk");
        g.add(`[${cut}][${matte.out}]blend=all_mode=multiply[${through}]`);
      }
      const shown = g.label("lbs");
      g.add(`[${mixed}][${through}]alphamerge[${shown}]`);
      g.add(`[${base}][${shown}]overlay=format=auto:shortest=1:${enable},format=${Y}[${out}]`);
    }
    vCur = out;
    if (keep) {
      const [cut, front] = [g.label("lsc"), g.label("lsf")];
      g.add(`[${keep}][${subject}]alphamerge[${cut}]`);
      g.add(`[${out}][${cut}]overlay=format=auto:shortest=1:${enable},format=${Y}[${front}]`);
      vCur = front;
    }
    if (a) overlayAudio.push(a);
  });

  function mediaLayerStream(layer: MediaLayer, asset: Asset): { v: string; a?: string } {
    const w = even(layer.size.width * W);
    let h: number;
    if (layer.size.height) h = even(layer.size.height * H);
    else if ((asset.type === "video" || asset.type === "image") && asset.width && asset.height) h = even((w * asset.height) / asset.width);
    else if (asset.type === "color" || asset.type === "gradient") h = even((w * H) / W);
    else h = even((w * 9) / 16);
    const input = sourceInput(asset, layer.in, layer.duration);
    const raw = g.label("lraw");
    const graded = sceneGradeFor(asset, layer.effects);
    g.add(`[${input}:v]${chain(["setpts=PTS-STARTPTS", `fps=${F}`, workingMatrix(asset), ...colorConversion(asset, true, graded.grade), `format=${YA}`])}[${raw}]`);
    const fitted = fit(raw, layer.size.height ? (layer.fit === "blur" ? "contain" : layer.fit) : "stretch", w, h, true);
    let styled = g.label("lfx");
    g.add(`[${fitted}]${chain([`format=${YA}`, ...effectsToFilter(graded.effects, effectCtx(layer.duration, w, h, true))])}[${styled}]`);
    // Rounded corners: multiply the layer's alpha by a rounded-rectangle mask drawn once.
    const radius = Math.min(Math.round(layer.cornerRadius * k), Math.floor(Math.min(w, h) / 2));
    if (radius > 0) {
      const [colorPart, alphaPart, mask, alpha, out] = [g.label("lrc"), g.label("lra"), g.label("lrm"), g.label("lrx"), g.label("lrr")];
      const inside = `lte(hypot(max(${radius}-X,X-(W-1-${radius}))*gt(max(${radius}-X,X-(W-1-${radius})),0),max(${radius}-Y,Y-(H-1-${radius}))*gt(max(${radius}-Y,Y-(H-1-${radius})),0)),${radius})`;
      g.add(`[${styled}]split=2[${colorPart}][${alphaPart}]`);
      g.add(`nullsrc=s=${w}x${h}:r=${F},trim=end_frame=1,format=gray,geq=lum='255*${inside}'[${mask}]`);
      g.add(`[${alphaPart}]alphaextract[${alpha}]`);
      const merged = g.label("lrb");
      g.add(`[${alpha}][${mask}]blend=all_mode=multiply[${merged}]`);
      g.add(`[${colorPart}][${merged}]alphamerge[${out}]`);
      styled = out;
    }
    const pinKeys = layer.keyframes?.corners;
    // Corner pin: stretch the layer to the frame, pad it with clear pixels (perspective repeats the
    // edge pixels outward, and those stay clear), and send the padded corners where the layer's
    // corners, extended by the same perspective, land. Replaces placement, shadow, 3D and scale.
    if (pinKeys?.length) {
      const P = PIN_PAD;
      const [out, padded] = [g.label("lcp"), g.label("lcq")];
      const outer = pinKeys.map((key) => ({ ...key, value: padCorners(key.value, W, H, P) }));
      const coord = (c: number, axis: 0 | 1) => {
        const keys = outer.map((key) => ({ ...key, value: key.value[c]![axis] + P }));
        return keys.length > 1 ? numberExpr(keys, `(on/${F})`) : String(round3(keys[0]!.value));
      };
      // perspective's corner order: top-left, top-right, bottom-left, bottom-right.
      const coords = [0, 1, 3, 2].flatMap((c, i) => [`x${i}='${coord(c, 0)}'`, `y${i}='${coord(c, 1)}'`]).join(":");
      g.add(`[${styled}]scale=${W}:${H},format=${YA},pad=${W + 2 * P}:${H + 2 * P}:${P}:${P}:color=black@0[${padded}]`);
      g.add(`[${padded}]perspective=${coords}:sense=destination:interpolation=linear:eval=${pinKeys.length > 1 ? "frame" : "init"}[${out}]`);
      styled = out;
    }
    // Drop shadow: a blurred black silhouette, offset down, under the layer. Padding keeps the center in place.
    const shadow = pinKeys?.length ? 0 : Math.round(layer.shadow * k);
    if (shadow > 0) {
      const pad = shadow * 3;
      const [padded, top, sil, out] = [g.label("lsp"), g.label("lst"), g.label("lss"), g.label("lsh")];
      g.add(`[${styled}]pad=${w + 2 * pad}:${h + 2 * pad}:${pad}:${pad}:color=black@0,split=2[${padded}][${top}]`);
      g.add(
        `[${padded}]lutyuv=y=16:u=128:v=128:a='val*0.55',gblur=sigma=${round3(shadow * 0.9)},crop=iw:ih-${shadow}:0:0,pad=iw:ih+${shadow}:0:${shadow}:color=black@0[${sil}]`,
      );
      g.add(`[${sil}][${top}]overlay=0:0:format=auto[${out}]`);
      styled = out;
    }
    // 3D: turn the layer in space and project it through a camera `perspective` layer widths away.
    // Padding leaves room for the near side, which grows as it comes toward the viewer.
    const { rotateX: tiltKeys, rotateY: turnKeys } = layer.keyframes ?? {};
    if (!pinKeys?.length && (layer.rotateX || layer.rotateY || tiltKeys?.length || turnKeys?.length)) {
      // Size from the layer as it is now: a drop shadow has already padded it by 3 shadows a side.
      const [pw, ph] = [even((w + 6 * shadow) * 1.8), even((h + 6 * shadow) * 1.8)];
      const [padded, out] = [g.label("l3p"), g.label("l3d")];
      const deg = (keys: typeof tiltKeys, value: number) => `((${keys?.length ? numberExpr(keys, `(on/${F})`) : value})*PI/180)`;
      const [a, b] = [deg(tiltKeys, layer.rotateX), deg(turnKeys, layer.rotateY)];
      const f = round3(layer.perspective * w);
      // Where a corner (x, y from the center) lands: turn about the vertical axis, tilt about the horizontal one, project.
      const corner = (x: number, y: number) => {
        const z1 = `(${-x}*sin(${b}))`;
        const z = `(${y}*sin(${a})+${z1}*cos(${a}))`;
        const k = `(${f}/(${f}+${z}))`;
        return [`${pw / 2}+${x}*cos(${b})*${k}`, `${ph / 2}+(${y}*cos(${a})-${z1}*sin(${a}))*${k}`];
      };
      const pts = [corner(-pw / 2, -ph / 2), corner(pw / 2, -ph / 2), corner(-pw / 2, ph / 2), corner(pw / 2, ph / 2)];
      const coords = pts.flatMap(([x, y], i) => [`x${i}='${x}'`, `y${i}='${y}'`]).join(":");
      g.add(`[${styled}]pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2:color=black@0[${padded}]`);
      g.add(`[${padded}]perspective=${coords}:sense=destination:interpolation=linear:eval=${tiltKeys?.length || turnKeys?.length ? "frame" : "init"}[${out}]`);
      styled = out;
    }
    const v = g.label("lv");
    const { rotation: rotationKeys, scale: scaleKeys, opacity: opacityKeys } = pinKeys?.length ? { opacity: layer.keyframes?.opacity } : (layer.keyframes ?? {});
    const fadeIn = layer.animationIn && layer.animationIn.type !== "none" ? layer.animationIn.duration : 0;
    const fadeOut = layer.animationOut && layer.animationOut.type !== "none" ? layer.animationOut.duration : 0;
    g.add(
      `[${styled}]${chain([
        `format=${YA}`,
        layer.opacity < 1 && `colorchannelmixer=aa=${layer.opacity}`,
        // Keyframes (t and T are seconds from the layer's start here). The per-frame scale comes
        // last: it changes the frame size, and the other filters size their buffers only once.
        rotationKeys?.length && `rotate=a='(${numberExpr(rotationKeys, "t")})*PI/180':ow='hypot(iw,ih)':oh=ow:c=none`,
        opacityKeys?.length && `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${numberExpr(opacityKeys, "T")},0,1)'`,
        fadeIn && `fade=t=in:st=0:d=${fadeIn}:alpha=1`,
        fadeOut && `fade=t=out:st=${round3(Math.max(0, layer.duration - fadeOut))}:d=${fadeOut}:alpha=1`,
        scaleKeys?.length && `scale=w='max(2,2*trunc(iw*(${numberExpr(scaleKeys, "t")})/2))':h='max(2,2*trunc(ih*(${numberExpr(scaleKeys, "t")})/2))':eval=frame`,
        `setpts=PTS+${layer.start}/TB`,
      ])}[${v}]`,
    );
    const a = asset.type === "video" && asset.hasAudio !== false && layer.volume > 0 ? layerAudio(layer, input) : undefined;
    return { v, a };
  }

  function layerAudio(layer: MediaLayer, input: number): string {
    const a = g.label("la");
    const ms = Math.round(layer.start * 1000);
    g.add(`[${input}:a]${chain(["asetpts=PTS-STARTPTS", ...audioEffectsToFilter(layer.audioEffects), `volume=${layer.volume}`, AUDIO_FMT, `adelay=${ms}|${ms}`])}[${a}]`);
    return a;
  }

  // -------------------------------------------------------------------------
  // Text, shapes & captions (ASS via libass)
  // -------------------------------------------------------------------------
  const ass = new AssDocument(project.settings.width, project.settings.height, 0);
  ass.fontMap = opts.fontMap;
  ass.fontFallback = opts.fontFallback;
  project.layers.forEach((layer, i) => {
    if (layer.type === "text") addTextLayer(ass, layer, 10 + i, F);
    else if (layer.type === "shape") addShapeLayer(ass, layer, 10 + i, F);
  });
  const captions = buildCaptions(project, timeline);
  if (captions) {
    // Captions build explicit line breaks, so they need a no-wrap document of their own style;
    // using \q2 per event keeps everything in one file.
    const before = ass.events.length;
    addCaptionEvents(ass, captions.chunks, captions.style, { width: ass.width, height: ass.height, layer: 1000 });
    for (let i = before; i < ass.events.length; i++) {
      const ev = ass.events[i]!;
      ev.text = ev.text.replace(/^\{/, "{\\q2");
    }
  }
  if (!ass.isEmpty && !opts.piece) {
    files.push({ name: ASS_FILE, content: ass.toString() });
  }
  if (!ass.isEmpty && !opts.piece && !opts.audioOnly) {
    const out = g.label("txt");
    const fonts = opts.fontsDir ? `:fontsdir='${escapeFilterPath(path.resolve(opts.fontsDir))}'` : "";
    g.add(`[${vCur}]ass=filename=${ASS_FILE}${fonts}[${out}]`);
    vCur = out;
  }

  // -------------------------------------------------------------------------
  // Audio tracks: voice, ducked music, sfx
  // -------------------------------------------------------------------------
  const voice: string[] = [aCur, ...splitAudio, ...overlayAudio];
  const duckedMusic: string[] = [];
  const plainMusic: string[] = [];
  const otherAudio: string[] = [];
  for (const ta of timeline.audio) {
    const { clip, asset } = ta;
    if (ta.duration <= 0 || clip.volume === 0) continue;
    const srcDur = asset.type === "audio" || asset.type === "video" ? asset.duration : undefined;
    const sourceSeconds = round3(ta.duration * clip.speed);
    const loop = clip.loop && (srcDur === undefined || clip.in + sourceSeconds > srcDur);
    const k = sourceInput(asset, loop ? 0 : clip.in, sourceSeconds, loop);
    const label = g.label("au");
    const ms = Math.round(ta.start * 1000);
    g.add(
      `[${k}:a]${chain([
        "asetpts=PTS-STARTPTS",
        ...atempoChain(clip.speed),
        ...audioEffectsToFilter(clip.audioEffects),
        clip.volume !== 1 && `volume=${clip.volume}`,
        clip.fadeIn > 0 && `afade=t=in:st=0:d=${clip.fadeIn}`,
        clip.fadeOut > 0 && `afade=t=out:st=${round3(Math.max(0, ta.duration - clip.fadeOut))}:d=${clip.fadeOut}`,
        AUDIO_FMT,
        ms > 0 && `adelay=${ms}|${ms}`,
      ])}[${label}]`,
    );
    if (clip.role === "voiceover") voice.push(label);
    else if (clip.role === "music") (clip.duck !== false ? duckedMusic : plainMusic).push(label);
    else otherAudio.push(label);
  }

  const mix = (labels: string[], duration: "first" | "longest"): string => {
    if (labels.length === 1) return labels[0]!;
    const out = g.label("mix");
    g.add(`${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=${duration}:normalize=0[${out}]`);
    return out;
  };

  const taps: { label: string; file: string }[] = [];
  /** Analysis renders: copy a submix out to its own WAV file. */
  const tap = (name: "voice" | "music", label: string): string => {
    const file = opts.analysis?.audio?.[name];
    if (!file) return label;
    const [keep, out] = [g.label("tap"), g.label(`stem${name}`)];
    g.add(`[${label}]asplit=2[${keep}][${out}]`);
    taps.push({ label: out, file });
    return keep;
  };

  let voiceMix = mix(voice, "first");
  const finalInputs: string[] = [];
  const music: string[] = [];
  const hasSpeech = voice.length > 1 || timeline.clips.some((c) => project.transcripts[c.clip.assetId] || (c.asset.type === "video" && c.asset.hasAudio !== false && !c.clip.muted));
  if (duckedMusic.length) {
    const ducking = mix(duckedMusic, "longest");
    if (hasSpeech) {
      const main = g.label("vmain");
      const sc = g.label("vsc");
      const ducked = g.label("duck");
      g.add(`[${voiceMix}]asplit=2[${main}][${sc}]`);
      g.add(`[${ducking}][${sc}]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350:makeup=1[${ducked}]`);
      voiceMix = main;
      music.push(ducked);
    } else {
      music.push(ducking);
    }
  }
  music.push(...plainMusic);
  finalInputs.push(tap("voice", voiceMix));
  if (music.length) finalInputs.push(tap("music", mix(music, "longest")));
  finalInputs.push(...otherAudio);
  const aMixed = mix(finalInputs, "first");
  const aOut = "aout";
  g.add(
    `[${aMixed}]${chain([
      // Master effects can change the sample rate (loudnorm), so reformat before limiting.
      ...(project.audioEffects.length ? [...audioEffectsToFilter(project.audioEffects), AUDIO_FMT] : []),
      "alimiter=limit=0.95:level=false",
      "apad",
      `atrim=duration=${total}`,
    ])}[${aOut}]`,
  );

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------
  const vOut = "vout";
  const sheet = opts.contactSheet;
  const piece = opts.piece;
  if (piece) {
    const layer = piece.kind === "layer";
    if (layer && !layerPiece) throw new Error(`No media layer "${piece.layerId}" to compile as a piece`);
    if (layer) g.add(`[${vCur}]nullsink`);
    const pixFmt = layer ? "yuva420p" : "yuv420p";
    // The base piece is cut to the edit's frames (the encoder's -t), clips have theirs already.
    const tail = piece.kind === "base" ? `,trim=end_frame=${piece.frames}` : "";
    g.add(`[${layer ? layerPiece : vCur}]format=${pixFmt}${tail}[${vOut}]`);
    g.add(`[${aOut}]anullsink`);
    const filterGraph = g.lines.join(";\n");
    files.push({ name: piece.script, content: filterGraph });
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      ...g.inputArgs,
      "-filter_complex_script", piece.script,
      "-map", `[${vOut}]`,
      ...(piece.ss ? ["-ss", piece.ss] : []),
      "-fps_mode", "passthrough",
      "-f", "rawvideo", "-pix_fmt", pixFmt, "pipe:1",
    ];
    return { args, files, filterGraph, timeline, duration: total, width: W, height: H };
  }
  if (opts.segment) {
    g.add(`[${vCur}]format=${Y}[${vOut}]`);
    g.add(`[${aOut}]anullsink`);
    const filterGraph = g.lines.join(";\n");
    files.push({ name: FILTER_SCRIPT, content: filterGraph });
    const args = [
      "-y", "-hide_banner", "-loglevel", "error", "-stats",
      ...g.inputArgs,
      "-filter_complex_script", FILTER_SCRIPT,
      "-map", `[${vOut}]`,
      ...segmentCodec(deep),
      // Keep exactly the frames the clip's chain makes, as the uncached graph does: forcing a rate
      // or length here drops or repeats a frame, and every later clip shifts by it.
      "-fps_mode", "passthrough",
      path.resolve(opts.output),
    ];
    return { args, files, filterGraph, timeline, duration: total, width: W, height: H };
  }
  const analysis = opts.analysis;
  if (analysis) {
    // Snap each time to a frame so the select below picks exactly one frame for it.
    const last = Math.max(0, Math.ceil(total * F) - 1);
    const frames = [...new Set((analysis.framesAt ?? []).map((t) => Math.min(last, Math.max(0, Math.round(t * F)))))].sort((a, b) => a - b);
    const frameTimes = frames.map((n) => round3(n / F));
    if (!frameTimes.length && !analysis.audio) throw new Error("An analysis render needs frame times or audio outputs");
    if (frameTimes.length) g.add(`[${vCur}]select='${frameTimes.map((t) => `lt(abs(t-${t}),${round3(0.5 / F)})`).join("+")}',format=rgb24[${vOut}]`);
    else g.add(`[${vCur}]nullsink`);
    if (!analysis.audio) g.add(`[${aOut}]anullsink`);
    const filterGraph = g.lines.join(";\n");
    files.push({ name: FILTER_SCRIPT, content: filterGraph });
    const wav = (label: string, file: string) => ["-map", `[${label}]`, "-c:a", "pcm_s16le", "-ar", "48000", path.resolve(file)];
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...g.inputArgs,
      "-filter_complex_script",
      FILTER_SCRIPT,
      ...(frameTimes.length ? ["-map", `[${vOut}]`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"] : []),
      ...(analysis.audio ? [...wav(aOut, analysis.audio.mix), ...taps.flatMap((t) => wav(t.label, t.file))] : []),
    ];
    return { args, files, filterGraph, timeline, duration: total, width: W, height: H, frameTimes };
  }
  if (sheet) {
    const n = sheet.columns * sheet.rows;
    // Sample the middle of each of n equal slices.
    g.add(
      `[${vCur}]select='isnan(prev_selected_t)*gte(t,${round3(total / n / 2)})+gte(t-prev_selected_t,${round3(total / n)})',scale=${even(sheet.thumbWidth)}:-2,tile=${sheet.columns}x${sheet.rows}:padding=4:margin=4,format=yuv420p[${vOut}]`,
    );
  } else {
    // A hardware encoder that takes frames on its device (VAAPI) gets them uploaded here.
    const upload = opts.frameAt === undefined && !opts.analysis ? hardwareUpload(exportHardware(project.export, opts.hardwareEncoder)) : undefined;
    // The file is BT.709, as its tags say; a single frame becomes RGB from the working BT.601.
    const matrix = opts.frameAt === undefined ? `,${OUTPUT_MATRIX}` : "";
    g.add(`[${vCur}]format=${Y}${matrix}${upload ? `,${upload}` : ""}[${vOut}]`);
  }
  const still = opts.frameAt !== undefined || !!sheet;
  // Image outputs have no audio stream; every filter output must still be consumed.
  if (still) g.add(`[${aOut}]anullsink`);

  const filterGraph = g.lines.join(";\n");
  const exp = project.export;
  const outputArgs: string[] = ["-map", `[${vOut}]`];
  const range = opts.range;
  if (sheet) {
    outputArgs.push("-frames:v", "1", "-update", "1");
  } else if (opts.frameAt !== undefined) {
    outputArgs.push("-ss", String(round3(opts.frameAt)), "-frames:v", "1", "-update", "1");
  } else {
    outputArgs.push(
      "-map",
      `[${aOut}]`,
      // 10-bit and ProRes exports come from the deep graph and are written at 10 bits.
      ...exportVideoArgs(exp, opts.preset, opts.hardwareEncoder),
      ...OUTPUT_COLOR_TAGS,
      "-r",
      String(F),
      "-c:a",
      exp.audioCodec,
      "-b:a",
      exp.audioBitrate,
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
    );
    if (range) outputArgs.push("-ss", String(round3(range.start)), "-to", String(round3(Math.min(range.end, total))));
    else outputArgs.push("-t", String(total));
  }
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-stats",
    ...(still || opts.analysis ? [] : hardwareGlobalArgs(exportHardware(project.export, opts.hardwareEncoder))),
    ...g.inputArgs,
    "-filter_complex_script",
    FILTER_SCRIPT,
    ...outputArgs,
    ...(opts.extraOutputArgs ?? []),
    path.resolve(opts.output),
  ];
  files.push({ name: FILTER_SCRIPT, content: filterGraph });
  const duration = still ? 0 : range ? round3(Math.min(range.end, total) - range.start) : total;
  return { args, files, filterGraph, timeline, duration, width: W, height: H };
}

/** Effects attached to a clip, layer or the whole project (helper for tooling). */
export function effectsOf(project: Project, target: string): Effect[] | undefined {
  if (target === "global") return project.effects;
  const clip: Clip | undefined = project.clips.find((c) => c.id === target);
  if (clip) return clip.effects;
  const layer = project.layers.find((l) => l.id === target);
  return layer && layer.type === "media" ? layer.effects : undefined;
}

/**
 * The video encoder's arguments for an export: ProRes 422 HQ (prores_ks profile 3, 10-bit 4:2:2;
 * crf and preset do not apply), x264 or x265 at 8 or 10 bits, or the graphics card's encoder for
 * 8-bit exports when one was found.
 */
export function exportVideoArgs(exp: Project["export"], preset: string | undefined, hardware: HardwareEncoder | undefined): string[] {
  if (isProRes(exp.videoCodec)) return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"];
  const hw = exportHardware(exp, hardware);
  if (hw) return hardwareEncoderArgs(hw, exp.crf);
  return ["-c:v", exp.videoCodec, "-preset", preset ?? exp.preset, "-crf", String(exp.crf), "-pix_fmt", exp.bitDepth === 10 ? "yuv420p10le" : "yuv420p"];
}

/** The hardware encoder an export uses: none for 10-bit or ProRes exports (they encode in software). */
export function exportHardware(exp: Project["export"], hardware: HardwareEncoder | undefined): HardwareEncoder | undefined {
  return hardware && exp.bitDepth !== 10 && !isProRes(exp.videoCodec) ? hardware : undefined;
}
