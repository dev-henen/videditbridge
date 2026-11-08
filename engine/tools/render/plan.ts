import path from "node:path";
import type { Asset, Fit, MediaLayer, Project } from "../../core/schema.js";
import { computeTimeline, type TimedClip } from "../../core/timeline.js";
import { easeValue, numberAt, positionAt } from "../../core/keyframes.js";
import { parseColor, round3 } from "../../core/util.js";
import { effectsToFilter, escapeFilterPath } from "../../library/effects/index.js";
import { getTransition } from "../../library/transitions/index.js";
import { ASS_FILE, compileProject, gradientSource, rampPts, renderSize, type CompileOptions } from "./compile.js";
import { cropPosition, effectsOps, joinedTime, lutArgs, type PlanOp } from "./plan-effects.js";
import { hardwareEncoderArgs, type HardwareEncoder } from "./hardware.js";
import { colorTableFile, convertsColor, inputTableFile, outputTableFile, sceneGradeFor } from "./color-space.js";
import { gradeConstants, type SceneGrade } from "../../library/color/index.js";

/**
 * Engine plans: a project turned into what the GPU render engine (native/ave-render) draws on every
 * frame. Like compileProject this is pure, and it follows the FFmpeg backend's timing and rounding
 * (frame counts, fit sizes, crop and overlay positions), so both backends give the same frames.
 * Keep the types in step with native/ave-render/src/plan.rs.
 */

export const PLAN_VERSION = 2;

/**
 * How a decoder writes frames: packed `vuya` (stills, which may have alpha), or planar 4:2:0 as
 * the FFmpeg backend keeps video, `yuv420p` for clips and `yuva420p` for layers. Planar chroma is
 * scaled at half size on the GPU, as FFmpeg's scale does.
 */
export type PlanPixelFormat = "vuya" | "yuv420p" | "yuva420p" | "yuv420p10le" | "yuva420p10le";

export type PlanSource =
  | {
      kind: "decode";
      width: number;
      height: number;
      args: string[];
      format?: PlanPixelFormat;
      still?: boolean;
      seek?: PlanSeek;
      /**
       * A generated source that can start at any frame (the text layer): `args` with `{frame}`
       * replaced by the first frame wanted and `{left}` by the frames from there to the end.
       */
      seekArgs?: string[];
    }
  | { kind: "color"; color: [number, number, number, number] };

/**
 * How to start a video source's decoder at a later frame instead of its first, for previews that
 * jump around (engine sessions): from `inPoint` + frame / fps x `speed` seconds of `src`, with the
 * same timing filters as `args` (held at the end and cut to `frames` for clips), then `tail`.
 * Only for constant speed, forwards; exports always decode from the start.
 */
export interface PlanSeek {
  src: string;
  inPoint: number;
  speed: number;
  sourceDuration: number;
  frames?: number;
  tail: string[];
}

/** A source fitted to a box: scaled to `scaled`, placed at `offset` (negative for a crop) in a `width` x `height` image, the rest `fill`. */
export interface PlanItem {
  source: PlanSource;
  width: number;
  height: number;
  scaled: [number, number];
  offset: [number, number];
  fill: [number, number, number, number];
  opaque?: boolean;
  /** Effects on the fitted picture, in order; time counts in frames of the piece (the clip). */
  effects?: PlanOp[];
  /** fit blur: the same source fitted again behind the picture, through its own effects (blurred and darkened). */
  backdrop?: { scaled: [number, number]; offset: [number, number]; effects: PlanOp[] };
  /** Keep the fitted picture as YUV (Y, U, V in red, green, blue) instead of turning it into RGB: the text source. */
  keepYuv?: boolean;
}

export interface PlanClip {
  item: number;
  /** Output frame showing the clip's frame 0, and how many frames it shows. */
  first: number;
  frames: number;
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
  /** xfade's transition name, or circlereveal with its origin, reach (frame heights) and the frame's aspect. */
  transition?: { kind: string; offset: number; duration: number; origin?: [number, number]; reach?: number; aspect?: number };
}

export interface PlanLayer {
  item: number;
  start: number;
  end: number;
  /** Frames a still or generated source lasts (video layers end where their decoder does). */
  frames?: number;
  /**
   * The output frame that shows the layer's frame 0. The backend moves the layer's frames by
   * `setpts=PTS+start/TB` on its 1/fps timebase, which truncates: a layer starting between frames
   * shows its frames from the frame before (Math.trunc of start / (1 / fps), in doubles as there).
   */
  offset: number;
  /** Top-left corner, pixels. */
  x: number;
  y: number;
  /** A moving layer (slides, position keyframes): its corner on each output frame from `frame0` (the last holds). */
  frame0?: number;
  positions?: [number, number][];
  /** Opacity keyframes: a factor on each frame of the layer (the last holds). */
  opacities?: number[];
  opacity: number;
  blend: string;
  fadeIn?: number;
  fadeOut?: number;
  duration: number;
}

export interface EnginePlan {
  version: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
  background: [number, number, number];
  ffmpeg: string;
  cwd?: string;
  items: PlanItem[];
  clips: PlanClip[];
  layers: PlanLayer[];
  /** The item holding the text drawn over black and over (235, 240, 240), stacked (`PlanOptions.textLayer`). */
  text?: number;
  /** Whole-video effects on the primary track (clips and transitions), before the layers; time counts in output frames. */
  effects?: PlanOp[];
  /** Transitions run on RGB, not YUV, in the FFmpeg backend (see transitionsInRgb). */
  rgbTransitions?: boolean;
  /**
   * The encoder's arguments (it reads the frames on stdin). `bitDepth` 10: the engine gives yuv420p10le.
   * `dither`: 8-bit frames get a light dither (footage in a color space, whose grades would show steps).
   */
  output: { args: string[]; bitDepth?: 10; dither?: boolean };
  /** Files the pieces' ffmpeg runs read from the work folder (`cwd`), which the caller writes before running the plan. */
  files?: { name: string; content: string }[];
}

export interface PlanOptions {
  output: string;
  /** The ffmpeg binary for decoders and the encoder. */
  ffmpeg: string;
  baseDir?: string;
  scale?: number;
  preset?: string;
  /** The finished sound (a WAV file), muxed into the output. */
  audio?: string;
  /** Text, shapes and captions: the encoder burns in overlay.ass from its working directory. */
  overlay?: boolean;
  /**
   * Text, shapes and captions drawn by the engine instead (engine sessions, which draw single
   * frames): libass draws overlay.ass from the working directory in a decoder that stays open, so
   * fonts load once, not for every frame, and the engine puts it on as it packs the frame (`text`).
   */
  textLayer?: boolean;
  fontsDir?: string;
  hardwareEncoder?: HardwareEncoder;
  extraOutputArgs?: string[];
  /**
   * What pieces the FFmpeg backend draws (engineGaps) read besides the media: the clips' model masks,
   * removals and smooth motion frames, and the finished picture's mattes (layer masks, layers
   * behind the subject), as render() prepares them for the backend.
   */
  pieceInputs?: PieceInputs;
}

export type PieceInputs = Pick<CompileOptions, "masks" | "faceMasks" | "objectMasks" | "skyMasks" | "depthMasks" | "removals" | "interpolated" | "subjectMask" | "skyMatte" | "objectMattes">;

/** Filters that take RGB frames only: after a transition, FFmpeg's format negotiation then runs xfade on RGB too. */
const RGB_FILTERS = new Set(["colorbalance", "colortemperature", "curves", "colorchannelmixer", "lut3d", "haldclut", "exposure", "vibrance", "huesaturation", "rgbashift"]);

/**
 * Whether the FFmpeg backend's xfade runs on RGB frames: its format follows the filter after it,
 * the first of the whole-video effects, and when that takes RGB only (or bakes into an RGB table),
 * the transitions run on RGB. There "black" is plain black, not YUV's luma 0 below video black,
 * chroma planes are full size, and fadegrays averages R, G and B.
 */
export function transitionsInRgb(project: Project, W: number, H: number): boolean {
  if (!project.effects.length) return false;
  const chain = effectsToFilter(project.effects, { width: W, height: H, fps: project.settings.fps, duration: 1, label: (p) => p }).join(",");
  const first = /^\s*(\w+)(?:=([^,;:[]*))?/.exec(chain);
  if (!first) return false;
  if (first[1] === "format") return /rgb|gbr/.test(first[2] ?? "");
  return RGB_FILTERS.has(first[1]!);
}

/** Transitions the engine draws: FFmpeg xfade names (see primary.wgsl), and the catalog's custom circlereveal. */
const TRANSITIONS = new Set([
  "fade", "fadeblack", "fadewhite", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown", "circleopen", "circleclose", "horzopen", "horzclose", "vertopen", "vertclose",
  "diagtl", "zoomin", "circlecrop", "rectcrop", "coverleft", "coverright", "revealleft", "revealright", "fadegrays", "pixelize", "hblur",
  "dissolve", "radial", "distance", "squeezeh", "squeezev", "hlslice", "hrslice", "vuslice", "vdslice", "hlwind", "hrwind",
]);
const FITS = new Set<Fit>(["cover", "contain", "stretch", "blur"]);

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** FFmpeg's pad and overlay positions: truncated, then aligned to the 4:2:0 chroma grid (crop rounds instead, see cropPosition). */
const chromaAligned = (v: number) => Math.trunc(v) & ~1;
const rgba = (hex: string): [number, number, number, number] => {
  const c = parseColor(hex);
  return [c.r / 255, c.g / 255, c.b / 255, c.a];
};

/**
 * What the engine does not draw itself in a project, by place. Those places become pieces the
 * FFmpeg backend draws for it (compileProject's `piece`), read like any other source, so the engine
 * renders every project and the pieces match the backend exactly:
 *
 * - `clips`: a clip's picture (fit and effects) comes from the backend; fades, transitions and the
 *   rest stay on the engine.
 * - `layers`: a media layer placed on a clear frame-size canvas comes from the backend (keyframes,
 *   rounded corners, shadow, 3D and effects included); the engine blends it.
 * - `base`: the primary track and the media layers up to `layers` (an index into project.layers,
 *   -1 for none) come from the backend as one picture, when what is wrong there needs the picture
 *   under it (whole-video effects, transitions, layer masks, layers behind the subject).
 */
export interface EngineGaps {
  clips: Map<string, string[]>;
  layers: Map<string, string[]>;
  base?: { reasons: string[]; layers: number };
}

export function engineGaps(project: Project): EngineGaps {
  const gaps: EngineGaps = { clips: new Map(), layers: new Map() };
  const { width, height, fps } = project.settings;
  const timeline = computeTimeline(project);
  const ctx = (duration: number) => ({ width, height, fps, duration });
  const base: string[] = [];
  let baseLayers = -1;
  for (const r of effectsOps(project.effects, ctx(timeline.primaryDuration || timeline.duration), 1).unsupported) base.push(`whole-video effects: ${r}`);
  const sized = (a: Asset | undefined) => !((a?.type === "video" || a?.type === "image") && !(a.width && a.height));
  for (const clip of project.clips) {
    const where = `clip "${clip.id}"`;
    const out: string[] = [];
    const duration = timeline.clips.find((c) => c.clip === clip)?.duration ?? 1;
    for (const r of effectsOps(clip.effects, ctx(duration), 1).unsupported) out.push(r);
    if (!FITS.has(clip.fit)) out.push(`fit ${clip.fit}`);
    if (clip.keyframes?.focus?.length) out.push("moving crop focus");
    if (clip.interpolate) out.push("smooth motion");
    const t = clip.transition && getTransition(clip.transition.type);
    if (clip.transition && (!t || (t.custom ? t.id !== "circlereveal" : !TRANSITIONS.has(t.xfade)))) base.push(`${where}: transition ${clip.transition.type}`);
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (!sized(asset)) out.push(`size of asset "${asset!.id}" unknown`);
    // The engine converts after the fit, so the background around a contained picture would go through the camera's table too.
    if (clip.fit === "contain" && asset && convertsColor(asset)) out.push("fit contain on footage with a color space");
    if (out.length) gaps.clips.set(clip.id, out);
  }
  project.layers.forEach((layer, index) => {
    if (layer.type !== "media") return;
    const where = `layer "${layer.id}"`;
    const out: string[] = [];
    const asset = project.assets.find((a) => a.id === layer.assetId);
    if (layer.effects.length && asset) {
      // Effects run on the layer's own picture, at its size and with its transparency.
      const [w, h] = layerSize(layer, asset, width, height);
      for (const r of effectsOps(layer.effects, { width: w, height: h, fps, duration: layer.duration, alpha: true }, 1).unsupported) out.push(r);
    }
    if (layer.mask || layer.behindSubject || layer.behindObject) {
      // Both need the picture under the layer, which only the base piece has.
      base.push(`${where}: ${layer.mask ? "mask" : layer.behindObject ? "behind an object" : "behind the subject"}`);
      baseLayers = index;
    }
    if (layer.shadow > 0) out.push("shadow");
    if (layer.rotateX || layer.rotateY) out.push("3D rotation");
    for (const [name, keys] of Object.entries(layer.keyframes ?? {})) if (keys?.length && !["position", "opacity"].includes(name)) out.push(`${name} keyframes`);
    if (!sized(asset)) out.push(`size of asset "${asset!.id}" unknown`);
    if (out.length) gaps.layers.set(layer.id, out);
  });
  if (base.length) {
    gaps.base = { reasons: base, layers: baseLayers };
    // Everything in the base piece is the backend's already.
    gaps.clips.clear();
    project.layers.forEach((l, i) => i <= baseLayers && gaps.layers.delete(l.id));
  }
  return gaps;
}

/** What the engine leaves to FFmpeg pieces in a project (engineGaps), one line per place; empty when it draws everything itself. */
export function engineBridged(project: Project): string[] {
  const gaps = engineGaps(project);
  return [
    ...(gaps.base?.reasons.map((r) => `base picture: ${r}`) ?? []),
    ...[...gaps.clips].map(([id, rs]) => `clip "${id}": ${rs.join(", ")}`),
    ...[...gaps.layers].map(([id, rs]) => `layer "${id}": ${rs.join(", ")}`),
  ];
}

/**
 * What keeps the engine from rendering a project at all (empty when it can). Since the engine takes
 * what it cannot draw itself from the FFmpeg backend as pieces (engineGaps), nothing in a project
 * does; renders still fall back to FFmpeg when the engine is not built or the graphics card fails.
 */
export function engineUnsupported(_project: Project): string[] {
  return [];
}

/** The engine plan of a project, or what it uses that the engine cannot draw yet. */
export function planProject(project: Project, opts: PlanOptions): { plan: EnginePlan; unsupported?: undefined } | { plan?: undefined; unsupported: string[] } {
  const unsupported = engineUnsupported(project);
  if (unsupported.length) return { unsupported };
  const gaps = engineGaps(project);
  const files: { name: string; content: string }[] = [];
  const timeline = computeTimeline(project);
  const total = timeline.duration;
  if (total <= 0) throw new Error("Project is empty: add clips, layers or audio before rendering");
  const F = project.settings.fps;
  const { width: W, height: H } = renderSize(project, opts.scale);
  const baseDir = opts.baseDir ?? process.cwd();
  const resolveSrc = (src: string) => (/^[a-z]+:\/\//i.test(src) ? src : path.resolve(baseDir, src));
  const background = rgba(project.settings.backgroundColor);
  const items: PlanItem[] = [];

  /**
   * Frames of a source as limited-range YUV on stdout, in `format`. The YUV to RGB matrix is fixed
   * to the one the encoder uses back (swscale's BT.601 default), so YUV values come out as they went
   * in, as in the FFmpeg backend. Video that is already 4:2:0 passes through without a conversion.
   */
  const decode = (input: string[], filters: (string | false | undefined)[], width: number, height: number, format: PlanPixelFormat, still = false, seek?: Omit<PlanSeek, "tail">): PlanSource => {
    const tail = [`scale=${width}:${height}:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int`, `format=${format}`];
    return {
      kind: "decode",
      width,
      height,
      format,
      still,
      args: [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        ...input,
        "-an", "-sn",
        "-vf", [...filters, ...tail].filter(Boolean).join(","),
        ...(still ? ["-frames:v", "1"] : []),
        "-f", "rawvideo", "-pix_fmt", format, "pipe:1",
      ],
      ...(seek ? { seek: { ...seek, tail } } : {}),
    };
  };
  /**
   * A still or generated source for `duration` seconds (images, colors, gradients), as the FFmpeg
   * backend makes them. Layers (`yuva420p`) are 4:2:0 from the start in the backend. Clips are
   * scaled in the source's own format there: JPEG pictures as 4:2:0, other pictures and gradients
   * in RGB, at full chroma (`vuya`).
   */
  const stillSource = (asset: Asset, layer: boolean): { source: PlanSource; size: [number, number] } | undefined => {
    if (asset.type === "color") return { source: { kind: "color", color: rgba(asset.color) }, size: [W, H] };
    if (asset.type === "image") {
      const format = convertsColor(asset) ? (layer ? "yuva420p10le" : "yuv420p10le") : layer ? "yuva420p" : /\.jpe?g$/i.test(asset.src) ? "yuv420p" : "vuya";
      return { source: decode(["-i", resolveSrc(asset.src)], [], asset.width!, asset.height!, format, true), size: [asset.width!, asset.height!] };
    }
    if (asset.type === "gradient") {
      return { source: decode(["-f", "lavfi", "-i", gradientSource(asset, W, H, F)], [], W, H, layer ? "yuva420p" : "vuya", true), size: [W, H] };
    }
    return undefined;
  };
  /** FFmpeg's scale (with force_original_aspect_ratio) and crop or pad, as sizes and an offset. */
  const fitBox = (fit: Fit, [iw, ih]: [number, number], w: number, h: number, focus?: { x: number; y: number }): Pick<PlanItem, "scaled" | "offset"> => {
    if (fit === "stretch") return { scaled: [w, h], offset: [0, 0] };
    const [tw, th] = [Math.round((h * iw) / ih), Math.round((w * ih) / iw)];
    if (fit === "contain") {
      const [sw, sh] = [Math.min(w, tw), Math.min(h, th)];
      return { scaled: [sw, sh], offset: [chromaAligned((w - sw) / 2), chromaAligned((h - sh) / 2)] };
    }
    const [sw, sh] = [Math.max(w, tw), Math.max(h, th)];
    const fx = round3(Math.min(1, Math.max(0, focus?.x ?? 0.5)));
    const fy = round3(Math.min(1, Math.max(0, focus?.y ?? 0.5)));
    return { scaled: [sw, sh], offset: [-cropPosition((sw - w) * fx), -cropPosition((sh - h) * fy)] };
  };
  const addItem = (item: PlanItem) => items.push(item) - 1;
  /** Camera log and HDR footage: its color space table, before any effect (the backend converts the source first). */
  const colorOps = (asset: Asset, grade?: SceneGrade): PlanOp[] => {
    if (!convertsColor(asset)) return [];
    if (!grade) return [{ op: "cube", file: path.resolve(colorTableFile(asset.colorSpace)) }];
    // Graded in ACEScct: the camera half, the grade as a shader, then the output half.
    return [{ op: "cube", file: path.resolve(inputTableFile(asset.colorSpace)) }, { op: "grade", ...gradeConstants(grade) }, { op: "cube", file: path.resolve(outputTableFile()) }];
  };

  /**
   * A piece the FFmpeg backend draws (engineGaps): its graph from compileProject, written to a file
   * in the work folder, and raw frames on stdout. Sessions start it later with an output seek, which
   * still runs the graph from the start, but only hands over the frames wanted.
   */
  const piece = (pieceProject: Project, kind: PieceKind, width: number, height: number, format: "yuv420p" | "yuva420p"): PlanSource => {
    const script = `piece-${items.length}.txt`;
    const compileOpts = { output: "", scale: opts.scale, baseDir, ...opts.pieceInputs };
    const compiled = compileProject(pieceProject, { ...compileOpts, piece: { ...kind, script } });
    const seeking = compileProject(pieceProject, { ...compileOpts, piece: { ...kind, script, ss: "{time}" } });
    for (const f of compiled.files) {
      const had = files.find((x) => x.name === f.name);
      if (had && had.content !== f.content) throw new Error(`Two pieces of the engine plan need different files named ${f.name}`);
      if (!had) files.push(f);
    }
    return { kind: "decode", width, height, format, args: compiled.args, seekArgs: seeking.args };
  };
  /** Pieces are pictures only: no sound, no text. */
  const silent = (p: Project): Project => ({ ...p, clips: p.clips.map((c) => ({ ...c, muted: true })), audio: [], captions: undefined, audioEffects: [] });

  // Primary track, with the FFmpeg backend's frame counts and xfade offsets.
  const clips: PlanClip[] = [];
  let curDur = 0;
  let next = 0;
  if (gaps.base) {
    // The primary track and the layers under the last one the engine cannot put on, from the backend.
    const frames = Math.ceil(total * F - 1e-6);
    const below = project.layers.slice(0, gaps.base.layers + 1).filter((l) => l.type === "media");
    const source = piece(silent({ ...project, layers: below }), { kind: "base", frames }, W, H, "yuv420p");
    const item = addItem({ source, width: W, height: H, scaled: [W, H], offset: [0, 0], fill: background, opaque: true });
    clips.push({ item, first: 0, frames, duration: total });
  }
  for (const tc of gaps.base ? [] : timeline.clips) {
    const { clip, asset } = tc;
    const frames = Math.max(1, Math.ceil(tc.end * F - 1e-6) - Math.ceil(tc.start * F - 1e-6));
    let source: PlanSource;
    let size: [number, number];
    const pieced = gaps.clips.has(clip.id);
    if (pieced) {
      // The clip as the backend fits it and runs its effects; fades and transitions stay here.
      const one = silent({ ...project, clips: [{ ...clip, transition: undefined, fadeIn: undefined, fadeOut: undefined }], layers: [], effects: [] });
      source = piece(one, { kind: "clip", frames }, W, H, "yuv420p");
      size = [W, H];
    } else if (asset.type === "video") {
      size = [asset.width!, asset.height!];
      source = decode(
        [...(clip.in > 0 ? ["-ss", String(round3(clip.in))] : []), "-t", String(round3(tc.sourceDuration)), "-i", resolveSrc(asset.src)],
        [clip.reverse && "reverse", "setpts=PTS-STARTPTS", ...retime(tc), `fps=${F}`, "tpad=stop_mode=clone:stop=-1", `trim=end_frame=${frames}`],
        size[0],
        size[1],
        convertsColor(asset) ? "yuv420p10le" : "yuv420p",
        false,
        clip.reverse || tc.speedMap ? undefined : { src: resolveSrc(asset.src), inPoint: clip.in, speed: clip.speed, sourceDuration: tc.sourceDuration, frames },
      );
    } else {
      const s = stillSource(asset, false);
      if (!s) throw new Error(`Clip "${clip.id}" uses audio asset "${asset.id}" as a picture`);
      ({ source, size } = s);
    }
    // Camera log and HDR footage: its color space table first (10-bit decoding above).
    const graded = sceneGradeFor(asset, clip.effects);
    const ops = pieced ? [] : [...colorOps(asset, graded.grade), ...effectsOps(graded.effects, { width: W, height: H, fps: F, duration: tc.duration }, frames).ops];
    // fit blur, as compileProject's fit draws it: the picture contained over a cover copy blurred
    // (gblur sigma 40) and darkened (eq brightness -0.08).
    const blur = clip.fit === "blur" && !pieced;
    const item = addItem({
      source,
      width: W,
      height: H,
      ...(pieced ? { scaled: [W, H] as [number, number], offset: [0, 0] as [number, number] } : fitBox(blur ? "contain" : clip.fit, size, W, H, clip.focus)),
      fill: blur ? [0, 0, 0, 0] : background,
      opaque: true,
      ...(ops.length ? { effects: ops } : {}),
      ...(blur ? { backdrop: { ...fitBox("cover", size, W, H), effects: [...colorOps(asset, graded.grade), { op: "blur", sigma: 40 }, { op: "lut", args: lutArgs(["eq=brightness=-0.08"]) }] as PlanOp[] } } : {}),
    });
    let first = next;
    let transition: PlanClip["transition"];
    if (tc.index > 0 && tc.transitionDuration > 0) {
      const d = tc.transitionDuration;
      const offset = round3(curDur - d);
      first = Math.ceil(offset * F - 1e-6);
      const def = getTransition(clip.transition!.type)!;
      if (def.custom) {
        // circlereveal, as its xfade expression computes the circle (transitions catalog).
        const [ox, oy] = [round3(clip.transition!.origin?.x ?? 0.5), round3(clip.transition!.origin?.y ?? 0.5)];
        const aspect = round3(W / H);
        const reach = round3(Math.hypot(Math.max(ox, 1 - ox) * aspect, Math.max(oy, 1 - oy)) + 0.03);
        transition = { kind: "circlereveal", offset, duration: d, origin: [ox, oy], reach, aspect };
      } else transition = { kind: def.xfade, offset, duration: d };
      curDur = round3(curDur + tc.duration - d);
    } else {
      curDur = round3(curDur + tc.duration);
    }
    clips.push({ item, first, frames, duration: tc.duration, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, transition });
    next = first + frames;
  }

  // Media overlays, sized and placed as mediaLayerStream and overlayMotion do.
  const layers: PlanLayer[] = [];
  const totalFrames = Math.ceil(total * F - 1e-6);
  for (const [index, layer] of project.layers.entries()) {
    if (layer.type !== "media" || index <= (gaps.base?.layers ?? -1)) continue;
    const asset = project.assets.find((a) => a.id === layer.assetId);
    if (!asset) throw new Error(`Layer "${layer.id}" references unknown asset "${layer.assetId}"`);
    if (gaps.layers.has(layer.id)) {
      // The layer placed on a clear canvas by the backend, for the frames it can show on (a frame of
      // margin each side); the engine blends it over the picture as it is.
      const end = round3(layer.start + layer.duration);
      const first = Math.max(0, Math.floor(layer.start * F) - 1);
      const last = Math.min(totalFrames - 1, Math.ceil(end * F) + 1);
      const frames = Math.max(1, last - first + 1);
      const one = silent({ ...project, clips: [], layers: [layer], effects: [] });
      const source = piece(one, { kind: "layer", layerId: layer.id, first, frames }, W, H, "yuva420p");
      const item = addItem({ source, width: W, height: H, scaled: [W, H], offset: [0, 0], fill: [0, 0, 0, 0] });
      // Frame-exact: frame k of the piece is output frame first + k (the backend's enable is in it already).
      const start = first / F - 1e-9;
      layers.push({ item, start, end: (first + frames - 1) / F + 1e-9, frames, offset: first, x: 0, y: 0, opacity: 1, blend: layer.blend, duration: frames / F });
      continue;
    }
    const [w, h] = layerSize(layer, asset, W, H);
    let source: PlanSource;
    let size: [number, number];
    if (asset.type === "video") {
      size = [asset.width!, asset.height!];
      source = decode(
        [...(layer.in > 0 ? ["-ss", String(round3(layer.in))] : []), "-t", String(round3(layer.duration)), "-i", resolveSrc(asset.src)],
        ["setpts=PTS-STARTPTS", `fps=${F}`],
        size[0],
        size[1],
        convertsColor(asset) ? "yuva420p10le" : "yuva420p",
        false,
        { src: resolveSrc(asset.src), inPoint: layer.in, speed: 1, sourceDuration: layer.duration },
      );
    } else {
      const s = stillSource(asset, true);
      if (!s) throw new Error(`Layer "${layer.id}" uses audio asset "${asset.id}" as a picture`);
      ({ source, size } = s);
    }
    const fit: Fit = layer.size.height ? (layer.fit === "blur" ? "contain" : layer.fit) : "stretch";
    const graded = sceneGradeFor(asset, layer.effects);
    // Rounded corners after the effects, as compile.ts cuts them (its radius scales with previews).
    const radius = Math.min(Math.round(layer.cornerRadius * (opts.scale && opts.scale > 0 ? opts.scale : 1)), Math.floor(Math.min(w, h) / 2));
    const ops = [
      ...colorOps(asset, graded.grade),
      ...effectsOps(graded.effects, { width: w, height: h, fps: F, duration: layer.duration, alpha: true }, Math.max(1, Math.ceil(layer.duration * F - 1e-6))).ops,
      ...(radius > 0 ? [{ op: "corners", radius } as const] : []),
    ];
    const item = addItem({ source, width: w, height: h, ...fitBox(fit, size, w, h), fill: [0, 0, 0, 0], ...(ops.length ? { effects: ops } : {}) });
    const fades = (a: MediaLayer["animationIn"]) => (a && a.type !== "none" ? a.duration : 0);
    layers.push({
      item,
      start: layer.start,
      end: round3(layer.start + layer.duration),
      // Stills loop for the layer's duration in the FFmpeg backend: that many frames.
      ...(asset.type === "video" ? {} : { frames: Math.ceil(layer.duration * F - 1e-6) }),
      offset: Math.trunc(layer.start / (1 / F)),
      x: chromaAligned(W * layer.position.x - w / 2),
      y: chromaAligned(H * layer.position.y - h / 2),
      ...layerMotion(layer, w, h, W, H, F),
      opacity: layer.opacity,
      blend: layer.blend,
      fadeIn: fades(layer.animationIn),
      fadeOut: fades(layer.animationOut),
      duration: layer.duration,
    });
  }

  const fonts = opts.fontsDir ? `:fontsdir='${escapeFilterPath(path.resolve(opts.fontsDir))}'` : "";
  let text: number | undefined;
  if (opts.textLayer) {
    // libass draws the text twice per frame, on frames timed in AV_TIME_BASE as the encoder's are:
    // over black (Y 16, U and V 128) and over (235, 240, 240), stacked. Its blending is linear per
    // plane, so the two give each plane's blend factor and what it adds, and the engine puts the
    // text on in YUV as it packs the frame, as libass does on the encoder's 4:2:0 frames. (Over a
    // transparent picture libass applies the color's own opacity to the alpha twice, which fades
    // cannot undo.)
    const count = Math.ceil(total * F - 1e-6);
    const pass = (label: string, [y, u, v]: number[], first: string) =>
      `color=c=black:s=${W}x${H}:r=${F},format=yuv420p,lutyuv=y=${y}:u=${u}:v=${v},settb=AVTB,setpts=round((N+${first})*1000000/${F}),ass=filename=${ASS_FILE}${fonts}[${label}]`;
    const args = (first: string, left: string) => [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-filter_complex", `${pass("b", [16, 128, 128], first)};${pass("w", [235, 240, 240], first)};[b][w]vstack,format=yuv420p`,
      // Frames start at the frame wanted: without passthrough ffmpeg repeats the first to fill from 0.
      "-fps_mode", "passthrough", "-frames:v", left,
      "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1",
    ];
    text = addItem({
      source: { kind: "decode", width: W, height: 2 * H, format: "yuv420p", args: args("0", String(count)), seekArgs: args("{frame}", "{left}") },
      width: W,
      height: 2 * H,
      scaled: [W, 2 * H],
      offset: [0, 0],
      fill: [0, 0, 0, 1],
      keepYuv: true,
    });
  }

  const exp = project.export;
  // Text goes on in YUV, as in the FFmpeg backend, on frames timed in AV_TIME_BASE as the backend's are:
  // libass takes whole milliseconds, so a frame exactly at an event's start can land on either side of it.
  // 10-bit exports: the engine gives 10-bit frames (no dither), and the encoder keeps them.
  const tenBit = exp.bitDepth === 10;
  const pixFmt = tenBit ? "yuv420p10le" : "yuv420p";
  const picture = ["settb=AVTB", `format=${pixFmt}`, opts.overlay && `ass=filename=${ASS_FILE}${fonts}`].filter(Boolean).join(",");
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo", "-pix_fmt", pixFmt, "-s", `${W}x${H}`, "-r", String(F), "-i", "pipe:0",
    ...(opts.audio ? ["-i", path.resolve(opts.audio)] : []),
    "-filter_complex", `[0:v]${picture}[v]`,
    "-map", "[v]",
    ...(opts.audio ? ["-map", "1:a"] : []),
    ...(opts.hardwareEncoder && !tenBit
      ? hardwareEncoderArgs(opts.hardwareEncoder, exp.crf)
      : ["-c:v", exp.videoCodec, "-preset", opts.preset ?? exp.preset, "-crf", String(exp.crf), "-pix_fmt", pixFmt]),
    "-r", String(F),
    ...(opts.audio ? ["-c:a", exp.audioCodec, "-b:a", exp.audioBitrate, "-ar", "48000"] : []),
    "-movflags", "+faststart",
    "-t", String(total),
    ...(opts.extraOutputArgs ?? []),
    path.resolve(opts.output),
  ];
  return {
    plan: {
      version: PLAN_VERSION,
      width: W,
      height: H,
      fps: F,
      frames: Math.ceil(total * F - 1e-6),
      background: [background[0], background[1], background[2]],
      ffmpeg: opts.ffmpeg,
      items,
      clips,
      layers,
      ...(text !== undefined ? { text } : {}),
      // The base piece has the transitions and whole-video effects in it already.
      ...(!gaps.base && transitionsInRgb(project, W, H) ? { rgbTransitions: true } : {}),
      ...(() => {
        if (gaps.base) return {};
        const { ops } = effectsOps(project.effects, { width: W, height: H, fps: F, duration: timeline.primaryDuration || total }, Math.ceil(total * F - 1e-6), joinedTime(F));
        return ops.length ? { effects: ops } : {};
      })(),
      ...(files.length ? { files } : {}),
      output: { args, ...(tenBit ? { bitDepth: 10 as const } : project.assets.some(convertsColor) ? { dither: true } : {}) },
    },
  };
}

/** The clip's timing filters after the in point, as in compileProject (speed, or a speed ramp). */
function retime(tc: TimedClip): string[] {
  if (tc.speedMap) return [`setpts='(${rampPts(tc.speedMap, tc.sourceDuration)})/TB'`];
  return tc.clip.speed !== 1 ? [`setpts=PTS/${tc.clip.speed}`] : [];
}

/**
 * Where a moving media layer is on each output frame, as compileProject's overlay expressions put it
 * (position keyframes from the layer's start, slide animations from overlayMotion), and its opacity
 * keyframes per frame of the layer. Nothing for a layer that holds still.
 */
function layerMotion(layer: MediaLayer, w: number, h: number, W: number, H: number, F: number): Pick<PlanLayer, "frame0" | "positions" | "opacities"> {
  const keys = layer.keyframes?.position;
  const slides = [layer.animationIn, layer.animationOut].some((a) => a?.type.startsWith("slide-"));
  const out: Pick<PlanLayer, "frame0" | "positions" | "opacities"> = {};
  const end = round3(layer.start + layer.duration);
  if (keys?.length || slides) {
    const frame0 = Math.ceil(layer.start * F - 1e-6);
    const last = Math.floor(end * F + 1e-6);
    out.frame0 = frame0;
    out.positions = Array.from({ length: Math.max(1, last - frame0 + 1) }, (_, i) => {
      const t = (frame0 + i) / F;
      const at = keys?.length ? positionAt(keys, t - layer.start) : layer.position;
      let [x, y] = [W * at.x - w / 2, H * at.y - h / 2];
      // overlayMotion's slides: 8% of the height or 10% of the width, eased over the animation.
      for (const [anim, entering] of [[layer.animationIn, true], [layer.animationOut, false]] as const) {
        if (!anim?.type.startsWith("slide-")) continue;
        const d = round3(anim.duration);
        const t0 = entering ? layer.start : round3(end - d);
        const e = easeValue(Math.min(1, Math.max(0, (t - t0) / d)), anim.easing);
        const k = entering ? 1 - e : e;
        const sign = entering ? 1 : -1;
        if (anim.type === "slide-up") y += sign * H * 0.08 * k;
        else if (anim.type === "slide-down") y -= sign * H * 0.08 * k;
        else if (anim.type === "slide-left") x += sign * W * 0.1 * k;
        else if (anim.type === "slide-right") x -= sign * W * 0.1 * k;
      }
      return [chromaAligned(x), chromaAligned(y)];
    });
  }
  const opacity = layer.keyframes?.opacity;
  if (opacity?.length) {
    const frames = Math.max(1, Math.ceil(layer.duration * F - 1e-6));
    out.opacities = Array.from({ length: frames }, (_, k) => Math.min(1, Math.max(0, numberAt(opacity, k / F))));
  }
  return out;
}

/** A media layer's size in output pixels, as mediaLayerStream computes it. */
function layerSize(layer: MediaLayer, asset: Asset, W: number, H: number): [number, number] {
  const w = even(layer.size.width * W);
  if (layer.size.height) return [w, even(layer.size.height * H)];
  if ((asset.type === "video" || asset.type === "image") && asset.width && asset.height) return [w, even((w * asset.height) / asset.width)];
  if (asset.type === "color" || asset.type === "gradient") return [w, even((w * H) / W)];
  return [w, even((w * 9) / 16)];
}


/**
 * The output frames a contact sheet of `count` pictures shows, as the FFmpeg backend's `select`
 * picks them (compile.ts): the first frame at or after the middle of the first of `count` equal
 * slices, then each frame at least a slice after the one picked before. `t` is the frame's time as
 * select sees it there: microseconds (the frames are on AV_TIME_BASE) times 1e-6, in doubles.
 */
export function contactSheetFrames(duration: number, fps: number, count: number): number[] {
  const frames = Math.ceil(duration * fps - 1e-6);
  const [first, step] = [round3(duration / count / 2), round3(duration / count)];
  const picked: number[] = [];
  let previous: number | undefined;
  for (let n = 0; n < frames && picked.length < count; n++) {
    const t = Math.round((n * 1e6) / fps) * 1e-6;
    if (previous === undefined ? t >= first : t - previous >= step) {
      picked.push(n);
      previous = t;
    }
  }
  return picked;
}

/** A piece's kind for compileProject, without the file names the plan gives it. */
type PieceKind = { kind: "clip"; frames: number } | { kind: "base"; frames: number } | { kind: "layer"; layerId: string; first: number; frames: number };
