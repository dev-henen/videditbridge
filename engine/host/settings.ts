import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appDir } from "../tools/appdirs.js";
import { setDefaultBackend, type RenderBackend } from "../tools/render/render.js";
import { setHardwareEncoding } from "../tools/render/hardware.js";
import { applyPerformance, loadPerformance } from "../tools/render/benchmark.js";
import { hasKeychain, readKeychainKey, writeKeychainKey } from "./secrets.js";

/**
 * The app's settings (the Settings tab), kept in the app's data folder and applied by the host: the
 * Anthropic API key Claude uses, the model new conversations start with, which renderer draws the
 * picture, and whether exports encode on the graphics card. The key lives in the system's keychain
 * (secrets.ts); only where there is none does the settings file hold it.
 */
export interface AppSettings {
  /** In the file only where the system has no keychain (a key found here moves to the keychain). */
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

/** The key the environment gave the host when it started, which always wins over a stored one. */
const envKey = process.env.ANTHROPIC_API_KEY || undefined;

/** The stored key (keychain or file), and where it is. */
let stored: { key?: string; place: "keychain" | "file" } = { place: "file" };

/** Read the settings and the stored key; a key still in the file moves to the keychain when there is one. */
export async function loadSettings(file = settingsFile()): Promise<AppSettings> {
  let s: AppSettings;
  try {
    s = { ...DEFAULTS, ...(JSON.parse(await readFile(file, "utf8")) as Partial<AppSettings>) };
  } catch {
    s = { ...DEFAULTS };
  }
  if (await hasKeychain()) {
    if (s.apiKey && (await writeKeychainKey(s.apiKey))) {
      delete s.apiKey;
      await saveSettings(s, file);
    }
    stored = { key: await readKeychainKey(), place: "keychain" };
  } else stored = { key: s.apiKey, place: "file" };
  return s;
}

export async function saveSettings(s: AppSettings, file = settingsFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(s, null, 2), "utf8");
  await rename(temp, file);
}

/**
 * Store the key (undefined removes it): in the keychain, or in `s` (saved with the settings) where
 * there is no keychain. Returns whether it changed.
 */
export async function storeKey(s: AppSettings, key: string | undefined): Promise<boolean> {
  if (key === stored.key) return false;
  if (await writeKeychainKey(key)) {
    delete s.apiKey;
    stored = { key, place: "keychain" };
  } else {
    s.apiKey = key;
    stored = { key, place: "file" };
  }
  return true;
}

/** Make the settings take effect in this process: the key for Claude, the renderer, hardware encoding. */
export async function applySettings(s: AppSettings): Promise<void> {
  if (!envKey) {
    if (stored.key) process.env.ANTHROPIC_API_KEY = stored.key;
    else delete process.env.ANTHROPIC_API_KEY;
  }
  if (s.renderer === "auto") applyPerformance(await loadPerformance());
  else setDefaultBackend(s.renderer as RenderBackend, s.renderer as RenderBackend);
  setHardwareEncoding(s.hardwareEncoding);
}

/** What the Settings tab shows: the settings with the key hidden (its last four characters), and where it is kept. */
export function publicSettings(s: AppSettings) {
  const key = envKey || stored.key;
  const source = envKey ? "environment" : stored.place === "keychain" ? "keychain" : "settings";
  return {
    renderer: s.renderer,
    hardwareEncoding: s.hardwareEncoding,
    defaultModel: s.defaultModel ?? null,
    apiKey: key ? { set: true, hint: `…${key.slice(-4)}`, source } : { set: false },
    keychain: stored.place === "keychain",
    file: settingsFile(),
  };
}
