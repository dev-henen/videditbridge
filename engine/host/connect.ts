import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Connecting other AI apps to the editor (Settings, Connections). Apps that start MCP servers
 * themselves (the Claude app, Gemini CLI) get an entry in their own config file, written here; the
 * entry runs the MCP server of this install (engine/mcp/main), which drives this app. Apps that
 * connect to an address (ChatGPT) use the HTTP server the host runs (main.ts, connect.http).
 */

/** The name the editor goes by in the other apps' MCP settings. */
export const MCP_NAME = "videditbridge";
/** Names the editor had in those configs before (as "AI Video Editor"); an entry under one is renamed. */
const OLD_MCP_NAMES = ["ai-video-editor"];

export interface McpLaunch {
  command: string;
  args: string[];
}

/**
 * How another app starts this install's MCP server: the same Node and build as this host
 * (dist/host/main.js gives dist/mcp/main.js; from source, engine/mcp/main.ts through tsx).
 */
export function mcpLaunch(projectsDir: string, hostMain = process.argv[1] ?? ""): McpLaunch | undefined {
  const ext = path.extname(hostMain);
  const main = path.resolve(path.dirname(hostMain), "..", "mcp", `main${ext}`);
  if (!existsSync(main)) return undefined;
  const root = path.resolve(path.dirname(hostMain), "..", "..");
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const script = ext === ".ts" ? [tsx, main] : [main];
  return { command: process.execPath, args: [...script, "--projects-dir", projectsDir] };
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
/** The launch as one command line, for apps set up by hand. */
export const commandLine = (l: McpLaunch) => [l.command, ...l.args].map(quote).join(" ");

export type ClientId = "claude" | "gemini-cli";

export interface ClientInfo {
  id: ClientId;
  name: string;
  /** The app's MCP config file. */
  configFile: string;
  /** Whether the app looks installed (its settings folder exists). */
  installed: boolean;
  /** Whether its config has the editor. */
  connected: boolean;
  /** Connected, but to another install or folder (connecting again updates it). */
  outdated: boolean;
  /** What to do after connecting. */
  note: string;
}

/** Subfolders of the given folders whose names match, newest first. */
function subdirs(parents: string[], name: RegExp): string[] {
  const found: { dir: string; time: number }[] = [];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const d of readdirSync(parent)) {
      if (!name.test(d)) continue;
      const dir = path.join(parent, d);
      try {
        found.push({ dir, time: statSync(dir).mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
  }
  return found.sort((a, b) => b.time - a.time).map((f) => f.dir);
}

/**
 * Where the Claude app may keep its data, most likely first. On Windows the Microsoft Store build
 * keeps it outside its package, in %LOCALAPPDATA%\Claude-Data\claude_<id> (older builds: the package's
 * LocalCache\Roaming\Claude); the installer build in %APPDATA%\Claude.
 */
function claudeDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [
      ...subdirs([path.join(local, "Claude-Data")], /^claude_/i),
      ...subdirs([path.join(local, "Packages")], /^Claude_/i).map((p) => path.join(p, "LocalCache", "Roaming", "Claude")),
      path.join(roaming, "Claude"),
    ];
  }
  if (process.platform === "darwin") return [path.join(home, "Library", "Application Support", "Claude")];
  const xdg = process.env.XDG_CONFIG_HOME;
  return [path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "Claude")];
}

/** Whether a folder is an app's live data folder (it keeps its settings and storage there), not just a config file. */
const looksLive = (dir: string) => ["config.json", "Preferences", "Local Storage"].some((f) => existsSync(path.join(dir, f)));

/** Whether a command is on the PATH (with Windows' program extensions). */
function onPath(command: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => existsSync(path.join(dir, command + ext.toLowerCase())) || existsSync(path.join(dir, command + ext))));
}

interface ClientSpec {
  name: string;
  /** Where the app may keep its config, most likely first. */
  dirs: () => string[];
  file: string;
  note: string;
  /** Whether the app is installed, when its config folder alone does not tell (the folder may be ours). */
  installed?: () => boolean;
}

const CLIENTS: Record<ClientId, ClientSpec> = {
  claude: { name: "Claude app", dirs: claudeDirs, file: "claude_desktop_config.json", note: "Quit and reopen the Claude app to use it." },
  // Google's terminal tool, not the Gemini app (which takes an address: see the connector address).
  "gemini-cli": {
    name: "Gemini CLI",
    dirs: () => [path.join(os.homedir(), ".gemini")],
    file: "settings.json",
    note: "Start a new Gemini CLI session to use it.",
    installed: () => onPath("gemini"),
  },
};
export const CLIENT_IDS = Object.keys(CLIENTS) as ClientId[];
export const isClientId = (v: unknown): v is ClientId => typeof v === "string" && v in CLIENTS;

/** Where an app may keep its config: $AVE_CLIENT_CONFIG_DIR (tests) holds every app's folders instead of their real places. */
function dirsOf(id: ClientId): string[] {
  const test = process.env.AVE_CLIENT_CONFIG_DIR;
  if (!test) return CLIENTS[id].dirs();
  // In tests, <root>/<id> is the app's folder; <root>/<id>-candidates/* are more places, as the real ones.
  const extra = path.join(test, `${id}-candidates`);
  return [...subdirs([extra], /./), path.join(test, id)];
}

/** The app's config folder: the one it really uses (its live data folder), else one that has its config, else the most likely. */
function dirOf(id: ClientId): string {
  const dirs = dirsOf(id);
  return dirs.find(looksLive) ?? dirs.find((d) => existsSync(path.join(d, CLIENTS[id].file))) ?? dirs.find(existsSync) ?? dirs[dirs.length - 1]!;
}

type McpConfig = { mcpServers?: Record<string, { command?: string; args?: string[] }> } & Record<string, unknown>;

async function readConfig(file: string): Promise<McpConfig | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as McpConfig;
  } catch {
    throw new Error(`${file} is not valid JSON, so it was left as it is. Fix it, then connect again.`);
  }
}

/** The editor's entry in a config: under its name, or under the name it had before (which counts as outdated). */
function entryIn(config: McpConfig | undefined): { entry?: { command?: string; args?: string[] }; old: boolean } {
  const servers = config?.mcpServers ?? {};
  if (servers[MCP_NAME]) return { entry: servers[MCP_NAME], old: false };
  const old = OLD_MCP_NAMES.find((n) => servers[n]);
  return old ? { entry: servers[old], old: true } : { old: false };
}

/** The config without the editor's entries under its old names. */
const withoutOldNames = (servers: NonNullable<McpConfig["mcpServers"]>) => Object.fromEntries(Object.entries(servers).filter(([n]) => !OLD_MCP_NAMES.includes(n)));

export async function clientInfo(id: ClientId, launch: McpLaunch | undefined): Promise<ClientInfo> {
  const dir = dirOf(id);
  const configFile = path.join(dir, CLIENTS[id].file);
  const { entry, old } = entryIn(await readConfig(configFile).catch(() => undefined));
  const outdated = !!entry && (old || (!!launch && (entry.command !== launch.command || JSON.stringify(entry.args ?? []) !== JSON.stringify(launch.args))));
  const check = process.env.AVE_CLIENT_CONFIG_DIR ? undefined : CLIENTS[id].installed;
  return { id, name: CLIENTS[id].name, configFile, installed: check ? check() : existsSync(dir), connected: !!entry, outdated, note: CLIENTS[id].note };
}

/**
 * Add the editor to an app's config, or take it out. The rest of the file stays as it was; the
 * previous file is kept as <file>.bak. Entries under the editor's old names go either way.
 */
export async function setClientConnected(id: ClientId, connected: boolean, launch: McpLaunch | undefined): Promise<ClientInfo> {
  if (connected && !launch) throw new Error("This install has no MCP server to connect (engine/mcp is missing).");
  const file = path.join(dirOf(id), CLIENTS[id].file);
  const config = (await readConfig(file)) ?? {};
  const servers = withoutOldNames({ ...config.mcpServers });
  const had = entryIn(config).entry !== undefined;
  if (connected) servers[MCP_NAME] = { command: launch!.command, args: launch!.args };
  else if (!had) return clientInfo(id, launch);
  else delete servers[MCP_NAME];
  await writeConfig(file, { ...config, mcpServers: servers });
  // An entry in a place the app does not read (written there before, or by an older version) goes.
  for (const dir of dirsOf(id)) {
    const other = path.join(dir, CLIENTS[id].file);
    if (other === file) continue;
    const stale = await readConfig(other).catch(() => undefined);
    if (!entryIn(stale).entry) continue;
    const { [MCP_NAME]: _, ...rest } = withoutOldNames(stale!.mcpServers!);
    await writeConfig(other, { ...stale, mcpServers: rest });
  }
  return clientInfo(id, launch);
}

/** At start: an app connected under the editor's old name gets its entry renamed (and pointed at this install). */
export async function renameOldEntries(launch: McpLaunch | undefined): Promise<void> {
  if (!launch) return;
  for (const id of CLIENT_IDS) {
    const config = await readConfig(path.join(dirOf(id), CLIENTS[id].file)).catch(() => undefined);
    if (entryIn(config).old) await setClientConnected(id, true, launch).catch(() => undefined);
  }
}

/** Write a config through a temporary file, keeping the previous one as <file>.bak. */
async function writeConfig(file: string, config: McpConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) await copyFile(file, `${file}.bak`);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
