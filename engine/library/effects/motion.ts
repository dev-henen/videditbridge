import { z } from "zod";
import { parseColor, round3 } from "../../core/util.js";
import {
  SubjectRegionSchema,
  TimesSchema,
  define,
  ease,
  geqLight,
  hitEnvelope,
  labeler,
  lightCanvas,
  lightLayer,
  maskedBlend,
  num,
  timedBlend,
  windows,
  zoompan,
  type EffectContext,
  type EffectDefinition,
  gbrFormat,
  yuvFormat,
} from "./helpers.js";

/** Deterministic pseudo-random 0..1 per index, so renders are repeatable. */
const rand = (i: number) => {
  const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const EasingParam = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("ease-in-out");
const scaleOf = (ctx: EffectContext) => Math.min(ctx.width, ctx.height) / 1080;

/** lightRays' numbers: the quarter size, the highlight curve, the six zooms (scaled size and crop offset), the per-channel levels. */
export function lightRays(p: { x: number; y: number; threshold: number; length: number; intensity: number; color: string }, ctx: Pick<EffectContext, "width" | "height">) {
  const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
  const [w, h] = [even(ctx.width / 4), even(ctx.height / 4)];
  // Radial blur by repeated zooms about the source: each pass averages the picture with a copy
  // enlarged about the source, doubling the samples along every ray, so 6 passes give 64 samples
  // spaced evenly in log distance from the source. Highlights at distance d streak out to d * zoom.
  const zoom = 20 ** p.length;
  const zooms = Array.from({ length: 6 }, (_, k) => {
    const f = zoom ** (2 ** k / 2 ** 6);
    const [sw, sh] = [even(w * f), even(h * f)];
    return { width: sw, height: sh, x: round3((sw - w) * p.x), y: round3((sh - h) * p.y) };
  });
  const { r, g, b } = parseColor(p.color);
  const tint = [r / 255, g / 255, b / 255] as const;
  // Averaging spreads the light thin, so it is brought back up: a gain above 1 moves a channel's
  // input white point down, a gain below 1 its output white point.
  const levels = (["r", "g", "b"] as const)
    .map((ch, k) => {
      const gain = Math.max(1e-3, 1.3 * p.intensity * tint[k]!);
      return gain >= 1 ? `${ch}imax=${round3(Math.max(0.001, 1 / gain))}` : `${ch}omax=${round3(gain)}`;
    })
    .join(":");
  return { size: [w, h] as [number, number], curve: `curves=all='0/0 ${round3(p.threshold)}/0 1/1'`, zooms, levels: `colorlevels=${levels}` };
}

/** lightLeak's speeds as its expression rounds them: s, 0.7 s, 0.8 s, 0.6 s and 1.7 s. */
export function lightLeakSpeeds(p: { speed: number }): [number, number, number, number, number] {
  const s = round3(0.15 + (p.speed / 100) * 0.9);
  return [s, round3(s * 0.7), round3(s * 0.8), round3(s * 0.6), round3(s * 1.7)];
}

/** bokehLights' orbs on the light canvas: start, sway and drift (overlay expressions of t), size, alpha. */
export function bokehOrbs(p: { count: number; size: number; speed: number }, ctx: EffectContext) {
  const { w: W, h: H } = lightCanvas(ctx);
  return Array.from({ length: p.count }, (_, i) => {
    const R = Math.max(1, Math.round(((p.size / 100) * 0.12 + 0.01) * (0.6 + 0.8 * rand(i * 3 + 1)) * Math.min(W, H)));
    const span = round3(H + 2 * R);
    return {
      x0: round3(rand(i * 3) * W - R),
      sway: round3(0.04 * W),
      swaySpeed: round3(0.3 + rand(i + 50)),
      y0: round3(rand(i * 3 + 7) * span + 1000 * span),
      v: round3((p.speed / 100) * 0.08 * (0.5 + rand(i * 3 + 2)) * H),
      span,
      size: 2 * R,
      alpha: round3(0.45 + 0.55 * rand(i + 90)),
    };
  });
}

/** The glow effect's numbers (8-bit RGB): the curve that keeps bright parts, the blur, the screen's opacity. */
export function glowEffect(p: { strength: number; threshold: number; radius: number }, ctx: EffectContext): { curve: string; sigma: number; opacity: number } {
  const t = round3(0.4 + 0.55 * (p.threshold / 100));
  return { curve: `curves=all='0/0 ${t}/0 1/1'`, sigma: round3(p.radius * 0.6 * scaleOf(ctx)), opacity: round3(p.strength) };
}

/** 7x7 disc kernel: out-of-focus lenses turn points of light into discs, not Gaussian smudges. */
const DISC = (() => {
  const cells: number[] = [];
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) cells.push(x * x + y * y <= 10.5 ? 1 : 0);
  return { matrix: cells.join(" "), sum: cells.reduce((s, v) => s + v, 0) };
})();

/**
 * Camera movement by cropping a slightly enlarged frame with moving offsets (and optional
 * rotation). x/y offsets and the angle are expressions of t, in pixels and radians.
 */
function cameraMove(ctx: EffectContext, margin: number, xExpr: string, yExpr: string, angle?: string): string {
  const m = Math.max(2, Math.ceil(margin));
  const w = ctx.width + 2 * m;
  const h = ctx.height + 2 * m;
  const rotate = angle ? `,rotate=a='${angle}':c=black` : "";
  return `scale=${w}:${h}${rotate},crop=${ctx.width}:${ctx.height}:'${m}+(${xExpr})':'${m}+(${yExpr})'`;
}

export function motionEffects(): EffectDefinition[] {
  return [
    // --- blur & lens ----------------------------------------------------------------
    define({
      id: "bokeh",
      name: "Bokeh / Lens Blur",
      category: "blur",
      perFrame: true,
      description:
        "Out-of-focus lens blur where points of light become soft discs (bokeh), unlike a plain blur. Use on night lights, city backgrounds or b-roll behind titles. Give a subject ellipse to keep a person sharp in front of a bokeh background.",
      params: z.object({
        amount: num(40, 1, 100, "Disc size / defocus strength"),
        highlights: num(50, 0, 100, "Make bright spots bloom into brighter discs"),
        subject: SubjectRegionSchema.optional().describe("Ellipse that stays sharp (x, y center, width, height as frame fractions); omit to defocus the whole frame"),
        feather: num(0.35, 0.02, 1, "Softness of the subject edge"),
      }),
      toFilter: (p, ctx) => {
        const radius = (p.amount / 100) * 48 * scaleOf(ctx);
        const d = Math.max(1, Math.round(radius / 3));
        const w = Math.max(8, Math.round(ctx.width / d / 2) * 2);
        const h = Math.max(8, Math.round(ctx.height / d / 2) * 2);
        const knee = round3(0.85 - 0.25 * (p.highlights / 100));
        const k = `${DISC.matrix}`;
        // Shrinking averages small lights into the dark around them; growing bright points first
        // (dilation is a 3x3 max filter) keeps them, so they open into discs like real bokeh.
        const grow = Math.round((p.highlights / 100) * Math.min(4, d / 2 + 1));
        const branch = [
          ...Array.from({ length: grow }, () => "dilation"),
          `scale=${w}:${h}:flags=area`,
          p.highlights > 0 && `curves=all='0/0 ${knee}/${knee} ${round3(knee + (1 - knee) * 0.4)}/1 1/1'`,
          `convolution=0m='${k}':1m='${k}':2m='${k}':3m='${k}':0rdiv=${round3(1 / DISC.sum)}:1rdiv=${round3(1 / DISC.sum)}:2rdiv=${round3(1 / DISC.sum)}:3rdiv=${round3(1 / DISC.sum)}`,
          `scale=${ctx.width}:${ctx.height}:flags=bicubic`,
          // Round off the blocky edges the small kernel leaves on each disc.
          `gblur=sigma=${round3(Math.max(0.5, d * 0.5))}`,
        ]
          .filter(Boolean)
          .join(",");
        return p.subject ? maskedBlend(ctx, branch, { region: p.subject, inside: false, feather: p.feather, strength: 1 }) : branch;
      },
    }),
    define({
      id: "zoomBlur",
      name: "Zoom Blur",
      category: "blur",
      perFrame: true,
      description: "Radial blur streaking out from a point, like zooming the lens during exposure. Pairs well with zoomPunch and whoosh sound effects for energetic moments.",
      params: z.object({
        amount: num(40, 1, 100, "Streak length"),
        x: num(0.5, 0, 1, "Center x"),
        y: num(0.5, 0, 1, "Center y"),
      }),
      toFilter: (p, ctx) => {
        const label = labeler(ctx);
        const n = 5;
        const copies = Array.from({ length: n }, () => label("fzb"));
        const out = [`split=${n}${copies.map((c) => `[${c}]`).join("")}`];
        const scaled = copies.map((c, i) => {
          const s = 1 + (p.amount / 100) * 0.18 * (i / (n - 1));
          const w = Math.round((ctx.width * s) / 2) * 2;
          const h = Math.round((ctx.height * s) / 2) * 2;
          const o = label("fzs");
          out.push(`[${c}]scale=${w}:${h},crop=${ctx.width}:${ctx.height}:${round3((w - ctx.width) * p.x)}:${round3((h - ctx.height) * p.y)}[${o}]`);
          return o;
        });
        out.push(`${scaled.map((s) => `[${s}]`).join("")}mix=inputs=${n}`);
        return out.join(";");
      },
    }),
    define({
      id: "rackFocus",
      name: "Rack Focus / Focus Pull",
      category: "blur",
      description: "Animate focus: start blurred and pull into sharp focus (direction in), or drift out of focus (direction out), over a time window in the clip. A classic opener or scene ending.",
      params: z.object({
        direction: z.enum(["in", "out"]).default("in").describe("in = blurred to sharp, out = sharp to blurred"),
        start: num(0, 0, 3600, "Seconds from the clip start when the focus change begins"),
        duration: num(1.2, 0.1, 30, "Seconds the focus change takes"),
        amount: num(30, 1, 100, "Blur at the blurred end"),
      }),
      toFilter: (p, ctx) => {
        const prog = ease(`clip((T-${p.start})/${p.duration},0,1)`, "ease-in-out");
        return timedBlend(ctx, `gblur=sigma=${round3(p.amount * 0.5 * scaleOf(ctx))}`, p.direction === "in" ? `1-${prog}` : prog);
      },
    }),
    define({
      id: "motionBlur",
      name: "Motion Blur",
      category: "blur",
      description: "Blend neighbouring frames so movement smears like a slow shutter. Smooths fast pans and sped-up footage.",
      params: z.object({ frames: z.number().int().min(2).max(8).default(3).describe("Frames blended together") }),
      toFilter: (p) => `tmix=frames=${p.frames}`,
    }),

    // --- light ----------------------------------------------------------------------
    define({
      id: "glow",
      name: "Glow / Bloom",
      category: "light",
      perFrame: true,
      description: "Bright areas bloom with a soft glow (dreamy, cinematic, neon at night).",
      params: z.object({
        strength: num(0.8, 0, 1, "Glow opacity"),
        threshold: num(45, 0, 100, "Only parts brighter than this glow"),
        radius: num(30, 1, 100, "Glow spread"),
      }),
      toFilter: (p, ctx) => {
        const label = labeler(ctx);
        const [o, c, g] = [label("fgo"), label("fgc"), label("fgg")];
        const fmt = gbrFormat(ctx);
        const s = glowEffect(p, ctx);
        return [
          `format=${fmt},split=2[${o}][${c}]`,
          `[${c}]${s.curve},gblur=sigma=${s.sigma}[${g}]`,
          `[${o}][${g}]blend=all_mode=screen:all_opacity=${s.opacity},format=${yuvFormat(ctx)}`,
        ].join(";");
      },
    }),
    define({
      id: "lightRays",
      name: "Light Rays / God Rays",
      category: "light",
      perFrame: true,
      description:
        "Shafts of light streaming out from a bright source: sun through trees, clouds or a window, a stage light, headlights in haze. The parts of the picture brighter than threshold are smeared outward from the source point and added back as light, so rays only come from real highlights and are broken up by whatever blocks them. " +
        "Put the source on the light itself (inside the frame or on its edge). Pair with dust motes in the beams (add_particles dust) and a lens flare (add_light flare).",
      params: z.object({
        x: num(0.5, 0, 1, "Source x (frame fraction), on the light"),
        y: num(0.2, 0, 1, "Source y (frame fraction)"),
        threshold: num(0.7, 0, 0.98, "Only parts brighter than this cast rays (lower for dimmer sources)"),
        length: num(0.5, 0.05, 1, "How far the rays reach toward the frame edges"),
        intensity: num(0.8, 0, 3, "Brightness of the rays"),
        color: z.string().default("#FFE6B8").describe("Ray tint #RRGGBB (warm sunlight by default)"),
      }),
      toFilter: (p, ctx) => {
        // Radial blur by repeated zooms about the source at quarter size: each pass averages the
        // picture with a copy enlarged about the source, doubling the samples along every ray, so
        // 6 passes give 64 samples spaced evenly in log distance from the source, close enough that
        // rays from small highlights stay continuous.
        const label = labeler(ctx);
        const fmt = gbrFormat(ctx);
        const spec = lightRays(p, ctx);
        const [w, h] = spec.size;
        const [o, c] = [label("fro"), label("frc")];
        const lines = [`format=${fmt},split=2[${o}][${c}]`];
        let cur = label("frh");
        lines.push(`[${c}]scale=${w}:${h},${spec.curve}[${cur}]`);
        for (const z0 of spec.zooms) {
          const [a, b, z, next] = [label("fra"), label("frb"), label("frz"), label("frn")];
          lines.push(`[${cur}]split=2[${a}][${b}]`);
          lines.push(`[${b}]scale=${z0.width}:${z0.height},crop=${w}:${h}:${z0.x}:${z0.y}[${z}]`);
          lines.push(`[${a}][${z}]blend=all_mode=average[${next}]`);
          cur = next;
        }
        const rays = label("frr");
        lines.push(`[${cur}]${spec.levels},scale=${ctx.width}:${ctx.height}[${rays}]`);
        lines.push(`[${o}][${rays}]blend=all_mode=screen,format=${yuvFormat(ctx)}`);
        return lines.join(";");
      },
    }),
    define({
      id: "bokehLights",
      name: "Floating Bokeh Lights",
      category: "light",
      description: "Soft out-of-focus light orbs of different sizes drifting slowly upward over the picture. Romantic, festive or dreamy openers, weddings, night scenes and title backgrounds.",
      params: z.object({
        count: z.number().int().min(1).max(30).default(12).describe("Number of orbs"),
        size: num(30, 1, 100, "Orb size"),
        speed: num(25, 0, 100, "How fast they drift upward"),
        color: z.string().default("#FFD8A0").describe("Light color #RRGGBB (warm gold by default)"),
        opacity: num(0.6, 0, 1, "Overall strength"),
      }),
      toFilter: (p, ctx) => {
        // One soft disc is drawn once, then scaled copies move over a small black canvas with
        // overlay position expressions: far cheaper than evaluating every orb at every pixel.
        const label = labeler(ctx);
        const { w: W, h: H } = lightCanvas(ctx);
        const d = round3(ctx.duration + 1);
        const sprites = Array.from({ length: p.count }, () => label("fbs"));
        const [disc, discAlpha] = [label("fbd"), label("fba")];
        const lines = [
          `nullsrc=s=64x64:r=${ctx.fps},trim=end_frame=1,format=gray,geq=lum='255*clip((32-hypot(X-31.5,Y-31.5))/9,0,1)',split=2[${disc}][${discAlpha}]`,
          `[${disc}][${discAlpha}]alphamerge,format=yuva420p,split=${p.count}${sprites.map((s) => `[${s}]`).join("")}`,
        ];
        let canvas = label("fbc");
        lines.push(`color=c=black:s=${W}x${H}:r=${ctx.fps}:d=${d},format=yuv420p[${canvas}]`);
        bokehOrbs(p, ctx).forEach((o, i) => {
          const s = sprites[i]!;
          const x = `${o.x0}+${o.sway}*sin(t*${o.swaySpeed}+${i})`;
          const y = `mod(${o.y0}-t*${o.v},${o.span})-${o.size}`;
          const orb = label("fbo");
          const next = label("fbc");
          lines.push(`[${s}]scale=${o.size}:${o.size},lutyuv=a='val*${o.alpha}'[${orb}]`);
          lines.push(`[${canvas}][${orb}]overlay=x='${x}':y='${y}'[${next}]`);
          canvas = next;
        });
        const out = label("fbg");
        lines.push(`[${canvas}]format=gray[${out}]`);
        return lightLayer(ctx, { lines, out }, p.color, p.opacity);
      },
    }),
    define({
      id: "lightLeak",
      name: "Light Leak",
      category: "light",
      description: "Warm film light leaks washing slowly across the frame from the edges. Nostalgic, vintage, summer and wedding looks.",
      params: z.object({
        color: z.string().default("#FF7A2E").describe("Leak color #RRGGBB"),
        opacity: num(0.45, 0, 1, "Strength"),
        speed: num(30, 0, 100, "How fast the leaks move"),
      }),
      toFilter: (p, ctx) => {
        const [s, s07, s08, s06, s17] = lightLeakSpeeds(p);
        const r = "(0.32*max(W,H))";
        const b1 = `exp(-(pow(X-W*(0.0+0.25*sin(T*${s})),2)+pow(Y-H*(0.15+0.25*cos(T*${s07})),2))/pow(${r},2))`;
        const b2 = `exp(-(pow(X-W*(1.0-0.25*sin(T*${s08}+1)),2)+pow(Y-H*(0.85-0.2*sin(T*${s06}+2)),2))/pow(${r},2))`;
        return lightLayer(ctx, geqLight(ctx, `255*min(1,(${b1}+0.8*${b2})*(0.75+0.25*sin(T*${s17})))`), p.color, p.opacity);
      },
    }),
    define({
      id: "flashHits",
      name: "Flash Hits",
      category: "light",
      description: "Quick white (or colored-feel) flashes at chosen moments that fade out, e.g. on beats, cuts or impacts. Use add_moment_effect or beat_sync to place them.",
      params: z.object({
        times: TimesSchema.default([0]),
        strength: num(0.6, 0.05, 1, "Brightness of each flash"),
        decay: num(8, 1, 40, "How fast each flash fades (higher = shorter)"),
      }),
      toFilter: (p) => `eq=brightness='min(1,${p.strength}*(${hitEnvelope("t", p.times, 0.02, p.decay)}))':eval=frame`,
    }),
    define({
      id: "strobe",
      name: "Strobe / Flicker",
      category: "light",
      description: "Rhythmic strobe flashes (club, music video) or an irregular old-film flicker.",
      params: z.object({
        mode: z.enum(["strobe", "flicker"]).default("strobe"),
        rate: num(8, 0.5, 30, "Flashes per second (strobe)"),
        strength: num(0.35, 0, 1, "Brightness change"),
      }),
      toFilter: (p) =>
        p.mode === "strobe"
          ? `eq=brightness='${p.strength}*lt(mod(t*${p.rate},1),0.35)':eval=frame`
          : `eq=brightness='${round3(p.strength * 0.3)}*sin(t*37)*sin(t*13.7)*sin(t*5.3)':eval=frame`,
    }),

    // --- zoom ---------------------------------------------------------------------
    define({
      id: "smoothZoom",
      name: "Smooth Zoom (Push In / Pull Out)",
      category: "motion",
      description:
        "Eased zoom between two framings over a time window: a slow push-in for emphasis, a fast crash zoom (short duration), or a pull-out reveal (to < from). Times are seconds from the clip start; x, y is the point to zoom toward.",
      params: z.object({
        from: num(1, 1, 4, "Zoom at the start (1 = full frame)"),
        to: num(1.3, 1, 4, "Zoom at the end"),
        start: num(0, 0, 3600, "Seconds from the clip start when the zoom begins"),
        duration: num(2, 0.05, 3600, "Seconds the zoom takes"),
        easing: EasingParam,
        x: num(0.5, 0, 1, "Zoom toward this x"),
        y: num(0.5, 0, 1, "Zoom toward this y"),
      }),
      toFilter: (p, ctx) => {
        const prog = ease(`clip((it-${p.start})/${p.duration},0,1)`, p.easing);
        return zoompan(ctx, `${p.from}+${round3(p.to - p.from)}*${prog}`, `(iw-iw/zoom)*${p.x}`, `(ih-ih/zoom)*${p.y}`);
      },
    }),
    define({
      id: "zoomPunch",
      name: "Zoom Punch",
      category: "motion",
      description:
        "Snap zoom-in hits that spring back, at chosen moments: emphasis on a key word, a beat drop, a joke landing. Use add_moment_effect or beat_sync to place them on the timeline.",
      params: z.object({
        times: TimesSchema.default([0]),
        amount: num(0.15, 0.02, 1, "Extra zoom at the peak of each hit"),
        decay: num(5, 0.5, 30, "How fast it springs back (higher = snappier)"),
        x: num(0.5, 0, 1, "Zoom toward this x"),
        y: num(0.5, 0, 1, "Zoom toward this y"),
      }),
      toFilter: (p, ctx) =>
        zoompan(ctx, `1+min(${round3(p.amount * 1.5)},${p.amount}*(${hitEnvelope("it", p.times, 0.06, p.decay)}))`, `(iw-iw/zoom)*${p.x}`, `(ih-ih/zoom)*${p.y}`),
    }),
    define({
      id: "heartbeat",
      name: "Heartbeat Pulse",
      category: "motion",
      description: "Double zoom pulse like a heartbeat (lub-dub). Suspense, romance, tension.",
      params: z.object({
        bpm: num(70, 30, 180, "Heartbeats per minute"),
        amount: num(0.05, 0.01, 0.3, "Zoom on each beat"),
      }),
      toFilter: (p, ctx) => {
        const period = round3(60 / p.bpm);
        const ph = `mod(it,${period})`;
        return zoompan(ctx, `1+${p.amount}*(exp(-${ph}*14)+0.6*if(gte(${ph},0.22),exp(-(${ph}-0.22)*14),0))`);
      },
    }),

    // --- shake & vibration --------------------------------------------------------
    define({
      id: "handheld",
      name: "Handheld Camera",
      category: "shake",
      description: "Gentle, organic drift and sway like a camera held by hand. Makes tripod or screen footage feel alive and documentary-like.",
      params: z.object({ amount: num(30, 1, 100, "How much the camera wanders") }),
      toFilter: (p, ctx) => {
        const a = round3((p.amount / 100) * 24 * scaleOf(ctx));
        const rot = round3((p.amount / 100) * 0.012);
        const x = `${a}*(0.6*sin(t*0.9)+0.4*sin(t*2.3+1.7))`;
        const y = `${a}*(0.6*sin(t*0.7+0.5)+0.4*sin(t*1.9+2.9))`;
        return cameraMove(ctx, a + Math.max(ctx.width, ctx.height) * rot, x, y, `${rot}*sin(t*0.6+0.3)`);
      },
    }),
    define({
      id: "vibrate",
      name: "Vibrate / Buzz",
      category: "shake",
      description: "Fast, small jitter like a phone buzzing, a bass hit or an engine rumble. Runs the whole clip, or only for `length` seconds after each of `times`.",
      params: z.object({
        intensity: num(6, 1, 40, "Jitter size in pixels (at 1080p)"),
        frequency: num(25, 5, 60, "Jitters per second"),
        times: TimesSchema.optional(),
        length: num(0.4, 0.05, 10, "Seconds each vibration lasts when times are given"),
      }),
      toFilter: (p, ctx) => {
        const a = round3(p.intensity * scaleOf(ctx));
        const on = windows("t", p.times, p.length);
        const f = round3(p.frequency * 2 * Math.PI);
        return cameraMove(ctx, a, `${a}*${on}*sin(t*${f})`, `${a}*${on}*sin(t*${round3(f * 1.31)}+1)`);
      },
    }),
    define({
      id: "earthquake",
      name: "Earthquake",
      category: "shake",
      description: "Violent, chaotic shaking with rotation: explosions, earthquakes, chaos, hype moments. Optionally builds up over time.",
      params: z.object({
        intensity: num(40, 5, 120, "Shake size in pixels (at 1080p)"),
        rotation: num(2, 0, 10, "Max tilt in degrees"),
        buildUp: num(0, 0, 30, "Seconds to grow from nothing to full strength"),
      }),
      toFilter: (p, ctx) => {
        const a = round3(p.intensity * scaleOf(ctx));
        const env = p.buildUp > 0 ? `min(1,t/${p.buildUp})` : "1";
        const rot = round3((p.rotation * Math.PI) / 180);
        const x = `${a}*${env}*(0.5*sin(t*13.1)+0.3*sin(t*29.3+1)+0.2*sin(t*47.9+2))`;
        const y = `${a}*${env}*(0.5*sin(t*11.7+0.4)+0.3*sin(t*31.1+2.2)+0.2*sin(t*53.3+0.9))`;
        return cameraMove(ctx, a + (Math.max(ctx.width, ctx.height) * rot) / 2, x, y, rot > 0 ? `${rot}*${env}*sin(t*9.7)*sin(t*3.1+1)` : undefined);
      },
    }),
    define({
      id: "impactShake",
      name: "Impact Shake",
      category: "shake",
      description: "A hard jolt that settles quickly, at chosen moments: hits, drops, slams, punchlines. Use add_moment_effect or beat_sync to place them.",
      params: z.object({
        times: TimesSchema.default([0]),
        intensity: num(30, 2, 120, "Jolt size in pixels (at 1080p)"),
        decay: num(7, 1, 30, "How fast it settles (higher = shorter)"),
      }),
      toFilter: (p, ctx) => {
        const a = round3(p.intensity * scaleOf(ctx));
        const env = `min(1.5,${hitEnvelope("t", p.times, 0.015, p.decay)})`;
        return cameraMove(ctx, a * 1.5, `${a}*${env}*sin(t*71)`, `${a}*${env}*sin(t*59+1.3)`);
      },
    }),

    // --- compositing ----------------------------------------------------------------
    define({
      id: "chromaKey",
      name: "Green Screen / Chroma Key",
      category: "distort",
      description:
        "Key out a green (or blue) screen: put a picture behind the subject (backdrop: a set, a stage, a place, an image or video asset), replace it with a solid color to draw a UI or label on (phone screens, monitors), or make it transparent on a media overlay so whatever is underneath shows through. Removes green spill from edges and fingers. " +
        "With a backdrop, shadows the subject casts on the screen darken it (shadows), so they stand on it instead of floating. Runs at full speed: prefer it to a custom filter for any green screen work.",
      params: z.object({
        color: z.string().default("#00FF00").describe("Screen color to remove, #RRGGBB. Measure it with sample_color: real screens are rarely pure green"),
        similarity: num(0.1, 0.01, 0.6, "How far from the key color still counts as screen (raise slowly if green remains)"),
        blend: num(0.04, 0, 0.5, "Edge softness"),
        replace: z.string().default("#111216").describe('Color to fill the keyed area with, or "transparent" (media overlays only)'),
        backdrop: z.string().optional().describe("Image or video asset id shown behind the subject instead of the replace color (primary clips), filling the frame"),
        shadows: num(0.7, 0, 1, "With a backdrop: how much shadows on the screen darken it (0 = none, 1 = as dark as on the screen)"),
      }),
      usesMedia: (p) => (p.backdrop ? [p.backdrop] : []),
      toFilter: (p, ctx) => {
        // colorkey compares full RGB (brightness included): pale, desaturated screens (often lime or
        // mint on phones) stay apart from beige wood and skin, which chromakey's UV-only distance confuses.
        const hex = p.color.replace(/^#/, "").slice(0, 6);
        const blue = /^#?0000/i.test(p.color);
        const key = `format=rgba,colorkey=color=0x${hex}:similarity=${p.similarity}:blend=${p.blend},despill=type=${blue ? "blue" : "green"}`;
        if (p.replace === "transparent") return `${key},format=yuva420p`;
        const label = labeler(ctx);
        const backdrop = p.backdrop ? ctx.media?.(p.backdrop) : undefined;
        if (p.backdrop && !backdrop) throw new Error("A chroma key backdrop works on primary video clips only; on a media layer, key to transparent and put the backdrop under it");
        if (backdrop) {
          // Keyed by how far the screen channel exceeds the brighter of the other two, not by distance
          // to one color: a shadow on the screen is darker but still green, so it counts as screen and
          // shows as a shadow on the backdrop instead of a dark blob. Planes, blend and lookup tables
          // only, so it runs at copying speed.
          const [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16) || 0) as [number, number, number];
          const [level, excess] = blue ? [b, b - Math.max(r, g)] : [g, g - Math.max(r, b)];
          // Fully screen above `hi`, fully subject below `lo` (similarity widens the screen, blend the edge).
          const lo = Math.max(2, Math.round(excess * Math.max(0.02, 0.22 - p.similarity)));
          const hi = lo + Math.max(8, Math.round(excess * p.blend * 8));
          const [src, mk, sh, k1, o1, o2, mx, ex, alpha, fg, shade, bd, lit] = ["fks", "fkm", "fkh", "fkk", "fko", "fkp", "fkx", "fke", "fka", "fkf", "fkd", "fkb", "fkl"].map((x) => label(x));
          const [keyPlane, others] = blue ? ["b", "r+g"] : ["g", "r+b"];
          // Shadows: the screen channel against the screen's level, as a gray shade multiplied into the backdrop.
          const shadeExpr = `255*(1-${round3(p.shadows)}*(1-clip(val/${level || 255},0,1)))`;
          return [
            `format=gbrp,split=3[${src}][${mk}][${sh}]`,
            `[${mk}]split=2[${k1}][${o1}]`,
            `[${o1}]extractplanes=${others}[${o2}][${mx}]`,
            `[${o2}][${mx}]blend=all_mode=lighten[${ex}]`,
            `[${k1}]extractplanes=${keyPlane}[${k1}k]`,
            `[${k1}k][${ex}]blend=all_mode=subtract,format=gray,lut=y='255*(1-clip((val-${lo})/${hi - lo},0,1))',format=gray[${alpha}]`,
            `[${src}]format=rgba,despill=type=${blue ? "blue" : "green"},format=gbrap[${src}d]`,
            `[${src}d][${alpha}]alphamerge[${fg}]`,
            `[${sh}]extractplanes=${keyPlane},format=gray,lut=y='${shadeExpr}',format=gray,format=gbrp[${shade}]`,
            // overlay pairs frames by time: the backdrop starts with the clip, whatever its own timestamps.
            `[${backdrop}]setpts=PTS-STARTPTS,scale=${ctx.width}:${ctx.height}:force_original_aspect_ratio=increase,crop=${ctx.width}:${ctx.height},setsar=1,format=gbrp[${bd}]`,
            `[${bd}][${shade}]blend=all_mode=multiply:shortest=1[${lit}]`,
            `[${lit}][${fg}]overlay=shortest=1,format=${yuvFormat(ctx)}`,
          ].join(";");
        }
        const [fg, bg] = [label("fkf"), label("fkb")];
        return [
          `${key}[${fg}]`,
          `color=c=0x${p.replace.replace(/^#/, "").slice(0, 6)}:s=${ctx.width}x${ctx.height}:r=${ctx.fps}:d=${round3(ctx.duration + 1)}[${bg}]`,
          `[${bg}][${fg}]overlay=shortest=1,format=${yuvFormat(ctx)}`,
        ].join(";");
      },
    }),

    // --- stylize --------------------------------------------------------------------
    define({
      id: "trails",
      name: "Light Trails / Echo",
      category: "stylize",
      description: "Bright moving things leave fading trails (light painting, dance, night traffic, dreamy echoes).",
      params: z.object({ length: num(50, 1, 100, "Trail length") }),
      toFilter: (p) => `lagfun=decay=${round3(0.85 + 0.14 * (p.length / 100))}`,
    }),
    define({
      id: "vhs",
      name: "VHS / Retro Tape",
      category: "stylize",
      perFrame: true,
      description: "Old videotape look: color bleed, soft picture, tape noise and scanlines.",
      params: z.object({ amount: num(50, 0, 100, "Strength") }),
      toFilter: (p, ctx) => {
        const a = p.amount / 100;
        const s = scaleOf(ctx);
        return [
          `rgbashift=rh=${Math.round(4 * a * s + 1)}:bh=-${Math.round(4 * a * s + 1)}`,
          `gblur=sigma=${round3(0.4 + 1.2 * a * s)}:sigmaV=0.3`,
          `noise=alls=${Math.round(6 + 14 * a)}:allf=t`,
          `eq=saturation=${round3(1 + 0.3 * a)}:contrast=${round3(1 + 0.1 * a)}`,
          `drawgrid=w=iw:h=${Math.max(2, Math.round(4 * s))}:t=1:c=black@${round3(0.08 + 0.17 * a)}`,
        ].join(",");
      },
    }),
    define({
      id: "tilt",
      name: "Dutch Tilt / Rotate",
      category: "distort",
      perFrame: true,
      description: "Rotate the frame by a fixed angle and zoom just enough to hide the corners. A tilted (dutch) angle adds unease or energy.",
      params: z.object({ degrees: num(6, -45, 45, "Rotation, positive = clockwise") }),
      toFilter: (p, ctx) => {
        const th = (Math.abs(p.degrees) * Math.PI) / 180;
        const k = Math.cos(th) + Math.max(ctx.width / ctx.height, ctx.height / ctx.width) * Math.sin(th);
        const w = Math.round((ctx.width * k) / 2) * 2;
        const h = Math.round((ctx.height * k) / 2) * 2;
        return `scale=${w}:${h},rotate=a=${round3((p.degrees * Math.PI) / 180)},crop=${ctx.width}:${ctx.height}`;
      },
    }),
  ];
}

