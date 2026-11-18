import path from "node:path";
import { computeTimeline } from "../core/timeline.js";
import { validateProject } from "../core/validate.js";
import { summarizeProject } from "../core/summary.js";
import { buildCaptions } from "../tools/captions/build.js";
import type { EditorSession } from "./session.js";

/** Serializable snapshot of a session for the native app: timeline lanes, renders, history, activity and issues. */
export function sessionState(session: EditorSession) {
  const project = session.project;
  let timeline: ReturnType<typeof computeTimeline> | undefined;
  let timelineError: string | undefined;
  try {
    timeline = computeTimeline(project);
  } catch (e) {
    timelineError = (e as Error).message;
  }
  let captions: { start: number; end: number; text: string }[] = [];
  try {
    captions = timeline ? (buildCaptions(project, timeline)?.chunks ?? []).map((c) => ({ start: c.start, end: c.end, text: c.words.map((w) => w.text).join(" ") })) : [];
  } catch {
    captions = [];
  }
  return {
    revision: session.revision,
    name: project.name,
    settings: project.settings,
    duration: timeline?.duration ?? 0,
    timelineError,
    /** Objects selected with select_object, in the order they were selected (the viewer outlines the last). */
    objects: Object.keys(project.objects),
    clips: (timeline?.clips ?? []).map((c) => ({
      id: c.clip.id,
      assetId: c.clip.assetId,
      assetType: c.asset.type,
      label: c.clip.label,
      start: c.start,
      end: c.end,
      transition: c.clip.transition && c.transitionDuration > 0 ? { type: c.clip.transition.type, duration: c.transitionDuration } : undefined,
      effects: c.clip.effects.map((e) => e.type),
    })),
    layers: project.layers.map((l) => ({
      id: l.id,
      type: l.type,
      start: l.start,
      end: l.start + l.duration,
      label: l.type === "text" ? l.text : l.type === "media" ? l.assetId : `${l.shape} ${l.color}`,
      group: l.label,
    })),
    audio: (timeline?.audio ?? []).map((a) => ({ id: a.clip.id, role: a.clip.role, assetId: a.clip.assetId, start: a.start, end: a.end })),
    assets: mediaList(session, timeline),
    captions,
    summary: summarizeProject(project),
    issues: validateProject(project).issues,
    history: session.history.slice(-50).reverse(),
    // The app opens rendered files directly, so url is the file path.
    renders: session.renders
      .map((r) => ({ ...r, url: r.path, stale: r.revision !== session.revision }))
      .slice(-20)
      .reverse(),
    activities: session.activities.slice(-60).reverse(),
    log: session.log.slice(-30).reverse(),
    canUndo: session.canUndo,
    canRedo: session.canRedo,
  };
}

/**
 * Every media item in the project, for the app's Media tab: what it is, where the file is (an
 * absolute path, which the app opens directly), its size and length, and where the edit uses it.
 */
function mediaList(session: EditorSession, timeline: ReturnType<typeof computeTimeline> | undefined) {
  const project = session.project;
  const uses = new Map<string, number>();
  const first = new Map<string, number>();
  const use = (assetId: string, at: number) => {
    uses.set(assetId, (uses.get(assetId) ?? 0) + 1);
    if (!first.has(assetId) || at < first.get(assetId)!) first.set(assetId, at);
  };
  for (const c of timeline?.clips ?? []) use(c.clip.assetId, c.start);
  for (const a of timeline?.audio ?? []) use(a.clip.assetId, a.start);
  for (const l of project.layers) if (l.type === "media") use(l.assetId, l.start);
  return project.assets.map((a) => ({
    id: a.id,
    type: a.type,
    label: a.label ?? null,
    path: "src" in a ? (isUrl(a.src) ? a.src : path.resolve(session.options.baseDir, a.src)) : null,
    duration: "duration" in a ? (a.duration ?? null) : null,
    width: "width" in a ? (a.width ?? null) : null,
    height: "height" in a ? (a.height ?? null) : null,
    color: a.type === "color" ? a.color : a.type === "gradient" ? a.colors[0] : null,
    drawn: ("svg" in a && !!a.svg) || ("particles" in a && !!a.particles),
    uses: uses.get(a.id) ?? 0,
    firstUse: first.get(a.id) ?? null,
  }));
}

const isUrl = (src: string) => /^[a-z][a-z0-9+.-]+:\/\//i.test(src);
