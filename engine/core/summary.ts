import type { Effect, Project } from "./schema.js";
import { computeTimeline } from "./timeline.js";
import { formatTime } from "./util.js";
import { describeColorSettings, type ColorSettings } from "../library/effects/color.js";
import { describeMask } from "../library/effects/masks.js";

const fx = (effects: Effect[]) =>
  effects.length
    ? ` fx:[${effects
        .map((e) =>
          e.type === "color"
            ? `color(${describeColorSettings((e.params ?? {}) as ColorSettings)})`
            : e.params && Object.keys(e.params).length
              ? `${e.type}(${JSON.stringify(e.params)})`
              : e.type,
        )
        .map((s, k) => (effects[k]!.keyframes?.length ? `${s} ramped over ${effects[k]!.keyframes!.length} keyframes` : s))
        .map((s, k) => {
          const { mask, label } = effects[k]!;
          return `${label ? `"${label}" ` : ""}${s}${mask ? ` masked to ${describeMask(mask)}` : ""}`;
        })
        .join(", ")}]`
    : "";

const afx = (effects: Effect[]) => fx(effects).replace(/^ fx:/, " audio fx:");

const span = (start: number, end: number) => `${formatTime(start)}-${formatTime(end)}`;

/**
 * Compact, human/AI-readable description of the edit: what plays when.
 * Far cheaper for a model to read than the raw JSON.
 */
export function summarizeProject(project: Project): string {
  const lines: string[] = [];
  const s = project.settings;
  let timeline;
  try {
    timeline = computeTimeline(project);
  } catch (e) {
    timeline = undefined;
    lines.push(`Warning: timeline cannot be computed: ${(e as Error).message}`);
  }
  lines.push(
    `Project "${project.name}" (${project.id}): ${s.width}x${s.height} @ ${s.fps}fps` +
      (timeline ? `, duration ${formatTime(timeline.duration)} (${timeline.duration}s)` : ""),
  );
  if (typeof project.metadata.template === "string") lines.push(`Template: ${project.metadata.template}`);

  lines.push("", `Assets (${project.assets.length}):`);
  for (const a of project.assets) {
    const info =
      a.type === "video"
        ? `${a.duration !== undefined ? `${a.duration}s` : "?s"}${a.width ? ` ${a.width}x${a.height}` : ""}${a.hasAudio === false ? " no-audio" : ""}`
        : a.type === "audio"
          ? `${a.duration !== undefined ? `${a.duration}s` : "?s"}`
          : a.type === "image"
            ? `${a.width ? `${a.width}x${a.height}` : ""}`
            : a.type === "color"
              ? a.color
              : a.colors.join(" to ");
    const tr = project.transcripts[a.id] ? ` [transcript: ${project.transcripts[a.id]!.words.length} words]` : "";
    const src = "src" in a ? ` ${a.src}` : "";
    lines.push(`  ${a.id} (${a.type}) ${info}${src}${tr}`);
  }

  lines.push("", `Primary track (${project.clips.length} clips):`);
  if (timeline) {
    for (const tc of timeline.clips) {
      const c = tc.clip;
      const tr = c.transition && tc.index > 0 ? ` transition ${c.transition.type} ${tc.transitionDuration}s` : "";
      const src = tc.asset.type === "video" ? ` src ${c.in}-${+(c.in + tc.sourceDuration).toFixed(3)}s` : "";
      const extra = [
        c.keyframes?.speed?.length
          ? `speed ramp ${Math.min(...c.keyframes.speed.map((k) => k.value))}-${Math.max(...c.keyframes.speed.map((k) => k.value))}x`
          : c.speed !== 1 && `speed ${c.speed}x`,
        c.interpolate && "smooth motion",
        c.muted && "muted",
        c.volume !== 1 && `vol ${c.volume}`,
        c.fit !== "cover" && `fit ${c.fit}`,
        c.keyframes?.focus?.length ? `crop follows ${c.keyframes.focus.length} keyframes` : c.focus && `focus (${c.focus.x}, ${c.focus.y})`,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`  [${tc.index}] ${c.id} ${span(tc.start, tc.end)} ${c.assetId}${src}${tr}${extra ? ` (${extra})` : ""}${fx(c.effects)}${afx(c.audioEffects)}${c.label ? ` "${c.label}"` : ""}`);
    }
  }

  if (project.layers.length) {
    lines.push("", `Layers (${project.layers.length}, bottom to top; text/shapes always draw above media):`);
    for (const l of project.layers) {
      const anim = [l.animationIn && `in:${l.animationIn.type}`, l.animationOut && `out:${l.animationOut.type}`].filter(Boolean).join(" ");
      const moving = Object.entries(l.keyframes ?? {})
        .filter(([, keys]) => (keys as unknown[] | undefined)?.length)
        .map(([prop, keys]) => `${prop} ${(keys as unknown[]).length}`);
      const pos = `${l.keyframes?.position?.length ? "" : ` @(${l.position.x},${l.position.y})`}${moving.length ? ` keyframes: ${moving.join(", ")}` : ""}`;
      const what =
        l.type === "text"
          ? `text "${l.text.length > 60 ? `${l.text.slice(0, 57)}...` : l.text}" ${l.style.fontFamily} ${l.style.fontSize}px ${l.style.color}`
          : l.type === "media"
            ? `media ${l.assetId} w=${l.size.width}${l.size.height ? ` h=${l.size.height}` : ""}${l.opacity < 1 ? ` opacity ${l.opacity}` : ""}${l.blend !== "normal" ? ` blend ${l.blend}` : ""}${l.volume > 0 ? ` vol ${l.volume}` : ""}${fx(l.effects)}${afx(l.audioEffects)}`
            : `shape ${l.shape} ${l.size.width}x${l.size.height} ${l.color}`;
      lines.push(`  ${l.id} ${span(l.start, l.start + l.duration)} ${what}${pos}${anim ? ` [${anim}]` : ""}`);
    }
  }

  if (project.audio.length && timeline) {
    lines.push("", `Audio (${project.audio.length}):`);
    for (const ta of timeline.audio) {
      const a = ta.clip;
      const flags = [a.speed !== 1 && `speed ${a.speed}x`, a.volume !== 1 && `vol ${a.volume}`, a.loop && "loop", a.role === "music" && a.duck !== false && "ducked", a.fadeIn && `fadeIn ${a.fadeIn}s`, a.fadeOut && `fadeOut ${a.fadeOut}s`]
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${a.id} ${a.role} ${span(ta.start, ta.end)} ${a.assetId}${flags ? ` (${flags})` : ""}${afx(a.audioEffects)}`);
    }
  }

  if (project.effects.length) lines.push("", `Global effects:${fx(project.effects)}`);
  if (project.audioEffects.length) lines.push("", `Master audio:${afx(project.audioEffects)}`);
  if (project.captions) {
    const c = project.captions;
    lines.push(
      "",
      `Captions: ${c.enabled ? "on" : "off"}, style "${c.style}"${c.overrides ? ` overrides ${JSON.stringify(c.overrides)}` : ""}${c.segments ? `, ${c.segments.length} manual segments` : ", from transcripts"}`,
    );
  }
  return lines.join("\n");
}
