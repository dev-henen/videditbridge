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
