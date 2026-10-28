import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const APP = "ai-video-editor";

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
export function appDir(kind: "cache" | "data", sys: AppDirsEnv = current()): string {
  const { platform, home, env } = sys;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") return p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), APP);
  if (platform === "darwin") return p.join(home, "Library", kind === "cache" ? "Caches" : "Application Support", APP);
  const xdg = kind === "cache" ? env.XDG_CACHE_HOME : env.XDG_DATA_HOME;
  // The XDG spec ignores relative paths.
  return p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(home, ...(kind === "cache" ? [".cache"] : [".local", "share"])), APP);
}

/** The folder used on every system before app data followed each system's conventions. */
export const legacyAppDir = (sys: AppDirsEnv = current()): string => (sys.platform === "win32" ? path.win32 : path.posix).join(sys.home, ".cache", APP);

/** Subfolders of the old shared folder and where each one belongs now. */
const LEGACY: Record<string, "cache" | "data"> = { models: "cache", fonts: "data" };

let migrated = false;

/**
 * Move folders from the old ~/.cache/ai-video-editor to their new places. A folder is moved only
 * when its new place does not exist yet, so nothing is ever overwritten.
 */
export function migrateLegacyAppDir(sys: AppDirsEnv = current()): void {
  const old = legacyAppDir(sys);
  if (!existsSync(old)) return;
  for (const [sub, kind] of Object.entries(LEGACY)) {
    const from = path.join(old, sub);
    const to = path.join(appDir(kind, sys), sub);
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
