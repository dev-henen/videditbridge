import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addAsset, createProject, withProjectPaths } from "../src/core/operations.js";
import { toProjectPath } from "../src/core/util.js";
import { fileOnDisk, validateProject } from "../src/core/validate.js";
import { escapeFilterPath } from "../src/library/effects/index.js";
import { appDir, legacyAppDir, migrateLegacyAppDir } from "../src/tools/appdirs.js";
import { FONT_REPLACEMENTS, bundledFontsDir, ensureBundledFonts, fontsIn, prepareFonts, replaceFont } from "../src/tools/fonts/index.js";
import { replaceSvgFonts } from "../src/tools/graphics/index.js";
import { runFfmpeg } from "../src/tools/render/ffmpeg.js";
import { checkFfmpeg, describeFfmpegCheck, parseFfmpegList } from "../src/tools/render/selftest.js";
import { AssDocument } from "../src/tools/captions/ass.js";
import { ffmpegAvailable } from "./helpers/media.js";

const temps: string[] = [];
const tempDir = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "ave-xp-"));
  temps.push(d);
  return d;
};
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

describe("app folders (E4)", () => {
  const home = "/home/u";
  it("follows each system's conventions", () => {
    expect(appDir("cache", { platform: "win32", home: "C:\\Users\\u", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } })).toBe("C:\\Users\\u\\AppData\\Local\\ai-video-editor");
    expect(appDir("data", { platform: "darwin", home: "/Users/u", env: {} })).toBe("/Users/u/Library/Application Support/ai-video-editor");
    expect(appDir("cache", { platform: "darwin", home: "/Users/u", env: {} })).toBe("/Users/u/Library/Caches/ai-video-editor");
    expect(appDir("cache", { platform: "linux", home, env: {} })).toBe("/home/u/.cache/ai-video-editor");
    expect(appDir("data", { platform: "linux", home, env: {} })).toBe("/home/u/.local/share/ai-video-editor");
    expect(appDir("data", { platform: "linux", home, env: { XDG_DATA_HOME: "/xdg/data" } })).toBe("/xdg/data/ai-video-editor");
    // Relative XDG paths are ignored, as the spec says.
    expect(appDir("cache", { platform: "linux", home, env: { XDG_CACHE_HOME: "rel" } })).toBe("/home/u/.cache/ai-video-editor");
  });

  it("moves the old shared folder without overwriting", async () => {
    const root = await tempDir();
    const sys = { platform: "win32" as const, home: root, env: { LOCALAPPDATA: path.join(root, "local") } };
    if (process.platform !== "win32") Object.assign(sys, { platform: "linux", env: { XDG_CACHE_HOME: path.join(root, "cache"), XDG_DATA_HOME: path.join(root, "data") } });
    const old = legacyAppDir(sys);
    await mkdir(path.join(old, "models"), { recursive: true });
    await mkdir(path.join(old, "fonts"), { recursive: true });
    await writeFile(path.join(old, "models", "m.onnx"), "m");
    await writeFile(path.join(old, "fonts", "f.ttf"), "f");
    migrateLegacyAppDir(sys);
    expect(existsSync(path.join(appDir("cache", sys), "models", "m.onnx"))).toBe(true);
    expect(existsSync(path.join(appDir("data", sys), "fonts", "f.ttf"))).toBe(true);
    expect(existsSync(old)).toBe(false);
  });
});

describe("project paths (B1)", () => {
  it("stores files inside the project relative, with forward slashes", () => {
    expect(toProjectPath("C:\\Repo\\p\\.render\\sfx\\a.wav", "C:\\Repo\\p")).toBe(".render/sfx/a.wav");
    expect(toProjectPath("c:/repo/P/media/a.mp4", "C:\\Repo\\p")).toBe("media/a.mp4");
    expect(toProjectPath("/home/u/p/media/a.mp4", "/home/u/p")).toBe("media/a.mp4");
    expect(toProjectPath("/home/u/P/media/a.mp4", "/home/u/p")).toBe("/home/u/P/media/a.mp4");
    expect(toProjectPath("media\\a.mp4", "/x")).toBe("media/a.mp4");
    expect(toProjectPath("./media/a.mp4", "/x")).toBe("media/a.mp4");
    expect(toProjectPath("D:\\other\\a.mp4", "C:\\Repo\\p")).toBe("D:/other/a.mp4");
    expect(toProjectPath("https://x.test/a.mp4", "/x")).toBe("https://x.test/a.mp4");
  });

  it("rewrites a project and leaves a clean one untouched", () => {
    const p = addAsset(createProject({}), { type: "audio", id: "a", src: "C:\\Repo\\p\\.render\\a.wav", duration: 1 });
    const q = withProjectPaths(p, "C:\\Repo\\p");
    expect(q.assets[0]).toMatchObject({ src: ".render/a.wav" });
    expect(p.assets[0]).toMatchObject({ src: "C:\\Repo\\p\\.render\\a.wav" });
    expect(withProjectPaths(q, "C:\\Repo\\p")).toBe(q);
  });

  it("warns about absolute and backslash paths", () => {
    const p = addAsset(createProject({}), { type: "audio", id: "a", src: "C:\\elsewhere\\a.wav", duration: 1 });
    const msgs = validateProject(p).issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/backslashes/);
    expect(msgs).toMatch(/absolute path/);
  });
});

describe("file name case (B2)", () => {
  it("finds the name as spelled on disk and reports case-only differences", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "Media"));
    await writeFile(path.join(dir, "Media", "Clip.MP4"), "x");
    expect(fileOnDisk(path.join(dir, "Media", "Clip.MP4"))).toBe(path.join(dir, "Media", "Clip.MP4"));
    expect(fileOnDisk(path.join(dir, "Media", "missing.mp4"))).toBeUndefined();
    const p = addAsset(createProject({}), { type: "audio", id: "a", src: "media/clip.mp4", duration: 1 });
    const issues = validateProject(p, { baseDir: dir }).issues.filter((i) => i.path === "assets.0.src");
    // Linux file systems are case-sensitive, so there the file is missing (and the message names the one on disk).
    if (process.platform === "linux") expect(issues[0]).toMatchObject({ level: "error", message: expect.stringMatching(/not found.*"Media\/Clip\.MP4"/) });
    else expect(issues[0]).toMatchObject({ level: "warning", message: expect.stringContaining('named "Media/Clip.MP4" on disk') });
  });
});

describe("filter paths (B3)", () => {
  it("escapes for both levels of FFmpeg parsing", () => {
    expect(escapeFilterPath("C:\\a b\\x.cube", "win32")).toBe("C\\:/a b/x.cube");
    expect(escapeFilterPath("/a:b/it's\\x.cube", "linux")).toBe("/a\\:b/it\\'\\''s\\\\x.cube");
  });

  // Names legal on this system; Windows forbids : and \ in names.
  const names = ["with space", "it's", "brackets [1], semi; colon", "naïve 日本"].concat(process.platform === "win32" ? [] : ["co:lon", "back\\slash"]);
  it("reads LUT files with awkward names through a filter script", async () => {
    if (!(await ffmpegAvailable())) return;
    const root = await tempDir();
    const cube = `LUT_3D_SIZE 2\n${[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${r} ${g} ${b}`))).join("\n")}\n`;
    for (const name of names) {
      const dir = path.join(root, name);
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${name.split(" ")[0]}.cube`);
      await writeFile(file, cube);
      const script = path.join(root, "graph.txt");
      await writeFile(script, `[0:v]lut3d=file='${escapeFilterPath(file)}'[out]`);
      const r = await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", "color=c=gray:s=16x16:d=0.1", "-filter_complex_script", script, "-map", "[out]", "-frames:v", "1", "-f", "null", "-"]);
      expect(r.code, `${name}: ${r.stderr.slice(-400)}`).toBe(0);
    }
  });
});

describe("fonts (C1, C2)", () => {
  it("bundles every replacement font", async () => {
    const families = new Set((await fontsIn(bundledFontsDir())).map((f) => f.family));
    for (const to of Object.values(FONT_REPLACEMENTS)) expect(families, to).toContain(to);
    expect((await readdir(bundledFontsDir())).filter((f) => f.endsWith("OFL.txt")).length).toBeGreaterThanOrEqual(6);
  });

  it("copies the bundled fonts into the fonts folder", async () => {
    const dir = path.join(await tempDir(), "fonts");
    await ensureBundledFonts(dir);
    expect((await fontsIn(dir)).map((f) => f.family)).toContain("Arimo");
    const { fontsDir, fontMap } = await prepareFonts(dir);
    expect(fontsDir).toBe(path.resolve(dir));
    // Only names this system lacks are replaced.
    for (const [name, to] of Object.entries(fontMap)) expect(Object.values(FONT_REPLACEMENTS)).toContain(to), expect(name).toBe(name.toLowerCase());
  });

  it("applies replacements to ASS styles and SVG", () => {
    const map = { arial: "Arimo", "arial black": "Archivo Black" };
    expect(replaceFont("Arial", map)).toBe("Arimo");
    expect(replaceFont("Inter", map)).toBe("Inter");
    expect(replaceSvgFonts(`<text font-family="Arial Black, sans-serif">x</text><text style="font-family: 'Arial'">y</text>`, map)).toBe(
      `<text font-family="Archivo Black, sans-serif">x</text><text style="font-family: 'Arimo'">y</text>`,
    );
    const doc = new AssDocument(100, 100);
    doc.fontMap = map;
    doc.addStyle({ fontFamily: "Arial", fontSize: 20, primaryColor: "#FFFFFF", secondaryColor: "#000000", outlineColor: "#000000", backColor: "#000000", bold: false, italic: false, spacing: 0, borderStyle: 1, outline: 0, shadow: 0, alignment: 5, marginL: 0, marginR: 0, marginV: 0 });
    doc.addEvent({ layer: 0, start: 0, end: 1, style: "S1", text: "x" });
    expect(doc.toString()).toMatch(/Style: S1,Arimo,/);
  });

  it("defaults to bundled fonts", () => {
    const p = createProject({});
    expect(JSON.stringify(p)).not.toMatch(/Arial|Georgia|Impact/);
  });
});

describe("FFmpeg self-test (D1)", () => {
  it("parses listings", () => {
    const names = parseFfmpegList("Filters:\n  T.. = Timeline support\n ... ass               V->V       Render ASS subtitles\n V....D libx264  libx264 H.264\n");
    expect([...names]).toEqual(["ass", "libx264"]);
  });

  it("finds everything the renderer uses in this build", async () => {
    if (!(await ffmpegAvailable())) return;
    const c = await checkFfmpeg();
    expect(c.ok, describeFfmpegCheck(c)).toBe(true);
  });
});

describe("model execution providers (E2)", () => {
  it("measures by default, maps gpu per system and always ends with the CPU", async () => {
    const { ortProviders } = await import("../src/tools/vision/faces.js");
    expect(ortProviders("win32", {})).toBe("auto");
    expect(ortProviders("freebsd", {})).toEqual(["cpu"]);
    expect(ortProviders("win32", { AVE_ORT_PROVIDERS: "cpu" })).toEqual(["cpu"]);
    expect(ortProviders("win32", { AVE_ORT_PROVIDERS: "gpu" })).toEqual(["dml", "cpu"]);
    expect(ortProviders("darwin", { AVE_ORT_PROVIDERS: "gpu" })).toEqual(["coreml", "cpu"]);
    expect(ortProviders("linux", { AVE_ORT_PROVIDERS: "GPU" })).toEqual(["cuda", "cpu"]);
    expect(ortProviders("linux", { AVE_ORT_PROVIDERS: "cuda, cpu" })).toEqual(["cuda", "cpu"]);
  });

  it("falls back to the CPU when the provider fails on the first run", async () => {
    const { createOrtSession } = await import("../src/tools/vision/faces.js");
    const made: string[] = [];
    const ort = {
      Tensor: class {},
      InferenceSession: {
        create: async (_: string, opts?: { executionProviders?: string[] }) => {
          const on = opts?.executionProviders?.[0] ?? "cpu";
          made.push(on);
          return { run: async () => (on === "cpu" ? { out: { data: [1] } } : Promise.reject(new Error("missing operator"))) };
        },
      },
    };
    const s = await createOrtSession(ort as never, "m.onnx", ["dml", "cpu"]);
    expect(await s.run({})).toEqual({ out: { data: [1] } });
    await s.run({});
    expect(made).toEqual(["dml", "cpu"]);
  });
});

describe("script fallback fonts (C3)", () => {
  it("switches to the script font only where the font in effect has no glyph", async () => {
    const { applyFontFallback, scriptFontsFor } = await import("../src/tools/fonts/scripts.js");
    const latinOnly = { covers: (f: string, cp: number) => (f === "Arimo" ? cp < 0x2000 : undefined) };
    expect(applyFontFallback("Hi 日本 ok", "Arimo", latinOnly)).toBe("Hi {\\fnNoto Sans SC}日本 {\\fnArimo}ok");
    // Kana makes the Chinese characters Japanese; spaces and \N stay in the font around them.
    expect(applyFontFallback("日本語です\\Nyes", "Arimo", latinOnly)).toBe("{\\fnNoto Sans JP}日本語です\\N{\\fnArimo}yes");
    // An \fn tag in the text sets the font in effect.
    expect(applyFontFallback("{\\fnInter\\b1}a 🎉", "Arimo", latinOnly)).toBe("{\\fnInter\\b1}a {\\fnNoto Emoji}🎉");
    // A font that covers the script keeps it.
    expect(applyFontFallback("日本", "MS Gothic", { covers: () => true })).toBe("日本");
    expect(scriptFontsFor(["Hello", "مرحبا", "שלום 👋"]).map((s) => s.family).sort()).toEqual(["Noto Emoji", "Noto Sans Arabic", "Noto Sans Hebrew"]);
  });

  it("reads which characters a font has", async () => {
    const { readFontCoverage } = await import("../src/tools/fonts/index.js");
    const arimo = await readFontCoverage(path.join(bundledFontsDir(), "Arimo-400.ttf"));
    expect(arimo.has("A".codePointAt(0)!)).toBe(true);
    expect(arimo.has("Ж".codePointAt(0)!)).toBe(true);
    expect(arimo.has("日".codePointAt(0)!)).toBe(false);
  });
});

describe("measuring providers on this computer (E2)", () => {
  const fakeOrt = (ms: Record<string, number>, made: string[] = []) => ({
    Tensor: class {},
    InferenceSession: {
      create: async (_: string, opts?: { executionProviders?: string[] }) => {
        const on = opts?.executionProviders?.[0] ?? "cpu";
        made.push(on);
        return {
          run: async () => {
            const until = performance.now() + ms[on]!;
            while (performance.now() < until);
            return { out: { data: [on === "cpu" ? 1 : 2] } };
          },
        };
      },
    },
  });

  it.each([
    ["the graphics card when it is faster", { cpu: 8, gpu: 1 }, "gpu"],
    ["the CPU when it is faster", { cpu: 1, gpu: 8 }, "cpu"],
  ])("keeps %s and remembers it", async (_, speed, winner) => {
    const { createOrtSession, gpuProvider, providerChoiceFile } = await import("../src/tools/vision/faces.js");
    const gpu = gpuProvider()!;
    const file = path.join(await tempDir(), "m.onnx");
    const ort = fakeOrt({ cpu: speed.cpu, [gpu]: speed.gpu });
    const s = await createOrtSession(ort as never, file, "auto");
    // While measuring, answers come from the CPU.
    for (let i = 0; i < 4; i++) expect(await s.run({})).toEqual({ out: { data: [1] } });
    const expected = winner === "gpu" ? gpu : "cpu";
    expect(await s.run({})).toEqual({ out: { data: [expected === "cpu" ? 1 : 2] } });
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(providerChoiceFile(file), "utf8"))).toMatchObject({ provider: expected });
    // The next session uses the remembered choice without measuring.
    const made: string[] = [];
    await createOrtSession(fakeOrt({ cpu: 0, [gpu]: 0 }, made) as never, file, "auto");
    expect(made).toEqual([expected]);
  });
});
