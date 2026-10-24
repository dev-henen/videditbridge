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
  const alpha = Math.round(255 * (1 - color.a * layer.opacity))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  addPhased(doc, {
    layer: z,
    start: layer.start,
    end: layer.start + layer.duration,
    style,
    x: Math.round(layer.position.x * doc.width),
    y: Math.round(layer.position.y * doc.height),
    tags: `\\1a&H${alpha}&\\p1`,
    body: `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`,
    animIn: layer.animationIn?.type === "typewriter" ? { ...layer.animationIn, type: "fade" } : layer.animationIn,
    animOut: layer.animationOut,
  });
}
