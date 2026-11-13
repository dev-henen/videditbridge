import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The apps' config files go to a folder of the test's own, before the module reads it.
const root = await mkdtemp(path.join(tmpdir(), "ave-connect-"));
process.env.AVE_CLIENT_CONFIG_DIR = root;
const { MCP_NAME, clientInfo, commandLine, mcpLaunch, setClientConnected } = await import("../../engine/host/connect.js");

describe("connecting other AI apps to the editor", () => {
  const launch = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["/app/dist/mcp/main.js", "--projects-dir", "/my projects"] };
  beforeAll(async () => {
    await mkdir(path.join(root, "claude"), { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds this install's MCP server next to the host, run through tsx from source", () => {
    const l = mcpLaunch("/projects", path.resolve("engine/host/main.ts"))!;
    expect(l.command).toBe(process.execPath);
    expect(l.args.slice(-3)).toEqual([path.resolve("engine/mcp/main.ts"), "--projects-dir", "/projects"]);
    expect(l.args[0]).toMatch(/tsx[\\/]dist[\\/]cli\.mjs$/);
    expect(mcpLaunch("/projects", "/nowhere/host/main.js")).toBeUndefined();
    expect(commandLine(launch)).toBe('"C:\\Program Files\\nodejs\\node.exe" /app/dist/mcp/main.js --projects-dir "/my projects"');
  });

  it("adds the editor to an app's config, keeping everything else, and takes it out again", async () => {
    const file = path.join(root, "claude", "claude_desktop_config.json");
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    expect(await clientInfo("claude", launch)).toMatchObject({ installed: true, connected: false });

    const on = await setClientConnected("claude", true, launch);
    expect(on).toMatchObject({ connected: true, outdated: false });
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written).toEqual({ theme: "dark", mcpServers: { other: { command: "x" }, [MCP_NAME]: launch } });
    // The file as it was is kept.
    expect(JSON.parse(await readFile(`${file}.bak`, "utf8")).mcpServers[MCP_NAME]).toBeUndefined();

    // Another install (or projects folder) shows as outdated until connected again.
    expect((await clientInfo("claude", { ...launch, args: ["other"] })).outdated).toBe(true);

    expect((await setClientConnected("claude", false, launch)).connected).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("makes the config when the app has none, and says so when an app is not installed", async () => {
    expect((await clientInfo("gemini-cli", launch)).installed).toBe(false);
    await setClientConnected("gemini-cli", true, launch);
    expect(JSON.parse(await readFile(path.join(root, "gemini-cli", "settings.json"), "utf8")).mcpServers[MCP_NAME]).toEqual(launch);
  });

  it("writes where the app really keeps its data, and takes the entry out of places it does not read", async () => {
    // As the Microsoft Store build of the Claude app: its data in a folder of its own, while the
    // usual place holds an entry written there before.
    const live = path.join(root, "claude-candidates", "claude_pzs8");
    await mkdir(live, { recursive: true });
    await writeFile(path.join(live, "config.json"), "{}");
    await writeFile(path.join(live, "claude_desktop_config.json"), JSON.stringify({ preferences: { keep: true } }));
    const usual = path.join(root, "claude", "claude_desktop_config.json");
    await writeFile(usual, JSON.stringify({ mcpServers: { [MCP_NAME]: launch, other: { command: "x" } } }));

    // The entry in the usual place does not count: the app does not read it.
    const before = await clientInfo("claude", launch);
    expect(before.configFile).toBe(path.join(live, "claude_desktop_config.json"));
    expect(before.connected).toBe(false);

    expect((await setClientConnected("claude", true, launch)).connected).toBe(true);
    expect(JSON.parse(await readFile(path.join(live, "claude_desktop_config.json"), "utf8"))).toEqual({ preferences: { keep: true }, mcpServers: { [MCP_NAME]: launch } });
    expect(JSON.parse(await readFile(usual, "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    await rm(path.join(root, "claude-candidates"), { recursive: true, force: true });
  });

  it("leaves a config it cannot read alone", async () => {
    const file = path.join(root, "claude", "claude_desktop_config.json");
    await writeFile(file, "{ not json");
    await expect(setClientConnected("claude", true, launch)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });
});
