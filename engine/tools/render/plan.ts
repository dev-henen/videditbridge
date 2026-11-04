import path from "node:path";
import type { Asset, Fit, MediaLayer, Project } from "../../core/schema.js";
import { computeTimeline, type TimedClip } from "../../core/timeline.js";
import { easeValue, numberAt, positionAt } from "../../core/keyframes.js";
import { parseColor, round3 } from "../../core/util.js";
import { effectsToFilter, escapeFilterPath } from "../../library/effects/index.js";
import { getTransition } from "../../library/transitions/index.js";
import { ASS_FILE, gradientSource, rampPts, renderSize } from "./compile.js";
import { cropPosition, effectsOps, lutArgs, type PlanOp } from "./plan-effects.js";
import { hardwareEncoderArgs, type HardwareEncoder } from "./hardware.js";

/**
 * Engine plans: a project turned into what the GPU render engine (native/ave-render) draws on every
 * frame. Like compileProject this is pure, and it follows the FFmpeg backend's timing and rounding
 * (frame counts, fit sizes, crop and overlay positions), so both backends give the same frames.
 * Keep the types in step with native/ave-render/src/plan.rs.
 */

export const PLAN_VERSION = 1;

export type PlanSource =
  | { kind: "decode"; width: number; height: number; args: string[]; still?: boolean }
  | { kind: "color"; color: [number, number, number, number] };

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
  /** Whole-video effects on the primary track (clips and transitions), before the layers; time counts in output frames. */
  effects?: PlanOp[];
  /** Transitions run on RGB, not YUV, in the FFmpeg backend (see transitionsInRgb). */
  rgbTransitions?: boolean;
  output: { args: string[] };
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
  fontsDir?: string;
  hardwareEncoder?: HardwareEncoder;
  extraOutputArgs?: string[];
}

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
 * What the engine cannot draw yet in a project, one line per feature and place (empty when it can
 * render the whole project). Those projects render with the FFmpeg backend.
 */
export function engineUnsupported(project: Project): string[] {
  const out: string[] = [];
  const { width, height, fps } = project.settings;
  const timeline = computeTimeline(project);
  const ctx = (duration: number) => ({ width, height, fps, duration });
  for (const r of effectsOps(project.effects, ctx(timeline.primaryDuration || timeline.duration), 1).unsupported) out.push(`whole-video effects: ${r}`);
  const sized = (a: Asset | undefined, where: string) => {
    if ((a?.type === "video" || a?.type === "image") && !(a.width && a.height)) out.push(`${where}: size of asset "${a.id}" unknown (probe it first)`);
  };
  for (const clip of project.clips) {
    const where = `clip "${clip.id}"`;
    const duration = timeline.clips.find((c) => c.clip === clip)?.duration ?? 1;
    for (const r of effectsOps(clip.effects, ctx(duration), 1).unsupported) out.push(`${where}: ${r}`);
    if (!FITS.has(clip.fit)) out.push(`${where}: fit ${clip.fit}`);
    if (clip.keyframes?.focus?.length) out.push(`${where}: moving crop focus`);
    if (clip.interpolate) out.push(`${where}: smooth motion`);
    const t = clip.transition && getTransition(clip.transition.type);
    if (clip.transition && (!t || (t.custom ? t.id !== "circlereveal" : !TRANSITIONS.has(t.xfade)))) out.push(`${where}: transition ${clip.transition.type}`);
    sized(project.assets.find((a) => a.id === clip.assetId), where);
  }
  for (const layer of project.layers) {
    if (layer.type !== "media") continue;
    const where = `layer "${layer.id}"`;
    const asset = project.assets.find((a) => a.id === layer.assetId);
    if (layer.effects.length && asset) {
      // Effects run on the layer's own picture, at its size and with its transparency.
      const [w, h] = layerSize(layer, asset, width, height);
      for (const r of effectsOps(layer.effects, { width: w, height: h, fps, duration: layer.duration, alpha: true }, 1).unsupported) out.push(`${where}: ${r}`);
    }
    if (layer.mask) out.push(`${where}: mask`);
    if (layer.behindSubject) out.push(`${where}: behind the subject`);
    if (layer.cornerRadius > 0) out.push(`${where}: rounded corners`);
    if (layer.shadow > 0) out.push(`${where}: shadow`);
    if (layer.rotateX || layer.rotateY) out.push(`${where}: 3D rotation`);
    for (const [name, keys] of Object.entries(layer.keyframes ?? {})) if (keys?.length && !["position", "opacity"].includes(name)) out.push(`${where}: ${name} keyframes`);
    sized(project.assets.find((a) => a.id === layer.assetId), where);
  }
  return out;
}

/** The engine plan of a project, or what it uses that the engine cannot draw yet. */
export function planProject(project: Project, opts: PlanOptions): { plan: EnginePlan; unsupported?: undefined } | { plan?: undefined; unsupported: string[] } {
  const unsupported = engineUnsupported(project);
  if (unsupported.length) return { unsupported };
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
   * Frames of a source as RGBA on stdout. The YUV to RGB matrix is fixed to the one the encoder uses
   * back (swscale's BT.601 default), so YUV values come out as they went in, as in the FFmpeg backend.
   */
  const decode = (input: string[], filters: (string | false | undefined)[], width: number, height: number, still = false): PlanSource => ({
    kind: "decode",
    width,
    height,
    still,
    args: [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      ...input,
      "-an", "-sn",
      "-vf", [...filters, `scale=${width}:${height}:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int`, "format=vuya"].filter(Boolean).join(","),
      ...(still ? ["-frames:v", "1"] : []),
      "-f", "rawvideo", "-pix_fmt", "vuya", "pipe:1",
    ],
  });
  /** A still or generated source for `duration` seconds (images, colors, gradients), as the FFmpeg backend makes them. */
  const stillSource = (asset: Asset): { source: PlanSource; size: [number, number] } | undefined => {
    if (asset.type === "color") return { source: { kind: "color", color: rgba(asset.color) }, size: [W, H] };
    if (asset.type === "image") return { source: decode(["-i", resolveSrc(asset.src)], [], asset.width!, asset.height!, true), size: [asset.width!, asset.height!] };
    if (asset.type === "gradient") {
      return { source: decode(["-f", "lavfi", "-i", gradientSource(asset, W, H, F)], [], W, H, true), size: [W, H] };
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

  // Primary track, with the FFmpeg backend's frame counts and xfade offsets.
  const clips: PlanClip[] = [];
  let curDur = 0;
  let next = 0;
  for (const tc of timeline.clips) {
    const { clip, asset } = tc;
    const frames = Math.max(1, Math.ceil(tc.end * F - 1e-6) - Math.ceil(tc.start * F - 1e-6));
    let source: PlanSource;
    let size: [number, number];
    if (asset.type === "video") {
      size = [asset.width!, asset.height!];
      source = decode(
        [...(clip.in > 0 ? ["-ss", String(round3(clip.in))] : []), "-t", String(round3(tc.sourceDuration)), "-i", resolveSrc(asset.src)],
        [clip.reverse && "reverse", "setpts=PTS-STARTPTS", ...retime(tc), `fps=${F}`, "tpad=stop_mode=clone:stop=-1", `trim=end_frame=${frames}`],
        size[0],
        size[1],
      );
    } else {
      const s = stillSource(asset);
      if (!s) throw new Error(`Clip "${clip.id}" uses audio asset "${asset.id}" as a picture`);
      ({ source, size } = s);
    }
    const { ops } = effectsOps(clip.effects, { width: W, height: H, fps: F, duration: tc.duration }, frames);
    // fit blur, as compileProject's fit draws it: the picture contained over a cover copy blurred
    // (gblur sigma 40) and darkened (eq brightness -0.08).
    const blur = clip.fit === "blur";
    const item = addItem({
      source,
      width: W,
      height: H,
      ...fitBox(blur ? "contain" : clip.fit, size, W, H, clip.focus),
      fill: blur ? [0, 0, 0, 0] : background,
      opaque: true,
      ...(ops.length ? { effects: ops } : {}),
      ...(blur ? { backdrop: { ...fitBox("cover", size, W, H), effects: [{ op: "blur", sigma: 40 }, { op: "lut", args: lutArgs(["eq=brightness=-0.08"]) }] as PlanOp[] } } : {}),
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
  for (const layer of project.layers) {
    if (layer.type !== "media") continue;
    const asset = project.assets.find((a) => a.id === layer.assetId);
    if (!asset) throw new Error(`Layer "${layer.id}" references unknown asset "${layer.assetId}"`);
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
      );
    } else {
      const s = stillSource(asset);
      if (!s) throw new Error(`Layer "${layer.id}" uses audio asset "${asset.id}" as a picture`);
      ({ source, size } = s);
    }
    const fit: Fit = layer.size.height ? (layer.fit === "blur" ? "contain" : layer.fit) : "stretch";
    const { ops } = effectsOps(layer.effects, { width: w, height: h, fps: F, duration: layer.duration, alpha: true }, Math.max(1, Math.ceil(layer.duration * F - 1e-6)));
    const item = addItem({ source, width: w, height: h, ...fitBox(fit, size, w, h), fill: [0, 0, 0, 0], ...(ops.length ? { effects: ops } : {}) });
    const fades = (a: MediaLayer["animationIn"]) => (a && a.type !== "none" ? a.duration : 0);
    layers.push({
      item,
      start: layer.start,
      end: round3(layer.start + layer.duration),
      // Stills loop for the layer's duration in the FFmpeg backend: that many frames.
      ...(asset.type === "video" ? {} : { frames: Math.ceil(layer.duration * F - 1e-6) }),
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

  const exp = project.export;
  const fonts = opts.fontsDir ? `:fontsdir='${escapeFilterPath(path.resolve(opts.fontsDir))}'` : "";
  // Text goes on in YUV, as in the FFmpeg backend, on frames timed in AV_TIME_BASE as the backend's are:
  // libass takes whole milliseconds, so a frame exactly at an event's start can land on either side of it.
  const picture = ["settb=AVTB", "format=yuv420p", opts.overlay && `ass=filename=${ASS_FILE}${fonts}`].filter(Boolean).join(",");
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "rawvideo", "-pix_fmt", "vuya", "-s", `${W}x${H}`, "-r", String(F), "-i", "pipe:0",
    ...(opts.audio ? ["-i", path.resolve(opts.audio)] : []),
    "-filter_complex", `[0:v]${picture}[v]`,
    "-map", "[v]",
    ...(opts.audio ? ["-map", "1:a"] : []),
    ...(opts.hardwareEncoder
      ? hardwareEncoderArgs(opts.hardwareEncoder, exp.crf)
      : ["-c:v", exp.videoCodec, "-preset", opts.preset ?? exp.preset, "-crf", String(exp.crf), "-pix_fmt", "yuv420p"]),
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
      ...(transitionsInRgb(project, W, H) ? { rgbTransitions: true } : {}),
      ...(() => {
        const { ops } = effectsOps(project.effects, { width: W, height: H, fps: F, duration: timeline.primaryDuration || total }, Math.ceil(total * F - 1e-6));
        return ops.length ? { effects: ops } : {};
      })(),
      output: { args },
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

