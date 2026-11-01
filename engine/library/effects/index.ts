import { z } from "zod";
import { MaskSchema, type Easing, type Effect } from "../../core/schema.js";
import { easeValue } from "../../core/keyframes.js";
import { clamp, round3, toFfmpegColor } from "../../core/util.js";
import { bakeColor, define, maskBranch, maskedBlend, num, personBlend, rampFilter, SubjectRegionSchema, zoompan, type EffectCategory, type EffectContext, type EffectDefinition } from "./helpers.js";
import { motionEffects } from "./motion.js";
import { customEffect } from "./custom.js";
import { maskIsTemporal, maskNeeds, maskObjects, maskViewFilter, maskedEffect } from "./masks.js";
import { SkyReplaceParams, skyReplaceFilter } from "./sky.js";

export { CUSTOM_FILTERS, checkCustomFilter } from "./custom.js";
import { ColorSettingsSchema, colorFilter, type ColorSettings } from "./color.js";

export * from "./color.js";
export * from "./helpers.js";
export * from "./masks.js";
export * from "./sky.js";
export * from "./color-match.js";
import { ColorMatchParams, colorMatchFilter } from "./color-match.js";


const GRADES: Record<string, { name: string; description: string; filter: string }> = {
  cinematic: {
    name: "Cinematic",
    description: "Teal shadows, warm highlights, slightly crushed contrast",
    filter: "colorbalance=rs=-0.08:gs=-0.02:bs=0.1:rh=0.08:gh=0.02:bh=-0.08,eq=contrast=1.1:saturation=0.9",
  },
  tealOrange: {
    name: "Teal & Orange",
    description: "Strong blockbuster teal/orange split toning",
    filter: "colorbalance=rs=-0.15:bs=0.15:rm=0.05:rh=0.15:bh=-0.15,eq=saturation=1.15",
  },
  warm: { name: "Warm", description: "Golden, cozy tone", filter: "colortemperature=temperature=4500,eq=saturation=1.05" },
  cool: { name: "Cool", description: "Clean, blue-ish modern tone", filter: "colortemperature=temperature=8000" },
  vintage: {
    name: "Vintage",
    description: "Faded film look with lifted blacks and warm tint",
    filter: "curves=preset=vintage,eq=saturation=0.85",
  },
  noir: { name: "Noir", description: "High-contrast black & white", filter: "hue=s=0,eq=contrast=1.35:brightness=-0.03" },
  vibrant: { name: "Vibrant", description: "Punchy saturated social-media look", filter: "eq=saturation=1.35:contrast=1.08" },
  faded: {
    name: "Faded",
    description: "Matte, low-contrast pastel look",
    filter: "curves=all='0/0.08 1/0.92',eq=saturation=0.8",
  },
  moody: {
    name: "Moody",
    description: "Dark, desaturated and slightly green-teal",
    filter: "eq=brightness=-0.05:contrast=1.15:saturation=0.7,colorbalance=gs=0.03:bs=0.05",
  },
  bright: { name: "Bright & Airy", description: "Lifted exposure, soft contrast", filter: "eq=brightness=0.06:contrast=0.95:saturation=1.05" },
  sunset: {
    name: "Sunset",
    description: "Magenta-orange golden hour",
    filter: "colorbalance=rm=0.1:bm=0.05:rh=0.12:gh=0.02,colortemperature=temperature=5000",
  },
  matrix: { name: "Matrix", description: "Green-tinted digital look", filter: "colorbalance=rs=-0.1:gs=0.15:bs=-0.1:gm=0.1,eq=contrast=1.1" },
  crossProcess: { name: "Cross Process", description: "Experimental film cross-processing", filter: "curves=preset=cross_process" },
};

const gradeEffects = Object.entries(GRADES).map(([id, g]) =>
  define({
    id,
    name: g.name,
    category: "grade",
    perFrame: true,
    description: `Color grade: ${g.description}.`,
    params: z.object({}),
    toFilter: (_p, ctx) => bakeColor(ctx, g.filter.split(",")),
  }),
);

export const EFFECTS: EffectDefinition[] = [
  // --- color ----------------------------------------------------------------
  define({
    id: "adjust",
    name: "Adjust",
    category: "color",
    perFrame: true,
    description: "Basic color correction: brightness, contrast, saturation, gamma.",
    params: z.object({
      brightness: num(0, -1, 1, "-1..1, 0 = unchanged"),
      contrast: num(1, 0, 3, "1 = unchanged"),
      saturation: num(1, 0, 3, "1 = unchanged, 0 = grayscale"),
      gamma: num(1, 0.1, 3, "1 = unchanged"),
    }),
    toFilter: (p) => `eq=brightness=${p.brightness}:contrast=${p.contrast}:saturation=${p.saturation}:gamma=${p.gamma}`,
  }),
  define({
    id: "temperature",
    name: "Temperature",
    category: "color",
    perFrame: true,
    description: "White balance. Lower kelvin = warmer, higher = cooler.",
    params: z.object({ kelvin: num(6500, 1000, 40000, "Color temperature in kelvin (6500 = neutral)") }),
    toFilter: (p) => `colortemperature=temperature=${p.kelvin}`,
  }),
  define({
    id: "grayscale",
    name: "Black & White",
    category: "color",
    perFrame: true,
    description: "Remove all color.",
    params: z.object({}),
    toFilter: () => "hue=s=0",
  }),
  define({
    id: "sepia",
    name: "Sepia",
    category: "color",
    perFrame: true,
    description: "Old-photo brown tone.",
    params: z.object({}),
    toFilter: () => "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
  }),
  define({
    id: "invert",
    name: "Invert",
    category: "color",
    perFrame: true,
    description: "Negative image.",
    params: z.object({}),
    toFilter: () => "negate",
  }),
  define({
    id: "hueShift",
    name: "Hue Shift",
    category: "color",
    perFrame: true,
    description: "Rotate all hues.",
    params: z.object({ degrees: num(90, -180, 180, "Hue rotation in degrees") }),
    toFilter: (p) => `hue=h=${p.degrees}`,
  }),
  define({
    id: "tint",
    name: "Tint",
    category: "color",
    perFrame: true,
    description: "Wash the image with a color.",
    params: z.object({
      color: z.string().default("#FF8800").describe("Tint color #RRGGBB"),
      strength: num(0.3, 0, 1, "0..1"),
    }),
    toFilter: (p) => {
      const c = toFfmpegColor(p.color).slice(2);
      const r = parseInt(c.slice(0, 2), 16) / 255;
      const g = parseInt(c.slice(2, 4), 16) / 255;
      const b = parseInt(c.slice(4, 6), 16) / 255;
      return `colorize=hue=${Math.round(rgbToHue(r, g, b))}:saturation=${round3(p.strength)}:lightness=0.5:mix=${round3(p.strength)}`;
    },
  }),
  define({
    id: "lut",
    name: "LUT",
    category: "grade",
    perFrame: true,
    description: "Apply a 3D LUT file (.cube/.3dl) for a custom grade.",
    params: z.object({ file: z.string().describe("Path to a .cube or .3dl LUT file") }),
    toFilter: (p) => `lut3d=file='${escapeFilterPath(p.file)}'`,
  }),
  ...gradeEffects,
  ...colorEffects(),

  // --- retouch --------------------------------------------------------------------
  define({
    id: "beauty",
    name: "Beauty / Skin Retouch",
    category: "retouch",
    perFrame: true,
    description:
      "Portrait retouch: edge-preserving skin smoothing that keeps eyes, hair and outlines sharp, plus optional brightening and warmth. Applies to the whole frame, only inside a face region (x, y, width, height as frame fractions; check placement with render_frame), or, with followFace, only on the faces wherever they move (found on every frame of primary video clips).",
    params: z.object({
      smooth: num(50, 0, 100, "Skin smoothing strength"),
      brighten: num(15, 0, 100, "Lift and even out skin tones"),
      warmth: num(10, -100, 100, "+ warmer, healthier skin, - cooler"),
      region: SubjectRegionSchema.optional().describe("Only retouch inside this ellipse (the face); omit for the whole frame"),
      followFace: z.boolean().default(false).describe("Retouch only the faces, following them frame by frame (primary video clips; elsewhere region applies)"),
    }),
    usesFaceMask: (p) => p.followFace,
    toFilter: (p, ctx) => {
      const s = p.smooth / 100;
      const scale = Math.min(ctx.width, ctx.height) / 1080;
      const retouched = [
        s > 0 && `bilateral=sigmaS=${round3((2 + 10 * s) * scale)}:sigmaR=${round3(0.04 + 0.08 * s)}:planes=7`,
        p.brighten > 0 && `eq=brightness=${round3(p.brighten * 0.0006)}:gamma=${round3(1 + p.brighten * 0.002)}`,
        p.warmth !== 0 && `colortemperature=temperature=${Math.round(6500 - p.warmth * 15)}`,
      ];
      if (!retouched.some(Boolean)) return "null";
      // Smoothing is blended back over the original so detail survives even at full strength.
      const strength = 0.55 + 0.4 * Math.max(s, 0.25);
      const mask = p.followFace && !ctx.alpha ? ctx.faceMask?.() : undefined;
      if (mask) return maskBranch(ctx, mask, retouched.filter(Boolean).join(","), 0.3, strength);
      return maskedBlend(ctx, retouched.filter(Boolean).join(","), {
        region: p.region,
        inside: true,
        strength: 0.55 + 0.4 * Math.max(s, 0.25),
      });
    },
  }),
  define({
    id: "backgroundBlur",
    name: "Background Blur / Portrait Mode",
    category: "retouch",
    perFrame: true,
    description:
      "Keep the subject sharp and blur everything around it, like a portrait-mode lens. With cutout, the person's real outline is found on every frame (on primary clips) and followed as they move; otherwise an ellipse (x, y = its center, width, height as frame fractions) stays sharp. A larger feather gives a softer, more natural edge.",
    params: z.object({
      amount: num(25, 1, 100, "Background blur strength"),
      cutout: z.boolean().default(false).describe("Follow the person's outline, found automatically on each frame (primary clips); the ellipse is used elsewhere"),
      subject: SubjectRegionSchema.default({ x: 0.5, y: 0.45, width: 0.6, height: 0.7 }).describe("Ellipse around the subject that stays sharp"),
      feather: num(0.35, 0.02, 1, "Softness of the subject edge"),
      dim: num(0, 0, 1, "Also darken the background (0 = no change)"),
    }),
    usesPersonMask: (p) => p.cutout,
    toFilter: (p, ctx) => {
      const scale = Math.min(ctx.width, ctx.height) / 1080;
      const blurred = [`gblur=sigma=${round3(p.amount * 0.6 * scale)}`, p.dim > 0 && `eq=brightness=${round3(-0.25 * p.dim)}`].filter(Boolean).join(",");
      const mask = p.cutout && !ctx.alpha ? ctx.personMask?.() : undefined;
      if (mask) return personBlend(ctx, mask, blurred, p.feather);
      return maskedBlend(ctx, blurred, { region: p.subject, inside: false, feather: p.feather, strength: 1 });
    },
  }),
  define({
    id: "backgroundReplace",
    name: "Replace Background",
    category: "retouch",
    perFrame: true,
    description:
      "Put a solid color behind the person, like a virtual backdrop: the person's outline is found on every frame of primary clips (no green screen needed). Elsewhere the ellipse is kept instead. Best on one or two people in front of a plain-ish scene.",
    params: z.object({
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#101216").describe("Backdrop color, #RRGGBB"),
      mix: num(1, 0, 1, "How much of the backdrop replaces the scene (0.7 leaves a hint of it)"),
      subject: SubjectRegionSchema.default({ x: 0.5, y: 0.45, width: 0.6, height: 0.7 }).describe("Ellipse kept when there is no cutout"),
      feather: num(0.25, 0.02, 1, "Softness of the person's edge"),
    }),
    usesPersonMask: () => true,
    toFilter: (p, ctx) => {
      // The backdrop is painted over the scene at `mix`, so below 1 a little of the room shows through.
      const backdrop = `drawbox=x=0:y=0:w=iw:h=ih:color=${toFfmpegColor(p.color)}@${round3(p.mix)}:t=fill`;
      const mask = !ctx.alpha ? ctx.personMask?.() : undefined;
      if (mask) return personBlend(ctx, mask, backdrop, p.feather, true);
      return maskedBlend(ctx, backdrop, { region: p.subject, inside: false, feather: p.feather, strength: 1 });
    },
  }),

  define({
    id: "skyReplace",
    name: "Replace Sky",
    category: "retouch",
    perFrame: false, // the new sky moves over time
    description:
      "Put a new sky (an image or video asset, or a gradient) where the sky is, found by a model on every frame of primary clips. The new sky moves with the camera, is softened to the scene's sharpness, gets the scene's horizon haze, and the scenery is tinted slightly toward it. Use replace_sky, which measures the camera motion and colors and sets this up; check the edge with render_frame where trees or buildings meet the sky.",
    params: SkyReplaceParams,
    usesSkyMask: () => true,
    usesMedia: (p) => (p.asset ? [p.asset] : []),
    toFilter: (p, ctx) => skyReplaceFilter(p, ctx),
  }),
  define({
    id: "colorMatch",
    name: "Color Match",
    category: "color",
    perFrame: true,
    description:
      "Makes a shot look like a reference shot or still: lightness, color cast, saturation and hue moved together as one color transfer (or per-channel curves), fitted from the colors of both. Set up by match_color and grade_scene, which measure the shots and pick the method that matches best; it goes last on the clip.",
    params: ColorMatchParams,
    toFilter: (p, ctx) => colorMatchFilter(p, ctx),
  }),

  // --- blur & stylize -----------------------------------------------------------
  define({
    id: "maskView",
    name: "Mask View",
    category: "retouch",
    perFrame: (p) => !maskIsTemporal((p as { mask: z.output<typeof MaskSchema> }).mask),
    description:
      "Shows a mask in place of an effect, white on black (matte) or as a red tint over the picture (overlay), to check what the mask selects. render_mask uses it; it does not belong in a finished edit.",
    params: z.object({
      mask: MaskSchema.default(MaskSchema.parse({ kind: "shape", shape: { type: "ellipse", x: 0.5, y: 0.5, width: 0.5, height: 0.5 } })),
      style: z.enum(["matte", "overlay"]).default("matte"),
    }),
    usesPersonMask: (p) => maskNeeds(p.mask, "person"),
    usesFaceMask: (p) => maskNeeds(p.mask, "face"),
    usesSkyMask: (p) => maskNeeds(p.mask, "sky"),
    toFilter: (p, ctx) => maskViewFilter(ctx, p.mask, p.style),
  }),
  define({
    id: "blur",
    name: "Blur",
    category: "blur",
    perFrame: true,
    description: "Gaussian blur.",
    params: z.object({ amount: num(10, 0, 100, "Blur radius") }),
    toFilter: (p) => `gblur=sigma=${p.amount}`,
  }),
  define({
    id: "denoise",
    name: "Denoise",
    category: "retouch",
    perFrame: false, // works across frames
    description:
      "Remove grain and color noise from dim or phone footage, keeping edges. strength 0.3 is light, 0.6 cleans low-light video, 1 is heavy (skin and texture start to smear). Pair with the denoise audio effect for hiss.",
    params: z.object({ strength: num(0.5, 0, 1, "0..1") }),
    toFilter: (p) => {
      const s = 1 + p.strength * 7;
      return `hqdn3d=luma_spatial=${round3(s)}:chroma_spatial=${round3(s * 1.4)}:luma_tmp=${round3(s * 1.5)}:chroma_tmp=${round3(s * 2)}`;
    },
  }),
  define({
    id: "stabilize",
    name: "Stabilize",
    category: "motion",
    perFrame: false, // works across frames
    description:
      "Steady shaky handheld footage: camera shake is measured frame to frame and cancelled, and the picture is zoomed in slightly (zoom) so the moving edges stay out of frame. Best on small jitters; it does not straighten big pans. Put it on the clip (each clip is stabilized on its own).",
    params: z.object({
      zoom: num(1.08, 1, 1.3, "Crop-in that hides the edges; raise it if borders show"),
      range: num(48, 8, 64, "Largest shake corrected, in pixels"),
    }),
    toFilter: (p, ctx) => {
      const r = Math.round(p.range / 2) * 2;
      return `deshake=rx=${r}:ry=${r}:edge=mirror,scale=${Math.round((ctx.width * p.zoom) / 2) * 2}:${Math.round((ctx.height * p.zoom) / 2) * 2},crop=${ctx.width}:${ctx.height}`;
    },
  }),
  define({
    id: "sharpen",
    name: "Sharpen",
    category: "blur",
    perFrame: true,
    description: "Increase detail.",
    params: z.object({ amount: num(1, 0, 3, "Sharpen strength") }),
    toFilter: (p) => `unsharp=5:5:${p.amount}:5:5:0`,
  }),
  define({
    id: "vignette",
    name: "Vignette",
    category: "stylize",
    perFrame: true,
    description: "Darken the edges to focus attention on the center.",
    params: z.object({ strength: num(0.5, 0, 1, "0..1") }),
    toFilter: (p) => `vignette=angle=${round3(0.2 + p.strength * 0.8)}`,
  }),
  define({
    id: "grain",
    name: "Film Grain",
    category: "stylize",
    perFrame: true,
    description: "Animated film grain noise.",
    params: z.object({ amount: num(12, 0, 60, "Noise strength") }),
    toFilter: (p) => `noise=alls=${p.amount}:allf=t+u`,
  }),
  define({
    id: "pixelate",
    name: "Pixelate",
    category: "stylize",
    perFrame: true,
    description: "Blocky low-resolution mosaic (censoring, retro).",
    params: z.object({ blockSize: num(20, 2, 200, "Pixel block size") }),
    toFilter: (p, ctx) => {
      const w = Math.max(2, Math.round(ctx.width / p.blockSize));
      const h = Math.max(2, Math.round(ctx.height / p.blockSize));
      return `scale=${w}:${h},scale=${ctx.width}:${ctx.height}:flags=neighbor`;
    },
  }),
  define({
    id: "chromaticAberration",
    name: "Chromatic Aberration / RGB Split",
    category: "stylize",
    perFrame: true,
    description: "Offset red and blue channels for a glitchy or lens-distortion look.",
    params: z.object({ amount: num(6, 0, 50, "Channel offset in pixels") }),
    toFilter: (p) => `rgbashift=rh=-${Math.round(p.amount)}:bh=${Math.round(p.amount)}`,
  }),
  define({
    id: "glitch",
    name: "Glitch",
    category: "stylize",
    perFrame: true,
    description: "Digital glitch: jittering RGB split plus noise.",
    params: z.object({ amount: num(10, 1, 40, "Glitch intensity") }),
    toFilter: (p) => {
      const a = Math.round(p.amount);
      return `rgbashift=rh=${a}:bv=-${Math.round(a / 2)}:gh=-${Math.round(a / 2)},noise=alls=${Math.round(a * 1.5)}:allf=t`;
    },
  }),
  define({
    id: "letterbox",
    name: "Letterbox",
    category: "stylize",
    perFrame: true,
    description: "Cinematic black bars top and bottom.",
    params: z.object({ ratio: num(2.39, 1, 4, "Target aspect ratio of the visible area, e.g. 2.39") }),
    toFilter: (p, ctx) => {
      const visible = Math.min(ctx.height, Math.round(ctx.width / p.ratio));
      const bar = Math.max(0, Math.floor((ctx.height - visible) / 2));
      return `drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`;
    },
  }),
  define({
    id: "mirror",
    name: "Flip",
    category: "distort",
    perFrame: true,
    description: "Flip horizontally or vertically.",
    params: z.object({ direction: z.enum(["horizontal", "vertical"]).default("horizontal") }),
    toFilter: (p) => (p.direction === "horizontal" ? "hflip" : "vflip"),
  }),

  // --- motion -------------------------------------------------------------------
  define({
    id: "kenBurns",
    name: "Ken Burns",
    category: "motion",
    description: "Slow zoom (in or out) with optional pan. Great for photos and static shots.",
    params: z.object({
      zoomFrom: num(1, 1, 3, "Start zoom (1 = no zoom)"),
      zoomTo: num(1.2, 1, 3, "End zoom"),
      pan: z.enum(["center", "left", "right", "up", "down"]).default("center"),
    }),
    toFilter: (p, ctx) => {
      const frames = Math.max(1, Math.round(ctx.duration * ctx.fps));
      const z0 = p.zoomFrom;
      const dz = p.zoomTo - p.zoomFrom;
      const zoomExpr = `${z0}+${round3(dz)}*on/${frames}`;
      const prog = `(on/${frames})`;
      const cx = "iw/2-(iw/zoom/2)";
      const cy = "ih/2-(ih/zoom/2)";
      const x = p.pan === "left" ? `(iw-iw/zoom)*(1-${prog})` : p.pan === "right" ? `(iw-iw/zoom)*${prog}` : cx;
      const y = p.pan === "up" ? `(ih-ih/zoom)*(1-${prog})` : p.pan === "down" ? `(ih-ih/zoom)*${prog}` : cy;
      return zoompan(ctx, zoomExpr, x, y);
    },
  }),
  define({
    id: "zoom",
    name: "Static Zoom / Crop In",
    category: "motion",
    perFrame: true,
    description: "Punch into the frame by a fixed amount (reframe a shot).",
    params: z.object({
      scale: num(1.2, 1, 4, "Zoom factor"),
      x: num(0.5, 0, 1, "Focus point x (0..1)"),
      y: num(0.5, 0, 1, "Focus point y (0..1)"),
    }),
    toFilter: (p, ctx) => {
      const w = Math.round(ctx.width / p.scale / 2) * 2;
      const h = Math.round(ctx.height / p.scale / 2) * 2;
      return `crop=${w}:${h}:'clip(iw*${p.x}-${w}/2,0,iw-${w})':'clip(ih*${p.y}-${h}/2,0,ih-${h})',scale=${ctx.width}:${ctx.height}`;
    },
  }),
  define({
    id: "punchIn",
    name: "Punch-In Zooms",
    category: "motion",
    description:
      "Alternate between normal and zoomed framing every few seconds, the classic talking-head jump-zoom that keeps viewers engaged.",
    params: z.object({
      interval: num(3, 0.5, 30, "Seconds between zoom changes"),
      scale: num(1.15, 1.01, 2, "Zoom factor when punched in"),
    }),
    toFilter: (p, ctx) => zoompan(ctx, `if(mod(floor(it/${p.interval}),2),${p.scale},1)`),
  }),
  define({
    id: "shake",
    name: "Camera Shake",
    category: "shake",
    description: "Constant camera shake that runs for the whole clip. For a natural handheld look use handheld; for hits at moments use impactShake.",
    params: z.object({
      intensity: num(10, 1, 60, "Max offset in pixels"),
      speed: num(20, 1, 60, "Shake frequency"),
    }),
    toFilter: (p, ctx) => {
      const i = Math.round(p.intensity);
      return `scale=${ctx.width + i * 2}:${ctx.height + i * 2},crop=${ctx.width}:${ctx.height}:'${i}+${i}*sin(t*${p.speed})':'${i}+${i}*cos(t*${round3(p.speed * 1.3)})'`;
    },
  }),
  define({
    id: "pulse",
    name: "Beat Pulse",
    category: "motion",
    description: "Rhythmic zoom pulse, e.g. on a music beat.",
    params: z.object({
      bpm: num(120, 30, 240, "Beats per minute"),
      amount: num(0.06, 0.01, 0.5, "Zoom added on each beat"),
    }),
    toFilter: (p, ctx) => {
      const period = round3(60 / p.bpm);
      return zoompan(ctx, `1+${p.amount}*exp(-8*mod(it,${period})/${period})`);
    },
  }),

  ...motionEffects(),

  // --- time -----------------------------------------------------------------------
  define({
    id: "fadeIn",
    name: "Fade In",
    category: "time",
    description: "Fade in from black at the start.",
    params: z.object({ duration: num(0.5, 0.05, 10, "Seconds") }),
    toFilter: (p) => `fade=t=in:st=0:d=${p.duration}`,
  }),
  define({
    id: "fadeOut",
    name: "Fade Out",
    category: "time",
    description: "Fade out to black at the end.",
    params: z.object({ duration: num(0.5, 0.05, 10, "Seconds") }),
    toFilter: (p, ctx) => `fade=t=out:st=${round3(Math.max(0, ctx.duration - p.duration))}:d=${p.duration}`,
  }),
  define({
    id: "flash",
    name: "Flash",
    category: "time",
    description: "Quick white flash at the start of the clip (impact moment).",
    params: z.object({ duration: num(0.25, 0.05, 2, "Seconds") }),
    toFilter: (p) => `fade=t=in:st=0:d=${p.duration}:color=white`,
  }),
];

EFFECTS.push(customEffect);

const byId = new Map(EFFECTS.map((e) => [e.id, e]));

export function getEffect(id: string): EffectDefinition | undefined {
  return byId.get(id);
}

export function listEffects(category?: EffectCategory): EffectDefinition[] {
  return category ? EFFECTS.filter((e) => e.category === category) : EFFECTS;
}

export function registerEffect(def: EffectDefinition): void {
  if (byId.has(def.id)) throw new Error(`Effect "${def.id}" already registered`);
  EFFECTS.push(def);
  byId.set(def.id, def);
}

/** Validate params against the definition and fill defaults. */
export function resolveEffectParams(effect: Effect): Record<string, unknown> {
  const def = getEffect(effect.type);
  if (!def) throw new Error(`Unknown effect "${effect.type}"`);
  return def.params.parse(effect.params ?? {}) as Record<string, unknown>;
}

export function effectToFilter(effect: Effect, ctx: EffectContext): string {
  const def = getEffect(effect.type);
  if (!def) throw new Error(`Unknown effect "${effect.type}"`);
  const states = effectStates(effect);
  const chain =
    states.length === 1
      ? def.toFilter(def.params.parse(states[0]!.params), ctx)
      : rampFilter(
          ctx,
          states.map((s) => def.toFilter(def.params.parse(s.params), ctx)),
          states.map((s) => s.time),
          states.map((s) => s.easing),
        );
  // A masked effect runs on a copy and shows through its matte.
  return effect.mask ? maskedEffect(ctx, MaskSchema.parse(effect.mask), chain) : chain;
}

/** Numbers move part way (`e`) from `a` to `b`, also inside nested settings; other values switch half way. */
function lerpParams(a: unknown, b: unknown, e: number): unknown {
  if (typeof a === "number" && typeof b === "number") return round3(a + (b - a) * e);
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (plain(a) && plain(b)) return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, lerpParams(a[k], b[k], e)]));
  return e < 0.5 ? a : b;
}

/** Up to this many copies of an effect run for a ramp. */
const MAX_STATES = 6;

/**
 * The settings a keyframed effect moves through, with the time each is reached and the easing into
 * it. Between keyframes whose numbers differ, in-between states are added (MAX_STATES in all), so
 * a blur ramps through real blur amounts instead of dissolving from sharp to fully blurred.
 */
export function effectStates(effect: Effect): { time: number; params: Record<string, unknown>; easing: Easing }[] {
  const base = effect.params ?? {};
  const keys = [...(effect.keyframes ?? [])].sort((a, b) => a.time - b.time);
  if (!keys.length) return [{ time: 0, params: base, easing: "linear" }];
  const states = keys.map((k) => ({ time: k.time, params: { ...base, ...k.params }, easing: k.easing ?? "ease-in-out" }));
  const per = states.length > 1 ? Math.max(1, Math.floor((MAX_STATES - 1) / (states.length - 1))) : 1;
  const out = [states[0]!];
  for (let i = 1; i < states.length; i++) {
    const [a, b] = [states[i - 1]!, states[i]!];
    if (per < 2 || !numbersDiffer(a.params, b.params)) {
      out.push(b);
      continue;
    }
    // The easing is spent in the values; between neighbouring states the blend is straight.
    for (let j = 1; j < per; j++) {
      const u = j / per;
      out.push({ time: round3(a.time + (b.time - a.time) * u), params: lerpParams(a.params, b.params, easeValue(u, b.easing)) as Record<string, unknown>, easing: "linear" });
    }
    out.push({ ...b, easing: "linear" });
  }
  return out;
}

/** Whether any number differs between two settings, nested ones included. */
function numbersDiffer(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a !== b;
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  return plain(a) && plain(b) && [...new Set([...Object.keys(a), ...Object.keys(b)])].some((k) => numbersDiffer(a[k], b[k]));
}

export function effectsToFilter(effects: Effect[], ctx: EffectContext): string[] {
  return effects.map((e) => effectToFilter(e, ctx));
}

/**
 * How many copies of the clip's person cutout or face mask stream an effect takes: one per state of
 * a ramped effect that uses it itself (EffectDefinition.usesPersonMask), plus one for its mask.
 */
export function maskStreams(effect: Effect, kind: "person" | "face" | "sky"): number {
  const def = byId.get(effect.type);
  const uses = kind === "person" ? def?.usesPersonMask : kind === "face" ? def?.usesFaceMask : def?.usesSkyMask;
  const parsed = uses && def!.params.safeParse(effect.params ?? {});
  const own = uses && parsed?.success && uses(parsed.data) ? effectStates(effect).length : 0;
  return own + (maskNeeds(effect.mask, kind) ? 1 : 0);
}

/**
 * The tracked objects an effect needs streams of (one stream each): those its mask uses, and for
 * maskView those of the mask it shows.
 */
export function effectObjects(effect: Effect): string[] {
  const shown = effect.type === "maskView" ? MaskSchema.safeParse((effect.params as { mask?: unknown } | undefined)?.mask) : undefined;
  return [...new Set([...maskObjects(effect.mask), ...(shown?.success ? maskObjects(shown.data) : [])])];
}

/** Whether an effect wants the clip's person cutout (see EffectDefinition.usesPersonMask and Effect.mask). */
export function usesPersonMask(effect: Effect): boolean {
  return maskStreams(effect, "person") > 0;
}

/** Whether an effect wants masks that follow the clip's faces (see EffectDefinition.usesFaceMask and Effect.mask). */
export function usesFaceMask(effect: Effect): boolean {
  return maskStreams(effect, "face") > 0;
}

/** Whether an effect wants the clip's sky matte (see EffectDefinition.usesSkyMask and Effect.mask). */
export function usesSkyMask(effect: Effect): boolean {
  return maskStreams(effect, "sky") > 0;
}

/** The picture assets an effect reads, one stream per state of a ramped effect (see EffectDefinition.usesMedia). */
export function effectMedia(effect: Effect): string[] {
  const def = byId.get(effect.type);
  const parsed = def?.usesMedia && def.params.safeParse(effect.params ?? {});
  if (!parsed?.success) return [];
  const ids = def!.usesMedia!(parsed.data);
  return effectStates(effect).flatMap(() => ids);
}

/** Whether an effect works frame by frame (see EffectDefinition.perFrame). Unknown effects are not. */
export function isPerFrame(effect: Effect): boolean {
  // Settings that change over time, or a matte smoothed over frames, make the effect depend on time.
  if (effect.keyframes?.length || maskIsTemporal(effect.mask)) return false;
  const def = byId.get(effect.type);
  if (!def?.perFrame) return false;
  if (typeof def.perFrame === "boolean") return true;
  const parsed = def.params.safeParse(effect.params ?? {});
  return parsed.success && def.perFrame(parsed.data);
}

/**
 * The leading global effects that can run on each clip instead of the joined video. They stop at
 * the first effect that is not per-frame, since later effects depend on its result.
 */
export function perClipGlobalEffects(effects: Effect[]): Effect[] {
  const n = effects.findIndex((e) => !isPerFrame(e));
  return n === -1 ? effects : effects.slice(0, n);
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return clamp(((h * 60) + 360) % 360, 0, 359);
}

/**
 * Escape a filesystem path for use inside a single-quoted FFmpeg filter argument. FFmpeg reads it
 * twice: the option level treats \ ' and : as special (so each gets a backslash), then the graph
 * level reads everything inside '...' literally except ' itself (written '\''). Backslashes are
 * folder separators only on Windows; on macOS and Linux they, like : and ', are legal in names.
 */
export function escapeFilterPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const file = platform === "win32" ? p.replace(/\\/g, "/") : p;
  return file.replace(/[\\':]/g, (c) => `\\${c}`).replace(/'/g, "'\\''");
}

/**
 * The all-in-one "color" effect plus one effect per control, all compiled by colorFilter.
 * Prefer the "color" effect (one per clip) so adjustments can be tweaked together.
 */
function colorEffects(): EffectDefinition[] {
  const shape = ColorSettingsSchema.shape;
  const single = (
    id: string,
    name: string,
    category: EffectCategory,
    description: string,
    key: keyof ColorSettings,
  ): EffectDefinition =>
    define({
      id,
      name,
      category,
      perFrame: true,
      description,
      params: z.object({ value: ((shape[key] as z.ZodOptional<z.ZodNumber>).unwrap()).default(0) }),
      toFilter: (p, ctx) => colorFilter({ [key]: (p as { value: unknown }).value } as ColorSettings, ctx) || "null",
    });
  return [
    define({
      id: "color",
      name: "Color (all controls)",
      category: "color",
      // Auto correct smooths levels over neighboring frames.
      perFrame: (p) => !(p as ColorSettings).autoCorrect,
      description:
        "Full color panel in one effect: exposure, contrast, highlights/shadows/whites/blacks, brilliance, temperature/tint, saturation, vibrance, per-color HSL, tone curves, color wheels, fade, clarity, sharpen, vignette, grain, auto-correct. Use one per clip and tweak values together.",
      params: ColorSettingsSchema,
      toFilter: (p, ctx) => colorFilter(p as ColorSettings, ctx) || "null",
    }),
    single("exposure", "Exposure", "light", "Brighten or darken like a camera exposure change (value in stops, -3..3).", "exposure"),
    single("brightness", "Brightness", "light", "Overall brightness (-100..100).", "brightness"),
    single("contrast", "Contrast", "light", "Contrast (-100..100).", "contrast"),
    single("highlights", "Highlights", "light", "Recover (-) or boost (+) the brightest areas (-100..100).", "highlights"),
    single("shadows", "Shadows", "light", "Lift (+) or deepen (-) dark areas (-100..100).", "shadows"),
    single("whites", "Whites", "light", "White point: + brighter whites, - pull whites down (-100..100).", "whites"),
    single("blacks", "Blacks", "light", "Black point: + lifted blacks, - crushed blacks (-100..100).", "blacks"),
    single("brilliance", "Brilliance", "light", "Balances the image: + brightens shadows and tames highlights for a natural, even look (-100..100).", "brilliance"),
    single("saturation", "Saturation", "color", "Saturation of all colors (-100..100, -100 = black and white).", "saturation"),
    single("vibrance", "Vibrance", "color", "Smart saturation that boosts muted colors and protects skin tones (-100..100).", "vibrance"),
    single("hue", "Hue", "color", "Rotate all hues (-180..180 degrees).", "hue"),
    define({
      id: "whiteBalance",
      name: "White Balance",
      category: "color",
      perFrame: true,
      description: "Relative white balance: temperature (- cooler, + warmer) and tint (- green, + magenta), each -100..100.",
      params: z.object({ temperature: z.number().min(-100).max(100).default(0), tint: z.number().min(-100).max(100).default(0) }),
      toFilter: (p, ctx) => colorFilter(p as ColorSettings, ctx) || "null",
    }),
    define({
      id: "hsl",
      name: "HSL / Color Mixer",
      category: "color",
      perFrame: true,
      description: "Adjust hue, saturation and luminance per color range: red, orange, yellow, green, aqua, blue, purple, magenta.",
      params: shape.hsl.unwrap(),
      toFilter: (p, ctx) => colorFilter({ hsl: p } as ColorSettings, ctx) || "null",
    }),
    define({
      id: "curves",
      name: "Tone Curves",
      category: "grade",
      perFrame: true,
      description: "Tone curve graphs: master and per-channel red/green/blue curves as [input, output] points in 0..1, or a preset shape.",
      params: shape.curves.unwrap(),
      toFilter: (p, ctx) => colorFilter({ curves: p } as ColorSettings, ctx) || "null",
    }),
    define({
      id: "colorWheels",
      name: "Color Wheels",
      category: "grade",
      perFrame: true,
      description: "Color grading wheels: tint shadows, midtones and highlights separately, each with a hue (0..360) and amount (0..100). Teal shadows + orange highlights is the classic film look.",
      params: shape.wheels.unwrap(),
      toFilter: (p, ctx) => colorFilter({ wheels: p } as ColorSettings, ctx) || "null",
    }),
    single("fade", "Fade", "grade", "Matte film look: lifted blacks and softer contrast (0..100).", "fade"),
    single("clarity", "Clarity", "stylize", "Local contrast: + crisp texture and detail, - soft and dreamy (-100..100).", "clarity"),
    define({
      id: "autoCorrect",
      name: "Auto Correct",
      category: "color",
      description: "Automatic levels and white balance: stretches contrast and neutralizes color casts.",
      params: z.object({}),
      toFilter: () => colorFilter({ autoCorrect: true }),
    }),
  ];
}
