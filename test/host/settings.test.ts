import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// A keychain entry of its own, and no key from the environment, before the modules read them.
process.env.AVE_KEYCHAIN_SERVICE = `ai-video-editor-unit-${process.pid}`;
delete process.env.ANTHROPIC_API_KEY;
const { loadSettings, publicSettings, saveSettings, storeKey } = await import("../../engine/host/settings.js");
const { hasKeychain, writeKeychainKey } = await import("../../engine/host/secrets.js");

describe("app settings and the API key", () => {
  afterAll(async () => {
    await writeKeychainKey(undefined);
  });

  it("moves a key from the settings file into the system keychain, and keeps it out of the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ave-settings-"));
    const file = path.join(dir, "settings.json");
    try {
      await writeFile(file, JSON.stringify({ renderer: "ffmpeg", hardwareEncoding: false, apiKey: "sk-ant-old-file-5678" }));
      const s = await loadSettings(file);
      expect(s.renderer).toBe("ffmpeg");
      const shown = publicSettings(s);
      expect(shown.apiKey).toMatchObject({ set: true, hint: "…5678" });
      if (await hasKeychain()) {
        // Moved: the keychain has it, the file no longer does.
        expect(shown.apiKey.source).toBe("keychain");
        expect(await readFile(file, "utf8")).not.toContain("sk-ant-old");
        // A new key goes to the keychain too; removing it clears it.
        expect(await storeKey(s, "sk-ant-new-0001")).toBe(true);
        await saveSettings(s, file);
        expect(await readFile(file, "utf8")).not.toContain("sk-ant-new");
        expect(publicSettings(s).apiKey).toMatchObject({ hint: "…0001", source: "keychain" });
        expect(await storeKey(s, undefined)).toBe(true);
        expect(publicSettings(s).apiKey).toEqual({ set: false });
      } else {
        // No keychain on this machine: the file keeps it, and the settings say so.
        expect(shown.apiKey.source).toBe("settings");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
