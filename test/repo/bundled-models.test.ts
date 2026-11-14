import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledModelsDir } from "../../engine/tools/appdirs.js";
import { FILE_MODELS, TRANSFORMERS_MODELS } from "../../engine/tools/bundled-models.js";
import { DETECT_MODEL, OBJECT_MODEL } from "../../engine/tools/vision/objects.js";
import { ensureModelFile, FACE_MODEL } from "../../engine/tools/vision/faces.js";

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });

describe("the models an installed app carries", () => {
  it("include every single-file model the engine loads", () => {
    const listed = new Set(FILE_MODELS.map((m) => `${m.folder}/${m.model.file}`));
    const folders = new Set(FILE_MODELS.map((m) => m.folder));
    const used: string[] = [];
    for (const file of sources("engine")) {
      for (const call of readFileSync(file, "utf8").matchAll(/ensureModelFile\([^,]+,\s*"([^"]+)"/g)) used.push(`${call[1]} (${path.relative(".", file)})`);
    }
    expect(used.length).toBeGreaterThanOrEqual(8);
    for (const u of used) expect(folders, `${u} is not in FILE_MODELS (engine/tools/bundled-models.ts)`).toContain(u.split(" ")[0]);
    expect(listed.size).toBe(FILE_MODELS.length);
  });

  it("include every transformers.js model, as the tools load it", () => {
    const ids = TRANSFORMERS_MODELS.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([OBJECT_MODEL.id, DETECT_MODEL.id, "onnx-community/whisper-base.en_timestamped", "onnx-community/whisper-base_timestamped", "onnx-community/Kokoro-82M-v1.0-ONNX"]));
    // Each tool's from_pretrained or pipeline call reads its id from a constant or method on this list.
    for (const file of sources("engine/tools")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from_pretrained|pipeline)\(\s*(?:"[^"]+",\s*)?"([^"]+\/[^"]+)"/g)) expect(ids, `${m[1]} in ${file}`).toContain(m[1]);
    }
  });
});

describe("bundled models", () => {
  const before = process.env.AVE_BUNDLED_MODELS_DIR;
  let dir: string | undefined;
  afterEach(() => {
    if (before === undefined) delete process.env.AVE_BUNDLED_MODELS_DIR;
    else process.env.AVE_BUNDLED_MODELS_DIR = before;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("are used in place, with nothing downloaded", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ave-bundled-"));
    mkdirSync(path.join(dir, "yunet"));
    const file = path.join(dir, "yunet", FACE_MODEL.file);
    writeFileSync(file, Buffer.alloc(200_000));
    process.env.AVE_BUNDLED_MODELS_DIR = dir;
    expect(bundledModelsDir()).toBe(dir);
    // A bad address would fail if it were fetched.
    expect(await ensureModelFile({}, "yunet", { ...FACE_MODEL, url: "http://127.0.0.1:9/none.onnx" })).toBe(file);
  });

  it("are not there when the folder is missing (a development checkout)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ave-bundled-"));
    process.env.AVE_BUNDLED_MODELS_DIR = path.join(dir, "missing");
    expect(bundledModelsDir()).toBeUndefined();
  });
});
