import type { Easing, Keyframe, Layer, LayerKeyframes, Position } from "./schema.js";
import { round3 } from "./util.js";

/** 0..1 progress shaped by an easing curve (the same curves as entrance animations). */
export function easeValue(u: number, easing: Easing): number {
  const v = Math.min(1, Math.max(0, u));
  switch (easing) {
    case "ease-in":
      return v * v;
    case "ease-out":
      return 1 - (1 - v) ** 2;
    case "ease-in-out":
      return v * v * (3 - 2 * v);
    default:
      return v;
  }
}

/** The same curve as an FFmpeg expression of a 0..1 progress expression `u`. */
export function easeExpr(u: string, easing: Easing): string {
  switch (easing) {
    case "ease-in":
      return `pow(${u},2)`;
    case "ease-out":
      return `(1-pow(1-${u},2))`;
    case "ease-in-out":
      return `(${u}*${u}*(3-2*${u}))`;
    default:
      return u;
  }
}

const sorted = <T>(keys: Keyframe<T>[]) => [...keys].sort((a, b) => a.time - b.time);

/** A keyframed number at time `t` (seconds from the start). Holds the first and last values outside the keys. */
export function numberAt(keys: Keyframe<number>[], t: number): number {
  const k = sorted(keys);
  if (t <= k[0]!.time) return k[0]!.value;
  for (let i = 1; i < k.length; i++) {
    const b = k[i]!;
    if (t < b.time) {
      const a = k[i - 1]!;
      return a.value + (b.value - a.value) * easeValue((t - a.time) / Math.max(1e-9, b.time - a.time), b.easing);
    }
  }
  return k[k.length - 1]!.value;
}

/** A keyframed position at time `t`. */
export function positionAt(keys: Keyframe<Position>[], t: number): Position {
  const pick = (axis: "x" | "y") => keys.map((k) => ({ ...k, value: k.value[axis] }));
  return { x: numberAt(pick("x"), t), y: numberAt(pick("y"), t) };
}

/**
 * A keyframed number as an FFmpeg expression of a time expression `t` (seconds from the start),
 * built as nested if()s, one per keyframe gap.
 */
export function numberExpr(keys: Keyframe<number>[], t: string): string {
  const k = sorted(keys);
  let expr = String(round3(k[k.length - 1]!.value));
  for (let i = k.length - 1; i >= 1; i--) {
    const [a, b] = [k[i - 1]!, k[i]!];
    const span = Math.max(1e-6, b.time - a.time);
    const u = `clip((${t}-${round3(a.time)})/${round3(span)},0,1)`;
    const segment = `${round3(a.value)}+${round3(b.value - a.value)}*${easeExpr(u, b.easing)}`;
    expr = `if(lt(${t},${round3(b.time)}),${segment},${expr})`;
  }
  return k.length > 1 ? `if(lt(${t},${round3(k[0]!.time)}),${round3(k[0]!.value)},${expr})` : expr;
}

export function positionExpr(keys: Keyframe<Position>[], t: string): { x: string; y: string } {
  const pick = (axis: "x" | "y") => keys.map((k) => ({ ...k, value: k.value[axis] }));
  return { x: numberExpr(pick("x"), t), y: numberExpr(pick("y"), t) };
}

export interface LayerState {
  position: Position;
  scale: number;
  rotation: number;
  opacity: number;
}

const has = <T>(keys?: Keyframe<T>[]): keys is Keyframe<T>[] => !!keys && keys.length > 0;

/** Whether a layer has any keyframes. */
export function isAnimated(layer: { keyframes?: LayerKeyframes }): boolean {
  const k = layer.keyframes;
  return !!k && (has(k.position) || has(k.scale) || has(k.rotation) || has(k.opacity));
}

/** Where a layer is, how big, how turned and how visible at time `t` (seconds from its start). */
export function layerStateAt(layer: Layer, t: number): LayerState {
  const k = layer.keyframes ?? {};
  return {
    position: has(k.position) ? positionAt(k.position, t) : layer.position,
    scale: has(k.scale) ? numberAt(k.scale, t) : 1,
    rotation: has(k.rotation) ? numberAt(k.rotation, t) : 0,
    opacity: has(k.opacity) ? numberAt(k.opacity, t) : 1,
  };
}

/**
 * Drop keyframes that the line between their neighbours already explains within `tolerance`, so a
 * path sampled from tracking (a point every half second) becomes a few smooth moves.
 */
export function simplifyKeys(keys: Keyframe<Position>[], tolerance = 0.01): Keyframe<Position>[] {
  const k = sorted(keys);
  if (k.length <= 2) return k;
  const keep = new Array<boolean>(k.length).fill(false);
  keep[0] = keep[k.length - 1] = true;
  const walk = (a: number, b: number) => {
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (k[i]!.time - k[a]!.time) / Math.max(1e-9, k[b]!.time - k[a]!.time);
      const x = k[a]!.value.x + (k[b]!.value.x - k[a]!.value.x) * u;
      const y = k[a]!.value.y + (k[b]!.value.y - k[a]!.value.y) * u;
      const d = Math.hypot(k[i]!.value.x - x, k[i]!.value.y - y);
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tolerance) {
      keep[at] = true;
      walk(a, at);
      walk(at, b);
    }
  };
  walk(0, k.length - 1);
  return k.filter((_, i) => keep[i]);
}

/**
 * Average each point with its neighbours (up to `radius` on each side) to take out detection
 * jitter. The window stays even on both sides, so the ends of a path are not pulled inward.
 */
export function smoothKeys(keys: Keyframe<Position>[], radius = 1): Keyframe<Position>[] {
  const k = sorted(keys);
  return k.map((key, i) => {
    const r = Math.min(radius, i, k.length - 1 - i);
    const win = k.slice(i - r, i + r + 1);
    const avg = (axis: "x" | "y") => round3(win.reduce((n, w) => n + w.value[axis], 0) / win.length);
    return { ...key, value: { x: avg("x"), y: avg("y") } };
  });
}
