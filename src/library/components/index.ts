import { z } from "zod";
import type { Layer, Project } from "../../core/schema.js";
import { LayerSchema } from "../../core/schema.js";
import { deepClone, newId, round3 } from "../../core/util.js";

/**
 * Components are reusable composite elements (a lower-third = bar + name + title, a CTA = button + label…).
 * They expand into ordinary layers, so once inserted everything stays editable.
 */

export interface ComponentContext {
  width: number;
  height: number;
  /** Component duration in seconds. */
  duration: number;
}

/** A layer whose `start` is relative to the component start. */
export type ComponentLayer = z.input<typeof LayerSchema>;

export type ComponentCategory = "text" | "branding" | "social" | "structure" | "list";

export interface ComponentDefinition<P extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  category: ComponentCategory;
  description: string;
  params: P;
  defaultDuration: number;
  build(params: z.output<P>, ctx: ComponentContext): ComponentLayer[];
}

function define<P extends z.ZodType>(def: ComponentDefinition<P>): ComponentDefinition {
  return def as unknown as ComponentDefinition;
}

const color = (def: string) => z.string().default(def);
/** Pixel size authored for a 1080px short side. */
const px = (ctx: ComponentContext, n: number) => Math.round((n * Math.min(ctx.width, ctx.height)) / 1080);
const anim = (type: string, duration = 0.4) => ({ type, duration, easing: "ease-out" as const });

export const COMPONENTS: ComponentDefinition[] = [
  define({
    id: "lower-third",
    name: "Lower Third",
    category: "text",
    description: "Name + title bar in the lower-left area. Introduce a speaker, guest or location.",
    defaultDuration: 4,
    params: z.object({
      name: z.string().describe("Primary line, e.g. a person's name"),
      title: z.string().default("").describe("Secondary line, e.g. role or company"),
      accentColor: color("#6C47FF"),
      textColor: color("#FFFFFF"),
      fontFamily: z.string().default("Arial"),
    }),
    build: (p, ctx) => {
      const y = 0.8;
      const layers: ComponentLayer[] = [
        { type: "shape", id: "bar", start: 0, duration: ctx.duration, position: { x: 0.3, y }, size: { width: 0.52, height: p.title ? 0.11 : 0.075 }, color: "#000000", opacity: 0.7, animationIn: anim("slide-right"), animationOut: anim("fade", 0.3) },
        { type: "shape", id: "accent", start: 0, duration: ctx.duration, position: { x: 0.045, y }, size: { width: 0.012, height: p.title ? 0.11 : 0.075 }, color: p.accentColor, animationIn: anim("slide-right"), animationOut: anim("fade", 0.3) },
        { type: "text", id: "name", start: 0.15, duration: ctx.duration - 0.15, text: p.name, position: { x: 0.07, y: p.title ? y - 0.022 : y }, style: { fontFamily: p.fontFamily, fontSize: px(ctx, 54), color: p.textColor, bold: true, outlineWidth: 0, align: "left" }, animationIn: anim("slide-right"), animationOut: anim("fade", 0.3) },
      ];
      if (p.title)
        layers.push({ type: "text", id: "title", start: 0.3, duration: ctx.duration - 0.3, text: p.title, position: { x: 0.07, y: y + 0.028 }, style: { fontFamily: p.fontFamily, fontSize: px(ctx, 36), color: p.accentColor === "#000000" ? "#DDDDDD" : "#E6E6E6", bold: false, outlineWidth: 0, align: "left" }, animationIn: anim("fade"), animationOut: anim("fade", 0.3) });
      return layers;
    },
  }),
  define({
    id: "title-card",
    name: "Title Card",
    category: "structure",
    description: "Large centered title with an optional subtitle. Openers, section headers, end cards.",
    defaultDuration: 3,
    params: z.object({
      title: z.string(),
      subtitle: z.string().default(""),
      color: color("#FFFFFF"),
      subtitleColor: color("#CCCCCC"),
      fontFamily: z.string().default("Arial Black"),
      animation: z.string().default("pop").describe("Animation id for the title"),
      y: z.number().default(0.45),
    }),
    build: (p, ctx) => {
      const layers: ComponentLayer[] = [
        { type: "text", id: "title", start: 0, duration: ctx.duration, text: p.title, position: { x: 0.5, y: p.y }, style: { fontFamily: p.fontFamily, fontSize: px(ctx, 104), color: p.color, outlineWidth: 0, shadow: 3 }, animationIn: anim(p.animation, 0.5), animationOut: anim("fade", 0.3) },
      ];
      if (p.subtitle)
        layers.push({ type: "text", id: "subtitle", start: 0.35, duration: ctx.duration - 0.35, text: p.subtitle, position: { x: 0.5, y: p.y + 0.09 }, style: { fontFamily: "Arial", fontSize: px(ctx, 48), color: p.subtitleColor, bold: false, outlineWidth: 0, shadow: 2 }, animationIn: anim("slide-up"), animationOut: anim("fade", 0.3) });
      return layers;
    },
  }),
  define({
    id: "hook-text",
    name: "Hook Text",
    category: "social",
    description: "Big punchy statement at the top of the frame for the first seconds of a short. Stops the scroll.",
    defaultDuration: 3,
    params: z.object({
      text: z.string(),
      color: color("#FFFFFF"),
      highlight: color("#FFE600").describe("Background box color"),
      textOnHighlight: color("#000000"),
      boxed: z.boolean().default(true),
      y: z.number().default(0.2),
    }),
    build: (p, ctx) => [
      {
        type: "text",
        id: "hook",
        start: 0,
        duration: ctx.duration,
        text: p.text,
        position: { x: 0.5, y: p.y },
        style: p.boxed
          ? { fontFamily: "Arial Black", fontSize: px(ctx, 68), color: p.textOnHighlight, background: p.highlight, uppercase: true, outlineWidth: px(ctx, 16) }
          : { fontFamily: "Arial Black", fontSize: px(ctx, 80), color: p.color, uppercase: true, outlineWidth: px(ctx, 6) },
        animationIn: anim("pop", 0.35),
        animationOut: anim("fade", 0.25),
      },
    ],
  }),
  define({
    id: "cta",
    name: "Call to Action",
    category: "social",
    description: "Button-style call to action (\"Follow for more\", \"Link in bio\", \"Shop now\").",
    defaultDuration: 3,
    params: z.object({
      text: z.string().default("Follow for more"),
      buttonColor: color("#FF3B5C"),
      textColor: color("#FFFFFF"),
      y: z.number().default(0.82),
    }),
    build: (p, ctx) => [
      {
        type: "text",
        id: "button",
        start: 0,
        duration: ctx.duration,
        text: p.text,
        position: { x: 0.5, y: p.y },
        style: { fontFamily: "Arial Black", fontSize: px(ctx, 56), color: p.textColor, background: p.buttonColor, outlineWidth: px(ctx, 22) },
        animationIn: anim("pop", 0.4),
        animationOut: anim("zoom", 0.3),
      },
    ],
  }),
  define({
    id: "subscribe",
    name: "Subscribe Button",
    category: "social",
    description: "Red SUBSCRIBE button that pops in near the bottom. YouTube reminder.",
    defaultDuration: 3,
    params: z.object({ text: z.string().default("SUBSCRIBE"), x: z.number().default(0.5), y: z.number().default(0.85) }),
    build: (p, ctx) => [
      {
        type: "text",
        id: "subscribe",
        start: 0,
        duration: ctx.duration,
        text: `▶ ${p.text}`,
        position: { x: p.x, y: p.y },
        style: { fontFamily: "Arial Black", fontSize: px(ctx, 50), color: "#FFFFFF", background: "#FF0000", outlineWidth: px(ctx, 18) },
        animationIn: anim("pop", 0.4),
        animationOut: anim("pop", 0.3),
      },
    ],
  }),
  define({
    id: "social-handle",
    name: "Social Handle",
    category: "branding",
    description: "Small @handle watermark-style text in a corner.",
    defaultDuration: 5,
    params: z.object({
      handle: z.string().describe("e.g. @yourname"),
      corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
      opacity: z.number().min(0).max(1).default(0.85),
    }),
    build: (p, ctx) => {
      const right = p.corner.endsWith("right");
      const bottom = p.corner.startsWith("bottom");
      const alpha = Math.round(p.opacity * 255).toString(16).padStart(2, "0").toUpperCase();
      return [
        {
          type: "text",
          id: "handle",
          start: 0,
          duration: ctx.duration,
          text: p.handle,
          position: { x: right ? 0.95 : 0.05, y: bottom ? 0.94 : 0.06 },
          style: { fontSize: px(ctx, 34), color: `#FFFFFF${alpha}`, bold: true, outlineWidth: 0, shadow: 2, align: right ? "right" : "left" },
          animationIn: anim("fade"),
          animationOut: anim("fade"),
        },
      ];
    },
  }),
  define({
    id: "logo",
    name: "Logo / Watermark",
    category: "branding",
    description: "Image asset placed in a corner as a logo or watermark.",
    defaultDuration: 5,
    params: z.object({
      assetId: z.string().describe("Id of an image asset already in the project"),
      corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("top-right"),
      width: z.number().default(0.15).describe("Fraction of frame width"),
      opacity: z.number().min(0).max(1).default(0.9),
    }),
    build: (p, ctx) => [
      {
        type: "media",
        id: "logo",
        assetId: p.assetId,
        start: 0,
        duration: ctx.duration,
        position: { x: p.corner.endsWith("right") ? 0.95 - p.width / 2 : 0.05 + p.width / 2, y: p.corner.startsWith("top") ? 0.07 : 0.93 },
        size: { width: p.width },
        opacity: p.opacity,
        animationIn: anim("fade"),
        animationOut: anim("fade"),
      },
    ],
  }),
  define({
    id: "quote",
    name: "Quote",
    category: "text",
    description: "Large quotation with attribution. Quote cards, testimonials, motivational posts.",
    defaultDuration: 5,
    params: z.object({
      quote: z.string(),
      author: z.string().default(""),
      color: color("#FFFFFF"),
      accentColor: color("#FFD54A"),
      fontFamily: z.string().default("Georgia"),
    }),
    build: (p, ctx) => {
      const layers: ComponentLayer[] = [
        { type: "text", id: "mark", start: 0, duration: ctx.duration, text: "“", position: { x: 0.5, y: 0.28 }, style: { fontFamily: p.fontFamily, fontSize: px(ctx, 220), color: p.accentColor, outlineWidth: 0 }, animationIn: anim("zoom", 0.5), animationOut: anim("fade") },
        { type: "text", id: "quote", start: 0.2, duration: ctx.duration - 0.2, text: p.quote, position: { x: 0.5, y: 0.47 }, style: { fontFamily: p.fontFamily, fontSize: px(ctx, 62), color: p.color, bold: false, italic: true, outlineWidth: 0, shadow: 2 }, animationIn: anim("blur", 0.8), animationOut: anim("fade") },
      ];
      if (p.author)
        layers.push({ type: "text", id: "author", start: 0.8, duration: ctx.duration - 0.8, text: p.author, position: { x: 0.5, y: 0.66 }, style: { fontFamily: "Arial", fontSize: px(ctx, 40), color: p.accentColor, outlineWidth: 0 }, animationIn: anim("fade", 0.5), animationOut: anim("fade") });
      return layers;
    },
  }),
  define({
    id: "number-badge",
    name: "Number Badge",
    category: "list",
    description: "Big rank/step number with a label, for listicles (\"#3, Best value\") and step-by-step guides.",
    defaultDuration: 3,
    params: z.object({
      number: z.union([z.string(), z.number()]).transform(String),
      label: z.string().default(""),
      badgeColor: color("#FFE600"),
      numberColor: color("#000000"),
      labelColor: color("#FFFFFF"),
      y: z.number().default(0.16),
    }),
    build: (p, ctx) => {
      const layers: ComponentLayer[] = [
        { type: "text", id: "number", start: 0, duration: ctx.duration, text: `#${p.number}`, position: { x: 0.5, y: p.y }, style: { fontFamily: "Arial Black", fontSize: px(ctx, 96), color: p.numberColor, background: p.badgeColor, outlineWidth: px(ctx, 18) }, animationIn: anim("pop", 0.35), animationOut: anim("fade", 0.25) },
      ];
      if (p.label)
        layers.push({ type: "text", id: "label", start: 0.2, duration: ctx.duration - 0.2, text: p.label, position: { x: 0.5, y: p.y + 0.1 }, style: { fontFamily: "Arial Black", fontSize: px(ctx, 60), color: p.labelColor, uppercase: true, outlineWidth: px(ctx, 5) }, animationIn: anim("slide-up"), animationOut: anim("fade", 0.25) });
      return layers;
    },
  }),
  define({
    id: "chapter-title",
    name: "Chapter Title",
    category: "structure",
    description: "Small \"CHAPTER 2\" kicker above a section heading. Long-form tutorials and docs.",
    defaultDuration: 3,
    params: z.object({ kicker: z.string().default(""), heading: z.string(), accentColor: color("#6C47FF"), color: color("#FFFFFF") }),
    build: (p, ctx) => {
      const layers: ComponentLayer[] = [
        { type: "text", id: "heading", start: 0.15, duration: ctx.duration - 0.15, text: p.heading, position: { x: 0.5, y: 0.5 }, style: { fontFamily: "Arial Black", fontSize: px(ctx, 84), color: p.color, outlineWidth: 0, shadow: 3 }, animationIn: anim("wipe", 0.6), animationOut: anim("fade") },
      ];
      if (p.kicker)
        layers.unshift({ type: "text", id: "kicker", start: 0, duration: ctx.duration, text: p.kicker, position: { x: 0.5, y: 0.42 }, style: { fontFamily: "Arial", fontSize: px(ctx, 36), color: p.accentColor, bold: true, uppercase: true, outlineWidth: 0, letterSpacing: 6 }, animationIn: anim("fade"), animationOut: anim("fade") });
      return layers;
    },
  }),
  define({
    id: "meme-text",
    name: "Meme Text",
    category: "social",
    description: "Classic Impact top/bottom meme captions.",
    defaultDuration: 4,
    params: z.object({ top: z.string().default(""), bottom: z.string().default("") }),
    build: (p, ctx) => {
      const style = { fontFamily: "Impact", fontSize: px(ctx, 96), color: "#FFFFFF", bold: false, uppercase: true, outlineWidth: px(ctx, 6) };
      const layers: ComponentLayer[] = [];
      if (p.top) layers.push({ type: "text", id: "top", start: 0, duration: ctx.duration, text: p.top, position: { x: 0.5, y: 0.1 }, style });
      if (p.bottom) layers.push({ type: "text", id: "bottom", start: 0, duration: ctx.duration, text: p.bottom, position: { x: 0.5, y: 0.9 }, style });
      return layers;
    },
  }),
  define({
    id: "countdown",
    name: "Countdown",
    category: "structure",
    description: "3-2-1 style countdown; each number pops for an equal share of the duration.",
    defaultDuration: 3,
    params: z.object({ from: z.number().int().min(1).max(10).default(3), color: color("#FFFFFF"), finalText: z.string().default("") }),
    build: (p, ctx) => {
      const steps = [...Array(p.from).keys()].map((i) => String(p.from - i));
      if (p.finalText) steps.push(p.finalText);
      const each = ctx.duration / steps.length;
      return steps.map((s, i) => ({
        type: "text" as const,
        id: `n${i}`,
        start: round3(i * each),
        duration: round3(each),
        text: s,
        position: { x: 0.5, y: 0.5 },
        style: { fontFamily: "Arial Black", fontSize: px(ctx, s.length > 2 ? 110 : 260), color: p.color, outlineWidth: px(ctx, 8) },
        animationIn: anim("pop", Math.min(0.3, each / 2)),
      }));
    },
  }),
  define({
    id: "label",
    name: "Label / Callout",
    category: "text",
    description: "Small boxed label anywhere on screen (\"BEFORE\", \"Step 1\", \"$49\", annotations).",
    defaultDuration: 3,
    params: z.object({
      text: z.string(),
      x: z.number().default(0.5),
      y: z.number().default(0.1),
      background: color("#000000CC"),
      color: color("#FFFFFF"),
      size: z.number().default(44).describe("Font size at 1080p"),
      animation: z.string().default("pop"),
    }),
    build: (p, ctx) => [
      {
        type: "text",
        id: "label",
        start: 0,
        duration: ctx.duration,
        text: p.text,
        position: { x: p.x, y: p.y },
        style: { fontFamily: "Arial", fontSize: px(ctx, p.size), color: p.color, background: p.background, outlineWidth: px(ctx, 12) },
        animationIn: anim(p.animation, 0.3),
        animationOut: anim("fade", 0.25),
      },
    ],
  }),
  define({
    id: "end-screen",
    name: "End Screen",
    category: "structure",
    description: "Closing card: thank-you headline, follow/subscribe prompt and handle.",
    defaultDuration: 4,
    params: z.object({
      headline: z.string().default("Thanks for watching!"),
      prompt: z.string().default("Follow for more"),
      handle: z.string().default(""),
      accentColor: color("#FF3B5C"),
    }),
    build: (p, ctx) => {
      const layers: ComponentLayer[] = [
        { type: "text", id: "headline", start: 0, duration: ctx.duration, text: p.headline, position: { x: 0.5, y: 0.4 }, style: { fontFamily: "Arial Black", fontSize: px(ctx, 84), color: "#FFFFFF", outlineWidth: 0, shadow: 3 }, animationIn: anim("pop", 0.45), animationOut: anim("fade") },
        { type: "text", id: "prompt", start: 0.5, duration: ctx.duration - 0.5, text: p.prompt, position: { x: 0.5, y: 0.53 }, style: { fontFamily: "Arial Black", fontSize: px(ctx, 50), color: "#FFFFFF", background: p.accentColor, outlineWidth: px(ctx, 18) }, animationIn: anim("pop", 0.4), animationOut: anim("fade") },
      ];
      if (p.handle)
        layers.push({ type: "text", id: "handle", start: 0.8, duration: ctx.duration - 0.8, text: p.handle, position: { x: 0.5, y: 0.63 }, style: { fontSize: px(ctx, 40), color: "#DDDDDD", outlineWidth: 0 }, animationIn: anim("fade"), animationOut: anim("fade") });
      return layers;
    },
  }),
];

const byId = new Map(COMPONENTS.map((c) => [c.id, c]));

export function getComponent(id: string): ComponentDefinition | undefined {
  return byId.get(id);
}

export function listComponents(category?: ComponentCategory): ComponentDefinition[] {
  return category ? COMPONENTS.filter((c) => c.category === category) : COMPONENTS;
}

export function registerComponent<P extends z.ZodType>(def: ComponentDefinition<P>): void {
  if (byId.has(def.id)) throw new Error(`Component "${def.id}" already registered`);
  COMPONENTS.push(def as unknown as ComponentDefinition);
  byId.set(def.id, def as unknown as ComponentDefinition);
}

export interface ComponentInstance {
  component: string;
  start: number;
  duration?: number;
  params?: Record<string, unknown>;
}

/** Expand a component into concrete, absolutely-timed layers (ids prefixed with an instance id). */
export function buildComponentLayers(instance: ComponentInstance, ctx: { width: number; height: number }): Layer[] {
  const def = getComponent(instance.component);
  if (!def) throw new Error(`Unknown component "${instance.component}". Available: ${COMPONENTS.map((c) => c.id).join(", ")}`);
  const params = def.params.parse(instance.params ?? {});
  const duration = instance.duration ?? def.defaultDuration;
  const prefix = newId(def.id.replace(/-/g, ""));
  return def.build(params, { ...ctx, duration }).map((l) =>
    LayerSchema.parse({
      ...l,
      id: `${prefix}_${l.id}`,
      start: round3(instance.start + (l.start ?? 0)),
      duration: round3(Math.min(l.duration ?? duration, duration - (l.start ?? 0))),
      label: `component:${def.id}`,
    }),
  );
}

/** Add a component instance to a project. Returns the new project and the created layer ids. */
export function addComponent(project: Project, instance: ComponentInstance): { project: Project; layerIds: string[] } {
  const layers = buildComponentLayers(instance, project.settings);
  const next = deepClone(project);
  next.layers.push(...layers);
  return { project: next, layerIds: layers.map((l) => l.id) };
}
