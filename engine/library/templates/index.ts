import { TemplateSpecSchema, type MediaInput, type TemplateInputs, type TemplateSpec, type TemplateSpecInput } from "./types.js";
import { buildFromTemplate, collectMediaInputs, type BuildOptions, type BuildResult } from "./builder.js";
import { SOCIAL_TEMPLATES } from "./catalog/social.js";
import { YOUTUBE_TEMPLATES } from "./catalog/youtube.js";
import { BUSINESS_TEMPLATES } from "./catalog/business.js";
import { PERSONAL_TEMPLATES } from "./catalog/personal.js";

export * from "./types.js";
export { buildFromTemplate, collectMediaInputs, type BuildOptions, type BuildResult } from "./builder.js";

export const TEMPLATES: TemplateSpec[] = [...SOCIAL_TEMPLATES, ...YOUTUBE_TEMPLATES, ...BUSINESS_TEMPLATES, ...PERSONAL_TEMPLATES].map((t) =>
  TemplateSpecSchema.parse(t),
);

const byId = new Map(TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): TemplateSpec | undefined {
  return byId.get(id);
}

export interface TemplateFilter {
  category?: TemplateSpec["category"];
  aspectRatio?: TemplateSpec["aspectRatio"];
  /** Free-text search over name, description, tags and platforms. */
  query?: string;
}

export function listTemplates(filter: TemplateFilter = {}): TemplateSpec[] {
  const q = filter.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return TEMPLATES.filter((t) => {
    if (filter.category && t.category !== filter.category) return false;
    if (filter.aspectRatio && t.aspectRatio !== filter.aspectRatio) return false;
    if (q.length) {
      const hay = [t.id, t.name, t.description, ...t.tags, ...t.platforms].join(" ").toLowerCase();
      return q.every((w) => hay.includes(w));
    }
    return true;
  });
}

/** Add a custom template (e.g. one an AI authored). Validates the spec. */
export function registerTemplate(spec: TemplateSpecInput, opts: { replace?: boolean } = {}): TemplateSpec {
  const parsed = TemplateSpecSchema.parse(spec);
  if (byId.has(parsed.id) && !opts.replace) throw new Error(`Template "${parsed.id}" already exists`);
  const i = TEMPLATES.findIndex((t) => t.id === parsed.id);
  if (i >= 0) TEMPLATES[i] = parsed;
  else TEMPLATES.push(parsed);
  byId.set(parsed.id, parsed);
  return parsed;
}

/** Plain-text brief of a template: what it needs and how to edit toward it. */
export function describeTemplate(t: TemplateSpec): string {
  const lines = [
    `${t.name} (${t.id}): ${t.aspectRatio}, ${t.idealDuration[0]}-${t.idealDuration[1]}s, ${t.category}`,
    t.description,
    `Platforms: ${t.platforms.join(", ") || "any"}`,
    `How to edit: ${t.aiGuidance}`,
    "Inputs:",
    ...t.slots.map(
      (s) =>
        `  - ${s.id} (${s.kind}${s.required ? ", required" : ""}): ${s.description}` +
        (s.fields ? `\n      fields: ${Object.entries(s.fields).map(([k, v]) => `${k} = ${v}`).join("; ")}` : ""),
    ),
    "Scenes:",
    ...t.scenes.map(
      (s) =>
        `  - ${s.name}${s.repeat ? ` (×each ${s.repeat})` : ""}${s.optional ? " [optional]" : ""}: ${s.purpose}` +
        `${s.fitMedia ? ", length follows media" : `, ${s.duration}s`}`,
    ),
    `Look: captions ${t.captions?.style ?? "none"}; transition ${t.transition?.type ?? "cut"}; grade ${t.grade.map((g) => g.type).join("+") || "none"}; fonts ${t.theme.headingFont}/${t.theme.fontFamily}`,
  ];
  const auto = describeAutomation(t);
  if (auto.length) lines.push(`Automatic when applied (automate: false skips): ${auto.join("; ")}`);
  return lines.join("\n");
}

/** What apply_template does around the build, as short phrases. */
export function describeAutomation(t: TemplateSpec): string[] {
  const a = t.automation;
  if (!a) return [];
  const out: string[] = [];
  if (a.narrate?.script) out.push(`speaks ${a.narrate.script.from} with the local voice when ${a.narrate.script.into} is not given`);
  if (a.narrate?.items) out.push(`speaks each ${a.narrate.items.list} item's ${a.narrate.items.field} as that scene's narration (the scene lasts as long as the line)`);
  if (a.transcribe.length) out.push(`transcribes ${a.transcribe.join(", ")}`);
  if (a.cleanup) {
    const parts = [a.cleanup.retakes && "retakes", a.cleanup.fillers && "fillers", `pauses over ${a.cleanup.maxPause}s`].filter(Boolean);
    out.push(`removes ${parts.join(", ")} from ${a.cleanup.slot}`);
  }
  if (a.beatSync) out.push(a.beatSync.action === "cuts" ? `puts cuts on the ${a.beatSync.downbeats ? "downbeats" : "beat"}${a.beatSync.every > 1 ? ` (every ${a.beatSync.every})` : ""}` : `${a.beatSync.action} on the ${a.beatSync.downbeats ? "downbeats" : "beat"}${a.beatSync.every > 1 ? ` (every ${a.beatSync.every})` : ""}`);
  if (a.transitionSounds) out.push("adds a sound to each transition");
  return out;
}

export interface MediaInfo {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  isImage?: boolean;
}

/**
 * Build a project from a template, first filling in media durations/dimensions with `probe`
 * so scenes that follow media length (fitMedia, durationFrom) get exact timing.
 */
export async function applyTemplate(
  templateOrId: TemplateSpec | string,
  inputs: TemplateInputs,
  opts: BuildOptions & { probe?: (src: string) => Promise<MediaInfo> } = {},
): Promise<BuildResult> {
  const spec = typeof templateOrId === "string" ? getTemplate(templateOrId) : templateOrId;
  if (!spec) throw new Error(`Unknown template "${templateOrId}"`);
  const resolved = structuredClone(inputs);
  if (opts.probe) {
    const refs = collectMediaInputs(spec, resolved);
    const cache = new Map<string, Promise<MediaInfo>>();
    await Promise.all(
      refs.map(async ({ media, set }) => {
        if (!cache.has(media.src)) cache.set(media.src, opts.probe!(media.src).catch(() => ({})));
        const info = await cache.get(media.src)!;
        const next: Exclude<MediaInput, string> = { ...media };
        if (next.duration === undefined && info.duration !== undefined) next.duration = Math.max(0, info.duration - (next.in ?? 0));
        next.hasAudio ??= info.hasAudio;
        next.width ??= info.width;
        next.height ??= info.height;
        set(next);
      }),
    );
  }
  return buildFromTemplate(spec, resolved, opts);
}
