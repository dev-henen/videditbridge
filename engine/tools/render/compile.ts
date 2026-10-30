import path from "node:path";
import type { Asset, BlendMode, Clip, Effect, Fit, Keyframe, MediaLayer, Position, Project } from "../../core/schema.js";
import { numberExpr, positionExpr } from "../../core/keyframes.js";
import { computeTimeline, type SpeedMap, type Timeline, type TimedClip } from "../../core/timeline.js";
import { round3, toFfmpegColor } from "../../core/util.js";
import { effectObjects, effectsToFilter, escapeFilterPath, maskStreams, perClipGlobalEffects, type EffectContext } from "../../library/effects/index.js";
import { getTransition } from "../../library/transitions/index.js";
import { atempoChain, audioEffectsToFilter } from "../../library/audio-effects/index.js";
import { overlayMotion } from "../../library/animations/index.js";
import { AssDocument, addCaptionEvents } from "../captions/ass.js";
import { buildCaptions } from "../captions/build.js";
import { addShapeLayer, addTextLayer } from "./text.js";
import { hardwareEncoderArgs, type HardwareEncoder } from "./hardware.js";
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
  /** The FFmpeg build has the rubberband filter, used for speed ramps' sound (see rampTempo). */
  rubberband?: boolean;
  /** Encode the video on the graphics card instead of with x264, at matching quality. */
  hardwareEncoder?: HardwareEncoder;
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
export const SEGMENT_CODEC = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p"];

const AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
/** Seconds of crossfade where a J or L cut hands the sound from one clip to the other (no click). */
const SPLIT_FADE = 0.03;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * FFmpeg blend modes for each layer blend. The picture under the layer is blend's first input, so
 * modes that depend on order (overlay, colordodge) follow the usual definitions with it as the backdrop.
 */
const BLEND_MODES: Record<Exclude<BlendMode, "normal">, string> = {
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
function rampPts(map: SpeedMap, sourceDuration: number): string {
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
const previewScale = (scale?: number) => (scale && scale > 0 && scale !== 1 ? scale : 1);

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
      case "gradient": {
        const [x1, y1] = asset.direction === "horizontal" ? [W, 0] : asset.direction === "diagonal" ? [W, H] : [0, H];
        const cols = asset.colors.map((c, i) => `c${i}=${toFfmpegColor(c)}`).join(":");
        return g.addInput([
          "-f",
          "lavfi",
          "-t",
          String(round3(duration)),
          "-i",
          `gradients=s=${W}x${H}:r=${F}:n=${asset.colors.length}:${cols}:x0=0:y0=0:x1=${x1}:y1=${y1}:speed=0.00001`,
        ]);
      }
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

  const effectCtx = (duration: number, w = W, h = H, alpha = false): EffectContext => ({
    width: w,
    height: h,
    fps: F,
    duration,
    alpha,
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
    const frames = Math.max(1, Math.ceil(tc.end * F - 1e-6) - Math.ceil(tc.start * F - 1e-6));
    const exact = opts.segment ? [] : ["tpad=stop_mode=clone:stop=-1", `trim=end_frame=${frames}`];
    // concat outputs AV_TIME_BASE; keep every segment on it so xfade inputs always match.
    const finish = [`fps=${F}`, "format=yuv420p", "setsar=1", ...exact, "settb=AVTB"];
    if (cached) {
      g.add(`[${g.addInput(["-i", cached])}:v]${chain(["setpts=PTS-STARTPTS", ...finish])}[${v}]`);
    } else {
      const raw = g.label("raw");
      const speed = asset.type === "video" ? clip.speed : 1;
      // A speed ramp maps each frame's source time through the clip's time map.
      const retime = tc.speedMap ? `setpts='(${rampPts(tc.speedMap, tc.sourceDuration)})/TB'` : speed !== 1 && `setpts=PTS/${speed}`;
      const timing = (input: string) => `[${input}]${chain([clip.reverse && "reverse", "setpts=PTS-STARTPTS", retime, `fps=${F}`])}`;
      g.add(`${timing(`${k}:v`)}[${raw}]`);
      const fitted = fit(raw, clip.fit, W, H, false, clip.focus, clip.keyframes?.focus);
      // Person cutouts and face masks go through the same timing and fit as the picture, so they line up.
      // A ramped effect runs once per state, and each run (and the effect's mask) takes its own copy.
      const modelMasks = (count: number, file: string | undefined): string[] => {
        if (!count || !file) return [];
        const mraw = g.label("mraw");
        g.add(`${timing(`${g.addInput(["-i", file])}:v`)},format=gray[${mraw}]`);
        const mfit = fit(mraw, clip.fit, W, H, true, clip.focus, clip.keyframes?.focus);
        const labels = Array.from({ length: count }, () => g.label("mask"));
        g.add(`[${mfit}]format=gray${count > 1 ? `,split=${count}` : ""}${labels.map((l) => `[${l}]`).join("")}`);
        return labels;
      };
      const streams = (kind: "person" | "face") => clip.effects.reduce((n, e) => n + maskStreams(e, kind), 0);
      const personLabels = modelMasks(streams("person"), opts.masks?.[clip.id]);
      const faceLabels = modelMasks(streams("face"), opts.faceMasks?.[clip.id]);
      // Tracked objects: one stream per effect that uses each.
      const objectLabels = new Map<string, string[]>();
      for (const id of new Set(clip.effects.flatMap(effectObjects))) {
        const labels = modelMasks(clip.effects.filter((e) => effectObjects(e).includes(id)).length, opts.objectMasks?.[clip.id]?.[id]);
        if (labels.length) objectLabels.set(id, labels);
      }
      const clipEffects = effectsToFilter(clip.effects, {
        ...effectCtx(tc.duration),
        ...(personLabels.length ? { personMask: () => personLabels.shift() } : {}),
        ...(faceLabels.length ? { faceMask: () => faceLabels.shift() } : {}),
        ...(objectLabels.size ? { objectMask: (id: string) => objectLabels.get(id)?.shift() } : {}),
      });
      // Any mask an effect did not take still has to be consumed.
      for (const l of [...personLabels, ...faceLabels, ...[...objectLabels.values()].flat()]) g.add(`[${l}]nullsink`);
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
    g.add(`color=c=${bg}:s=${W}x${H}:r=${F}:d=${total},format=yuv420p,setsar=1[${vCur}]`);
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

  if (joinedEffects.length && !opts.segment) {
    const out = g.label("graded");
    g.add(`[${vCur}]${chain(effectsToFilter(joinedEffects, effectCtx(timeline.primaryDuration || total)))}[${out}]`);
    vCur = out;
  }

  // -------------------------------------------------------------------------
  // Media overlays
  // -------------------------------------------------------------------------
  const overlayAudio: string[] = [];
  project.layers.forEach((layer) => {
    if (layer.type !== "media") return;
    const asset = project.assets.find((a) => a.id === layer.assetId);
    if (!asset) throw new Error(`Layer "${layer.id}" references unknown asset "${layer.assetId}"`);
    const { v, a } = mediaLayerStream(layer, asset);
    const out = g.label("ov");
    const end = round3(layer.start + layer.duration);
    // Position keyframes count from the layer's start; overlay's t is timeline time.
    const keys = layer.keyframes?.position;
    const moving = keys?.length ? positionExpr(keys, `(t-${layer.start})`) : undefined;
    const motion = overlayMotion(
      `main_w*${moving ? `(${moving.x})` : layer.position.x}-overlay_w/2`,
      `main_h*${moving ? `(${moving.y})` : layer.position.y}-overlay_h/2`,
      layer.start,
      end,
      layer.animationIn,
      layer.animationOut,
    );
    const enable = `enable='between(t,${layer.start},${end})'`;
    if (layer.blend === "normal") {
      g.add(`[${vCur}][${v}]overlay=x='${motion.x}':y='${motion.y}':${enable}:eof_action=pass[${out}]`);
    } else {
      // blend ignores alpha and position: place the layer on a clear frame-size canvas, blend the
      // whole frame in RGB, then show the result only through the layer's alpha (opacity and fades
      // included).
      const [base, under, canvas, placed, color, alpha, top, mixed, cut] = ["lbb", "lbu", "lbc", "lbp", "lbr", "lba", "lbt", "lbm", "lbx"].map((p) => g.label(p));
      g.add(`[${vCur}]split=2[${base}][${under}]`);
      g.add(`color=c=black@0:s=${W}x${H}:r=${F}:d=${total},format=yuva420p[${canvas}]`);
      g.add(`[${canvas}][${v}]overlay=x='${motion.x}':y='${motion.y}':${enable}:eof_action=pass:format=auto,format=gbrap,split=2[${placed}][${alpha}]`);
      g.add(`[${placed}]format=gbrp[${color}]`);
      // Nearest-neighbor chroma both ways makes the round trip exact, so a black screen layer changes nothing.
      g.add(`[${under}]scale=flags=neighbor,format=gbrp[${top}]`);
      g.add(`[${top}][${color}]blend=all_mode=${BLEND_MODES[layer.blend]}:${enable},scale=flags=neighbor,format=yuv420p[${mixed}]`);
      g.add(`[${alpha}]alphaextract[${cut}]`);
      const shown = g.label("lbs");
      g.add(`[${mixed}][${cut}]alphamerge[${shown}]`);
      g.add(`[${base}][${shown}]overlay=format=auto:shortest=1:${enable},format=yuv420p[${out}]`);
    }
    vCur = out;
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
    g.add(`[${input}:v]setpts=PTS-STARTPTS,fps=${F},format=yuva420p[${raw}]`);
    const fitted = fit(raw, layer.size.height ? (layer.fit === "blur" ? "contain" : layer.fit) : "stretch", w, h, true);
    let styled = g.label("lfx");
    g.add(`[${fitted}]${chain(["format=yuva420p", ...effectsToFilter(layer.effects, effectCtx(layer.duration, w, h, true))])}[${styled}]`);
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
    // Drop shadow: a blurred black silhouette, offset down, under the layer. Padding keeps the center in place.
    const shadow = Math.round(layer.shadow * k);
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
    if (layer.rotateX || layer.rotateY || tiltKeys?.length || turnKeys?.length) {
      const [pw, ph] = [even(w * 1.8), even(h * 1.8)];
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
    const { rotation: rotationKeys, scale: scaleKeys, opacity: opacityKeys } = layer.keyframes ?? {};
    const fadeIn = layer.animationIn && layer.animationIn.type !== "none" ? layer.animationIn.duration : 0;
    const fadeOut = layer.animationOut && layer.animationOut.type !== "none" ? layer.animationOut.duration : 0;
    g.add(
      `[${styled}]${chain([
        "format=yuva420p",
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
    let a: string | undefined;
    if (asset.type === "video" && asset.hasAudio !== false && layer.volume > 0) {
      a = g.label("la");
      const ms = Math.round(layer.start * 1000);
      g.add(
        `[${input}:a]${chain(["asetpts=PTS-STARTPTS", ...audioEffectsToFilter(layer.audioEffects), `volume=${layer.volume}`, AUDIO_FMT, `adelay=${ms}|${ms}`])}[${a}]`,
      );
    }
    return { v, a };
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
  if (!ass.isEmpty) {
    files.push({ name: ASS_FILE, content: ass.toString() });
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
  if (opts.segment) {
    g.add(`[${vCur}]format=yuv420p[${vOut}]`);
    g.add(`[${aOut}]anullsink`);
    const filterGraph = g.lines.join(";\n");
    files.push({ name: FILTER_SCRIPT, content: filterGraph });
    const args = [
      "-y", "-hide_banner", "-loglevel", "error", "-stats",
      ...g.inputArgs,
      "-filter_complex_script", FILTER_SCRIPT,
      "-map", `[${vOut}]`,
      ...SEGMENT_CODEC,
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
    g.add(`[${vCur}]format=yuv420p[${vOut}]`);
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
      ...(opts.hardwareEncoder
        ? hardwareEncoderArgs(opts.hardwareEncoder, exp.crf)
        : ["-c:v", exp.videoCodec, "-preset", opts.preset ?? exp.preset, "-crf", String(exp.crf), "-pix_fmt", "yuv420p"]),
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
