import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REFERENCE_DIR, generateDocs } from "../../scripts/gen-docs.js";

describe("generated reference docs", () => {
  it("match the code (run `npm run docs` if this fails)", async () => {
    for (const [name, content] of Object.entries(await generateDocs())) {
      // Git may check files out with CRLF on Windows; only the text matters.
      const onDisk = (await readFile(path.join(REFERENCE_DIR, name), "utf8").catch(() => "")).replace(/\r\n/g, "\n");
      expect(onDisk, `docs/reference/${name} is out of date`).toBe(content);
    }
  });

  it("document every Claude tool", async () => {
    const { TOOLS } = await import("../../engine/claude/index.js");
    const doc = (await generateDocs())["claude-tools.md"]!;
    for (const t of TOOLS) expect(doc).toContain(`### ${t.name}`);
  });
});
