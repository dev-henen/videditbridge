import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JOURNAL_FILE, appendJournal, readJournal } from "../../engine/host/journal.js";

describe("project history (journal)", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps every entry in the project folder and reads them newest first", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ave-journal-"));
    expect(await readJournal(dir)).toEqual([]);
    await appendJournal(dir, { at: "2026-11-18T10:00:00.000Z", kind: "tool", text: "Adding text", status: "done" });
    await appendJournal(dir, { at: "2026-11-18T10:01:00.000Z", kind: "undo", text: "Undo: add text", status: "done" });
    await appendJournal(dir, { at: "2026-11-18T10:02:00.000Z", kind: "render", text: "Rendering video", detail: "x".repeat(1000), status: "error" });
    const entries = await readJournal(dir);
    expect(entries.map((e) => e.text)).toEqual(["Rendering video", "Undo: add text", "Adding text"]);
    expect(entries[0]!.detail!.length).toBeLessThanOrEqual(400);
    expect((await readFile(path.join(dir, JOURNAL_FILE), "utf8")).trim().split("\n")).toHaveLength(3);
    expect((await readJournal(dir, 2)).map((e) => e.text)).toEqual(["Rendering video", "Undo: add text"]);
  });

  it("skips a line cut short by a crash", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ave-journal-"));
    await writeFile(path.join(dir, JOURNAL_FILE), '{"at":"2026-11-18T10:00:00.000Z","kind":"file","text":"Opened"}\n{"at":"2026-11-1', "utf8");
    expect((await readJournal(dir)).map((e) => e.text)).toEqual(["Opened"]);
  });
});
