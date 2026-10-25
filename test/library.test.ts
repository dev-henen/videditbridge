import { describe, expect, it } from "vitest";
import {
  ANIMATIONS,
  AUDIO_EFFECTS,
  atempoChain,
  audioEffectToFilter,
  COMPONENTS,
  EFFECTS,
  TEMPLATES,
  TRANSITIONS,
  addComponent,
  assEnterPhase,
  assExitPhase,
  buildComponentLayers,
  buildFromTemplate,
  describeTemplate,
  effectToFilter,
  listTemplates,
  registerTemplate,
  resolveCaptionStyle,
  type TemplateSpecInput,
} from "../src/library/index.js";
import { createProject, validateProject } from "../src/core/index.js";
import { sampleInputs } from "./helpers/inputs.js";

const ctx = { width: 1080, height: 1920, fps: 30, duration: 4 };

describe("effects", () => {
  it.each(EFFECTS.map((e) => [e.id, e]))("%s compiles with default params", (_id, e) => {
    if (e.id === "lut") return; // needs a file param
    const f = effectToFilter({ type: e.id }, ctx);
    expect(f).toMatch(/^[a-z0-9]/);
    expect(f).not.toContain("undefined");
    expect(f).not.toContain("NaN");
  });

  it("rejects bad params", () => {
    expect(() => effectToFilter({ type: "blur", params: { amount: -1 } }, ctx)).toThrow();
    expect(() => effectToFilter({ type: "nope" }, ctx)).toThrow(/Unknown effect/);
  });

  it("retouch effects blend through a mask sized to the frame", () => {
    const f = effectToFilter({ type: "backgroundBlur", params: { subject: { x: 0.3, y: 0.5, width: 0.4, height: 0.8 } } }, ctx);
    expect(f).toContain("nullsrc=s=1080x1920");
    expect(f).toContain("maskedmerge");
    expect(f).toContain("(X/SW/W-0.3)/0.2");
    expect(effectToFilter({ type: "beauty" }, { ...ctx, alpha: true })).toContain("format=yuva420p");
    expect(effectToFilter({ type: "beauty", params: { smooth: 0, brighten: 0, warmth: 0 } }, ctx)).toBe("null");
  });

  it("kenBurns zooms over the clip's frame count", () => {
    expect(effectToFilter({ type: "kenBurns", params: { zoomTo: 1.5 } }, ctx)).toContain("on/120");
  });
});

describe("audio effects", () => {
  it.each(AUDIO_EFFECTS.map((e) => [e.id]))("%s compiles with default params", (id) => {
    const f = audioEffectToFilter({ type: id });
    expect(f).toMatch(/^[a-z]/);
    expect(f).not.toMatch(/undefined|NaN/);
  });

  it("rejects bad params and unknown ids", () => {
    expect(() => audioEffectToFilter({ type: "denoise", params: { amount: 200 } })).toThrow();
    expect(() => audioEffectToFilter({ type: "nope" })).toThrow(/Unknown audio effect/);
  });

  it("chains atempo for speeds outside 0.5-2 and keeps duration when shifting pitch", () => {
    expect(atempoChain(4)).toEqual(["atempo=2", "atempo=2"]);
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
    expect(atempoChain(1)).toEqual([]);
    expect(audioEffectToFilter({ type: "pitch", params: { semitones: 12 } })).toBe("aresample=48000,asetrate=96000,aresample=48000,atempo=0.5");
  });
});

describe("transitions & animations", () => {
  it("has a rich catalog with unique ids", () => {
    expect(TRANSITIONS.length).toBeGreaterThan(40);
    expect(new Set(TRANSITIONS.map((t) => t.id)).size).toBe(TRANSITIONS.length);
    expect(ANIMATIONS.length).toBeGreaterThan(10);
  });

  it.each(ANIMATIONS.map((a) => [a.id]))("animation %s produces ASS tags", (id) => {
    const anim = { type: id, duration: 0.5, easing: "ease-out" as const };
    const enter = assEnterPhase(anim, { x: 540, y: 960, width: 1080, height: 1920, text: "Hi there" });
    const exit = assExitPhase(anim, { x: 540, y: 960, width: 1080, height: 1920 });
    expect(enter.tags + exit.tags).toMatch(/\\(pos|move)\(/);
  });
});

describe("caption styles", () => {
  it("resolves overrides and rejects unknown ids", () => {
    expect(resolveCaptionStyle("bold-pop", { highlightColor: "#00FF00" }).highlightColor).toBe("#00FF00");
    expect(() => resolveCaptionStyle("missing")).toThrow(/Available/);
  });
});

describe("components", () => {
  const params: Record<string, Record<string, unknown>> = {
    "lower-third": { name: "Ada Lovelace", title: "Mathematician" },
    "title-card": { title: "Hello", subtitle: "World" },
    "hook-text": { text: "Stop scrolling" },
    quote: { quote: "Be curious.", author: "Someone" },
    "number-badge": { number: 3, label: "Best value" },
    "chapter-title": { kicker: "Chapter 1", heading: "Intro" },
    "social-handle": { handle: "@me" },
    logo: { assetId: "logo" },
    label: { text: "BEFORE" },
    "meme-text": { top: "top", bottom: "bottom" },
  };
  it.each(COMPONENTS.map((c) => [c.id]))("%s builds valid layers", (id) => {
    const layers = buildComponentLayers({ component: id, start: 2, params: params[id] }, { width: 1080, height: 1920 });
    expect(layers.length).toBeGreaterThan(0);
    for (const l of layers) {
      expect(l.start).toBeGreaterThanOrEqual(2);
      expect(l.label).toBe(`component:${id}`);
    }
  });

  it("adds components to a project", () => {
    const p = createProject({ assets: [{ type: "color", id: "bg", color: "#000000" }], clips: [{ id: "c", assetId: "bg", duration: 5 }] });
    const { project, layerIds } = addComponent(p, { component: "lower-third", start: 1, params: { name: "Sam" } });
    expect(layerIds).toHaveLength(3);
    expect(validateProject(project).ok).toBe(true);
  });
});

describe("templates", () => {
  const media = { video: "talk.mp4", image: "photo.png", audio: "music.mp3", videoDuration: 12, audioDuration: 20, transcript: { words: [{ text: "Hello", start: 0.2, end: 0.6 }, { text: "world.", start: 0.7, end: 1.1 }] } };

  it("ships a large catalog with unique ids across categories", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.category)).size).toBeGreaterThanOrEqual(6);
  });

  it.each(TEMPLATES.map((t) => [t.id, t]))("%s builds a valid project from sample inputs", (_id, t) => {
    const { project } = buildFromTemplate(t, sampleInputs(t, media));
    const v = validateProject(project);
    expect(v.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(project.metadata.template).toBe(t.id);
    expect(project.clips.length).toBeGreaterThan(0);
    expect(describeTemplate(t)).toContain(t.name);
  });

  it("consumes main media across scenes", () => {
    const t = TEMPLATES.find((x) => x.id === "viral-talking-head")!;
    const { project } = buildFromTemplate(t, { main: { src: "talk.mp4", duration: 30 }, hook: "Wait for it" });
    const [hook, body] = project.clips;
    expect(hook).toMatchObject({ in: 0, duration: 3 });
    expect(body).toMatchObject({ in: 3, duration: 27 });
  });

  it("repeats scenes per list item and skips optional scenes", () => {
    const t = TEMPLATES.find((x) => x.id === "listicle-countdown")!;
    const { project } = buildFromTemplate(t, { title: "Top 3", items: [{ media: "a.png", label: "A" }, { media: "b.png", label: "B" }, { media: "c.png", label: "C" }] });
    expect(project.clips).toHaveLength(4); // intro + 3 items, CTA skipped
    expect(project.layers.some((l) => l.type === "text" && l.text === "#3")).toBe(true);
  });

  it("requires required slots", () => {
    expect(() => buildFromTemplate(TEMPLATES.find((x) => x.id === "meme")!, {})).toThrow(/requires slot "media"/);
  });

  it("searches and registers custom templates", () => {
    expect(listTemplates({ query: "real estate" })[0]!.id).toBe("real-estate-tour");
    const custom: TemplateSpecInput = {
      id: "custom-test",
      name: "Custom",
      description: "x",
      category: "promo",
      aspectRatio: "1:1",
      idealDuration: [5, 10],
      aiGuidance: "x",
      slots: [{ id: "title", kind: "text", description: "title" }],
      scenes: [{ id: "s", name: "S", purpose: "p", texts: [{ text: "{{title}}" }] }],
    };
    registerTemplate(custom);
    const { project } = buildFromTemplate(listTemplates({ query: "custom-test" })[0]!, { title: "Hi" });
    expect(project.layers[0]).toMatchObject({ type: "text", text: "Hi" });
  });
});
