import { createHash } from "node:crypto";
import { readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { Clip, Project } from "../../core/schema.js";
import { computeTimeline, type TimedClip } from "../../core/timeline.js";
import { compileProject } from "./compile.js";

/** Bump when cached clips made by older code must not be reused (the key already covers the compiled graph). */
export const SEGMENT_VERSION = 4;

/** Default size limit of a render cache folder. */
export const DEFAULT_CACHE_BYTES = 4e9;

export interface SegmentPlan {
  clip: TimedClip;
  file: string;
  /** Already cached. */
  exists: boolean;
}

/** The one-clip project a cached clip is rendered from: the clip alone, silent, without its transition. */
export function segmentProject(project: Project, clip: Clip): Project {
  return { ...project, clips: [{ ...clip, transition: undefined, muted: true }], layers: [], audio: [], captions: undefined, audioEffects: [] };
}

/**
 * The cache file of each primary clip's picture. The key is the FFmpeg graph and inputs that make
 * it, plus the source file's size and modified time, so any change to the clip, the per-frame
 * global effects, the output size, the person cutout or face mask, or the code that builds effects gives a new file.
 */
export async function planSegments(
  project: Project,
  opts: { cacheDir: string; baseDir?: string; fontsDir?: string; scale?: number; masks?: Record<string, string>; faceMasks?: Record<string, string>; objectMasks?: Record<string, Record<string, string>> },
): Promise<SegmentPlan[]> {
  const timeline = computeTimeline(project);
  const baseDir = opts.baseDir ?? process.cwd();
  return Promise.all(
    timeline.clips.map(async (tc) => {
      const { clip, asset } = tc;
      let source: unknown;
      if ("src" in asset && !/^[a-z]+:\/\//i.test(asset.src)) {
        const st = await stat(path.resolve(baseDir, asset.src)).catch(() => undefined);
        source = { bytes: st?.size, mtime: st?.mtimeMs };
      }
      const compiled = compileProject(segmentProject(project, clip), { output: "", scale: opts.scale, baseDir, fontsDir: opts.fontsDir, segment: true, masks: opts.masks, faceMasks: opts.faceMasks, objectMasks: opts.objectMasks });
      // The last argument is the output path, which is not part of what the clip looks like.
      const key = { v: SEGMENT_VERSION, source, args: compiled.args.slice(0, -1), graph: compiled.filterGraph };
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
