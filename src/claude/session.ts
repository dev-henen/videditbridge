import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../core/schema.js";
import { createProject } from "../core/operations.js";
import type { TranscriptionProvider } from "../tools/transcript/providers.js";
import type { TTSProvider } from "../tools/voiceover/providers.js";

export interface SessionOptions {
  /** Directory that relative media paths resolve against. */
  baseDir?: string;
  /** Where previews, frames and voice-overs are written. */
  outputDir?: string;
  ffmpegPath?: string;
  fontsDir?: string;
  transcriber?: TranscriptionProvider;
  tts?: TTSProvider;
  /** Max undo steps kept. */
  historyLimit?: number;
}

export interface HistoryEntry {
  action: string;
  details?: unknown;
  at: string;
  project: Project;
}

export interface RenderArtifact {
  kind: "frame" | "contact-sheet" | "preview" | "video";
  path: string;
  at: string;
  /** Project revision the artifact was rendered from. */
  revision: number;
  time?: number;
}

export type ActivityKind = "tool" | "render" | "file" | "info";

/** A unit of work shown live to the user ("Adding text…", "Rendering preview… 45%"). */
export interface Activity {
  id: string;
  kind: ActivityKind;
  label: string;
  status: "running" | "done" | "error";
  /** 0..1 when known. */
  progress?: number;
  /** Result summary or error message. */
  detail?: string;
  startedAt: string;
  endedAt?: string;
}

export interface ActivityHandle {
  readonly id: string;
  progress(value: number): void;
  done(detail?: string): void;
  fail(message: string): void;
}

export interface SessionEvents {
  change: [{ project: Project; action: string; revision: number }];
  render: [RenderArtifact];
  log: [{ level: "info" | "error"; message: string; at: string }];
  activity: [Activity];
}

/**
 * Holds the project being edited, with undo/redo and change notifications.
 * One session = one video being edited by an AI (and watched by a human through the preview server).
 */
export class EditorSession extends EventEmitter<SessionEvents> {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private current: Project;
  private rev = 0;
  readonly renders: RenderArtifact[] = [];
  readonly log: { level: "info" | "error"; message: string; at: string }[] = [];
  /** Recent activities, oldest first. */
  readonly activities: Activity[] = [];
  private activityCount = 0;
  readonly options: Required<Pick<SessionOptions, "baseDir" | "outputDir" | "historyLimit">> & SessionOptions;

  /** Activities still in progress. */
  get running(): Activity[] {
    return this.activities.filter((a) => a.status === "running");
  }

  /** Begin a unit of work that viewers see live. Call `done` or `fail` when it ends. */
  startActivity(kind: ActivityKind, label: string): ActivityHandle {
    const activity: Activity = { id: `act${++this.activityCount}`, kind, label, status: "running", startedAt: new Date().toISOString() };
    this.activities.push(activity);
    if (this.activities.length > 200) this.activities.splice(0, this.activities.length - 200);
    const emit = () => this.emit("activity", { ...activity });
    const finish = (status: "done" | "error", detail?: string) => {
      if (activity.status !== "running") return;
      Object.assign(activity, { status, detail, endedAt: new Date().toISOString() });
      if (status === "done") activity.progress = activity.progress === undefined ? undefined : 1;
      emit();
    };
    emit();
    return {
      id: activity.id,
      progress: (value) => {
        if (activity.status !== "running") return;
        activity.progress = Math.max(0, Math.min(1, value));
        emit();
      },
      done: (detail) => finish("done", detail),
      fail: (message) => finish("error", message),
    };
  }

  /** Run `fn` as a tracked activity. */
  async track<T>(kind: ActivityKind, label: string, fn: (activity: ActivityHandle) => Promise<T>): Promise<T> {
    const activity = this.startActivity(kind, label);
    try {
      const result = await fn(activity);
      activity.done();
      return result;
    } catch (e) {
      activity.fail(e instanceof Error ? e.message.split("\n")[0]! : String(e));
      throw e;
    }
  }

  constructor(project?: Project, options: SessionOptions = {}) {
    super();
    this.current = project ?? createProject({ aspectRatio: "9:16" });
    const baseDir = path.resolve(options.baseDir ?? process.cwd());
    this.options = {
      ...options,
      baseDir,
      outputDir: path.resolve(options.outputDir ?? path.join(baseDir, ".render")),
      historyLimit: options.historyLimit ?? 100,
    };
  }

  get project(): Project {
    return this.current;
  }

  /** Increments on every change; lets viewers know whether a render is stale. */
  get revision(): number {
    return this.rev;
  }

  get history(): { action: string; at: string; details?: unknown }[] {
    return this.past.map(({ action, at, details }) => ({ action, at, details }));
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Replace the project, recording the previous state for undo. */
  commit(project: Project, action: string, details?: unknown): void {
    this.past.push({ action, details, at: new Date().toISOString(), project: this.current });
    if (this.past.length > this.options.historyLimit) this.past.shift();
    this.future = [];
    this.current = project;
    this.rev++;
    this.emit("change", { project, action, revision: this.rev });
  }

  undo(): string | undefined {
    const entry = this.past.pop();
    if (!entry) return undefined;
    this.future.push({ ...entry, project: this.current });
    this.current = entry.project;
    this.rev++;
    this.emit("change", { project: this.current, action: `undo ${entry.action}`, revision: this.rev });
    return entry.action;
  }

  redo(): string | undefined {
    const entry = this.future.pop();
    if (!entry) return undefined;
    this.past.push({ ...entry, project: this.current });
    this.current = entry.project;
    this.rev++;
    this.emit("change", { project: this.current, action: `redo ${entry.action}`, revision: this.rev });
    return entry.action;
  }

  recordRender(artifact: Omit<RenderArtifact, "at" | "revision">): RenderArtifact {
    const full = { ...artifact, at: new Date().toISOString(), revision: this.rev };
    this.renders.push(full);
    if (this.renders.length > 50) this.renders.shift();
    this.emit("render", full);
    return full;
  }

  info(message: string): void {
    const entry = { level: "info" as const, message, at: new Date().toISOString() };
    this.log.push(entry);
    this.emit("log", entry);
  }

  error(message: string): void {
    const entry = { level: "error" as const, message, at: new Date().toISOString() };
    this.log.push(entry);
    this.emit("log", entry);
  }

  /** A fresh path inside the output directory. */
  async outputPath(name: string): Promise<string> {
    await mkdir(this.options.outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(this.options.outputDir, `${stamp}-${name}`);
  }

  resolve(src: string): string {
    return /^[a-z]+:\/\//i.test(src) ? src : path.resolve(this.options.baseDir, src);
  }
}
