import { createHash } from "node:crypto";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { computeTimeline, type TimedClip } from "../../core/timeline.js";
import { perClipGlobalEffects } from "../../library/effects/index.js";
import { renderSize } from "./compile.js";

/** Bump when the picture a cached clip holds would change for the same inputs (compile changes). */
export const SEGMENT_VERSION = 3;

/** Default size limit of a render cache folder. */
export const DEFAULT_CACHE_BYTES = 4e9;

export interface SegmentPlan {
  clip: TimedClip;
  file: string;
  /** Already cached. */
  exists: boolean;
}

/**
 * The cache file of each primary clip's picture. The key covers everything that shapes it: the
 * source file (path, size, modified time), the clip's trim, speed, fit, effects and fades, the
 * output size and frame rate, and the global effects baked into clips. Any change gives a new file.
 */
export async function planSegments(project: Project, opts: { cacheDir: string; baseDir?: string; scale?: number }): Promise<SegmentPlan[]> {
  const timeline = computeTimeline(project);
  const size = renderSize(project, opts.scale);
  const global = perClipGlobalEffects(project.effects);
  const baseDir = opts.baseDir ?? process.cwd();
  return Promise.all(
    timeline.clips.map(async (tc) => {
      const { clip, asset } = tc;
      let source: unknown;
      if ("src" in asset) {
        const remote = /^[a-z]+:\/\//i.test(asset.src);
        const file = remote ? asset.src : path.resolve(baseDir, asset.src);
        const st = remote ? undefined : await stat(file).catch(() => undefined);
        source = { type: asset.type, file, bytes: st?.size, mtime: st?.mtimeMs };
      } else {
        const { id: _id, label: _label, ...rest } = asset;
        source = rest;
      }
      const key = {
        v: SEGMENT_VERSION,
        size,
        fps: project.settings.fps,
        background: project.settings.backgroundColor,
        source,
        clip: { in: clip.in, sourceDuration: tc.sourceDuration, duration: tc.duration, speed: clip.speed, fit: clip.fit, focus: clip.focus, effects: clip.effects, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut },
        global,
      };
      const hash = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 32);
      const file = path.join(opts.cacheDir, `${hash}.mkv`);
      const exists = await stat(file).then((s) => s.size > 0, () => false);
      return { clip: tc, file, exists };
    }),
  );
}

/** Mark cached clips as just used, so pruning keeps them. */
export async function touchSegments(files: string[]): Promise<void> {
  const now = new Date();
  await Promise.all(files.map((f) => utimes(f, now, now).catch(() => undefined)));
}

/** Delete the least recently used cached clips above `maxBytes`, and leftovers of interrupted writes. */
export async function pruneCache(cacheDir: string, maxBytes = DEFAULT_CACHE_BYTES): Promise<void> {
  const names = await readdir(cacheDir).catch(() => [] as string[]);
  const entries = (await Promise.all(names.map(async (n) => ({ file: path.join(cacheDir, n), name: n, st: await stat(path.join(cacheDir, n)).catch(() => undefined) })))).filter(
    (e): e is { file: string; name: string; st: NonNullable<typeof e.st> } => !!e.st?.isFile(),
  );
  const hour = Date.now() - 3600_000;
  for (const e of entries) if (e.name.endsWith(".part.mkv") && e.st.mtimeMs < hour) await rm(e.file, { force: true });
  const clips = entries.filter((e) => /^[0-9a-f]{32}\.mkv$/.test(e.name)).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  let total = 0;
  for (const e of clips) {
    total += e.st.size;
    if (total > maxBytes) await rm(e.file, { force: true });
  }
}
