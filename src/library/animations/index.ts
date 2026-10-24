import type { Animation, Easing } from "../../core/schema.js";
import { round3 } from "../../core/util.js";

/**
 * Animations are applied to layers when they enter (animationIn) and leave (animationOut).
 * Text & shape layers render through ASS (libass) so they support the full set;
 * media overlays support the subset marked `media: true`.
 */

export interface AnimationDefinition {
  id: string;
  name: string;
  description: string;
  /** Supported on media (video/image) overlays. Text and shapes support every animation. */
  media: boolean;
  defaultDuration: number;
}

export const ANIMATIONS: AnimationDefinition[] = [
  { id: "none", name: "None", description: "Appear/disappear instantly.", media: true, defaultDuration: 0 },
  { id: "fade", name: "Fade", description: "Opacity fade. Subtle and universally safe.", media: true, defaultDuration: 0.4 },
  { id: "slide-up", name: "Slide Up", description: "Moves up into place (enters from below).", media: true, defaultDuration: 0.4 },
  { id: "slide-down", name: "Slide Down", description: "Moves down into place (enters from above).", media: true, defaultDuration: 0.4 },
  { id: "slide-left", name: "Slide Left", description: "Moves left into place (enters from the right).", media: true, defaultDuration: 0.4 },
  { id: "slide-right", name: "Slide Right", description: "Moves right into place (enters from the left).", media: true, defaultDuration: 0.4 },
  { id: "pop", name: "Pop", description: "Scales from 0 with a springy overshoot. Energetic, social-media style.", media: false, defaultDuration: 0.35 },
  { id: "zoom", name: "Zoom", description: "Scales up from 50% while fading in.", media: false, defaultDuration: 0.4 },
  { id: "blur", name: "Blur In", description: "Starts blurred and transparent, sharpens into focus. Cinematic.", media: false, defaultDuration: 0.6 },
  { id: "typewriter", name: "Typewriter", description: "Reveals characters one at a time over the animation duration.", media: false, defaultDuration: 1 },
  { id: "spin", name: "Spin", description: "Rotates into place while fading in.", media: false, defaultDuration: 0.5 },
  { id: "wipe", name: "Wipe", description: "Revealed left-to-right by a moving mask.", media: false, defaultDuration: 0.5 },
  { id: "drop", name: "Drop", description: "Falls from above with a fade, like a title slam.", media: false, defaultDuration: 0.35 },
  { id: "stretch", name: "Stretch", description: "Expands horizontally from a thin line.", media: false, defaultDuration: 0.4 },
];

const byId = new Map(ANIMATIONS.map((a) => [a.id, a]));

export function getAnimation(id: string): AnimationDefinition | undefined {
  return byId.get(id);
}

export function listAnimations(): AnimationDefinition[] {
  return ANIMATIONS;
}

// ---------------------------------------------------------------------------
// ASS (text/shape) rendering
// ---------------------------------------------------------------------------

/** ASS \t acceleration: <1 decelerates (ease-out), >1 accelerates (ease-in). */
function accel(easing: Easing): number {
  return easing === "ease-out" ? 0.5 : easing === "ease-in" ? 2 : 1;
}

export interface AssAnimContext {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text of the layer, used by typewriter. */
  text?: string;
}

export interface AssPhase {
  /** Override tags (without braces). */
  tags: string;
  /** Optional replacement for the text body (typewriter builds per-character tags). */
  body?: string;
}

const ms = (s: number) => Math.round(s * 1000);

/**
 * Tags for the entrance phase. The phase event lasts exactly `anim.duration`.
 * Position tags (\pos or \move) are always included so callers don't add their own.
 */
export function assEnterPhase(anim: Animation, ctx: AssAnimContext): AssPhase {
  const d = ms(anim.duration);
  const a = accel(anim.easing);
  const { x, y } = ctx;
  const pos = `\\pos(${x},${y})`;
  const off = Math.round(ctx.height * 0.06);
  const offX = Math.round(ctx.width * 0.08);
  switch (anim.type) {
    case "fade":
      return { tags: `${pos}\\fad(${d},0)` };
    case "slide-up":
      return { tags: `\\move(${x},${y + off},${x},${y},0,${d})\\fad(${Math.round(d * 0.6)},0)` };
    case "slide-down":
      return { tags: `\\move(${x},${y - off},${x},${y},0,${d})\\fad(${Math.round(d * 0.6)},0)` };
    case "slide-left":
      return { tags: `\\move(${x + offX},${y},${x},${y},0,${d})\\fad(${Math.round(d * 0.6)},0)` };
    case "slide-right":
      return { tags: `\\move(${x - offX},${y},${x},${y},0,${d})\\fad(${Math.round(d * 0.6)},0)` };
    case "drop":
      return { tags: `\\move(${x},${y - off * 2},${x},${y},0,${d})\\fad(${Math.round(d * 0.5)},0)` };
    case "pop": {
      const peak = Math.round(d * 0.7);
      return { tags: `${pos}\\fscx0\\fscy0\\t(0,${peak},${a},\\fscx112\\fscy112)\\t(${peak},${d},\\fscx100\\fscy100)` };
    }
    case "zoom":
      return { tags: `${pos}\\fad(${d},0)\\fscx50\\fscy50\\t(0,${d},${a},\\fscx100\\fscy100)` };
    case "stretch":
      return { tags: `${pos}\\fscx0\\t(0,${d},${a},\\fscx100)` };
    case "blur":
      return { tags: `${pos}\\fad(${d},0)\\blur20\\t(0,${d},${a},\\blur0)` };
    case "spin":
      return { tags: `${pos}\\fad(${d},0)\\frz-90\\t(0,${d},${a},\\frz0)` };
    case "wipe":
      return { tags: `${pos}\\clip(0,0,0,${ctx.height})\\t(0,${d},${a},\\clip(0,0,${ctx.width},${ctx.height}))` };
    case "typewriter": {
      const chars = [...(ctx.text ?? "")];
      const visible = chars.filter((c) => c.trim()).length || 1;
      let i = 0;
      const body = chars
        .map((c) => {
          if (!c.trim()) return c;
          const t0 = Math.round((i++ * d) / visible);
          return `{\\alpha&HFF&\\t(${t0},${t0 + 1},\\alpha&H00&)}${escapeAssChar(c)}`;
        })
        .join("");
      return { tags: pos, body };
    }
    default:
      return { tags: pos };
  }
}

/** Tags for the exit phase (the event lasts exactly `anim.duration`). */
export function assExitPhase(anim: Animation, ctx: AssAnimContext): AssPhase {
  const d = ms(anim.duration);
  const a = accel(anim.easing === "ease-out" ? "ease-in" : anim.easing === "ease-in" ? "ease-out" : anim.easing);
  const { x, y } = ctx;
  const pos = `\\pos(${x},${y})`;
  const off = Math.round(ctx.height * 0.06);
  const offX = Math.round(ctx.width * 0.08);
  const fadeTail = `\\fad(0,${Math.round(d * 0.6)})`;
  switch (anim.type) {
    case "fade":
      return { tags: `${pos}\\fad(0,${d})` };
    // Exit slides continue in the same direction the name suggests.
    case "slide-up":
      return { tags: `\\move(${x},${y},${x},${y - off},0,${d})${fadeTail}` };
    case "slide-down":
    case "drop":
      return { tags: `\\move(${x},${y},${x},${y + off},0,${d})${fadeTail}` };
    case "slide-left":
      return { tags: `\\move(${x},${y},${x - offX},${y},0,${d})${fadeTail}` };
    case "slide-right":
      return { tags: `\\move(${x},${y},${x + offX},${y},0,${d})${fadeTail}` };
    case "pop": {
      const peak = Math.round(d * 0.3);
      return { tags: `${pos}\\t(0,${peak},\\fscx112\\fscy112)\\t(${peak},${d},${a},\\fscx0\\fscy0)` };
    }
    case "zoom":
      return { tags: `${pos}\\fad(0,${d})\\t(0,${d},${a},\\fscx50\\fscy50)` };
    case "stretch":
      return { tags: `${pos}\\t(0,${d},${a},\\fscx0)` };
    case "blur":
      return { tags: `${pos}\\fad(0,${d})\\t(0,${d},${a},\\blur20)` };
    case "spin":
      return { tags: `${pos}\\fad(0,${d})\\t(0,${d},${a},\\frz90)` };
    case "wipe":
      return { tags: `${pos}\\clip(0,0,${ctx.width},${ctx.height})\\t(0,${d},${a},\\clip(${ctx.width},0,${ctx.width},${ctx.height}))` };
    case "typewriter":
      return { tags: `${pos}\\fad(0,${d})` };
    default:
      return { tags: pos };
  }
}

export function escapeAssChar(c: string): string {
  if (c === "{") return "\\{";
  if (c === "}") return "\\}";
  if (c === "\\") return "\\\\";
  return c;
}

// ---------------------------------------------------------------------------
// FFmpeg (media overlay) rendering
// ---------------------------------------------------------------------------

function easeExpr(u: string, easing: Easing): string {
  switch (easing) {
    case "ease-out":
      return `(1-pow(1-${u},2))`;
    case "ease-in":
      return `pow(${u},2)`;
    case "ease-in-out":
      return `(${u}*${u}*(3-2*${u}))`;
    default:
      return u;
  }
}

/**
 * Overlay x/y expressions for a media layer with slide animations.
 * `baseX`/`baseY` are expressions for the resting position; `start`/`end` are timeline seconds.
 */
export function overlayMotion(
  baseX: string,
  baseY: string,
  start: number,
  end: number,
  animIn?: Animation,
  animOut?: Animation,
): { x: string; y: string } {
  let x = baseX;
  let y = baseY;
  const apply = (anim: Animation, entering: boolean) => {
    const d = round3(anim.duration);
    const t0 = entering ? start : round3(end - d);
    // u goes 0→1 across the phase; offset is (1-u) when entering, u when exiting.
    const u = `clip((t-${t0})/${d},0,1)`;
    const e = easeExpr(u, anim.easing);
    const k = entering ? `(1-${e})` : e;
    const sign = (dir: number) => (dir > 0 ? "+" : "-");
    switch (anim.type) {
      case "slide-up":
        y = `${y}${sign(entering ? 1 : -1)}H*0.08*${k}`;
        break;
      case "slide-down":
        y = `${y}${sign(entering ? -1 : 1)}H*0.08*${k}`;
        break;
      case "slide-left":
        x = `${x}${sign(entering ? 1 : -1)}W*0.1*${k}`;
        break;
      case "slide-right":
        x = `${x}${sign(entering ? -1 : 1)}W*0.1*${k}`;
        break;
    }
  };
  if (animIn) apply(animIn, true);
  if (animOut) apply(animOut, false);
  return { x, y };
}

/** Whether an animation needs alpha fading on a media overlay. */
export function mediaAnimFades(anim?: Animation): boolean {
  return !!anim && anim.type !== "none" && (getAnimation(anim.type)?.media ?? false);
}
