import path from "node:path";
import type { Asset, Clip, Effect, Fit, MediaLayer, Project } from "../../core/schema.js";
import { computeTimeline, type Timeline, type TimedClip } from "../../core/timeline.js";
import { round3, toFfmpegColor } from "../../core/util.js";
import { effectsToFilter, escapeFilterPath, type EffectContext } from "../../library/effects/index.js";
import { getTransition } from "../../library/transitions/index.js";
import { overlayMotion } from "../../library/animations/index.js";
import { AssDocument, addCaptionEvents } from "../captions/ass.js";
import { buildCaptions } from "../captions/build.js";
import { addShapeLayer, addTextLayer } from "./text.js";

export interface CompileOptions {
  /** Output file path. */
  output: string;
  /** Directory relative asset paths resolve against (default: cwd). */
  baseDir?: string;
  /** Downscale factor for fast previews, e.g. 0.5. */
  scale?: number;
  /** Directory with extra .ttf/.otf fonts for text and captions. */
  fontsDir?: string;
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
}

export const FILTER_SCRIPT = "graph.txt";
export const ASS_FILE = "overlay.ass";

const AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

/** atempo accepts 0.5-2 per instance; chain for larger factors. */
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${round3(s)}`);
  return out;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

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
  const k = opts.scale && opts.scale > 0 && opts.scale !== 1 ? opts.scale : 1;
  const W = even(project.settings.width * k);
  const H = even(project.settings.height * k);
  const bg = toFfmpegColor(project.settings.backgroundColor);
  const g = new GraphBuilder();
  const baseDir = opts.baseDir ?? process.cwd();
  const resolveSrc = (src: string) => (/^[a-z]+:\/\//i.test(src) ? src : path.resolve(baseDir, src));
  const total = timeline.duration;
  if (total <= 0) throw new Error("Project is empty: add clips, layers or audio before rendering");

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
  const fit = (input: string, fitMode: Fit, w: number, h: number, alpha: boolean): string => {
    const out = g.label("fit");
    const padColor = alpha ? "black@0" : bg;
    switch (fitMode) {
      case "cover":
        g.add(`[${input}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[${out}]`);
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

  const effectCtx = (duration: number, w = W, h = H): EffectContext => ({ width: w, height: h, fps: F, duration });
  const chain = (filters: (string | false | 0 | undefined)[]) => filters.filter(Boolean).join(",");

  // -------------------------------------------------------------------------
  // Primary track
  // -------------------------------------------------------------------------
  const clipStream = (tc: TimedClip): { v: string; a: string } => {
    const { clip, asset } = tc;
    const k = sourceInput(asset, clip.in, asset.type === "video" ? tc.sourceDuration : tc.duration);
    const raw = g.label("raw");
    const speed = asset.type === "video" ? clip.speed : 1;
    g.add(`[${k}:v]${chain(["setpts=PTS-STARTPTS", speed !== 1 && `setpts=PTS/${speed}`, `fps=${F}`])}[${raw}]`);
    const fitted = fit(raw, clip.fit, W, H, false);
    const v = g.label("v");
    g.add(
      `[${fitted}]${chain([
        ...effectsToFilter(clip.effects, effectCtx(tc.duration)),
        clip.fadeIn && `fade=t=in:st=0:d=${clip.fadeIn}`,
        clip.fadeOut && `fade=t=out:st=${round3(Math.max(0, tc.duration - clip.fadeOut))}:d=${clip.fadeOut}`,
        `fps=${F}`,
        "format=yuv420p",
        "setsar=1",
        // concat outputs AV_TIME_BASE; keep every segment on it so xfade inputs always match.
        "settb=AVTB",
      ])}[${v}]`,
    );
    const a = g.label("a");
    const hasAudio = asset.type === "video" && asset.hasAudio !== false && !clip.muted && clip.volume > 0;
    if (hasAudio) {
      g.add(
        `[${k}:a]${chain([
          "asetpts=PTS-STARTPTS",
          ...atempoChain(clip.speed),
          clip.volume !== 1 && `volume=${clip.volume}`,
          clip.fadeIn && `afade=t=in:st=0:d=${clip.fadeIn}`,
          clip.fadeOut && `afade=t=out:st=${round3(Math.max(0, tc.duration - clip.fadeOut))}:d=${clip.fadeOut}`,
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
        const xf = def?.xfade ?? "fade";
        const d = tc.transitionDuration;
        g.add(`[${vCur}][${next.v}]xfade=transition=${xf}:duration=${d}:offset=${round3(curDur - d)}[${vo}]`);
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

  if (project.effects.length) {
    const out = g.label("graded");
    g.add(`[${vCur}]${chain(effectsToFilter(project.effects, effectCtx(timeline.primaryDuration || total)))}[${out}]`);
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
    const motion = overlayMotion(
      `main_w*${layer.position.x}-overlay_w/2`,
      `main_h*${layer.position.y}-overlay_h/2`,
      layer.start,
      end,
      layer.animationIn,
      layer.animationOut,
    );
    g.add(`[${vCur}][${v}]overlay=x='${motion.x}':y='${motion.y}':enable='between(t,${layer.start},${end})':eof_action=pass[${out}]`);
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
    const k = sourceInput(asset, layer.in, layer.duration);
    const raw = g.label("lraw");
    g.add(`[${k}:v]setpts=PTS-STARTPTS,fps=${F},format=yuva420p[${raw}]`);
    const fitted = fit(raw, layer.size.height ? (layer.fit === "blur" ? "contain" : layer.fit) : "stretch", w, h, true);
    const v = g.label("lv");
    const fadeIn = layer.animationIn && layer.animationIn.type !== "none" ? layer.animationIn.duration : 0;
    const fadeOut = layer.animationOut && layer.animationOut.type !== "none" ? layer.animationOut.duration : 0;
    g.add(
      `[${fitted}]${chain([
        "format=yuva420p",
        ...effectsToFilter(layer.effects, effectCtx(layer.duration, w, h)),
        layer.opacity < 1 && `colorchannelmixer=aa=${layer.opacity}`,
        fadeIn && `fade=t=in:st=0:d=${fadeIn}:alpha=1`,
        fadeOut && `fade=t=out:st=${round3(Math.max(0, layer.duration - fadeOut))}:d=${fadeOut}:alpha=1`,
        `setpts=PTS+${layer.start}/TB`,
      ])}[${v}]`,
    );
    let a: string | undefined;
    if (asset.type === "video" && asset.hasAudio !== false && layer.volume > 0) {
      a = g.label("la");
      const ms = Math.round(layer.start * 1000);
      g.add(`[${k}:a]asetpts=PTS-STARTPTS,volume=${layer.volume},${AUDIO_FMT},adelay=${ms}|${ms}[${a}]`);
    }
    return { v, a };
  }

  // -------------------------------------------------------------------------
  // Text, shapes & captions (ASS via libass)
  // -------------------------------------------------------------------------
  const ass = new AssDocument(project.settings.width, project.settings.height, 0);
  project.layers.forEach((layer, i) => {
    if (layer.type === "text") addTextLayer(ass, layer, 10 + i);
    else if (layer.type === "shape") addShapeLayer(ass, layer, 10 + i);
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
  const files: CompiledRender["files"] = [];
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
  const voice: string[] = [aCur, ...overlayAudio];
  const duckedMusic: string[] = [];
  const otherAudio: string[] = [];
  for (const ta of timeline.audio) {
    const { clip, asset } = ta;
    if (ta.duration <= 0 || clip.volume === 0) continue;
    const srcDur = asset.type === "audio" || asset.type === "video" ? asset.duration : undefined;
    const loop = clip.loop && (srcDur === undefined || clip.in + ta.duration > srcDur);
    const k = sourceInput(asset, loop ? 0 : clip.in, ta.duration, loop);
    const label = g.label("au");
    const ms = Math.round(ta.start * 1000);
    g.add(
      `[${k}:a]${chain([
        "asetpts=PTS-STARTPTS",
        clip.volume !== 1 && `volume=${clip.volume}`,
        clip.fadeIn > 0 && `afade=t=in:st=0:d=${clip.fadeIn}`,
        clip.fadeOut > 0 && `afade=t=out:st=${round3(Math.max(0, ta.duration - clip.fadeOut))}:d=${clip.fadeOut}`,
        AUDIO_FMT,
        ms > 0 && `adelay=${ms}|${ms}`,
      ])}[${label}]`,
    );
    if (clip.role === "voiceover") voice.push(label);
    else if (clip.role === "music" && clip.duck !== false) duckedMusic.push(label);
    else otherAudio.push(label);
  }

  const mix = (labels: string[], duration: "first" | "longest"): string => {
    if (labels.length === 1) return labels[0]!;
    const out = g.label("mix");
    g.add(`${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:duration=${duration}:normalize=0[${out}]`);
    return out;
  };

  let voiceMix = mix(voice, "first");
  const finalInputs: string[] = [];
  const hasSpeech = voice.length > 1 || timeline.clips.some((c) => project.transcripts[c.clip.assetId] || (c.asset.type === "video" && c.asset.hasAudio !== false && !c.clip.muted));
  if (duckedMusic.length) {
    const music = mix(duckedMusic, "longest");
    if (hasSpeech) {
      const main = g.label("vmain");
      const sc = g.label("vsc");
      const ducked = g.label("duck");
      g.add(`[${voiceMix}]asplit=2[${main}][${sc}]`);
      g.add(`[${music}][${sc}]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350:makeup=1[${ducked}]`);
      voiceMix = main;
      finalInputs.push(voiceMix, ducked);
    } else {
      finalInputs.push(voiceMix, music);
    }
  } else {
    finalInputs.push(voiceMix);
  }
  finalInputs.push(...otherAudio);
  const aMixed = mix(finalInputs, "first");
  const aOut = "aout";
  g.add(`[${aMixed}]alimiter=limit=0.95:level=false,apad,atrim=duration=${total}[${aOut}]`);

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------
  const vOut = "vout";
  const sheet = opts.contactSheet;
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
      "-c:v",
      exp.videoCodec,
      "-preset",
      opts.preset ?? exp.preset,
      "-crf",
      String(exp.crf),
      "-pix_fmt",
      "yuv420p",
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
  return { args, files, filterGraph, timeline, duration };
}

/** Effects attached to a clip, layer or the whole project (helper for tooling). */
export function effectsOf(project: Project, target: string): Effect[] | undefined {
  if (target === "global") return project.effects;
  const clip: Clip | undefined = project.clips.find((c) => c.id === target);
  if (clip) return clip.effects;
  const layer = project.layers.find((l) => l.id === target);
  return layer && layer.type === "media" ? layer.effects : undefined;
}
