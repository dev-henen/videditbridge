import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../engine/version.js";

// The version is written in five places; `npm run bump <x.y.z>` sets them all (scripts/bump-version.ts).
describe("the app's version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { version: string; packages: Record<string, { version?: string }> };

  it("is the same in package.json, the lockfile, the engine, the desktop app and the Linux metadata", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]!.version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
    expect(readFileSync("ui/VideditBridge.csproj", "utf8")).toContain(`<Version>${pkg.version}</Version>`);
    // The newest release entry comes first.
    const releases = [...readFileSync("ui/Packaging/linux/io.github.dev_henen.videditbridge.metainfo.xml", "utf8").matchAll(/<release version="([^"]+)"/g)].map((m) => m[1]);
    expect(releases[0]).toBe(pkg.version);
  });

  it("is not written anywhere else in the engine", () => {
    // The host and the MCP server report VERSION; a literal would drift (it did: "0.2.0" after 0.1.1).
    for (const file of ["engine/host/main.ts", "engine/mcp/server.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/version: "\d+\.\d+\.\d+"|\?\? "\d+\.\d+\.\d+"/);
  });
});
