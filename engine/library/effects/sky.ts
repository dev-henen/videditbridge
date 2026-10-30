import { z } from "zod";
import { numberExpr } from "../../core/keyframes.js";
import { clamp, round3, toFfmpegColor } from "../../core/util.js";
import { labeler, num, type EffectContext } from "./helpers.js";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** How the camera moved since the clip's start, at a moment: the frame center's shift (frame fractions), zoom and turn (degrees clockwise). */
export const SkyMotionSchema = z.object({
  time: z.number().min(0).describe("Seconds from the clip's start"),
  x: z.number(),
  y: z.number(),
  scale: z.number().positive().default(1),
  angle: z.number().default(0),
});

export const SkyReplaceParams = z.object({
  asset: z.string().optional().describe("Image or video asset of the new sky; omit for a gradient"),
  colors: z.tuple([hexColor, hexColor]).default(["#3E7FD8", "#A9CAEC"]).describe("Gradient top and bottom colors, used when there is no asset"),
  focus: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .default({ x: 0.5, y: 0.5 })
    .describe("Which part of the new sky picture shows when it is cropped to the frame (0 = left or top edge, 1 = right or bottom)"),
  motion: z.array(SkyMotionSchema).default([]).describe("The camera's motion, so the sky moves with the scene (replace_sky measures it)"),
  cover: num(1.1, 1, 3, "How much larger than the frame the new sky is drawn, so moving it never shows its edges (replace_sky sets it from the motion)"),
  gain: num(1, 0.25, 4, "Brightness of the new sky (replace_sky matches it to the old sky's)"),
  blur: num(0.6, 0, 20, "Soften the new sky to the scene's sharpness, in pixels at 1080p"),
  haze: num(0.35, 0, 1, "Horizon haze: the scene's horizon color over the new sky, fading up from the scenery"),
  hazeColor: hexColor.default("#C8D3DE").describe("Haze color (replace_sky uses the new sky's lowest part, paler)"),
  hazeHeight: num(0.1, 0.01, 0.5, "How far up the haze reaches, as a fraction of frame height"),
  relight: num(0.12, 0, 1, "Tint the scenery toward the new sky's color, so it seems lit by it (0.1 is subtle)"),
  lightColor: hexColor.default("#9DB7D9").describe("The new sky's color, for relight (replace_sky measures it)"),
  edge: num(0.001, -0.02, 0.02, "Grow the new sky over the scenery's outline by this fraction of frame height (at least a pixel), covering the old sky that edge pixels still hold; negative shrinks it, 0 leaves the matte as found"),
  feather: num(0.0015, 0, 0.05, "Edge softness as a fraction of frame height"),
});

export type SkyReplace = z.output<typeof SkyReplaceParams>;

const rgb = (hex: string) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255) as [number, number, number];

/** Per-channel gains that tint toward `color` by `amount`, keeping brightness (Rec.709 luma). */
export function relightGains(color: string, amount: number): [number, number, number] {
  const c = rgb(color);
  const luma = Math.max(0.05, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
  return c.map((v) => round3(clamp(1 + amount * (v / luma - 1), 0.5, 1.5))) as [number, number, number];
}

/** A vertical gradient from `colors[0]` at the top to `colors[1]` at the bottom, drawn once and held for `dur` seconds. */
function gradientSource(colors: [string, string], w: number, h: number, fps: number, dur: number): string {
  const [a, b] = [rgb(colors[0]), rgb(colors[1])];
  const ch = (i: number) => `'${round3(a[i]! * 255)}+${round3((b[i]! - a[i]!) * 255)}*Y/${Math.max(1, h - 1)}'`;
  return `nullsrc=s=${w}x${h}:r=${fps},trim=end_frame=1,format=gbrp,geq=r=${ch(0)}:g=${ch(1)}:b=${ch(2)},loop=loop=-1:size=1,trim=duration=${dur}`;
}

/** Sky replacement as a graph fragment reading and writing one stream: see the skyReplace effect. */
export function skyReplaceFilter(p: SkyReplace, ctx: EffectContext): string {
  const label = labeler(ctx);
  const { width: W, height: H, fps: F } = ctx;
  const mask = ctx.skyMask?.();
  if (!mask) throw new Error("Sky replacement works on primary video clips only (not on media layers or whole-video effects)");
  const plateIn = p.asset ? ctx.media?.(p.asset) : undefined;
  if (p.asset && !plateIn) throw new Error(`The new sky "${p.asset}" was not prepared for this clip`);
  const dur = round3(ctx.duration + 1);
  const [orig, ma, mh, alpha, weight, plate, canvas, sky, hc, hz, sky2, lit, top] = ["sro", "srm", "srh", "sra", "srw", "srp", "src", "srs", "srk", "srz", "srt", "srl", "srx"].map(label);
  const [PW, PH] = [Math.ceil((W * p.cover) / 2) * 2, Math.ceil((H * p.cover) / 2) * 2];
  const lines = [`format=yuv420p[${orig}]`, `[${mask}]format=gray,split=2[${ma}][${mh}]`];

  // The sky's matte, grown over the outline and softened.
  const passes = p.edge === 0 ? 0 : Math.min(12, Math.max(1, Math.round(Math.abs(p.edge) * H)));
  const sigma = round3(p.feather * H * 0.5);
  lines.push(`[${ma}]${["null", ...Array(passes).fill(p.edge > 0 ? "dilation" : "erosion"), sigma >= 0.3 && `gblur=sigma=${sigma}`].filter(Boolean).join(",")}[${alpha}]`);
  // Haze weight: the scenery spread upward into the sky, strongest along the horizon. The spread is
  // wide sideways and short upward, so it follows the skyline instead of glowing around tall things.
  lines.push(`[${mh}]negate,gblur=sigma=${round3(W * 0.06)}:sigmaV=${round3(Math.max(1, p.hazeHeight * H * 0.5))},lut=y='min(255,2*val)*${round3(p.haze)}'[${weight}]`);

  // The new sky, cropped to cover the frame with room to move, then moved with the camera.
  const source = plateIn
    ? `[${plateIn}]scale=${PW}:${PH}:force_original_aspect_ratio=increase,crop=${PW}:${PH}:(iw-ow)*${round3(p.focus.x)}:(ih-oh)*${round3(p.focus.y)}`
    : gradientSource(p.colors, PW, PH, F, dur);
  const keys = (pick: (k: SkyReplace["motion"][number]) => number) => p.motion.map((k) => ({ time: k.time, value: pick(k), easing: "linear" as const }));
  const moving = p.motion.length > 0;
  const zooms = moving && p.motion.some((k) => Math.abs(k.scale - 1) > 1e-3);
  const turns = moving && p.motion.some((k) => Math.abs(k.angle) > 0.01);
  lines.push(
    `${source},${[
      "setsar=1",
      p.gain !== 1 && `format=gbrp,colorchannelmixer=rr=${round3(p.gain)}:gg=${round3(p.gain)}:bb=${round3(p.gain)}`,
      p.blur > 0 && `gblur=sigma=${round3((p.blur * H) / 1080)}`,
      "format=yuv420p",
      turns && `rotate=a='(${numberExpr(keys((k) => k.angle), "t")})*PI/180':c=black`,
      zooms && `scale=w='2*trunc(iw*(${numberExpr(keys((k) => k.scale), "t")})/2)':h='2*trunc(ih*(${numberExpr(keys((k) => k.scale), "t")})/2)':eval=frame`,
    ]
      .filter(Boolean)
      .join(",")}[${plate}]`,
  );
  const dx = moving ? `+main_w*(${numberExpr(keys((k) => k.x), "t")})` : "";
  const dy = moving ? `+main_h*(${numberExpr(keys((k) => k.y), "t")})` : "";
  lines.push(`color=c=black:s=${W}x${H}:r=${F}:d=${dur}[${canvas}]`);
  lines.push(`[${canvas}][${plate}]overlay=x='(main_w-overlay_w)/2${dx}':y='(main_h-overlay_h)/2${dy}':eval=frame:shortest=1,format=yuv420p[${sky}]`);
  // Horizon haze over the new sky.
  if (p.haze > 0) {
    lines.push(`color=c=${toFfmpegColor(p.hazeColor)}:s=${W}x${H}:r=${F}:d=${dur},format=yuv420p[${hc}]`);
    lines.push(`[${hc}][${weight}]alphamerge[${hz}]`);
    lines.push(`[${sky}][${hz}]overlay=format=auto:shortest=1,format=yuv420p[${sky2}]`);
  } else lines.push(`[${weight}]nullsink`, `[${sky}]null[${sky2}]`);
  // The scenery, tinted toward the new sky.
  const [gr, gg, gb] = relightGains(p.lightColor, p.relight);
  lines.push(p.relight > 0 ? `[${orig}]format=gbrp,colorchannelmixer=rr=${gr}:gg=${gg}:bb=${gb},format=yuv420p[${lit}]` : `[${orig}]null[${lit}]`);
  lines.push(`[${sky2}][${alpha}]alphamerge[${top}]`);
  lines.push(`[${lit}][${top}]overlay=format=auto:shortest=1,format=yuv420p`);
  return lines.join(";");
}
