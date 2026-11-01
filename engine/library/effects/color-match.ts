import { z } from "zod";
import { bakeColor, type EffectContext } from "./helpers.js";
import { ColorSettingsSchema, colorFilter, type ColorSettings } from "./color.js";

// Color science shared by the colorMatch effect and the shot matcher (tools/render/color-transfer.ts).
// All RGB values are sRGB / Rec.709 gamma-encoded in 0..1 unless named linear.

export type Vec3 = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** Oklab (Björn Ottosson, 2020) of a gamma-encoded RGB color. L is 0..1; a and b about -0.4..0.4. */
export function rgbToOklab([r, g, b]: Vec3): Vec3 {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Gamma-encoded RGB of an Oklab color, clipped to the RGB cube. */
export function oklabToRgb([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** CIELAB (D65) of a gamma-encoded RGB color, for color differences. */
export function rgbToLab([r, g, b]: Vec3): Vec3 {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t / 116 + 16 / 116);
  const x = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const y = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const z = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 color difference of two CIELAB colors (Sharma, Wu and Dalal, 2005). About 1 is just noticeable. */
export function deltaE2000([L1, a1, b1]: Vec3, [L2, a2, b2]: Vec3): number {
  const deg = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + G) * a1, (1 + G) * a2];
  const [Cp1, Cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / deg) + 360) % 360);
  const [hp1, hp2] = [hue(b1, ap1), hue(b2, ap2)];
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * deg);
  const Lm = (L1 + L2) / 2;
  const Cm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hm /= 2;
    else hm = hp1 + hp2 < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * deg) + 0.24 * Math.cos(2 * hm * deg) + 0.32 * Math.cos((3 * hm + 6) * deg) - 0.2 * Math.cos((4 * hm - 63) * deg);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cm;
  const SH = 1 + 0.015 * Cm * T;
  const Cm7p = Cm ** 7;
  const RT = -2 * Math.sqrt(Cm7p / (Cm7p + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * deg);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** The skin tone line of a Rec.709 vectorscope, in degrees (counterclockwise from +Cb). */
export const SKIN_LINE = 123;

/** Hue of a gamma-encoded RGB color on a Rec.709 vectorscope, in degrees (0..360, from +Cb toward +Cr). */
export function vectorscopeHue([r, g, b]: Vec3): number {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return ((Math.atan2((r - y) / 1.5748, (b - y) / 1.8556) * 180) / Math.PI + 360) % 360;
}

export const ColorTransferSchema = z.object({
  lightness: z
    .array(z.tuple([z.number(), z.number()]))
    .min(2)
    .describe("Oklab lightness curve as [in, out] points, inputs increasing from 0 to 1"),
  matrix: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("2x2 map of the Oklab a and b plane (row-major), around `from`"),
  from: z.tuple([z.number(), z.number()]).describe("Center of the shot's colors in Oklab a, b"),
  to: z.tuple([z.number(), z.number()]).describe("Where that center goes"),
  skin: z
    .object({
      hue: z.number().describe("Oklab hue of the skin after the transfer, degrees"),
      width: z.number().positive().describe("How far around that hue the correction reaches, degrees"),
      rotate: z.number().describe("Hue turn applied there, degrees"),
    })
    .optional()
    .describe("Turns skin hues back onto the skin line"),
});
export type ColorTransfer = z.infer<typeof ColorTransferSchema>;

export const ColorMatchParams = z.object({
  method: z.enum(["transfer", "reinhard", "curves"]).default("transfer").describe("How the match was fitted (see grade_scene)"),
  transfer: ColorTransferSchema.optional().describe("transfer and reinhard: the color transfer in Oklab"),
  curves: ColorSettingsSchema.shape.curves.optional().describe("curves: per-channel curves"),
  reference: z.string().optional().describe("The clip or image matched to, for the record"),
});
export type ColorMatch = z.infer<typeof ColorMatchParams>;

/** Oklab lightness through a curve of [in, out] points (linear between them). */
function curveAt(points: [number, number][], x: number): number {
  const v = Math.min(1, Math.max(0, x));
  let y = points[0]![1];
  for (let k = 0; k + 1 < points.length; k++) {
    const [[x0, y0], [x1, y1]] = [points[k]!, points[k + 1]!];
    if (x1 > x0) y += ((y1 - y0) / (x1 - x0)) * Math.min(Math.max(v - x0, 0), x1 - x0);
  }
  return Math.min(1, Math.max(0, y));
}

/** Oklab hue turn of the skin correction at a color, in radians. */
function skinTurn(skin: ColorTransfer["skin"], a: number, b: number): number {
  if (!skin) return 0;
  let d = Math.atan2(b, a) - (skin.hue * Math.PI) / 180;
  d -= 2 * Math.PI * Math.floor((d + Math.PI) / (2 * Math.PI));
  const w = Math.exp(-((d / ((skin.width * Math.PI) / 180)) ** 2)) * Math.min(1, Math.max(0, (Math.hypot(a, b) - 0.02) / 0.03));
  return (w * skin.rotate * Math.PI) / 180;
}

/** A color through a transfer, in Oklab. */
export function transferOklab(t: ColorTransfer, [L, a, b]: Vec3): Vec3 {
  const [da, db] = [a - t.from[0], b - t.from[1]];
  const a1 = t.to[0] + t.matrix[0] * da + t.matrix[1] * db;
  const b1 = t.to[1] + t.matrix[2] * da + t.matrix[3] * db;
  const th = skinTurn(t.skin, a1, b1);
  return [curveAt(t.lightness, L), a1 * Math.cos(th) - b1 * Math.sin(th), a1 * Math.sin(th) + b1 * Math.cos(th)];
}

/** A gamma-encoded RGB color through a transfer (what the colorMatch effect renders, before 8-bit rounding). */
export const transferRgb = (t: ColorTransfer, rgb: Vec3): Vec3 => oklabToRgb(transferOklab(t, rgbToOklab(rgb)));

const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1e6) / 1e6));

/**
 * The transfer as geq expressions on 0..255 RGB, the same math as transferRgb. Registers: 0..2 linear
 * RGB, then a' b' and the turn; 3..5 cone responses; 6 lightness; 7 and 8 the final a and b.
 */
export function transferExpressions(t: ColorTransfer): { r: string; g: string; b: string } {
  const lin = (c: string) => `if(lte(${c},0.04045),${c}/12.92,pow((${c}+0.055)/1.055,2.4))`;
  const curve = t.lightness
    .slice(0, -1)
    .map(([x0, y0], k) => {
      const [x1, y1] = t.lightness[k + 1]!;
      return x1 > x0 ? `+${n((y1 - y0) / (x1 - x0))}*clip(clip(ld(6),0,1)-${n(x0)},0,${n(x1 - x0)})` : "";
    })
    .join("");
  const steps = [
    `st(0,${lin("r(X,Y)/255")})`,
    `st(1,${lin("g(X,Y)/255")})`,
    `st(2,${lin("b(X,Y)/255")})`,
    "st(3,pow(0.4122214708*ld(0)+0.5363325363*ld(1)+0.0514459929*ld(2),1/3))",
    "st(4,pow(0.2119034982*ld(0)+0.6806995451*ld(1)+0.1073969566*ld(2),1/3))",
    "st(5,pow(0.0883024619*ld(0)+0.2817188376*ld(1)+0.6299787005*ld(2),1/3))",
    "st(6,0.2104542553*ld(3)+0.793617785*ld(4)-0.0040720468*ld(5))",
    `st(7,1.9779984951*ld(3)-2.428592205*ld(4)+0.4505937099*ld(5)-${n(t.from[0])})`,
    `st(8,0.0259040371*ld(3)+0.7827717662*ld(4)-0.808675766*ld(5)-${n(t.from[1])})`,
    `st(0,${n(t.to[0])}+${n(t.matrix[0])}*ld(7)+${n(t.matrix[1])}*ld(8))`,
    `st(1,${n(t.to[1])}+${n(t.matrix[2])}*ld(7)+${n(t.matrix[3])}*ld(8))`,
    `st(6,clip(${n(t.lightness[0]![1])}${curve},0,1))`,
  ];
  if (t.skin) {
    const [h, w] = [(t.skin.hue * Math.PI) / 180, (t.skin.width * Math.PI) / 180];
    steps.push(
      `st(2,atan2(ld(1),ld(0))-${n(h)})`,
      `st(2,ld(2)-2*PI*floor((ld(2)+PI)/(2*PI)))`,
      `st(2,exp(-pow(ld(2)/${n(w)},2))*clip((hypot(ld(0),ld(1))-0.02)/0.03,0,1)*${n((t.skin.rotate * Math.PI) / 180)})`,
      "st(7,ld(0)*cos(ld(2))-ld(1)*sin(ld(2)))",
      "st(8,ld(0)*sin(ld(2))+ld(1)*cos(ld(2)))",
    );
  } else steps.push("st(7,ld(0))", "st(8,ld(1))");
  // Cubes by multiplication: FFmpeg's pow() gives NaN for negative bases, which saturated colors reach.
  steps.push(
    "st(3,ld(6)+0.3963377774*ld(7)+0.2158037573*ld(8))",
    "st(4,ld(6)-0.1055613458*ld(7)-0.0638541728*ld(8))",
    "st(5,ld(6)-0.0894841775*ld(7)-1.291485548*ld(8))",
    "st(3,ld(3)*ld(3)*ld(3))",
    "st(4,ld(4)*ld(4)*ld(4))",
    "st(5,ld(5)*ld(5)*ld(5))",
  );
  const out = (lms: string) =>
    `'${[...steps, `st(0,clip(${lms},0,1))`, "255*if(lte(ld(0),0.0031308),12.92*ld(0),1.055*pow(ld(0),1/2.4)-0.055)"].join(";")}'`;
  return {
    r: out("4.0767416621*ld(3)-3.3077115913*ld(4)+0.2309699292*ld(5)"),
    g: out("-1.2684380046*ld(3)+2.6097574011*ld(4)-0.3413193965*ld(5)"),
    b: out("-0.0041960863*ld(3)-0.7034186147*ld(4)+1.707614701*ld(5)"),
  };
}

/** The colorMatch effect's filter: a transfer baked into a lookup table once, or the matched curves. */
export function colorMatchFilter(p: ColorMatch, ctx: EffectContext): string {
  if (p.method === "curves" || !p.transfer) return (p.curves && colorFilter({ curves: p.curves } as ColorSettings, ctx)) || "null";
  const e = transferExpressions(p.transfer);
  // One entry: bakeColor puts a format pin before each entry, and geq must get planar RGB.
  return bakeColor(ctx, [`format=gbrp,geq=r=${e.r}:g=${e.g}:b=${e.b}`]);
}
