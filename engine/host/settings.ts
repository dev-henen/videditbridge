import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appDir } from "../tools/appdirs.js";
import { setDefaultBackend, type RenderBackend } from "../tools/render/render.js";
import { setHardwareEncoding } from "../tools/render/hardware.js";
import { applyPerformance, loadPerformance } from "../tools/render/benchmark.js";
import { PROVIDERS, PROVIDER_IDS, envKeyOf, providerAvailable, providerInfo, type ProviderId } from "./models.js";
import { hasKeychain, readKeychainKey, writeKeychainKey } from "./secrets.js";

/**
 * The app's settings (the Settings tab), kept in the app's data folder and applied by the host: the
 * API keys of the AI providers (Anthropic for Claude, the default; OpenAI for ChatGPT; Google for
 * Gemini), the model new conversations start with, which renderer draws the picture, and whether
 * exports encode on the graphics card. Keys live in the system's keychain (secrets.ts); only where
 * there is none does the settings file hold them.
 */
export interface AppSettings {
  /** The Anthropic key, in the file only where the system has no keychain (a key found here moves to the keychain). */
  apiKey?: string;
  /** The other providers' keys, likewise only where there is no keychain. */
  apiKeys?: Partial<Record<Exclude<ProviderId, "anthropic">, string>>;
  /** The model new conversations start with (an id from host.info's models). */
  defaultModel?: string;
  /** "auto": what the performance test found (the GPU engine, FFmpeg where it fails); or one renderer always. */
  renderer: "auto" | "engine" | "ffmpeg";
  hardwareEncoding: boolean;
  /** The MCP connector address for ChatGPT and other apps that connect to one: on or off, and its port. */
  mcpHttp?: { enabled: boolean; port?: number };
}

const DEFAULTS: AppSettings = { renderer: "auto", hardwareEncoding: true };

/** $AVE_SETTINGS_FILE (tests), or settings.json in the app's data folder. */
export const settingsFile = () => process.env.AVE_SETTINGS_FILE || path.join(appDir("data"), "settings.json");

/** The keys the environment gave the host when it started, which always win over stored ones. */
const envKeys = Object.fromEntries(PROVIDERS.map((p) => [p.id, envKeyOf(p.id)])) as Record<ProviderId, string | undefined>;

/** The stored keys (keychain or file), and where they are. */
let place: "keychain" | "file" = "file";
let stored: Partial<Record<ProviderId, string>> = {};

/** A provider's key as the settings file holds it. */
const fileKey = (s: AppSettings, id: ProviderId) => (id === "anthropic" ? s.apiKey : s.apiKeys?.[id]);
function setFileKey(s: AppSettings, id: ProviderId, key: string | undefined): void {
  if (id === "anthropic") {
    if (key) s.apiKey = key;
    else delete s.apiKey;
    return;
  }
  const keys = { ...s.apiKeys };
  if (key) keys[id] = key;
  else delete keys[id];
  if (Object.keys(keys).length) s.apiKeys = keys;
  else delete s.apiKeys;
}

/** Read the settings and the stored keys; keys still in the file move to the keychain when there is one. */
export async function loadSettings(file = settingsFile()): Promise<AppSettings> {
  let s: AppSettings;
  try {
    s = { ...DEFAULTS, ...(JSON.parse(await readFile(file, "utf8")) as Partial<AppSettings>) };
  } catch {
    s = { ...DEFAULTS };
  }
  stored = {};
  if (await hasKeychain()) {
    place = "keychain";
    let moved = false;
    for (const id of PROVIDER_IDS) {
      const key = fileKey(s, id);
      if (key && (await writeKeychainKey(key, id))) {
        setFileKey(s, id, undefined);
        moved = true;
      }
      stored[id] = await readKeychainKey(id);
    }
    if (moved) await saveSettings(s, file);
  } else {
    place = "file";
    for (const id of PROVIDER_IDS) stored[id] = fileKey(s, id);
  }
  return s;
}

export async function saveSettings(s: AppSettings, file = settingsFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(s, null, 2), "utf8");
  await rename(temp, file);
}

/**
 * Store a provider's key (undefined removes it): in the keychain, or in `s` (saved with the
 * settings) where there is no keychain. Returns whether it changed.
 */
export async function storeKey(s: AppSettings, key: string | undefined, provider: ProviderId = "anthropic"): Promise<boolean> {
  if (key === stored[provider]) return false;
  if (await writeKeychainKey(key, provider)) {
    setFileKey(s, provider, undefined);
    place = "keychain";
  } else {
    setFileKey(s, provider, key);
    place = "file";
  }
  stored[provider] = key;
  return true;
}

/** Make the settings take effect in this process: the providers' keys, the renderer, hardware encoding. */
export async function applySettings(s: AppSettings): Promise<void> {
  for (const id of PROVIDER_IDS) {
    if (envKeys[id]) continue;
    const name = providerInfo(id).keyEnv[0]!;
    if (stored[id]) process.env[name] = stored[id];
    else delete process.env[name];
  }
  if (s.renderer === "auto") applyPerformance(await loadPerformance());
  else setDefaultBackend(s.renderer as RenderBackend, s.renderer as RenderBackend);
  setHardwareEncoding(s.hardwareEncoding);
}

/** A key as the Settings tab shows it: hidden but for its last four characters, and where it comes from. */
function shownKey(id: ProviderId) {
  const key = envKeys[id] || stored[id];
  const source = envKeys[id] ? "environment" : place === "keychain" ? "keychain" : "settings";
  return key ? { set: true as const, hint: `…${key.slice(-4)}`, source } : { set: false as const };
}

/** Which providers can be used now (after applySettings). */
export const availableProviders = () => Object.fromEntries(PROVIDER_IDS.map((id) => [id, providerAvailable(id)])) as Record<ProviderId, boolean>;

/** What the Settings tab shows: the settings with the keys hidden, and where they are kept. */
export function publicSettings(s: AppSettings) {
  return {
    renderer: s.renderer,
    hardwareEncoding: s.hardwareEncoding,
    defaultModel: s.defaultModel ?? null,
    /** Anthropic's key (as before). */
    apiKey: shownKey("anthropic"),
    /** Every provider's key. */
    apiKeys: Object.fromEntries(PROVIDER_IDS.map((id) => [id, shownKey(id)])) as Record<ProviderId, ReturnType<typeof shownKey>>,
    keychain: place === "keychain",
    file: settingsFile(),
  };
}
