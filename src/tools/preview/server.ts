import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Project } from "../../core/schema.js";
import { computeTimeline } from "../../core/timeline.js";
import { validateProject } from "../../core/validate.js";
import { summarizeProject } from "../../core/summary.js";
import { buildCaptions } from "../captions/build.js";
import { render, renderContactSheet, renderFrame } from "../render/render.js";
import { PREVIEW_PAGE } from "./page.js";

type Listener = (...args: never[]) => void;

/** What the preview needs from an editing session. `EditorSession` satisfies this. */
export interface PreviewSource {
  readonly project: Project;
  readonly revision: number;
  readonly history: { action: string; at: string }[];
  readonly renders: { kind: string; path: string; at: string; revision: number; time?: number }[];
  readonly log: { level: string; message: string; at: string }[];
  /** Live activities (tool calls, renders), oldest first. */
  readonly activities?: { id: string; kind: string; label: string; status: string; progress?: number; detail?: string; startedAt: string; endedAt?: string }[];
  readonly options: { baseDir: string; outputDir: string; ffmpegPath?: string; fontsDir?: string };
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
  undo?(): unknown;
  redo?(): unknown;
  recordRender?(a: { kind: "frame" | "contact-sheet" | "preview" | "video"; path: string; time?: number }): unknown;
  on(event: "change" | "render" | "log" | "activity", listener: Listener): unknown;
  off(event: "change" | "render" | "log" | "activity", listener: Listener): unknown;
  outputPath(name: string): Promise<string>;
}

export interface PreviewServerOptions {
  port?: number;
  host?: string;
  /** Re-render the contact sheet automatically after edits (default true). */
  autoContactSheet?: boolean;
  /** Debounce for automatic renders, ms. */
  debounceMs?: number;
  /** Pop up a preview window once the server is listening (see `openPreviewWindow`). */
  open?: boolean;
}

function detachedSpawn(cmd: string, args: string[]): void {
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }).on("error", () => undefined).unref();
  } catch {
    // nothing to open with
  }
}

/** Chromium-based browsers that support `--app` windows, per platform. */
function appBrowserCandidates(): string[] {
  if (process.platform === "win32") {
    const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((r) => [
      path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(r, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
}

/**
 * Pop up the preview as its own app-style window (no tabs or address bar) using an installed
 * Chromium browser in `--app` mode, Edge ships with Windows. Falls back to the default browser.
 * Returns how it was opened.
 */
export function openPreviewWindow(url: string, size = { width: 1440, height: 900 }): "app-window" | "browser" {
  const browser = appBrowserCandidates().find((p) => existsSync(p));
  if (browser) {
    detachedSpawn(browser, [`--app=${url}`, `--window-size=${size.width},${size.height}`, "--new-window"]);
    return "app-window";
  }
  openInBrowser(url);
  return "browser";
}

/** Open a URL in a normal tab of the system's default browser. */
export function openInBrowser(url: string): void {
  if (process.platform === "win32") detachedSpawn("explorer", [url]);
  else detachedSpawn(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

export interface PreviewServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Serializable snapshot the preview page renders. */
export interface PreviewStateOptions {
  /** Map a rendered file to the URL clients load it from. Default: /media/<path in outputDir> (other files are omitted). */
  mediaUrl?: (absolutePath: string) => string | undefined;
}

/** Serializable snapshot of a session for viewers (the web preview, the native app). */
export function previewState(source: PreviewSource, opts: PreviewStateOptions = {}) {
  const project = source.project;
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
  const defaultMedia = (p: string) =>
    p.startsWith(source.options.outputDir) ? `/media/${encodeURIComponent(path.relative(source.options.outputDir, p).split(path.sep).join("/"))}` : undefined;
  const media = opts.mediaUrl ?? defaultMedia;
  return {
    revision: source.revision,
    name: project.name,
    settings: project.settings,
    duration: timeline?.duration ?? 0,
    timelineError,
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
    history: source.history.slice(-50).reverse(),
    renders: source.renders
      .map((r) => ({ ...r, url: media(r.path), stale: r.revision !== source.revision }))
      .filter((r) => r.url !== undefined)
      .slice(-20)
      .reverse(),
    activities: (source.activities ?? []).slice(-60).reverse(),
    log: source.log.slice(-30).reverse(),
    canUndo: !!source.canUndo,
    canRedo: !!source.canRedo,
  };
}

/** Serialize renders so the machine isn't flooded; the latest queued request wins. */
class RenderQueue {
  private running: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.running.then(fn, fn);
    this.running = next.catch(() => undefined);
    return next;
  }
}

/**
 * Start a local web preview of a session. Humans watch edits land live; frames,
 * contact sheets and preview videos rendered here are also recorded on the session.
 */
export async function startPreviewServer(source: PreviewSource, opts: PreviewServerOptions = {}): Promise<PreviewServer> {
  const clients = new Set<ServerResponse>();
  const queue = new RenderQueue();
  const renderOpts = () => ({
    baseDir: source.options.baseDir,
    ffmpegPath: source.options.ffmpegPath,
    fontsDir: source.options.fontsDir,
  });
  const frameCache = new Map<string, string>();

  const broadcast = () => {
    let payload: string;
    try {
      payload = `event: state\ndata: ${JSON.stringify(previewState(source))}\n\n`;
    } catch (e) {
      payload = `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`;
    }
    for (const c of clients) c.write(payload);
  };

  let timer: NodeJS.Timeout | undefined;
  const onChange = () => {
    frameCache.clear();
    broadcast();
    if (opts.autoContactSheet === false) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const rev = source.revision;
      void queue
        .run(async () => {
          if (rev !== source.revision) return;
          const out = await source.outputPath("auto-sheet.png");
          await renderContactSheet(source.project, { output: out, columns: 4, rows: 2, thumbWidth: 280, ...renderOpts() });
          source.recordRender?.({ kind: "contact-sheet", path: out });
        })
        .catch((e) => {
          for (const c of clients) c.write(`event: error\ndata: ${JSON.stringify({ message: `Auto preview failed: ${(e as Error).message.split("\n")[0]}` })}\n\n`);
        });
    }, opts.debounceMs ?? 1200);
  };
  const onOther = () => broadcast();
  source.on("change", onChange);
  source.on("render", onOther);
  source.on("log", onOther);
  source.on("activity", onOther);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const serveFile = async (req: IncomingMessage, res: ServerResponse, file: string) => {
    const info = await stat(file);
    const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : info.size - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      createReadStream(file).pipe(res);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PREVIEW_PAGE);
      } else if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        clients.add(res);
        res.write(`event: state\ndata: ${JSON.stringify(previewState(source))}\n\n`);
        req.on("close", () => clients.delete(res));
      } else if (req.method === "GET" && url.pathname === "/api/state") {
        json(res, 200, previewState(source));
      } else if (req.method === "GET" && url.pathname === "/api/project") {
        json(res, 200, source.project);
      } else if (req.method === "GET" && url.pathname === "/api/frame") {
        const t = Math.max(0, Number(url.searchParams.get("t") ?? 0));
        const key = `${source.revision}:${t.toFixed(2)}`;
        let file = frameCache.get(key);
        if (!file) {
          file = await queue.run(async () => {
            const out = await source.outputPath(`scrub-${t.toFixed(2)}.png`);
            await renderFrame(source.project, t, { output: out, scale: 0.5, ...renderOpts() });
            return out;
          });
          frameCache.set(key, file);
        }
        await serveFile(req, res, file);
      } else if (req.method === "POST" && url.pathname === "/api/contact-sheet") {
        const out = await queue.run(async () => {
          const o = await source.outputPath("contact-sheet.png");
          await renderContactSheet(source.project, { output: o, columns: 4, rows: 3, thumbWidth: 320, ...renderOpts() });
          return o;
        });
        source.recordRender?.({ kind: "contact-sheet", path: out });
        json(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/api/preview") {
        const out = await queue.run(async () => {
          const o = await source.outputPath("preview.mp4");
          await render(source.project, { output: o, scale: 0.5, preset: "ultrafast", extraOutputArgs: ["-crf", "30"], ...renderOpts() });
          return o;
        });
        source.recordRender?.({ kind: "preview", path: out });
        json(res, 200, { ok: true });
      } else if (req.method === "POST" && (url.pathname === "/api/undo" || url.pathname === "/api/redo")) {
        const fn = url.pathname.endsWith("undo") ? source.undo : source.redo;
        if (!fn) return json(res, 400, { error: "Not supported" });
        fn.call(source);
        json(res, 200, { ok: true });
      } else if (req.method === "GET" && url.pathname.startsWith("/media/")) {
        const rel = decodeURIComponent(url.pathname.slice("/media/".length));
        const file = path.resolve(source.options.outputDir, rel);
        if (!file.startsWith(path.resolve(source.options.outputDir) + path.sep)) return json(res, 403, { error: "Forbidden" });
        await serveFile(req, res, file);
      } else {
        json(res, 404, { error: "Not found" });
      }
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    }
  });

  const port = opts.port ?? 4321;
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  if (opts.open) openPreviewWindow(url);
  return {
    url,
    server,
    close: () =>
      new Promise((resolve) => {
        clearTimeout(timer);
        source.off("change", onChange);
        source.off("render", onOther);
        source.off("log", onOther);
        source.off("activity", onOther);
        for (const c of clients) c.end();
        server.close(() => resolve());
      }),
  };
}
