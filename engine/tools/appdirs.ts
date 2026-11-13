import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const APP = "videditbridge";
/** The app's earlier name (it was "AI Video Editor"); its folders take the new name on first use. */
const OLD_APP = "ai-video-editor";

export interface AppDirsEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

const current = (): AppDirsEnv => ({ platform: process.platform, home: homedir(), env: process.env });

/**
 * Where the app keeps what it downloads, by the conventions of each system:
 * - `cache` (models, re-downloadable): %LOCALAPPDATA% on Windows, ~/Library/Caches on macOS, $XDG_CACHE_HOME (~/.cache) on Linux.
 * - `data` (fonts the user installed): %LOCALAPPDATA% on Windows, ~/Library/Application Support on macOS, $XDG_DATA_HOME (~/.local/share) on Linux.
 */
export function appDir(kind: "cache" | "data", sys?: AppDirsEnv): string {
  const s = sys ?? current();
  const p = s.platform === "win32" ? path.win32 : path.posix;
  const dir = p.join(appBase(kind, s), APP);
  // On this computer (not a computed example), the folder under the old name moves first.
  return sys ? dir : renamedOnce(dir, p.join(appBase(kind, s), OLD_APP));
}

/** The folder that holds the app's own folder, by the conventions of each system. */
function appBase(kind: "cache" | "data", { platform, home, env }: AppDirsEnv): string {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") return env.LOCALAPPDATA || p.join(home, "AppData", "Local");
  if (platform === "darwin") return p.join(home, "Library", kind === "cache" ? "Caches" : "Application Support");
  const xdg = kind === "cache" ? env.XDG_CACHE_HOME : env.XDG_DATA_HOME;
  // The XDG spec ignores relative paths.
  return xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ...(kind === "cache" ? [".cache"] : [".local", "share"]));
}

const renamed = new Map<string, string>();

/**
 * The app's folder after the rename: the folder under the old name becomes the new one (an instant
 * rename, models and all), when the new one does not exist yet. A folder in use stays under the old
 * name for now (and is used from there); the rename is tried again next start.
 */
export function renameAppFolder(dir: string, old: string): string {
  if (existsSync(dir) || !existsSync(old)) return dir;
  try {
    renameSync(old, dir);
    return dir;
  } catch {
    return old;
  }
}

function renamedOnce(dir: string, old: string): string {
  let r = renamed.get(dir);
  if (r === undefined) renamed.set(dir, (r = renameAppFolder(dir, old)));
  return r;
}

/** The folder used on every system before app data followed each system's conventions. */
export const legacyAppDir = (sys: AppDirsEnv = current()): string => (sys.platform === "win32" ? path.win32 : path.posix).join(sys.home, ".cache", OLD_APP);

/** Subfolders of the old shared folder and where each one belongs now. */
const LEGACY: Record<string, "cache" | "data"> = { models: "cache", fonts: "data" };

let migrated = false;

/**
 * Move folders from the old ~/.cache/ai-video-editor to their new places. A folder is moved only
 * when its new place does not exist yet, so nothing is ever overwritten.
 */
export function migrateLegacyAppDir(sys?: AppDirsEnv): void {
  const old = legacyAppDir(sys);
  if (!existsSync(old)) return;
  for (const [sub, kind] of Object.entries(LEGACY)) {
    const from = path.join(old, sub);
    const to = path.join(appDir(kind, sys), sub);
    // On Linux the old shared folder is the cache folder itself (renamed above): nothing to move.
    if (!existsSync(old)) return;
    if (path.resolve(from) === path.resolve(to) || !existsSync(from) || existsSync(to)) continue;
    try {
      mkdirSync(path.dirname(to), { recursive: true });
      try {
        renameSync(from, to);
      } catch {
        // Another drive or file system: copy, then remove the old copy.
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
    } catch {
      // A folder in use stays where it is; it is tried again next start.
    }
  }
  try {
    if (!readdirSync(old).length) rmdirSync(old);
  } catch {
    // Not empty or not removable: leave it.
  }
}

/** Models folder shared by every local model: $AVE_MODELS_DIR, else <cache>/models. */
export function defaultModelsDir(): string {
  if (process.env.AVE_MODELS_DIR) return process.env.AVE_MODELS_DIR;
  migrateOnce();
  return path.join(appDir("cache"), "models");
}

/** Fonts folder: $AVE_FONTS_DIR, else <data>/fonts. */
export function defaultFontsDir(): string {
  if (process.env.AVE_FONTS_DIR) return process.env.AVE_FONTS_DIR;
  migrateOnce();
  return path.join(appDir("data"), "fonts");
}

/** The move from the old folder runs on first use of either folder, once per process. */
function migrateOnce(): void {
  if (migrated) return;
  migrated = true;
  migrateLegacyAppDir();
}
