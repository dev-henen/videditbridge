import { z } from "zod";
import type { Effect } from "../../core/schema.js";
import { clamp, round3 } from "../../core/util.js";

export type AudioEffectCategory = "cleanup" | "voice" | "dynamics" | "eq" | "volume" | "creative";

export interface AudioEffectDefinition<P extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  category: AudioEffectCategory;
  description: string;
  params: P;
  /** Returns a comma-separated FFmpeg audio filter chain. */
  toFilter(params: z.output<P>): string;
}

const num = (def: number, min: number, max: number, desc: string) =>
  z.number().min(min).max(max).default(def).describe(desc);

function define<P extends z.ZodType>(def: AudioEffectDefinition<P>): AudioEffectDefinition {
  return def as unknown as AudioEffectDefinition;
}

/** atempo accepts 0.5-2 per instance; chain for larger factors. Changes speed without changing pitch. */
export function atempoChain(speed: number): string[] {
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

/** Shift pitch by semitones while keeping the duration. */
function pitchShift(semitones: number): string {
  if (semitones === 0) return "anull";
  const ratio = 2 ** (semitones / 12);
  return ["aresample=48000", `asetrate=${Math.round(48000 * ratio)}`, "aresample=48000", ...atempoChain(1 / ratio)].join(",");
}

const ROOMS = {
  small: { delays: [23, 41, 67, 89], decays: [0.5, 0.4, 0.3, 0.2] },
  room: { delays: [40, 75, 110, 160], decays: [0.5, 0.4, 0.3, 0.2] },
  hall: { delays: [60, 120, 190, 270, 360], decays: [0.5, 0.42, 0.33, 0.25, 0.18] },
  cathedral: { delays: [90, 180, 300, 450, 620, 800], decays: [0.55, 0.47, 0.4, 0.32, 0.25, 0.18] },
} as const;

export const AUDIO_EFFECTS: AudioEffectDefinition[] = [
  // --- cleanup ------------------------------------------------------------------
  define({
    id: "denoise",
    name: "Reduce Noise",
    category: "cleanup",
    description:
      "Remove steady background noise (hiss, fan, air conditioning, room tone) with spectral noise reduction. Higher amounts remove more but can sound watery. Noise louder than noiseFloor is only partly removed: raise it toward -25 for loud hiss, lower it toward -50 to protect quiet, soft speech when the noise is faint.",
    params: z.object({
      amount: num(50, 0, 100, "Noise reduction strength (50 removes about 20 dB)"),
      noiseFloor: num(-35, -70, -20, "Level of the noise to remove, in dB"),
    }),
    // Adaptive noise tracking (tn) follows the speech instead of the noise on short clips, so the floor is fixed.
    toFilter: (p) => `afftdn=nr=${round3(6 + p.amount * 0.3)}:nf=${p.noiseFloor}`,
  }),
  define({
    id: "dehum",
    name: "Remove Hum",
    category: "cleanup",
    description: "Notch out electrical mains hum and its harmonics (50 Hz in Europe/Asia/Africa, 60 Hz in the Americas).",
    params: z.object({ frequency: z.union([z.literal(50), z.literal(60)]).default(50).describe("Mains frequency in Hz") }),
    toFilter: (p) => [1, 2, 3, 4].map((h) => `bandreject=f=${p.frequency * h}:width_type=q:w=30`).join(","),
  }),
  define({
    id: "declick",
    name: "Remove Clicks",
    category: "cleanup",
    description: "Remove clicks, pops and mouth noises.",
    params: z.object({}),
    toFilter: () => "adeclick",
  }),
  define({
    id: "rumbleCut",
    name: "Low Cut / Rumble Filter",
    category: "cleanup",
    description: "High-pass filter that removes low rumble, wind and handling noise below the cutoff.",
    params: z.object({ frequency: num(80, 20, 400, "Cutoff in Hz") }),
    toFilter: (p) => `highpass=f=${p.frequency}:poles=2`,
  }),
  define({
    id: "gate",
    name: "Noise Gate",
    category: "cleanup",
    description: "Silence the quiet gaps between phrases so background noise does not sit under pauses.",
    params: z.object({
      threshold: num(-45, -80, -10, "Level in dB below which audio is reduced"),
      reduction: num(18, 1, 60, "How much quiet parts are lowered, in dB"),
    }),
    toFilter: (p) => `agate=threshold=${round3(10 ** (p.threshold / 20))}:range=${round3(10 ** (-p.reduction / 20))}:attack=5:release=250`,
  }),

  // --- voice --------------------------------------------------------------------
  define({
    id: "enhanceVoice",
    name: "Enhance Voice",
    category: "voice",
    description:
      "One-step speech polish for talking footage: rumble cut, light noise reduction, less boxiness, more presence and clarity, de-essing, compression and level evening. Use on dialogue, podcasts and voice-overs.",
    params: z.object({
      amount: num(60, 0, 100, "Overall strength"),
      denoise: z.boolean().default(true).describe("Include light noise reduction"),
      deEss: z.boolean().default(true).describe("Tame harsh s and sh sounds"),
      level: z.boolean().default(true).describe("Even out loud and quiet words"),
    }),
    toFilter: (p) => {
      const a = p.amount / 100;
      return [
        "highpass=f=75:poles=2",
        p.denoise && `afftdn=nr=${round3(6 + 10 * a)}:nf=-40`,
        `equalizer=f=300:t=q:w=1:g=${round3(-4 * a)}`,
        `equalizer=f=3200:t=q:w=1.2:g=${round3(4 * a)}`,
        `treble=g=${round3(2.5 * a)}:f=9000`,
        p.deEss && `deesser=i=${round3(0.2 + 0.3 * a)}`,
        `acompressor=threshold=${round3(10 ** (-(16 + 6 * a) / 20))}:ratio=${round3(2 + 2 * a)}:attack=10:release=150:makeup=${round3(1 + a)}`,
        // The threshold (about -40 dB) keeps the leveler from lifting the noise in pauses.
        p.level && "dynaudnorm=f=250:g=15:p=0.7:m=6:t=0.01",
      ]
        .filter(Boolean)
        .join(",");
    },
  }),
  define({
    id: "deEsser",
    name: "De-esser",
    category: "voice",
    description: "Reduce harsh sibilance (s, sh, t sounds) in speech.",
    params: z.object({ intensity: num(50, 0, 100, "Strength") }),
    toFilter: (p) => `deesser=i=${round3(p.intensity / 100)}`,
  }),
  define({
    id: "pitch",
    name: "Pitch / Voice Changer",
    category: "voice",
    description: "Shift the pitch in semitones without changing the speed. +5 to +8 gives a chipmunk voice, -4 to -7 a deep voice.",
    params: z.object({ semitones: num(4, -12, 12, "Pitch shift in semitones") }),
    toFilter: (p) => pitchShift(p.semitones),
  }),

  // --- dynamics -----------------------------------------------------------------
  define({
    id: "compressor",
    name: "Compressor",
    category: "dynamics",
    description: "Reduce the gap between loud and quiet parts for a fuller, steadier sound.",
    params: z.object({
      threshold: num(-18, -60, 0, "Level in dB where compression starts"),
      ratio: num(3, 1, 20, "Compression ratio"),
      attack: num(10, 0.1, 500, "Attack in ms"),
      release: num(150, 5, 2000, "Release in ms"),
      makeup: num(3, 0, 24, "Gain added afterwards, in dB"),
    }),
    toFilter: (p) =>
      `acompressor=threshold=${round3(10 ** (p.threshold / 20))}:ratio=${p.ratio}:attack=${p.attack}:release=${p.release}:makeup=${round3(clamp(10 ** (p.makeup / 20), 1, 64))}`,
  }),
  define({
    id: "normalize",
    name: "Loudness Normalize",
    category: "dynamics",
    description: "Bring audio to a standard loudness. -14 LUFS suits YouTube, Instagram and TikTok, -16 podcasts, -23 broadcast.",
    params: z.object({ target: num(-14, -30, -8, "Integrated loudness target in LUFS") }),
    toFilter: (p) => `loudnorm=I=${p.target}:TP=-1.5:LRA=11,aresample=48000`,
  }),

  // --- eq -----------------------------------------------------------------------
  define({
    id: "eq",
    name: "Equalizer",
    category: "eq",
    description: "Three-band tone control: bass, mids and treble, each -20..20 dB.",
    params: z.object({
      bass: num(0, -20, 20, "Low frequencies (around 100 Hz) in dB"),
      mid: num(0, -20, 20, "Mid frequencies (around 1 kHz) in dB"),
      treble: num(0, -20, 20, "High frequencies (around 8 kHz) in dB"),
    }),
    toFilter: (p) =>
      [p.bass && `bass=g=${p.bass}:f=100`, p.mid && `equalizer=f=1000:t=q:w=0.9:g=${p.mid}`, p.treble && `treble=g=${p.treble}:f=8000`].filter(Boolean).join(",") ||
      "anull",
  }),
  define({
    id: "bassBoost",
    name: "Bass Boost",
    category: "eq",
    description: "Warmer, punchier low end for music and voice.",
    params: z.object({ amount: num(6, 0, 20, "Boost in dB") }),
    toFilter: (p) => `bass=g=${p.amount}:f=110:w=0.6`,
  }),
  define({
    id: "lowpass",
    name: "Low Pass",
    category: "eq",
    description: "Remove highs above the cutoff (muffled, distant or underwater sound).",
    params: z.object({ frequency: num(1000, 100, 20000, "Cutoff in Hz") }),
    toFilter: (p) => `lowpass=f=${p.frequency}:poles=2`,
  }),
  define({
    id: "highpass",
    name: "High Pass",
    category: "eq",
    description: "Remove lows below the cutoff (thin, small-speaker sound).",
    params: z.object({ frequency: num(300, 20, 8000, "Cutoff in Hz") }),
    toFilter: (p) => `highpass=f=${p.frequency}:poles=2`,
  }),

  // --- volume -------------------------------------------------------------------
  define({
    id: "gain",
    name: "Gain",
    category: "volume",
    description: "Raise or lower the volume in decibels (+6 dB is about twice as loud, -6 dB about half).",
    params: z.object({ db: num(0, -60, 24, "Gain in dB") }),
    toFilter: (p) => (p.db === 0 ? "anull" : `volume=${p.db}dB`),
  }),
  define({
    id: "stereoWiden",
    name: "Stereo Widen",
    category: "volume",
    description: "Make stereo audio sound wider (music, ambience). No effect on mono sources.",
    params: z.object({ amount: num(1.5, 0, 4, "1 = unchanged, higher = wider") }),
    toFilter: (p) => `extrastereo=m=${p.amount}`,
  }),

  // --- creative -----------------------------------------------------------------
  define({
    id: "reverb",
    name: "Reverb",
    category: "creative",
    description: "Add room ambience, from a small room to a cathedral.",
    params: z.object({
      room: z.enum(["small", "room", "hall", "cathedral"]).default("room"),
      mix: num(0.3, 0, 1, "Wet level"),
    }),
    toFilter: (p) => {
      const r = ROOMS[p.room];
      const decays = r.decays.map((d) => round3(d * p.mix * 1.6)).join("|");
      return `aecho=in_gain=1:out_gain=${round3(1 / (1 + p.mix))}:delays=${r.delays.join("|")}:decays=${decays}`;
    },
  }),
  define({
    id: "echo",
    name: "Echo",
    category: "creative",
    description: "Distinct repeating echo, like shouting in a canyon.",
    params: z.object({
      delay: num(350, 20, 2000, "Time between repeats in ms"),
      decay: num(0.4, 0.05, 0.9, "Level of each repeat"),
    }),
    toFilter: (p) =>
      `aecho=in_gain=0.9:out_gain=0.8:delays=${p.delay}|${p.delay * 2}|${p.delay * 3}:decays=${round3(p.decay)}|${round3(p.decay ** 2)}|${round3(p.decay ** 3)}`,
  }),
  define({
    id: "telephone",
    name: "Telephone",
    category: "creative",
    description: "Narrow, lo-fi phone call sound.",
    params: z.object({}),
    toFilter: () => "highpass=f=400:poles=2,lowpass=f=3200:poles=2,acompressor=threshold=0.1:ratio=6:makeup=2,acrusher=bits=10:mix=0.4:mode=log",
  }),
  define({
    id: "radio",
    name: "Old Radio",
    category: "creative",
    description: "AM radio broadcast tone: band-limited, compressed and slightly gritty.",
    params: z.object({}),
    toFilter: () => "highpass=f=250:poles=2,lowpass=f=5000:poles=2,equalizer=f=1500:t=q:w=1:g=5,acompressor=threshold=0.08:ratio=8:makeup=3,acrusher=bits=12:mix=0.3",
  }),
  define({
    id: "megaphone",
    name: "Megaphone",
    category: "creative",
    description: "Harsh, distorted bullhorn voice.",
    params: z.object({}),
    toFilter: () => "highpass=f=700:poles=2,lowpass=f=3500:poles=2,volume=6dB,acrusher=bits=6:mix=0.5:mode=log,alimiter=limit=0.7",
  }),
  define({
    id: "underwater",
    name: "Underwater / Muffled",
    category: "creative",
    description: "Heavily muffled sound, like hearing through a wall or under water.",
    params: z.object({}),
    toFilter: () => "lowpass=f=450:poles=2,lowpass=f=450:poles=2,aecho=in_gain=1:out_gain=0.8:delays=30|60:decays=0.4|0.3",
  }),
  define({
    id: "robot",
    name: "Robot Voice",
    category: "creative",
    description: "Monotone, metallic robot voice.",
    params: z.object({}),
    toFilter: () => "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
  }),
  define({
    id: "whisper",
    name: "Whisper",
    category: "creative",
    description: "Turn a voice into a breathy whisper.",
    params: z.object({}),
    toFilter: () => "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8",
  }),
  define({
    id: "lofi",
    name: "Lo-fi",
    category: "creative",
    description: "Bit-crushed, band-limited retro sound.",
    params: z.object({ amount: num(50, 0, 100, "Strength") }),
    toFilter: (p) => `acrusher=bits=${Math.round(16 - p.amount * 0.1)}:mix=${round3(0.3 + p.amount * 0.006)}:mode=log,lowpass=f=${Math.round(9000 - p.amount * 60)}`,
  }),
  define({
    id: "chorus",
    name: "Chorus",
    category: "creative",
    description: "Thicken a sound as if several voices or instruments play together.",
    params: z.object({}),
    toFilter: () => "chorus=0.6:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3",
  }),
  define({
    id: "flanger",
    name: "Flanger",
    category: "creative",
    description: "Sweeping jet-plane whoosh.",
    params: z.object({ speed: num(0.5, 0.1, 10, "Sweeps per second") }),
    toFilter: (p) => `flanger=delay=2:depth=4:speed=${p.speed}`,
  }),
  define({
    id: "phaser",
    name: "Phaser",
    category: "creative",
    description: "Swirling, spacey phase-shift effect.",
    params: z.object({ speed: num(0.5, 0.1, 2, "Sweeps per second") }),
    toFilter: (p) => `aphaser=speed=${p.speed}:decay=0.5`,
  }),
  define({
    id: "tremolo",
    name: "Tremolo",
    category: "creative",
    description: "Rhythmic volume pulsing.",
    params: z.object({ rate: num(5, 0.1, 20, "Pulses per second"), depth: num(0.5, 0, 1, "Strength") }),
    toFilter: (p) => `tremolo=f=${p.rate}:d=${p.depth}`,
  }),
  define({
    id: "vibrato",
    name: "Vibrato",
    category: "creative",
    description: "Wavering pitch, like a warped tape or singer's vibrato.",
    params: z.object({ rate: num(5, 0.1, 20, "Wobbles per second"), depth: num(0.5, 0, 1, "Strength") }),
    toFilter: (p) => `vibrato=f=${p.rate}:d=${p.depth}`,
  }),
];

const byId = new Map(AUDIO_EFFECTS.map((e) => [e.id, e]));

export function getAudioEffect(id: string): AudioEffectDefinition | undefined {
  return byId.get(id);
}

export function listAudioEffects(category?: AudioEffectCategory): AudioEffectDefinition[] {
  return category ? AUDIO_EFFECTS.filter((e) => e.category === category) : AUDIO_EFFECTS;
}

export function registerAudioEffect(def: AudioEffectDefinition): void {
  if (byId.has(def.id)) throw new Error(`Audio effect "${def.id}" already registered`);
  AUDIO_EFFECTS.push(def);
  byId.set(def.id, def);
}

export function audioEffectToFilter(effect: Effect): string {
  const def = getAudioEffect(effect.type);
  if (!def) throw new Error(`Unknown audio effect "${effect.type}"`);
  return def.toFilter(def.params.parse(effect.params ?? {}));
}

export function audioEffectsToFilter(effects: Effect[]): string[] {
  return effects.map(audioEffectToFilter);
}
