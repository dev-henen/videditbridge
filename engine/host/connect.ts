import { existsSync, readdirSync } from "node:fs";
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
export const MCP_NAME = "ai-video-editor";

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

/** The Claude app's config: the Microsoft Store install keeps it in its package folder. */
function claudeConfigDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const packages = path.join(local, "Packages");
    const store = existsSync(packages) ? readdirSync(packages).find((d) => /^Claude_/i.test(d)) : undefined;
    if (store) return path.join(packages, store, "LocalCache", "Roaming", "Claude");
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "Claude");
}

const CLIENTS: Record<ClientId, { name: string; dir: () => string; file: string; note: string }> = {
  claude: { name: "Claude app", dir: claudeConfigDir, file: "claude_desktop_config.json", note: "Quit and reopen the Claude app to use it." },
  "gemini-cli": { name: "Gemini CLI", dir: () => path.join(os.homedir(), ".gemini"), file: "settings.json", note: "Start a new Gemini CLI session to use it." },
};
export const CLIENT_IDS = Object.keys(CLIENTS) as ClientId[];
export const isClientId = (v: unknown): v is ClientId => typeof v === "string" && v in CLIENTS;

/** $AVE_CLIENT_CONFIG_DIR (tests) holds every app's file instead of their real places. */
const dirOf = (id: ClientId) => (process.env.AVE_CLIENT_CONFIG_DIR ? path.join(process.env.AVE_CLIENT_CONFIG_DIR, id) : CLIENTS[id].dir());

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

export async function clientInfo(id: ClientId, launch: McpLaunch | undefined): Promise<ClientInfo> {
  const dir = dirOf(id);
  const configFile = path.join(dir, CLIENTS[id].file);
  const entry = (await readConfig(configFile).catch(() => undefined))?.mcpServers?.[MCP_NAME];
  const outdated = !!entry && !!launch && (entry.command !== launch.command || JSON.stringify(entry.args ?? []) !== JSON.stringify(launch.args));
  return { id, name: CLIENTS[id].name, configFile, installed: existsSync(dir), connected: !!entry, outdated, note: CLIENTS[id].note };
}

/**
 * Add the editor to an app's config, or take it out. The rest of the file stays as it was; the
 * previous file is kept as <file>.bak.
 */
export async function setClientConnected(id: ClientId, connected: boolean, launch: McpLaunch | undefined): Promise<ClientInfo> {
  if (connected && !launch) throw new Error("This install has no MCP server to connect (engine/mcp is missing).");
  const file = path.join(dirOf(id), CLIENTS[id].file);
  const config = (await readConfig(file)) ?? {};
  const servers = { ...config.mcpServers };
  if (connected) servers[MCP_NAME] = { command: launch!.command, args: launch!.args };
  else if (!(MCP_NAME in servers)) return clientInfo(id, launch);
  else delete servers[MCP_NAME];
  const next = { ...config, mcpServers: servers };
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) await copyFile(file, `${file}.bak`);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, file);
  return clientInfo(id, launch);
}
