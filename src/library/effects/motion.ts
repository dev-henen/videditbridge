import { z } from "zod";
import { round3 } from "../../core/util.js";
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
} from "./helpers.js";

/** Deterministic pseudo-random 0..1 per index, so renders are repeatable. */
const rand = (i: number) => {
  const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};

const EasingParam = z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).default("ease-in-out");
const scaleOf = (ctx: EffectContext) => Math.min(ctx.width, ctx.height) / 1080;

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
      description: "Bright areas bloom with a soft glow (dreamy, cinematic, neon at night).",
      params: z.object({
        strength: num(0.8, 0, 1, "Glow opacity"),
        threshold: num(45, 0, 100, "Only parts brighter than this glow"),
        radius: num(30, 1, 100, "Glow spread"),
      }),
      toFilter: (p, ctx) => {
        const label = labeler(ctx);
        const [o, c, g] = [label("fgo"), label("fgc"), label("fgg")];
        const fmt = ctx.alpha ? "gbrap" : "gbrp";
        const t = round3(0.4 + 0.55 * (p.threshold / 100));
        return [
          `format=${fmt},split=2[${o}][${c}]`,
          `[${c}]curves=all='0/0 ${t}/0 1/1',gblur=sigma=${round3(p.radius * 0.6 * scaleOf(ctx))}[${g}]`,
          `[${o}][${g}]blend=all_mode=screen:all_opacity=${round3(p.strength)},format=${ctx.alpha ? "yuva420p" : "yuv420p"}`,
        ].join(";");
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
        sprites.forEach((s, i) => {
          const R = Math.max(1, Math.round(((p.size / 100) * 0.12 + 0.01) * (0.6 + 0.8 * rand(i * 3 + 1)) * Math.min(W, H)));
          const span = round3(H + 2 * R);
          const v = round3((p.speed / 100) * 0.08 * (0.5 + rand(i * 3 + 2)) * H);
          const x = `${round3(rand(i * 3) * W - R)}+${round3(0.04 * W)}*sin(t*${round3(0.3 + rand(i + 50))}+${i})`;
          const y = `mod(${round3(rand(i * 3 + 7) * span + 1000 * span)}-t*${v},${span})-${2 * R}`;
          const orb = label("fbo");
          const next = label("fbc");
          lines.push(`[${s}]scale=${2 * R}:${2 * R},lutyuv=a='val*${round3(0.45 + 0.55 * rand(i + 90))}'[${orb}]`);
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
        const s = round3(0.15 + (p.speed / 100) * 0.9);
        const r = "(0.32*max(W,H))";
        const b1 = `exp(-(pow(X-W*(0.0+0.25*sin(T*${s})),2)+pow(Y-H*(0.15+0.25*cos(T*${round3(s * 0.7)})),2))/pow(${r},2))`;
        const b2 = `exp(-(pow(X-W*(1.0-0.25*sin(T*${round3(s * 0.8)}+1)),2)+pow(Y-H*(0.85-0.2*sin(T*${round3(s * 0.6)}+2)),2))/pow(${r},2))`;
        return lightLayer(ctx, geqLight(ctx, `255*min(1,(${b1}+0.8*${b2})*(0.75+0.25*sin(T*${round3(s * 1.7)})))`), p.color, p.opacity);
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
        "Key out a green (or blue) screen: replace it with a solid color to draw a UI or label on (phone screens, monitors), or make it transparent on a media overlay so whatever is underneath shows through. Removes green spill from edges and fingers.",
      params: z.object({
        color: z.string().default("#00FF00").describe("Screen color to remove, #RRGGBB. Measure it with sample_color: real screens are rarely pure green"),
        similarity: num(0.1, 0.01, 0.6, "How far from the key color still counts as screen (raise slowly if green remains)"),
        blend: num(0.04, 0, 0.5, "Edge softness"),
        replace: z.string().default("#111216").describe('Color to fill the keyed area with, or "transparent" (media overlays only)'),
      }),
      toFilter: (p, ctx) => {
        // colorkey compares full RGB (brightness included): pale, desaturated screens (often lime or
        // mint on phones) stay apart from beige wood and skin, which chromakey's UV-only distance confuses.
        const key = `format=rgba,colorkey=color=0x${p.color.replace(/^#/, "").slice(0, 6)}:similarity=${p.similarity}:blend=${p.blend},despill=type=${/^#?0000/i.test(p.color) ? "blue" : "green"}`;
        if (p.replace === "transparent") return `${key},format=yuva420p`;
        const label = labeler(ctx);
        const [fg, bg] = [label("fkf"), label("fkb")];
        return [
          `${key}[${fg}]`,
          `color=c=0x${p.replace.replace(/^#/, "").slice(0, 6)}:s=${ctx.width}x${ctx.height}:r=${ctx.fps}:d=${round3(ctx.duration + 1)}[${bg}]`,
          `[${bg}][${fg}]overlay=shortest=1,format=${ctx.alpha ? "yuva420p" : "yuv420p"}`,
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

