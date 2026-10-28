import { z } from "zod";
import { round3 } from "../../core/util.js";

/**
 * Sound effects synthesized by FFmpeg (no audio files needed): whooshes for transitions,
 * impacts for hits, pops and clicks for text and UI, risers before a reveal, and more.
 * Each definition returns a filter graph whose output is labeled [sfx].
 */

export type SoundEffectCategory = "transition" | "impact" | "ui" | "musical" | "foley";

export interface SoundEffectDefinition<P extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  category: SoundEffectCategory;
  description: string;
  params: P;
  /** Length in seconds for the given params. */
  duration(params: z.output<P>): number;
  /** Seconds from the start to the loudest moment, the point to line up with a cut or hit (default 0). */
  peak?(params: z.output<P>): number;
  /** FFmpeg filter graph (sources and filters) ending in the label [sfx]. 48 kHz mono. */
  graph(params: z.output<P>): string;
}

function define<P extends z.ZodType>(def: SoundEffectDefinition<P>): SoundEffectDefinition {
  return def as unknown as SoundEffectDefinition;
}

const R = 48000;
const len = (def: number, min: number, max: number) => z.number().min(min).max(max).default(def).describe("Length in seconds");
const tone = (expr: string, d: number) => `aevalsrc=exprs='${expr}':s=${R}:d=${round3(d)}`;
const noise = (color: "white" | "pink" | "brown", d: number, amp: number) => `anoisesrc=d=${round3(d)}:c=${color}:a=${amp}:r=${R}`;

export const SOUND_EFFECTS: SoundEffectDefinition[] = [
  // --- transition -----------------------------------------------------------------
  define({
    id: "whoosh",
    name: "Whoosh",
    category: "transition",
    description: "Airy whoosh that swells and fades. Put it on a cut, a slide or zoom transition, or a title flying in; start it slightly before the cut.",
    params: z.object({ duration: len(0.8, 0.2, 3) }),
    duration: (p) => p.duration,
    peak: (p) => p.duration / 2,
    graph: (p) =>
      `${noise("pink", p.duration, 0.9)},highpass=f=250,bandpass=f=1100:width_type=o:w=2.5,volume='pow(sin(PI*t/${p.duration}),3)*2.5':eval=frame[sfx]`,
  }),
  define({
    id: "swoosh",
    name: "Swoosh / Swipe",
    category: "transition",
    description: "Short, bright swipe for fast cuts, sliding text and UI motion.",
    params: z.object({ duration: len(0.35, 0.1, 1.5) }),
    duration: (p) => p.duration,
    peak: (p) => p.duration / 2,
    graph: (p) => `${noise("white", p.duration, 0.8)},highpass=f=1500,bandpass=f=3500:width_type=o:w=2,volume='pow(sin(PI*t/${p.duration}),2)*1.2':eval=frame[sfx]`,
  }),
  define({
    id: "riser",
    name: "Riser",
    category: "transition",
    description: "Rising tone and noise that builds tension up to a reveal or drop. End it exactly on the moment it leads to.",
    params: z.object({ duration: len(2, 0.5, 8) }),
    duration: (p) => p.duration,
    peak: (p) => p.duration,
    graph: (p) => {
      const d = p.duration;
      return [
        `${tone(`0.35*sin(2*PI*(180*t+${round3(1400 / (2 * d))}*t*t))`, d)}[rt]`,
        `${noise("white", d, 0.35)},highpass=f=2500[rn]`,
        `[rt][rn]amix=inputs=2:normalize=0,volume='pow(t/${d},2)':eval=frame[sfx]`,
      ].join(";");
    },
  }),
  define({
    id: "glitch",
    name: "Glitch",
    category: "transition",
    description: "Digital stutter and crunch for glitch transitions and tech looks.",
    params: z.object({ duration: len(0.5, 0.1, 2) }),
    duration: (p) => p.duration,
    peak: (p) => p.duration / 2,
    graph: (p) => `${noise("white", p.duration, 0.5)},acrusher=bits=4:mode=lin:mix=1,volume='gt(sin(2*PI*23*t)*sin(2*PI*7*t+1),0.05)':eval=frame,lowpass=f=6000[sfx]`,
  }),

  // --- impact ---------------------------------------------------------------------
  define({
    id: "impact",
    name: "Impact / Boom",
    category: "impact",
    description: "Deep cinematic boom: title reveals, big moments, the first frame of a trailer. Pair with impactShake or flashHits.",
    params: z.object({ duration: len(1.5, 0.4, 4) }),
    duration: (p) => p.duration,
    graph: (p) =>
      [
        `${tone("0.9*sin(2*PI*(58*t-9*t*t))*exp(-2.8*t)", p.duration)}[ib]`,
        `${noise("brown", 0.3, 0.9)},lowpass=f=900,afade=t=out:d=0.3[in]`,
        `[ib][in]amix=inputs=2:normalize=0:duration=longest,volume=0.8[sfx]`,
      ].join(";"),
  }),
  define({
    id: "hit",
    name: "Hit / Punch",
    category: "impact",
    description: "Short punchy hit for zoom punches, cuts on the beat and emphasis on a word.",
    params: z.object({}),
    duration: () => 0.35,
    graph: () =>
      [
        `${tone("0.85*sin(2*PI*(130*t-60*t*t))*exp(-22*t)", 0.35)}[ht]`,
        `${noise("white", 0.07, 0.6)},lowpass=f=3500,afade=t=out:d=0.07[hn]`,
        `[ht][hn]amix=inputs=2:normalize=0:duration=longest[sfx]`,
      ].join(";"),
  }),
  define({
    id: "bassDrop",
    name: "Bass Drop",
    category: "impact",
    description: "Falling sub-bass sweep, for drops and dramatic turns.",
    params: z.object({ duration: len(2, 0.5, 5) }),
    duration: (p) => p.duration,
    graph: (p) => `${tone(`0.9*sin(2*PI*(110*t-${round3(25 / p.duration)}*t*t))*min(1,t*30)*exp(-${round3(1.5 / p.duration)}*t)`, p.duration)}[sfx]`,
  }),

  // --- ui ---------------------------------------------------------------------------
  define({
    id: "pop",
    name: "Pop",
    category: "ui",
    description: "Bubbly pop for text, stickers, emoji or captions appearing.",
    params: z.object({}),
    duration: () => 0.15,
    graph: () => `${tone("0.7*sin(2*PI*(900*t-2500*t*t))*exp(-35*t)", 0.15)}[sfx]`,
  }),
  define({
    id: "click",
    name: "Click",
    category: "ui",
    description: "Crisp click for buttons, cursor moves and list items.",
    params: z.object({}),
    duration: () => 0.04,
    graph: () => `${tone("0.8*(random(0)*2-1)*exp(-500*t)", 0.04)},highpass=f=1500[sfx]`,
  }),
  define({
    id: "notification",
    name: "Notification",
    category: "ui",
    description: "Two-tone notification blip (messages, alerts, new item).",
    params: z.object({}),
    duration: () => 0.35,
    graph: () => `${tone("0.35*(sin(2*PI*880*t)*lt(t,0.09)+sin(2*PI*1320*t)*gte(t,0.11)*lt(t,0.3)*exp(-6*(t-0.11)))", 0.35)},afade=t=in:d=0.005[sfx]`,
  }),
  define({
    id: "error",
    name: "Error Buzz",
    category: "ui",
    description: "Low double buzz for mistakes, fails and wrong answers.",
    params: z.object({}),
    duration: () => 0.42,
    graph: () => `${tone("0.25*sgn(sin(2*PI*150*t))*(lt(t,0.15)+gte(t,0.22)*lt(t,0.37))", 0.42)},lowpass=f=2500[sfx]`,
  }),
  define({
    id: "typing",
    name: "Typing",
    category: "ui",
    description: "Keyboard typing clicks, for text typing on screen.",
    params: z.object({ duration: len(1.5, 0.3, 6) }),
    duration: (p) => p.duration,
    graph: (p) => {
      // Irregular key presses, about 9 per second.
      const presses: number[] = [];
      for (let t = 0.02, i = 0; t < p.duration - 0.05; i++) {
        presses.push(round3(t));
        const r = Math.sin(i * 12.9898) * 43758.5453;
        t += 0.06 + 0.12 * (r - Math.floor(r));
      }
      const clicks = presses.map((t) => `gte(t,${t})*exp(-400*(t-${t}))`).join("+");
      return `${tone(`0.6*(random(0)*2-1)*(${clicks})`, p.duration)},bandpass=f=2500:width_type=o:w=2,volume=9dB[sfx]`;
    },
  }),

  // --- musical ------------------------------------------------------------------
  define({
    id: "ding",
    name: "Ding",
    category: "musical",
    description: "Bright bell ding: a correct answer, a tip, a highlight or a list item.",
    params: z.object({ pitch: z.number().min(200).max(4000).default(1320).describe("Bell frequency in Hz") }),
    duration: () => 1.5,
    graph: (p) => `${tone(`0.4*(sin(2*PI*${p.pitch}*t)+0.5*sin(2*PI*${round3(p.pitch * 2.76)}*t)*exp(-3*t)+0.25*sin(2*PI*${round3(p.pitch * 5.4)}*t)*exp(-6*t))*exp(-2.5*t)`, 1.5)}[sfx]`,
  }),
  define({
    id: "success",
    name: "Success Chime",
    category: "musical",
    description: "Rising three-note chime for wins, completions and reveals.",
    params: z.object({}),
    duration: () => 1.2,
    graph: () =>
      `${tone("0.3*(sin(2*PI*523*t)*exp(-4*t)+gte(t,0.12)*sin(2*PI*659*(t-0.12))*exp(-4*(t-0.12))+gte(t,0.24)*sin(2*PI*784*(t-0.24))*exp(-3*(t-0.24)))", 1.2)}[sfx]`,
  }),

  // --- foley ----------------------------------------------------------------------
  define({
    id: "shutter",
    name: "Camera Shutter",
    category: "foley",
    description: "Camera shutter click, for freeze frames, photos and snapshots.",
    params: z.object({}),
    duration: () => 0.25,
    graph: () => `${tone("0.8*(random(0)*2-1)*(exp(-300*t)+gte(t,0.09)*exp(-200*(t-0.09)))", 0.25)},bandpass=f=3000:width_type=o:w=2,volume=4dB[sfx]`,
  }),
  define({
    id: "heartbeat",
    name: "Heartbeat",
    category: "foley",
    description: "One lub-dub heartbeat. Repeat it for tension; pairs with the heartbeat video effect.",
    params: z.object({}),
    duration: () => 0.8,
    graph: () => `${tone("0.9*(sin(2*PI*50*t)*exp(-18*t)+gte(t,0.25)*0.7*sin(2*PI*45*(t-0.25))*exp(-18*(t-0.25)))", 0.8)}[sfx]`,
  }),
];

const byId = new Map(SOUND_EFFECTS.map((e) => [e.id, e]));

export function getSoundEffect(id: string): SoundEffectDefinition | undefined {
  return byId.get(id);
}

export function listSoundEffects(category?: SoundEffectCategory): SoundEffectDefinition[] {
  return category ? SOUND_EFFECTS.filter((e) => e.category === category) : SOUND_EFFECTS;
}

export function registerSoundEffect(def: SoundEffectDefinition): void {
  if (byId.has(def.id)) throw new Error(`Sound effect "${def.id}" already registered`);
  SOUND_EFFECTS.push(def);
  byId.set(def.id, def);
}
