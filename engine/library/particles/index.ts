import { z } from "zod";
import type { BlendMode } from "../../core/schema.js";
import { parseColor } from "../../core/util.js";

/**
 * Atmosphere and light presets (section 6 of docs/design/cinematic-grade-and-vfx.md): rain, snow,
 * dust, embers, sparks, confetti, bokeh, smoke and fog as data for the Rust generator
 * (native/ave-native/src/particles.rs), and lens flare looks. Lengths are frame heights, areas and
 * positions frame fractions, times seconds, angles degrees (0 = right, 90 = down), colors sRGB 0..1.
 */

type Pair = [number, number];
type Rgb = [number, number, number];

/** A particle system: an emitter and how its particles move and look. */
export interface EmitterSpec {
  /** Where particles are born: x0, y0, x1, y1 (may reach outside the frame). */
  area: [number, number, number, number];
  /** Births per second, and at the first moment. */
  rate: number;
  burst: number;
  /** Most alive at once. */
  max: number;
  life: Pair;
  speed: Pair;
  direction: number;
  spread: number;
  /** Downward acceleration (negative rises, like hot embers). */
  gravity: number;
  /** Air velocity drag pulls particles toward; with gravity it sets how fast they fall. */
  wind: Pair;
  drag: number;
  /** Curl-noise sway: speed, size of the swirls, how fast they change. */
  turbulence: number;
  turbulenceScale: number;
  turbulenceSpeed: number;
  /** Radius. */
  size: Pair;
  /** (age 0..1, multiplier) stops. */
  sizeOverLife: Pair[];
  opacity: Pair;
  opacityOverLife: Pair[];
  colors: Rgb[];
  /** (age 0..1, r, g, b) stops replacing the picked color. */
  colorOverLife: [number, number, number, number][];
  shape: "disc" | "streak" | "rect" | "bokeh";
  /** Edge softness, a fraction of the radius. */
  softness: number;
  /** Streak length as a fraction of a frame's motion (1 = a 360 degree shutter). */
  streak: number;
  /** Rect width over height. */
  aspect: number;
  spin: Pair;
  flip: number;
  flicker: number;
  flickerRate: number;
  glow: number;
  /** Size and speed multiplier of the farthest and nearest particles. */
  depth: Pair;
  /** Extra blur of the nearest particles. */
  depthBlur: number;
  /** Adds light (embers, sparks) instead of covering what is under it (snow). */
  additive: boolean;
  ground?: { y: number; spread: number; splash: number; splashSize: number };
}

/** Drifting fractal noise (smoke, fog). */
export interface NoiseSpec {
  color: Rgb;
  opacity: number;
  /** Size of the billows. */
  scale: number;
  octaves: number;
  drift: Pair;
  evolve: number;
  /** Noise values mapped to no density and to full density. */
  density: Pair;
  /** Density multiplier at the top and the bottom of the frame. */
  falloff: Pair;
  layers: number;
  downscale: number;
}

/** A lens flare: per output frame, the source and its brightness. */
export interface FlareSpec {
  /** x, y per output frame, flattened. */
  positions: number[];
  intensity: number[];
  color: Rgb;
  size: number;
  /** Horizontal streak half-length, frame widths. */
  streak: number;
  streakColor: Rgb;
  ghosts: { at: number; size: number; color: Rgb; opacity: number; ring: boolean }[];
}

export type ParticleSystemSpec = { emitter: EmitterSpec } | { noise: NoiseSpec } | { flare: FlareSpec };

export interface ParticlePreset {
  id: string;
  name: string;
  /** Read by Claude: what it is and when to use it. */
  description: string;
  /** How the layer mixes with the picture. */
  blend: BlendMode;
  /** Seconds simulated before the layer starts, so it is already full (0 for bursts). */
  preroll: number;
  /** Falls straight from the sky: wind tilts its starting direction too. */
  falling?: boolean;
  systems: ParticleSystemSpec[];
}

const base: EmitterSpec = {
  area: [0, 0, 1, 1],
  rate: 10,
  burst: 0,
  max: 500,
  life: [2, 4],
  speed: [0, 0],
  direction: 90,
  spread: 0,
  gravity: 0,
  wind: [0, 0],
  drag: 0,
  turbulence: 0,
  turbulenceScale: 0.2,
  turbulenceSpeed: 0.3,
  size: [0.002, 0.004],
  sizeOverLife: [],
  opacity: [1, 1],
  opacityOverLife: [
    [0, 0],
    [0.1, 1],
    [0.85, 1],
    [1, 0],
  ],
  colors: [[1, 1, 1]],
  colorOverLife: [],
  shape: "disc",
  softness: 0.5,
  streak: 0,
  aspect: 1,
  spin: [0, 0],
  flip: 0,
  flicker: 0,
  flickerRate: 0,
  glow: 0,
  depth: [1, 1],
  depthBlur: 0,
  additive: false,
};

const emitter = (e: Partial<EmitterSpec>): ParticleSystemSpec => ({ emitter: { ...base, ...e } });

const rain = (heavy: boolean): Partial<EmitterSpec> => ({
  area: [-0.4, -0.3, 1.4, -0.02],
  rate: heavy ? 3200 : 1300,
  max: heavy ? 4000 : 2000,
  life: [1.2, 1.6],
  // Gravity and drag set a falling speed of 3 frame heights a second (before depth).
  speed: [3, 3],
  gravity: 6,
  drag: 2,
  size: heavy ? [0.0007, 0.0013] : [0.0006, 0.0011],
  opacity: heavy ? [0.4, 0.7] : [0.35, 0.6],
  opacityOverLife: [],
  colors: [
    [0.82, 0.88, 0.95],
    [0.9, 0.93, 1],
  ],
  shape: "streak",
  softness: 0.6,
  streak: 0.6,
  depth: [0.45, 1.9],
  depthBlur: 0.002,
  ground: heavy ? { y: 0.86, spread: 0.12, splash: 3, splashSize: 0.0012 } : undefined,
});

export const PARTICLE_PRESETS: ParticlePreset[] = [
  {
    id: "rain",
    name: "Rain",
    description: "Light rain: thin pale streaks falling fast, nearer drops bigger and softer. Lighten the picture with it; a cool, darker grade sells it.",
    blend: "screen",
    preroll: 1.5,
    falling: true,
    systems: [emitter(rain(false))],
  },
  {
    id: "heavyRain",
    name: "Heavy rain",
    description: "A downpour: dense streaks and droplets splashing up from a ground line (ground, default 0.86 of the frame height; set it to where the street or floor is).",
    blend: "screen",
    preroll: 1.5,
    falling: true,
    systems: [emitter(rain(true))],
  },
  {
    id: "snow",
    name: "Snow",
    description: "Falling snow: flakes of many sizes drifting down and swaying, near flakes large and out of focus. Works on dark and bright plates; for snow only in the sky, give mask { kind: 'sky' }.",
    blend: "normal",
    preroll: 10,
    falling: true,
    systems: [
      emitter({
        area: [-0.3, -0.15, 1.3, -0.02],
        rate: 220,
        max: 2500,
        life: [14, 18],
        speed: [0.15, 0.15],
        gravity: 0.3,
        drag: 2,
        turbulence: 0.08,
        turbulenceScale: 0.2,
        turbulenceSpeed: 0.3,
        size: [0.0015, 0.0038],
        opacity: [0.65, 0.95],
        opacityOverLife: [
          [0, 0],
          [0.03, 1],
          [0.95, 1],
          [1, 0],
        ],
        colors: [[1, 1, 1]],
        depth: [0.5, 2.6],
        depthBlur: 0.006,
      }),
    ],
  },
  {
    id: "dust",
    name: "Dust motes",
    description: "Dust floating in a beam of light: a few hundred tiny specks drifting slowly and twinkling as they catch the light. Best over a shaft of light or a window; limit it there with a shape or luma mask.",
    blend: "screen",
    preroll: 8,
    systems: [
      emitter({
        area: [-0.05, -0.05, 1.05, 1.05],
        rate: 30,
        max: 280,
        life: [6, 10],
        speed: [0.005, 0.02],
        direction: 0,
        spread: 360,
        drag: 0.5,
        wind: [0.004, -0.002],
        turbulence: 0.03,
        turbulenceScale: 0.15,
        turbulenceSpeed: 0.2,
        size: [0.0009, 0.0022],
        opacity: [0.5, 1],
        opacityOverLife: [
          [0, 0],
          [0.25, 1],
          [0.75, 1],
          [1, 0],
        ],
        colors: [
          [1, 0.95, 0.85],
          [1, 0.9, 0.75],
        ],
        flicker: 0.65,
        flickerRate: 1.2,
        glow: 0.5,
        depth: [0.6, 2.2],
        depthBlur: 0.004,
        additive: true,
      }),
    ],
  },
  {
    id: "embers",
    name: "Embers",
    description: "Glowing embers rising from below and flickering out: fire scenes, campfires, dramatic or heroic moments. Put them behind a person with behindSubject or mask { kind: 'person', invert: true }.",
    blend: "screen",
    preroll: 4,
    systems: [
      emitter({
        area: [-0.05, 1.0, 1.05, 1.08],
        rate: 45,
        max: 450,
        life: [2.5, 4.5],
        speed: [0.12, 0.3],
        direction: -90,
        spread: 40,
        gravity: -0.04,
        drag: 0.3,
        wind: [0.03, 0],
        turbulence: 0.12,
        turbulenceScale: 0.12,
        turbulenceSpeed: 0.8,
        size: [0.0018, 0.0038],
        sizeOverLife: [
          [0, 1],
          [1, 0.4],
        ],
        opacityOverLife: [
          [0, 0],
          [0.08, 1],
          [0.7, 0.8],
          [1, 0],
        ],
        colorOverLife: [
          [0, 1, 0.9, 0.55],
          [0.3, 1, 0.55, 0.15],
          [1, 0.6, 0.12, 0.03],
        ],
        shape: "streak",
        streak: 0.3,
        flicker: 0.5,
        flickerRate: 6,
        glow: 1,
        depth: [0.6, 2],
        depthBlur: 0.003,
        additive: true,
      }),
    ],
  },
  {
    id: "sparks",
    name: "Sparks",
    description: "A fountain of hot sparks thrown up and arcing down, streaked by their speed: grinders, welding, impacts, fireworks on the ground. Place it with area (default a small spot at the bottom middle).",
    blend: "add",
    preroll: 0.8,
    systems: [
      emitter({
        area: [0.48, 0.84, 0.52, 0.86],
        rate: 140,
        max: 900,
        life: [0.4, 1],
        speed: [0.6, 1.4],
        direction: -90,
        spread: 70,
        gravity: 1.6,
        drag: 0.6,
        size: [0.0008, 0.0015],
        opacityOverLife: [
          [0, 1],
          [0.8, 0.9],
          [1, 0],
        ],
        colorOverLife: [
          [0, 1, 1, 0.85],
          [0.4, 1, 0.72, 0.28],
          [1, 0.85, 0.25, 0.05],
        ],
        shape: "streak",
        streak: 1,
        flicker: 0.3,
        flickerRate: 12,
        glow: 0.5,
        depth: [0.8, 1.4],
        additive: true,
      }),
    ],
  },
  {
    id: "confetti",
    name: "Confetti",
    description: "A burst of colored paper pieces fluttering down, spinning and tumbling: celebrations, reveals, wins, announcements. Starts with a burst at the layer's start.",
    blend: "normal",
    preroll: 0,
    systems: [
      emitter({
        // Reaching into the top of the frame, so pieces show from the first frame of the burst.
        area: [-0.1, -0.4, 1.1, 0.1],
        rate: 110,
        burst: 450,
        max: 900,
        life: [5, 8],
        speed: [0.05, 0.25],
        spread: 90,
        gravity: 0.6,
        drag: 1.8,
        turbulence: 0.15,
        turbulenceScale: 0.25,
        turbulenceSpeed: 0.6,
        size: [0.006, 0.01],
        opacity: [1, 1],
        opacityOverLife: [
          [0, 1],
          [0.9, 1],
          [1, 0],
        ],
        colors: ["#FF4D4D", "#FFC93C", "#3CC8FF", "#4DE38A", "#FF7AC6", "#FFFFFF"].map(rgb),
        shape: "rect",
        softness: 0.1,
        aspect: 0.6,
        spin: [90, 360],
        flip: 1.5,
        depth: [0.6, 1.8],
        depthBlur: 0.004,
      }),
    ],
  },
  {
    id: "bokeh",
    name: "Bokeh orbs",
    description: "Large soft out-of-focus light orbs drifting slowly upward and fading in and out: romantic, festive, dreamy, night and title backgrounds.",
    blend: "screen",
    preroll: 8,
    systems: [
      emitter({
        area: [-0.1, -0.1, 1.1, 1.2],
        rate: 4,
        max: 40,
        life: [6, 10],
        speed: [0.01, 0.04],
        direction: -90,
        spread: 60,
        drag: 0.2,
        turbulence: 0.02,
        size: [0.02, 0.06],
        opacity: [0.15, 0.4],
        opacityOverLife: [
          [0, 0],
          [0.25, 1],
          [0.75, 1],
          [1, 0],
        ],
        colors: [
          [1, 0.85, 0.6],
          [1, 0.75, 0.45],
          [1, 0.95, 0.85],
        ],
        shape: "bokeh",
        softness: 0.08,
        depth: [0.7, 1.5],
        additive: true,
      }),
    ],
  },
  {
    id: "smoke",
    name: "Smoke",
    description: "Billowing gray smoke drifting up and across, thicker low in the frame: fires, battlefields, concerts, mystery. Not particles: layers of drifting noise.",
    blend: "normal",
    preroll: 0,
    systems: [
      {
        noise: { color: [0.72, 0.72, 0.72], opacity: 0.8, scale: 0.45, octaves: 5, drift: [0.02, -0.035], evolve: 0.08, density: [0.45, 0.85], falloff: [0.3, 1], layers: 2, downscale: 6 },
      },
    ],
  },
  {
    id: "fog",
    name: "Fog",
    description: "Low fog or mist rolling slowly across, dense at the bottom and clear at the top: moody landscapes, horror, mornings, depth in a wide shot.",
    blend: "normal",
    preroll: 0,
    systems: [
      {
        noise: { color: [0.86, 0.88, 0.91], opacity: 0.55, scale: 0.7, octaves: 4, drift: [0.025, 0], evolve: 0.03, density: [0.35, 0.8], falloff: [0.05, 1], layers: 3, downscale: 8 },
      },
    ],
  },
];

export function getParticlePreset(id: string): ParticlePreset | undefined {
  return PARTICLE_PRESETS.find((p) => p.id === id);
}

export const ParticlePresetIdSchema = z.enum(PARTICLE_PRESETS.map((p) => p.id) as [string, ...string[]]);

export const ParticleSettingsSchema = z.object({
  density: z.number().min(0.1).max(4).default(1).describe("More or fewer particles (smoke and fog: thicker or thinner), 1 = the preset"),
  size: z.number().min(0.25).max(4).default(1).describe("Particle size (smoke and fog: size of the billows), 1 = the preset"),
  speed: z.number().min(0.25).max(4).default(1).describe("How fast everything moves, 1 = the preset"),
  wind: z.number().min(-1).max(1).default(0).describe("Sideways wind in frame heights per second, + to the right (0.1 is a breeze, 0.5 a storm); slants rain"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("One color for every particle (#RRGGBB), replacing the preset's colors"),
  area: z
    .object({ x0: z.number().min(-1).max(2), y0: z.number().min(-1).max(2), x1: z.number().min(-1).max(2), y1: z.number().min(-1).max(2) })
    .optional()
    .describe("Where particles are born (frame fractions; may reach outside the frame): sparks from a grinder at a spot, embers from a fire's area, confetti over one side"),
  ground: z.number().min(0).max(1.5).optional().describe("Height of the ground line (frame fraction) where falling particles stop; heavyRain splashes there"),
  seed: z.number().int().min(0).max(1_000_000).default(1).describe("Another seed gives another, equally random, arrangement; the same seed always draws the same frames"),
});
export type ParticleSettings = z.output<typeof ParticleSettingsSchema>;

/** sRGB 0..1 of a #RRGGBB color. */
export function rgb(hex: string): Rgb {
  const c = parseColor(hex);
  return [c.r / 255, c.g / 255, c.b / 255];
}

/** A preset with settings applied: the systems to draw and the preroll. */
export function resolveParticles(preset: ParticlePreset, settings: ParticleSettings): { systems: ParticleSystemSpec[]; preroll: number } {
  const s = settings;
  const k = s.speed;
  const systems = preset.systems.map((sys): ParticleSystemSpec => {
    if ("noise" in sys) {
      const n = sys.noise;
      return {
        noise: {
          ...n,
          color: s.color ? rgb(s.color) : n.color,
          opacity: Math.min(1, n.opacity * Math.sqrt(s.density)),
          scale: n.scale * s.size,
          drift: [n.drift[0] * k + s.wind, n.drift[1] * k],
          evolve: n.evolve * k,
        },
      };
    }
    if (!("emitter" in sys)) return sys;
    const e = sys.emitter;
    const wind: Pair = [e.wind[0] * k + s.wind, e.wind[1] * k];
    const gravity = e.gravity * k * k;
    const out: EmitterSpec = {
      ...e,
      rate: e.rate * s.density,
      burst: Math.round(e.burst * s.density),
      max: Math.round(e.max * s.density),
      // Faster particles cross the frame sooner: their lives shorten to match, so the frame stays as full.
      life: [e.life[0] / k, e.life[1] / k],
      speed: [e.speed[0] * k, e.speed[1] * k],
      gravity,
      drag: e.drag * k,
      wind,
      turbulence: e.turbulence * k,
      turbulenceSpeed: e.turbulenceSpeed * k,
      size: [e.size[0] * s.size, e.size[1] * s.size],
      ground: e.ground ? { ...e.ground } : undefined,
      colors: s.color ? [rgb(s.color)] : e.colors,
      colorOverLife: s.color ? [] : e.colorOverLife,
      flickerRate: e.flickerRate * k,
      spin: [e.spin[0] * k, e.spin[1] * k],
      flip: e.flip * k,
    };
    if (preset.falling && out.drag > 0) {
      // Start at the falling speed and slant, so the first frames already look steady.
      const [vx, vy] = [wind[0], gravity / out.drag + wind[1]];
      out.direction = (Math.atan2(vy, vx) * 180) / Math.PI;
      out.speed = [Math.hypot(vx, vy), Math.hypot(vx, vy)];
      // Wind blows rain in from the side: widen the birth area against it.
      const lean = (vx / Math.max(vy, 1e-3)) * 1.3;
      out.area = [Math.min(e.area[0], e.area[0] - lean), e.area[1], Math.max(e.area[2], e.area[2] - lean), e.area[3]];
    }
    if (s.area) out.area = [s.area.x0, s.area.y0, s.area.x1, s.area.y1];
    if (s.ground !== undefined) out.ground = { ...(out.ground ?? { spread: 0.08, splash: 0, splashSize: 0 }), y: s.ground };
    return { emitter: out };
  });
  return { systems, preroll: preset.preroll / k };
}

export interface FlareLook {
  id: string;
  description: string;
  size: number;
  streak: number;
  streakColor: Rgb;
  ghosts: FlareSpec["ghosts"];
}

export const FLARE_LOOKS: FlareLook[] = [
  {
    id: "natural",
    description: "A spherical lens: warm glow, a short streak and a chain of faint colored ghosts and rings across the frame",
    size: 0.05,
    streak: 0.12,
    streakColor: [1, 0.85, 0.65],
    ghosts: [
      { at: 0.45, size: 0.012, color: [0.6, 0.8, 1], opacity: 0.25, ring: false },
      { at: 0.7, size: 0.02, color: [1, 0.7, 0.4], opacity: 0.16, ring: false },
      { at: 1.15, size: 0.032, color: [0.5, 1, 0.7], opacity: 0.14, ring: true },
      { at: 1.5, size: 0.008, color: [1, 0.55, 0.8], opacity: 0.3, ring: false },
      { at: 1.85, size: 0.055, color: [0.45, 0.6, 1], opacity: 0.09, ring: false },
      { at: 2.2, size: 0.018, color: [1, 0.85, 0.5], opacity: 0.15, ring: true },
    ],
  },
  {
    id: "anamorphic",
    description: "An anamorphic lens: a long thin blue streak across the frame and blue ghosts (sci-fi, night city, car lights)",
    size: 0.04,
    streak: 0.45,
    streakColor: [0.45, 0.65, 1],
    ghosts: [
      { at: 0.6, size: 0.015, color: [0.4, 0.6, 1], opacity: 0.2, ring: false },
      { at: 1.3, size: 0.03, color: [0.35, 0.55, 1], opacity: 0.12, ring: false },
      { at: 1.9, size: 0.012, color: [0.6, 0.75, 1], opacity: 0.22, ring: false },
    ],
  },
  {
    id: "subtle",
    description: "A soft glow with two faint ghosts, for a light that should catch the lens without drawing attention",
    size: 0.035,
    streak: 0,
    streakColor: [1, 1, 1],
    ghosts: [
      { at: 0.8, size: 0.015, color: [1, 0.8, 0.6], opacity: 0.1, ring: false },
      { at: 1.6, size: 0.025, color: [0.6, 0.8, 1], opacity: 0.07, ring: true },
    ],
  },
];

export const FlareLookSchema = z.enum(FLARE_LOOKS.map((l) => l.id) as [string, ...string[]]);
