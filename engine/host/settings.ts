import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appDir } from "../tools/appdirs.js";
import { setDefaultBackend, type RenderBackend } from "../tools/render/render.js";
import { setHardwareEncoding } from "../tools/render/hardware.js";
import { applyPerformance, loadPerformance } from "../tools/render/benchmark.js";

/**
 * The app's settings (the Settings tab), kept in the app's data folder and applied by the host: the
 * Anthropic API key Claude uses (stored on this machine only, never sent anywhere but Anthropic), the
 * model new conversations start with, which renderer draws the picture, and whether exports encode on
 * the graphics card.
 */
export interface AppSettings {
  /** Used when the environment has no ANTHROPIC_API_KEY of its own. */
  apiKey?: string;
  /** The model new conversations start with (an id from host.info's models). */
  defaultModel?: string;
  /** "auto": what the performance test found (the GPU engine, FFmpeg where it fails); or one renderer always. */
  renderer: "auto" | "engine" | "ffmpeg";
  hardwareEncoding: boolean;
}

const DEFAULTS: AppSettings = { renderer: "auto", hardwareEncoding: true };

/** $AVE_SETTINGS_FILE (tests), or settings.json in the app's data folder. */
export const settingsFile = () => process.env.AVE_SETTINGS_FILE || path.join(appDir("data"), "settings.json");

/** The key the environment gave the host when it started, which always wins over the stored one. */
const envKey = process.env.ANTHROPIC_API_KEY || undefined;

export async function loadSettings(file = settingsFile()): Promise<AppSettings> {
  try {
    return { ...DEFAULTS, ...(JSON.parse(await readFile(file, "utf8")) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s: AppSettings, file = settingsFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(s, null, 2), "utf8");
  await rename(temp, file);
}

/** Make the settings take effect in this process: the key for Claude, the renderer, hardware encoding. */
export async function applySettings(s: AppSettings): Promise<void> {
  if (!envKey) {
    if (s.apiKey) process.env.ANTHROPIC_API_KEY = s.apiKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
  if (s.renderer === "auto") applyPerformance(await loadPerformance());
  else setDefaultBackend(s.renderer as RenderBackend, s.renderer as RenderBackend);
  setHardwareEncoding(s.hardwareEncoding);
}

/** What the Settings tab shows: the settings with the key hidden (its last four characters), and where it came from. */
export function publicSettings(s: AppSettings) {
  const key = envKey || s.apiKey;
  return {
    renderer: s.renderer,
    hardwareEncoding: s.hardwareEncoding,
    defaultModel: s.defaultModel ?? null,
    apiKey: key ? { set: true, hint: `…${key.slice(-4)}`, source: envKey ? "environment" : "settings" } : { set: false },
    file: settingsFile(),
  };
}
