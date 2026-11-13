import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const site = path.join(root, "site");

describe("the user guide website", () => {
  it("builds, and has every page the app links to (with the sections it jumps to)", async () => {
    execFileSync(process.execPath, [path.join(root, "scripts", "build-site.mjs")], { stdio: "pipe" });
    const docs = await readFile(path.join(root, "ui", "Shared", "Docs.cs"), "utf8");
    const pages = [...docs.matchAll(/Site \+ "([\w-]+\.html)"/g)].map((m) => m[1]!);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of ["index.html", ...pages]) expect(existsSync(path.join(site, "_site", page)), page).toBe(true);
    // Settings' "How to get one" opens api-keys.html#<provider>.
    const keys = await readFile(path.join(site, "_site", "api-keys.html"), "utf8");
    for (const provider of ["anthropic", "openai", "google"]) expect(keys).toContain(`id="${provider}"`);
    expect(await readFile(path.join(site, "_site", "troubleshooting.html"), "utf8")).toContain('id="claude-app"');
  });

  it("shows only screenshots that exist, and keeps to the writing rules", async () => {
    for (const name of await readdir(path.join(site, "pages"))) {
      const html = await readFile(path.join(site, "pages", name), "utf8");
      for (const [, src] of html.matchAll(/src="(assets\/[^"]+)"/g)) expect(existsSync(path.join(site, src!)), `${name}: ${src}`).toBe(true);
      expect(html, `${name} has a long dash`).not.toMatch(/[–—]/);
      expect(html, `${name} has an emoji`).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });
});
