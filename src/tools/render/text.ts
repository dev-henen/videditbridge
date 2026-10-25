import type { Animation, ShapeLayer, TextLayer } from "../../core/schema.js";
import { parseColor } from "../../core/util.js";
import { assEnterPhase, assExitPhase, type AssAnimContext } from "../../library/animations/index.js";
import { AssDocument, escapeAssText, type AssStyle } from "../captions/ass.js";

interface PhasedEvent {
  layer: number;
  start: number;
  end: number;
  style: string;
  x: number;
  y: number;
  /** Extra tags applied in every phase (e.g. alignment, drawing mode). */
  tags: string;
  body: string;
  text?: string;
  animIn?: Animation;
  animOut?: Animation;
}

const cs = (s: number) => Math.round(s * 100) / 100;

/**
 * Emit up to three consecutive events (enter / hold / exit) so entrance and exit animations
 * can each use their own \move / \t timing (ASS allows a single \move per event).
 */
function addPhased(doc: AssDocument, ev: PhasedEvent): void {
  const total = ev.end - ev.start;
  let dIn = ev.animIn && ev.animIn.type !== "none" ? ev.animIn.duration : 0;
  let dOut = ev.animOut && ev.animOut.type !== "none" ? ev.animOut.duration : 0;
  if (dIn + dOut > total) {
    const k = total / (dIn + dOut);
    dIn *= k;
    dOut *= k;
  }
  const t0 = cs(ev.start);
  const t1 = cs(ev.start + dIn);
  const t2 = cs(ev.end - dOut);
  const t3 = cs(ev.end);
  const ctx: AssAnimContext = { x: ev.x, y: ev.y, width: doc.width, height: doc.height, text: ev.text };
  if (t1 > t0 && ev.animIn) {
    const p = assEnterPhase({ ...ev.animIn, duration: t1 - t0 }, ctx);
    doc.addEvent({ layer: ev.layer, start: t0, end: t1, style: ev.style, text: `{${ev.tags}${p.tags}}${p.body ?? ev.body}` });
  }
  if (t2 > t1) {
    doc.addEvent({ layer: ev.layer, start: t1, end: t2, style: ev.style, text: `{${ev.tags}\\pos(${ev.x},${ev.y})}${ev.body}` });
  }
  if (t3 > t2 && ev.animOut) {
    const p = assExitPhase({ ...ev.animOut, duration: t3 - t2 }, ctx);
    doc.addEvent({ layer: ev.layer, start: t2, end: t3, style: ev.style, text: `{${ev.tags}${p.tags}}${ev.body}` });
  }
}

export function textLayerStyle(layer: TextLayer, width: number): AssStyle {
  const s = layer.style;
  const box = !!s.background;
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    primaryColor: s.color,
    secondaryColor: s.color,
    outlineColor: box ? s.background! : s.outlineColor,
    backColor: s.shadowColor,
    bold: s.bold,
    italic: s.italic,
    spacing: s.letterSpacing,
    borderStyle: box ? 3 : 1,
    outline: box ? Math.max(s.outlineWidth, Math.round(s.fontSize * 0.25)) : s.outlineWidth,
    shadow: s.shadow,
    alignment: s.align === "left" ? 4 : s.align === "right" ? 6 : 5,
    marginL: Math.round(width * 0.05),
    marginR: Math.round(width * 0.05),
    marginV: 0,
  };
}

export function addTextLayer(doc: AssDocument, layer: TextLayer, z: number): void {
  const style = doc.addStyle(textLayerStyle(layer, doc.width), "Text");
  const raw = layer.style.uppercase ? layer.text.toUpperCase() : layer.text;
  addPhased(doc, {
    layer: z,
    start: layer.start,
    end: layer.start + layer.duration,
    style,
    x: Math.round(layer.position.x * doc.width),
    y: Math.round(layer.position.y * doc.height),
    tags: "",
    body: escapeAssText(raw),
    text: raw,
    animIn: layer.animationIn,
    animOut: layer.animationOut,
  });
}

/** ASS override color `&HBBGGRR&` (alpha goes in a separate tag). */
const bgr = (c: { r: number; g: number; b: number }) =>
  `&H${[c.b, c.g, c.r].map((v) => Math.round(v).toString(16).padStart(2, "0").toUpperCase()).join("")}&`;

/** ASS drawing path for a w×h shape with its top-left at 0,0. Curves use the standard 0.5523 Bezier circle constant. */
export function shapePath(shape: ShapeLayer["shape"], w: number, h: number, radius: number): string {
  const k = 0.5523;
  const n = (v: number) => Math.round(v * 10) / 10;
  if (shape === "ellipse") {
    const [rx, ry] = [w / 2, h / 2];
    const [cx, cy] = [rx, ry];
    return [
      `m ${n(cx + rx)} ${n(cy)}`,
      `b ${n(cx + rx)} ${n(cy + k * ry)} ${n(cx + k * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)}`,
      `b ${n(cx - k * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + k * ry)} ${n(cx - rx)} ${n(cy)}`,
      `b ${n(cx - rx)} ${n(cy - k * ry)} ${n(cx - k * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)}`,
      `b ${n(cx + k * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - k * ry)} ${n(cx + rx)} ${n(cy)}`,
    ].join(" ");
  }
  const r = shape === "roundedRect" ? Math.min(radius, w / 2, h / 2) : 0;
  if (r <= 0) return `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`;
  const c = r * (1 - k);
  return [
    `m ${n(r)} 0 l ${n(w - r)} 0`,
    `b ${n(w - c)} 0 ${w} ${n(c)} ${w} ${n(r)} l ${w} ${n(h - r)}`,
    `b ${w} ${n(h - c)} ${n(w - c)} ${h} ${n(w - r)} ${h} l ${n(r)} ${h}`,
    `b ${n(c)} ${h} 0 ${n(h - c)} 0 ${n(h - r)} l 0 ${n(r)}`,
    `b 0 ${n(c)} ${n(c)} 0 ${n(r)} 0`,
  ].join(" ");
}

export function addShapeLayer(doc: AssDocument, layer: ShapeLayer, z: number): void {
  const color = parseColor(layer.color);
  const style = doc.addStyle(
    {
      fontFamily: "Arial",
      fontSize: 20,
      primaryColor: layer.color.slice(0, 7),
      secondaryColor: "#000000",
      outlineColor: "#000000",
      backColor: "#000000",
      bold: false,
      italic: false,
      spacing: 0,
      borderStyle: 1,
      outline: 0,
      shadow: 0,
      alignment: 5,
      marginL: 0,
      marginR: 0,
      marginV: 0,
    },
    "Shape",
  );
  const w = Math.round(layer.size.width * doc.width);
  const h = Math.round(layer.size.height * doc.height);
  const hexAlpha = (opacity: number) =>
    Math.round(255 * (1 - opacity))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  const stroke = parseColor(layer.strokeColor);
  const tags = [
    `\\1a&H${layer.fill ? hexAlpha(color.a * layer.opacity) : "FF"}&`,
    layer.strokeWidth > 0 ? `\\bord${layer.strokeWidth}\\3c${bgr(stroke)}\\3a&H${hexAlpha(stroke.a * layer.opacity)}&` : "",
    "\\p1",
  ].join("");
  const anim = {
    animIn: layer.animationIn?.type === "typewriter" ? { ...layer.animationIn, type: "fade" } : layer.animationIn,
    animOut: layer.animationOut,
  };
  // The shadow is its own blurred, offset copy underneath: ASS blur on the shape itself would soften its edge.
  if (layer.shadow > 0) {
    addPhased(doc, {
      layer: z,
      start: layer.start,
      end: layer.start + layer.duration,
      style,
      x: Math.round(layer.position.x * doc.width),
      y: Math.round(layer.position.y * doc.height + layer.shadow),
      tags: `\\1c&H000000&\\1a&H${hexAlpha(0.5 * layer.opacity)}&\\bord0\\blur${Math.max(2, Math.round(layer.shadow))}\\p1`,
      body: shapePath(layer.shape, w, h, layer.radius),
      ...anim,
    });
  }
  addPhased(doc, {
    layer: z,
    start: layer.start,
    end: layer.start + layer.duration,
    style,
    x: Math.round(layer.position.x * doc.width),
    y: Math.round(layer.position.y * doc.height),
    tags,
    body: shapePath(layer.shape, w, h, layer.radius),
    ...anim,
  });
}
