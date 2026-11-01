import { describe, expect, it } from "vitest";
import { FLARE_LOOKS, PARTICLE_PRESETS, ParticleSettingsSchema, getParticlePreset, resolveParticles, type EmitterSpec } from "../../engine/library/particles/index.js";

const settings = (s: Record<string, unknown> = {}) => ParticleSettingsSchema.parse(s);
const emitterOf = (id: string, s: Record<string, unknown> = {}): EmitterSpec => {
  const sys = resolveParticles(getParticlePreset(id)!, settings(s)).systems[0]!;
  if (!("emitter" in sys)) throw new Error(`${id} has no emitter`);
  return sys.emitter;
};

describe("particle presets", () => {
  it("are described, unique and well formed", () => {
    expect(new Set(PARTICLE_PRESETS.map((p) => p.id)).size).toBe(PARTICLE_PRESETS.length);
    for (const p of PARTICLE_PRESETS) {
      expect(p.description.length, p.id).toBeGreaterThan(40);
      expect(p.systems.length, p.id).toBeGreaterThan(0);
      for (const sys of resolveParticles(p, settings()).systems) {
        if (!("emitter" in sys)) continue;
        const e = sys.emitter;
        expect(e.life[0], p.id).toBeGreaterThan(0);
        expect(e.max, p.id).toBeGreaterThan(0);
        expect(e.colors.length || e.colorOverLife.length, p.id).toBeGreaterThan(0);
        for (const stops of [e.sizeOverLife, e.opacityOverLife, e.colorOverLife]) {
          const ts = stops.map((s) => s[0]);
          expect(ts, `${p.id} stops in order`).toEqual([...ts].sort((a, b) => a - b));
        }
      }
    }
    for (const l of FLARE_LOOKS) expect(l.ghosts.every((g) => g.size > 0 && g.opacity > 0 && g.opacity <= 1), l.id).toBe(true);
  });

  it("scale with density, size and speed", () => {
    const base = emitterOf("snow");
    const dense = emitterOf("snow", { density: 2 });
    expect(dense.rate).toBeCloseTo(base.rate * 2);
    expect(dense.max).toBe(base.max * 2);
    expect(emitterOf("snow", { size: 2 }).size).toEqual([base.size[0] * 2, base.size[1] * 2]);
    const fast = emitterOf("snow", { speed: 2 });
    // Twice as fast: falling speed (gravity / drag) doubles, and lives halve so the frame stays as full.
    expect(fast.gravity / fast.drag).toBeCloseTo((2 * base.gravity) / base.drag);
    expect(fast.life[1]).toBeCloseTo(base.life[1] / 2);
    expect(resolveParticles(getParticlePreset("snow")!, settings({ speed: 2 })).preroll).toBeCloseTo(getParticlePreset("snow")!.preroll / 2);
  });

  it("slants falling rain with the wind and widens where it is born", () => {
    const still = emitterOf("rain");
    expect(still.direction).toBeCloseTo(90);
    const windy = emitterOf("rain", { wind: 0.6 });
    // Falling at 3 frame heights a second, pushed 0.6 to the right: about 11 degrees off vertical.
    expect(windy.direction).toBeCloseTo((Math.atan2(3, 0.6) * 180) / Math.PI, 3);
    expect(windy.wind[0]).toBeCloseTo(0.6);
    // Drops blown right come in from the left: the birth area reaches further left.
    expect(windy.area[0]).toBeLessThan(still.area[0]);
  });

  it("takes a color, a birth area and a ground line", () => {
    const e = emitterOf("embers", { color: "#3366FF", area: { x0: 0.2, y0: 0.9, x1: 0.4, y1: 1 }, ground: 0.8 });
    expect(e.colors).toEqual([[0.2, 0.4, 1]]);
    expect(e.colorOverLife).toEqual([]);
    expect(e.area).toEqual([0.2, 0.9, 0.4, 1]);
    expect(e.ground?.y).toBe(0.8);
    expect(emitterOf("heavyRain").ground?.splash).toBeGreaterThan(0);
  });

  it("thickens and moves smoke and fog", () => {
    const fog = getParticlePreset("fog")!;
    const thick = resolveParticles(fog, settings({ density: 2, wind: 0.1 })).systems[0]!;
    const plain = resolveParticles(fog, settings()).systems[0]!;
    if (!("noise" in thick) || !("noise" in plain)) throw new Error("fog is noise");
    expect(thick.noise.opacity).toBeGreaterThan(plain.noise.opacity);
    expect(thick.noise.drift[0]).toBeCloseTo(plain.noise.drift[0] + 0.1);
  });
});
