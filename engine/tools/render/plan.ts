import path from "node:path";
import type { Asset, Fit, MediaLayer, Project } from "../../core/schema.js";
import { computeTimeline, type TimedClip } from "../../core/timeline.js";
import { parseColor, round3, toFfmpegColor } from "../../core/util.js";
import { escapeFilterPath } from "../../library/effects/index.js";
import { getTransition } from "../../library/transitions/index.js";
import { ASS_FILE, rampPts, renderSize } from "./compile.js";
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
}

export interface PlanClip {
  item: number;
  /** Output frame showing the clip's frame 0, and how many frames it shows. */
  first: number;
  frames: number;
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
  transition?: { kind: "fade" | "fadeblack" | "fadewhite"; offset: number; duration: number };
}

export interface PlanLayer {
  item: number;
  start: number;
  end: number;
  /** Frames a still or generated source lasts (video layers end where their decoder does). */
  frames?: number;
  x: number;
  y: number;
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

/** Transitions the engine draws, by xfade name. */
const TRANSITIONS = new Set(["fade", "fadeblack", "fadewhite"]);
const FITS = new Set<Fit>(["cover", "contain", "stretch"]);

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** FFmpeg's crop, pad and overlay positions: truncated, then aligned to the 4:2:0 chroma grid. */
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
  if (project.effects.length) out.push(`whole-video effects (${project.effects.map((e) => e.type).join(", ")})`);
  const sized = (a: Asset | undefined, where: string) => {
    if ((a?.type === "video" || a?.type === "image") && !(a.width && a.height)) out.push(`${where}: size of asset "${a.id}" unknown (probe it first)`);
  };
  for (const clip of project.clips) {
    const where = `clip "${clip.id}"`;
    if (clip.effects.length) out.push(`${where}: effects (${clip.effects.map((e) => e.type).join(", ")})`);
    if (!FITS.has(clip.fit)) out.push(`${where}: fit ${clip.fit}`);
    if (clip.keyframes?.focus?.length) out.push(`${where}: moving crop focus`);
    if (clip.interpolate) out.push(`${where}: smooth motion`);
    const t = clip.transition && getTransition(clip.transition.type);
    if (clip.transition && (!t || t.custom || !TRANSITIONS.has(t.xfade))) out.push(`${where}: transition ${clip.transition.type}`);
    sized(project.assets.find((a) => a.id === clip.assetId), where);
  }
  for (const layer of project.layers) {
    if (layer.type !== "media") continue;
    const where = `layer "${layer.id}"`;
    if (layer.effects.length) out.push(`${where}: effects (${layer.effects.map((e) => e.type).join(", ")})`);
    if (layer.mask) out.push(`${where}: mask`);
    if (layer.behindSubject) out.push(`${where}: behind the subject`);
    if (layer.cornerRadius > 0) out.push(`${where}: rounded corners`);
    if (layer.shadow > 0) out.push(`${where}: shadow`);
    if (layer.rotateX || layer.rotateY) out.push(`${where}: 3D rotation`);
    if (Object.values(layer.keyframes ?? {}).some((k) => k?.length)) out.push(`${where}: keyframes`);
    for (const a of [layer.animationIn, layer.animationOut]) if (a?.type.startsWith("slide-")) out.push(`${where}: animation ${a.type}`);
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
      const [x1, y1] = asset.direction === "horizontal" ? [W, 0] : asset.direction === "diagonal" ? [W, H] : [0, H];
      const cols = asset.colors.map((c, i) => `c${i}=${toFfmpegColor(c)}`).join(":");
      const src = `gradients=s=${W}x${H}:r=${F}:n=${asset.colors.length}:${cols}:x0=0:y0=0:x1=${x1}:y1=${y1}:speed=0.00001`;
      return { source: decode(["-f", "lavfi", "-i", src], [], W, H, true), size: [W, H] };
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
    return { scaled: [sw, sh], offset: [-chromaAligned((sw - w) * fx), -chromaAligned((sh - h) * fy)] };
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
    const item = addItem({ source, width: W, height: H, ...fitBox(clip.fit, size, W, H, clip.focus), fill: background, opaque: true });
    let first = next;
    let transition: PlanClip["transition"];
    if (tc.index > 0 && tc.transitionDuration > 0) {
      const d = tc.transitionDuration;
      const offset = round3(curDur - d);
      first = Math.ceil(offset * F - 1e-6);
      transition = { kind: getTransition(clip.transition!.type)!.xfade as "fade", offset, duration: d };
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
    const item = addItem({ source, width: w, height: h, ...fitBox(fit, size, w, h), fill: [0, 0, 0, 0] });
    const fades = (a: MediaLayer["animationIn"]) => (a && a.type !== "none" ? a.duration : 0);
    layers.push({
      item,
      start: layer.start,
      end: round3(layer.start + layer.duration),
      // Stills loop for the layer's duration in the FFmpeg backend: that many frames.
      ...(asset.type === "video" ? {} : { frames: Math.ceil(layer.duration * F - 1e-6) }),
      x: chromaAligned(W * layer.position.x - w / 2),
      y: chromaAligned(H * layer.position.y - h / 2),
      opacity: layer.opacity,
      blend: layer.blend,
      fadeIn: fades(layer.animationIn),
      fadeOut: fades(layer.animationOut),
      duration: layer.duration,
    });
  }

  const exp = project.export;
  const fonts = opts.fontsDir ? `:fontsdir='${escapeFilterPath(path.resolve(opts.fontsDir))}'` : "";
  // Text goes on in YUV, as in the FFmpeg backend.
  const picture = ["format=yuv420p", opts.overlay && `ass=filename=${ASS_FILE}${fonts}`].filter(Boolean).join(",");
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
      output: { args },
    },
  };
}

/** The clip's timing filters after the in point, as in compileProject (speed, or a speed ramp). */
function retime(tc: TimedClip): string[] {
  if (tc.speedMap) return [`setpts='(${rampPts(tc.speedMap, tc.sourceDuration)})/TB'`];
  return tc.clip.speed !== 1 ? [`setpts=PTS/${tc.clip.speed}`] : [];
}

/** A media layer's size in output pixels, as mediaLayerStream computes it. */
function layerSize(layer: MediaLayer, asset: Asset, W: number, H: number): [number, number] {
  const w = even(layer.size.width * W);
  if (layer.size.height) return [w, even(layer.size.height * H)];
  if ((asset.type === "video" || asset.type === "image") && asset.width && asset.height) return [w, even((w * asset.height) / asset.width)];
  if (asset.type === "color" || asset.type === "gradient") return [w, even((w * H) / W)];
  return [w, even((w * 9) / 16)];
}

