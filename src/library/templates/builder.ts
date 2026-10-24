import type { Asset, Clip, Layer, Project, Transcript } from "../../core/schema.js";
import { ClipSchema, LayerSchema, ProjectSchema, TextStyleSchema } from "../../core/schema.js";
import { computeTimeline } from "../../core/timeline.js";
import { dimensionsFor, newId, round3, type AspectRatio } from "../../core/util.js";
import { buildComponentLayers } from "../components/index.js";
import type { MediaInput, SceneSpec, TemplateInputs, TemplateSpec, Theme } from "./types.js";
import { TemplateSpecSchema } from "./types.js";

export interface BuildOptions {
  /** Override the template's aspect ratio (e.g. reuse a vertical template for square). */
  aspectRatio?: AspectRatio;
  theme?: Partial<Theme>;
  name?: string;
}

export interface BuildResult {
  project: Project;
  /** Non-fatal problems (missing optional inputs, unknown durations…). */
  warnings: string[];
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|wma)$/i;
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Size presets authored at 1080px short side. */
const TEXT_PRESETS = {
  title: { size: 96, font: "heading", y: 0.42, color: "text", in: "pop", bold: true },
  heading: { size: 76, font: "heading", y: 0.3, color: "text", in: "slide-up", bold: true },
  subtitle: { size: 50, font: "body", y: 0.53, color: "text", in: "slide-up", bold: false },
  body: { size: 46, font: "body", y: 0.6, color: "text", in: "fade", bold: false },
  caption: { size: 44, font: "body", y: 0.86, color: "text", in: "fade", bold: true },
  kicker: { size: 34, font: "body", y: 0.35, color: "accent", in: "fade", bold: true },
  "big-number": { size: 220, font: "heading", y: 0.42, color: "accent", in: "pop", bold: true },
  footer: { size: 34, font: "body", y: 0.93, color: "text", in: "fade", bold: false },
} as const;

interface Scope {
  inputs: TemplateInputs;
  theme: Theme;
  item?: unknown;
  index?: number;
}

function lookup(path: string, scope: Scope): unknown {
  const [head, ...rest] = path.split(".");
  let value: unknown =
    head === "theme" ? scope.theme : head === "item" ? scope.item : head === "index" ? scope.index : scope.inputs[head!];
  for (const key of rest) {
    if (value === undefined || value === null) return undefined;
    value = Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : (value as Record<string, unknown>)[key];
  }
  return value;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Resolve placeholders. A string that is exactly one placeholder returns the raw value (e.g. a media object). */
function resolve(template: string, scope: Scope): unknown {
  const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(template.trim());
  if (whole) return lookup(whole[1]!, scope);
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_, p: string) => {
    const v = lookup(p, scope);
    if (isEmpty(v)) {
      missing = true;
      return "";
    }
    return typeof v === "object" ? String((v as { src?: string }).src ?? "") : String(v);
  });
  return missing && !out.trim() ? undefined : out;
}

function resolveDeep(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return resolve(value, scope);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v, scope)]));
  return value;
}

/** All placeholders referenced by a scene (used to skip optional scenes with missing inputs). */
function scenePlaceholders(scene: SceneSpec): string[] {
  const out: string[] = [];
  JSON.stringify({ b: scene.background, t: scene.texts, c: scene.components, o: scene.overlays }).replace(PLACEHOLDER, (_, p: string) => {
    out.push(p);
    return "";
  });
  return out.filter((p) => !p.startsWith("theme.") && p !== "index");
}

function toMedia(value: unknown): Exclude<MediaInput, string> | undefined {
  if (typeof value === "string") return value ? { src: value } : undefined;
  if (value && typeof value === "object" && typeof (value as { src?: unknown }).src === "string") return value as Exclude<MediaInput, string>;
  if (Array.isArray(value)) return toMedia(value[0]);
  return undefined;
}

/** Build a project from a template and inputs. Synchronous: pass media durations to fit scenes to media. */
export function buildFromTemplate(specInput: TemplateSpec, inputs: TemplateInputs, opts: BuildOptions = {}): BuildResult {
  const spec = TemplateSpecSchema.parse(specInput);
  const warnings: string[] = [];
  const theme: Theme = { ...spec.theme, ...opts.theme };
  const dims = dimensionsFor(opts.aspectRatio ?? spec.aspectRatio);
  const k = Math.min(dims.width, dims.height) / 1080;

  for (const slot of spec.slots) {
    if (slot.required && isEmpty(inputs[slot.id])) throw new Error(`Template "${spec.id}" requires slot "${slot.id}": ${slot.description}`);
  }

  const assets: Asset[] = [];
  const transcripts: Record<string, Transcript> = {};
  const bySrc = new Map<string, Asset>();
  const cursors = new Map<string, number>();

  const ensureMedia = (m: Exclude<MediaInput, string>, hint: string, forceKind?: "image" | "audio" | "video"): Asset => {
    const existing = bySrc.get(m.src);
    if (existing) return existing;
    const kind = forceKind ?? (IMAGE_EXT.test(m.src) ? "image" : AUDIO_EXT.test(m.src) ? "audio" : "video");
    const id = uniqueId(hint.replace(/[^\w]/g, "_") || "media", assets);
    const total = m.duration !== undefined ? (m.in ?? 0) + m.duration : undefined;
    const asset: Asset =
      kind === "image"
        ? { type: "image", id, src: m.src, ...(m.width ? { width: m.width, height: m.height } : {}) }
        : kind === "audio"
          ? { type: "audio", id, src: m.src, ...(total ? { duration: total } : {}) }
          : { type: "video", id, src: m.src, ...(total ? { duration: total } : {}), ...(m.hasAudio !== undefined ? { hasAudio: m.hasAudio } : {}), ...(m.width ? { width: m.width, height: m.height } : {}) };
    assets.push(asset);
    bySrc.set(m.src, asset);
    if (m.transcript) transcripts[id] = m.transcript;
    if (m.in) cursors.set(id, m.in);
    return asset;
  };

  const ensureColor = (key: string, make: (id: string) => Asset): Asset => {
    const existing = bySrc.get(key);
    if (existing) return existing;
    const asset = make(uniqueId("bg", assets));
    assets.push(asset);
    bySrc.set(key, asset);
    return asset;
  };

  type Pending = { clipId: string; scene: SceneSpec; scope: Scope };
  const clips: Clip[] = [];
  const pending: Pending[] = [];

  for (const scene of spec.scenes) {
    let items: unknown[] = [undefined];
    if (scene.repeat) {
      const v = inputs[scene.repeat];
      items = Array.isArray(v) ? v : isEmpty(v) ? [] : [v];
      if (!items.length) {
        if (!scene.optional) warnings.push(`Scene "${scene.id}" repeats over empty slot "${scene.repeat}" and was skipped`);
        continue;
      }
    }
    items.forEach((item, i) => {
      const scope: Scope = { inputs, theme, item, index: i + 1 };
      if (scene.optional && scenePlaceholders(scene).some((p) => isEmpty(lookup(p, scope)))) return;

      const bg = scene.background;
      let clip: Clip;
      const sceneDuration = resolveDuration(scene, scope) ?? scene.duration;
      const transition = clips.length === 0 ? undefined : scene.transition === null ? undefined : (scene.transition ?? spec.transition);
      const base = { id: newId("clip"), effects: scene.effects, transition, label: scene.name };

      if ("media" in bg) {
        const media = toMedia(resolve(bg.media, scope));
        if (!media) {
          warnings.push(`Scene "${scene.id}": no media for ${bg.media}; using a solid background`);
          const asset = ensureColor(theme.backgroundColor, (id) => ({ type: "color", id, color: theme.backgroundColor }));
          clip = ClipSchema.parse({ ...base, assetId: asset.id, duration: sceneDuration });
        } else {
          const asset = ensureMedia(media, bg.media.replace(/[{}]/g, "").replace(/^item\./, `${scene.id}_`) || scene.id);
          if (asset.type === "audio") throw new Error(`Scene "${scene.id}" background must be video or image, got audio`);
          if (asset.type === "image") {
            clip = ClipSchema.parse({ ...base, assetId: asset.id, duration: sceneDuration, fit: bg.fit ?? "cover" });
          } else {
            const start = bg.consume ? (cursors.get(asset.id) ?? 0) : (media.in ?? 0);
            const known = asset.type === "video" ? asset.duration : undefined;
            const available = known !== undefined ? Math.max(0, known - start) : undefined;
            let srcDur = scene.fitMedia ? (available ?? sceneDuration * bg.speed) : sceneDuration * bg.speed;
            if (scene.maxDuration) srcDur = Math.min(srcDur, scene.maxDuration * bg.speed);
            if (available !== undefined) srcDur = Math.min(srcDur, available);
            if (srcDur <= 0.05) {
              warnings.push(`Scene "${scene.id}": media "${media.src}" has no footage left; scene skipped`);
              return;
            }
            if (known === undefined && scene.fitMedia) warnings.push(`Scene "${scene.id}": duration of "${media.src}" unknown; using ${round3(srcDur)}s (use applyTemplate to probe)`);
            if (bg.consume) cursors.set(asset.id, start + srcDur);
            clip = ClipSchema.parse({ ...base, assetId: asset.id, in: round3(start), duration: round3(srcDur), speed: bg.speed, muted: bg.muted, volume: bg.volume, fit: bg.fit ?? "cover" });
          }
        }
      } else if ("color" in bg) {
        const color = String(resolve(bg.color, scope) ?? theme.backgroundColor);
        const asset = ensureColor(color, (id) => ({ type: "color", id, color }));
        clip = ClipSchema.parse({ ...base, assetId: asset.id, duration: sceneDuration });
      } else {
        const colors = bg.gradient.map((c) => String(resolve(c, scope)));
        const asset = ensureColor(`${colors.join(",")}|${bg.direction}`, (id) => ({ type: "gradient", id, colors, direction: bg.direction }));
        clip = ClipSchema.parse({ ...base, assetId: asset.id, duration: sceneDuration });
      }
      clips.push(clip);
      pending.push({ clipId: clip.id, scene, scope });
    });
  }

  if (!clips.length) throw new Error(`Template "${spec.id}" produced no scenes from the given inputs`);

  let project = ProjectSchema.parse({
    id: newId("proj"),
    name: opts.name ?? spec.name,
    settings: { ...dims, fps: spec.fps, backgroundColor: theme.backgroundColor.slice(0, 7) },
    assets,
    clips,
    effects: spec.grade,
    transcripts,
    metadata: { template: spec.id },
  });

  // Layers are placed after timing is known (transitions shift scene starts).
  const timeline = computeTimeline(project);
  const layers: Layer[] = [];
  for (const { clipId, scene, scope } of pending) {
    const tc = timeline.clips.find((c) => c.clip.id === clipId)!;
    const next = timeline.clips[tc.index + 1];
    const sceneStart = tc.start;
    const sceneEnd = next ? next.start + next.transitionDuration * 0.5 : tc.end;
    const span = (start: number, duration?: number) => {
      const s = round3(sceneStart + start);
      const d = round3(Math.min(duration ?? Infinity, sceneEnd - s));
      return d > 0.05 ? { start: s, duration: d } : undefined;
    };

    for (const t of scene.texts) {
      const text = resolve(t.text, scope);
      if (isEmpty(text) || typeof text !== "string") continue;
      const timing = span(t.start, t.duration);
      if (!timing) continue;
      const preset = TEXT_PRESETS[t.preset];
      const style = TextStyleSchema.parse({
        fontFamily: preset.font === "heading" ? theme.headingFont : theme.fontFamily,
        fontSize: Math.round(preset.size * k),
        color: preset.color === "accent" ? theme.accentColor : theme.textColor,
        bold: preset.bold,
        outlineWidth: Math.round(3 * k),
        shadow: 2,
        uppercase: t.preset === "kicker",
        ...(resolveDeep(t.style ?? {}, scope) as object),
      });
      layers.push(
        LayerSchema.parse({
          type: "text",
          id: newId("text"),
          text,
          ...timing,
          position: t.position ?? { x: 0.5, y: preset.y },
          style,
          animationIn: t.animationIn ?? { type: preset.in, duration: 0.4 },
          animationOut: t.animationOut ?? { type: "fade", duration: 0.25 },
          label: `${scene.id}:${t.preset}`,
        }),
      );
    }

    for (const c of scene.components) {
      const params = resolveDeep(c.params, scope) as Record<string, unknown>;
      // Params whose placeholders are empty are dropped so component defaults apply.
      const dropped = Object.keys(params).filter((key) => params[key] === undefined);
      for (const key of dropped) delete params[key];
      // Media params (e.g. a logo slot) become project assets.
      for (const [key, value] of Object.entries(params)) {
        const media = key === "assetId" ? toMedia(value) : undefined;
        if (media) {
          const asset = ensureMedia(media, String(c.params[key]).replace(/[{}]/g, ""), "image");
          if (!project.assets.some((a) => a.id === asset.id)) project.assets.push(asset);
          params[key] = asset.id;
        }
      }
      const timing = span(c.start, c.duration);
      if (!timing) continue;
      try {
        layers.push(...buildComponentLayers({ component: c.component, params, ...timing }, dims));
      } catch (e) {
        // A required param that came from an empty optional slot just means "leave it out".
        if (!dropped.length) warnings.push(`Scene "${scene.id}": component "${c.component}" skipped (${(e as Error).message.split("\n")[0]})`);
      }
    }

    for (const o of scene.overlays) {
      const media = toMedia(resolve(o.media, scope));
      if (!media) continue;
      const timing = span(o.start, o.duration);
      if (!timing) continue;
      const asset = ensureMedia(media, o.media.replace(/[{}]/g, "").replace(/^item\./, `${scene.id}_`));
      if (!project.assets.some((a) => a.id === asset.id)) project.assets.push(asset);
      layers.push(
        LayerSchema.parse({
          type: "media",
          id: newId("overlay"),
          assetId: asset.id,
          in: media.in ?? 0,
          ...timing,
          position: o.position,
          size: o.size,
          fit: o.fit,
          opacity: o.opacity,
          effects: o.effects,
          animationIn: o.animationIn,
          animationOut: o.animationOut,
          label: `${scene.id}:overlay`,
        }),
      );
    }
  }
  project.layers = layers;

  // Audio
  if (spec.voiceover) {
    const vo = toMedia(inputs[spec.voiceover.slot]);
    if (vo) {
      const asset = ensureMedia(vo, spec.voiceover.slot, "audio");
      if (!project.assets.some((a) => a.id === asset.id)) project.assets.push(asset);
      if (vo.transcript) project.transcripts[asset.id] = vo.transcript;
      project.audio.push({ id: newId("audio"), assetId: asset.id, role: "voiceover", start: 0, in: vo.in ?? 0, volume: spec.voiceover.volume, fadeIn: 0, fadeOut: 0, loop: false, ...(vo.duration ? { duration: vo.duration } : {}) });
    }
  }
  if (spec.music) {
    const m = toMedia(inputs[spec.music.slot]);
    if (m) {
      const asset = ensureMedia(m, spec.music.slot, "audio");
      if (!project.assets.some((a) => a.id === asset.id)) project.assets.push(asset);
      project.audio.push({
        id: newId("audio"),
        assetId: asset.id,
        role: "music",
        start: 0,
        in: m.in ?? 0,
        duration: timeline.duration,
        volume: spec.music.volume,
        fadeIn: spec.music.fadeIn,
        fadeOut: spec.music.fadeOut,
        loop: true,
        duck: spec.music.duck,
      });
    }
  }
  if (spec.captions && Object.keys(project.transcripts).length) {
    project.captions = { enabled: true, style: spec.captions.style, ...(spec.captions.overrides ? { overrides: spec.captions.overrides } : {}) };
  } else if (spec.captions) {
    warnings.push("Template uses captions but no transcript was provided — transcribe the main media to enable them");
  }

  project = ProjectSchema.parse(project);
  return { project, warnings };
}

/** Duration from `durationFrom`: a number, or the known duration of a media input. */
function resolveDuration(scene: SceneSpec, scope: Scope): number | undefined {
  if (!scene.durationFrom) return undefined;
  const v = resolve(scene.durationFrom, scope);
  const n = typeof v === "number" ? v : typeof v === "string" && /^d+(.d+)?$/.test(v) ? Number(v) : toMedia(v)?.duration;
  return n && n > 0 ? Math.min(n, scene.maxDuration ?? Infinity) : undefined;
}

function uniqueId(base: string, assets: Asset[]): string {
  let id = base;
  let n = 2;
  while (assets.some((a) => a.id === id)) id = `${base}_${n++}`;
  return id;
}

/** Every media input referenced by template inputs (for probing before build). */
export function collectMediaInputs(spec: TemplateSpec, inputs: TemplateInputs): { slot: string; media: Exclude<MediaInput, string>; set: (m: Exclude<MediaInput, string>) => void }[] {
  const out: { slot: string; media: Exclude<MediaInput, string>; set: (m: Exclude<MediaInput, string>) => void }[] = [];
  const visit = (value: unknown, slot: string, set: (v: unknown) => void) => {
    if (typeof value === "string" && spec.slots.find((s) => s.id === slot)?.kind !== "text") {
      if (/\.\w{2,5}$/.test(value)) out.push({ slot, media: { src: value }, set });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, slot, (nv) => (value[i] = nv)));
    } else if (value && typeof value === "object") {
      if (typeof (value as { src?: unknown }).src === "string") out.push({ slot, media: value as Exclude<MediaInput, string>, set });
      else for (const [key, v] of Object.entries(value)) visit(v, slot, (nv) => ((value as Record<string, unknown>)[key] = nv));
    }
  };
  for (const [slot, value] of Object.entries(inputs)) visit(value, slot, (nv) => (inputs[slot] = nv as never));
  return out;
}
