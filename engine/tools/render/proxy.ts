import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { deepClone } from "../../core/util.js";
import { runFfmpegOrThrow, type FfmpegOptions } from "./ffmpeg.js";

/** Bump when proxies would come out differently. */
const PROXY_VERSION = 1;
/** Proxies are this many pixels on the long side: enough for previews at half size, cropped to 9:16. */
export const PROXY_SIZE = 1280;
/** Only sources bigger than this on the long side get a proxy; decoding 1080p is already cheap. */
const PROXY_FROM = 1920;

export interface ProxyOptions extends FfmpegOptions {
  /** Render cache folder; proxies go in its `proxies` folder (default: the system temp folder). */
  cacheDir?: string;
  baseDir?: string;
  signal?: AbortSignal;
}

interface ProxyJob {
  src: string;
  file: string;
}

const isUrl = (src: string) => /^[a-z]+:\/\//i.test(src);

/** The proxy file of each video asset big enough to need one, and whether it is made yet. */
export async function planProxies(project: Project, opts: ProxyOptions = {}): Promise<Map<string, ProxyJob & { exists: boolean }>> {
  const dir = path.join(opts.cacheDir ?? path.join(tmpdir(), "ave-cache"), "proxies");
  const jobs = new Map<string, ProxyJob & { exists: boolean }>();
  for (const a of project.assets) {
    if (a.type !== "video" || isUrl(a.src) || !a.width || !a.height || Math.max(a.width, a.height) <= PROXY_FROM) continue;
    const src = path.resolve(opts.baseDir ?? process.cwd(), a.src);
    const st = await stat(src).catch(() => undefined);
    if (!st) continue;
    const key = JSON.stringify({ v: PROXY_VERSION, src, bytes: st.size, mtime: st.mtimeMs, size: PROXY_SIZE });
    const file = path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.mkv`);
    jobs.set(a.id, { src, file, exists: await stat(file).then((s) => s.size > 0, () => false) });
  }
  return jobs;
}

/**
 * Write a proxy: the same footage at PROXY_SIZE on the long side, every frame kept at its time, a
 * keyframe every half second so single frames seek fast, and the sound copied as it is.
 */
export async function writeProxy(src: string, output: string, opts: FfmpegOptions & { signal?: AbortSignal } = {}): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  const part = `${output}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.mkv`;
  const scale = `scale='if(gt(iw,ih),${PROXY_SIZE},-2)':'if(gt(iw,ih),-2,${PROXY_SIZE})'`;
  try {
    await runFfmpegOrThrow(
      ["-y", "-hide_banner", "-loglevel", "error", "-i", src, "-map", "0:v:0", "-map", "0:a?", "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "copy", "-threads", "2", part],
      opts,
    );
    await rename(part, output);
  } finally {
    await rm(part, { force: true });
  }
}

/** Proxies being made in the background, one at a time, so previews keep most of the machine. */
let queue: Promise<void> = Promise.resolve();
const pending = new Set<string>();

/** Make the missing proxies of a project, waiting for them. */
export async function makeProxies(project: Project, opts: ProxyOptions = {}): Promise<number> {
  let made = 0;
  for (const job of (await planProxies(project, opts)).values()) {
    if (job.exists) continue;
    await writeProxy(job.src, job.file, opts);
    made++;
  }
  return made;
}

/**
 * The project with each big video read from its proxy, for previews and frames. Proxies not made yet
 * are started in the background (and the original is used this time), so the next preview is faster.
 */
export async function withProxies(project: Project, opts: ProxyOptions = {}): Promise<Project> {
  const jobs = await planProxies(project, opts);
  if (!jobs.size) return project;
  const out = deepClone(project);
  for (const [id, job] of jobs) {
    if (job.exists) {
      const a = out.assets.find((x) => x.id === id);
      if (a && "src" in a) a.src = job.file;
      continue;
    }
    if (pending.has(job.file)) continue;
    pending.add(job.file);
    // Not tied to this render's signal: a cancelled preview should not waste the work.
    queue = queue
      .then(() => writeProxy(job.src, job.file, { ffmpegPath: opts.ffmpegPath }))
      .catch(() => undefined)
      .finally(() => pending.delete(job.file));
  }
  return out;
}

/** Wait for proxies started in the background (for tests and clean exits). */
export function proxiesIdle(): Promise<void> {
  return queue;
}
