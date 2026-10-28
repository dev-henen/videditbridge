import type { Project } from "../../core/schema.js";
import { cutSourceRanges, EditError } from "../../core/operations.js";
import { getAsset } from "../../core/timeline.js";
import { planCleanup, type CleanupOptions } from "./cuts.js";

export interface CleanupResult {
  project: Project;
  removed: { start: number; end: number; reason: string; text?: string }[];
  removedDuration: number;
}

/** Tighten a talking-head edit: remove fillers, stutters and long pauses using the asset's transcript. */
export function cleanupSpeech(p: Project, assetId: string, opts: CleanupOptions = { fillers: true, maxPause: 0.8 }): CleanupResult {
  const transcript = p.transcripts[assetId];
  if (!transcript) throw new EditError(`Asset "${assetId}" has no transcript. Transcribe it or set one first.`);
  const asset = getAsset(p, assetId);
  const mediaDuration = asset.type === "video" || asset.type === "audio" ? asset.duration : undefined;
  const plan = planCleanup(transcript, { mediaDuration, ...opts });
  return { project: cutSourceRanges(p, assetId, plan.remove), removed: plan.remove, removedDuration: plan.removedDuration };
}
