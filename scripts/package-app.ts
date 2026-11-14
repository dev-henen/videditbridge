/**
 * Builds the installer for the system it runs on (see ui/Packaging/README.md):
 *
 *   npx tsx scripts/package-app.ts [--models <folder>]
 *
 * - Windows: VideditBridge-<version>-windows-x64-setup.exe (Inno Setup, installs for the user, no admin)
 * - macOS:   VideditBridge-<version>-macos-<arch>.dmg (the app bundle, signed ad hoc)
 * - Linux:   VideditBridge-<version>-linux-x86_64.AppImage
 *
 * It needs `npm ci` and `npm run native` done first. The engine is staged as the repository lays it
 * out (dist, native, assets/fonts, node_modules, package.json) with a Node runtime and every model, so
 * the code finds its parts the same way it does in a checkout. `--models` copies the models from a
 * folder (a CI cache) instead of downloading them. Output goes to release/.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { downloadBundledModels } from "../engine/tools/bundled-models.js";
import { nativeTarget } from "../engine/tools/native/index.js";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "release");
const stage = path.join(out, "stage");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const version = pkg.version;
const platform = process.platform;
const arch = process.arch;
const win = platform === "win32";
const modelsArg = process.argv.indexOf("--models");
const modelsFrom = modelsArg > 0 ? path.resolve(process.argv[modelsArg + 1]!) : undefined;

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  console.log(`> ${cmd} ${args.join(" ")}`);
  // npm and npx are .cmd scripts on Windows, which need a shell.
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, stdio: "inherit", shell: win && /^(npm|npx)$/.test(cmd), env: { ...process.env, ...opts.env } });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status ?? r.signal})`);
}

const size = (p: string): number => {
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : s.size;
};
const gb = (p: string) => `${(size(p) / 1e9).toFixed(2)} GB`;

// ------------------------------------------------------------------ the engine

function stageEngine(engine: string): void {
  console.log(`\nEngine into ${engine}`);
  run("npm", ["run", "build"]);
  mkdirSync(engine, { recursive: true });
  cpSync(path.join(root, "dist"), path.join(engine, "dist"), { recursive: true });
  for (const f of ["package.json", "package-lock.json", "LICENSE"]) cpSync(path.join(root, f), path.join(engine, f));
  cpSync(path.join(root, "assets", "fonts"), path.join(engine, "assets", "fonts"), { recursive: true });

  // The native kernels and the GPU render engine, built for this machine by `npm run native`.
  const { file } = nativeTarget();
  const renderFile = file.replace(/^ave-native\.(.*)\.node$/, "ave-render.$1") + (win ? ".exe" : "");
  for (const [dir, f] of [["ave-native", file], ["ave-render", renderFile]] as const) {
    const from = path.join(root, "native", dir, f);
    if (!existsSync(from)) throw new Error(`${from} is missing: run npm run native first`);
    mkdirSync(path.join(engine, "native", dir), { recursive: true });
    cpSync(from, path.join(engine, "native", dir, f));
  }

  // Runtime packages only (FFmpeg comes with ffmpeg-static, ONNX Runtime with onnxruntime-node).
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: engine });
  pruneOtherSystems(path.join(engine, "node_modules"));

  // The Node runtime the engine runs on (EngineClient.BundledHost starts engine/node with dist/host/main.js).
  const node = path.join(engine, win ? "node.exe" : "node");
  cpSync(process.execPath, node);
  if (!win) chmodSync(node, 0o755);

  // Every model, read in place from engine/models (bundledModelsDir: a models folder next to node).
  // A cached copy goes in first; stageModels fetches anything it lacks.
  if (modelsFrom && existsSync(modelsFrom)) cpSync(modelsFrom, path.join(engine, "models"), { recursive: true });
}

async function stageModels(engine: string): Promise<void> {
  const models = path.join(engine, "models");
  // Fills in what a cache did not have, and checks that every model loads from the folder alone.
  await downloadBundledModels(models, (line) => console.log(`  ${line}`));
  rmSync(path.join(models, ".no-cache"), { recursive: true, force: true });
  console.log(`Models: ${gb(models)}`);
}

/** ONNX Runtime ships its libraries for every system; keep this one's. */
function pruneOtherSystems(modules: string): void {
  const bin = path.join(modules, "onnxruntime-node", "bin", "napi-v3");
  if (!existsSync(bin)) return;
  for (const p of readdirSync(bin)) {
    if (p !== platform) rmSync(path.join(bin, p), { recursive: true, force: true });
    else for (const a of readdirSync(path.join(bin, p))) if (a !== arch) rmSync(path.join(bin, p, a), { recursive: true, force: true });
  }
}

/** The staged engine runs on its own Node: FFmpeg and the native kernels answer. */
function smokeTest(engine: string): void {
  console.log("\nChecking the staged engine");
  const node = path.join(engine, win ? "node.exe" : "node");
  run(node, [path.join(engine, "dist", "cli.js"), "check"], { cwd: engine, env: { AVE_BUNDLED_MODELS_DIR: path.join(engine, "models") } });
  // The native kernels load, and the render engine is found where the engine looks for it.
  const probe = `const n = await import("./dist/tools/native/index.js"); n.native();
const e = await import("./dist/tools/render/engine.js"); const p = e.enginePath();
const path = await import("node:path");
if (!p || path.relative(process.cwd(), p).startsWith("..")) throw new Error("render engine not found in the package: " + p);
console.log("Native kernels loaded; render engine at " + p);`;
  run(node, ["--input-type=module", "-e", probe], { cwd: engine });
}

// ------------------------------------------------------------------ the app

function publishApp(rid: string, into: string): void {
  console.log(`\nApp (${rid}) into ${into}`);
  run("dotnet", ["publish", path.join(root, "ui", "VideditBridge.csproj"), "-c", "Release", "-r", rid, "--self-contained", "true", "-p:PublishSingleFile=false", `-p:Version=${version}`, "-o", into]);
}

// ------------------------------------------------------------------ installers

function windows(): string {
  const appDir = path.join(stage, "VideditBridge");
  publishApp(`win-${arch}`, appDir);
  stageEngine(path.join(appDir, "engine"));
  return appDir;
}

function innoSetup(appDir: string): string {
  const name = `VideditBridge-${version}-windows-${arch}-setup`;
  const iss = path.join(stage, "setup.iss");
  // Installs for the current user (no admin prompt); the engine and models go with the app.
  writeFileSync(
    iss,
    `[Setup]
AppId={{6F1D2B9E-3C4A-4E8B-9A1D-7B5C2E8F0A31}
AppName=VideditBridge
AppVersion=${version}
AppPublisher=Moses Henen
AppPublisherURL=https://github.com/dev-henen/videditbridge
AppSupportURL=https://github.com/dev-henen/videditbridge/issues
AppCopyright=Copyright (c) 2026 Moses Henen
DefaultDirName={localappdata}\\Programs\\VideditBridge
DefaultGroupName=VideditBridge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
LicenseFile=${path.join(root, "LICENSE")}
OutputDir=${out}
OutputBaseFilename=${name}
SetupIconFile=${path.join(root, "ui", "Assets", "AppIcon.ico")}
UninstallDisplayIcon={app}\\VideditBridge.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "${appDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\\VideditBridge"; Filename: "{app}\\VideditBridge.exe"
Name: "{autodesktop}\\VideditBridge"; Filename: "{app}\\VideditBridge.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\\VideditBridge.exe"; Description: "Open VideditBridge"; Flags: nowait postinstall skipifsilent
`,
  );
  const iscc = [process.env.ISCC, "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe"].find((p) => p && existsSync(p));
  if (!iscc) throw new Error("Inno Setup 6 is not installed (ISCC.exe); install it, or set ISCC");
  run(iscc, ["/Q", iss]);
  return path.join(out, `${name}.exe`);
}

function mac(): string {
  const app = path.join(stage, "VideditBridge.app");
  const contents = path.join(app, "Contents");
  publishApp(`osx-${arch}`, path.join(contents, "MacOS"));
  stageEngine(path.join(contents, "Resources", "engine"));
  // Info.plist with this version, and the icon from Packaging/icons.
  const plist = readFileSync(path.join(root, "ui", "Packaging", "macOS", "Info.plist"), "utf8").replaceAll("<string>0.1.0</string>", `<string>${version}</string>`);
  writeFileSync(path.join(contents, "Info.plist"), plist);
  const iconset = path.join(stage, "AppIcon.iconset");
  mkdirSync(iconset, { recursive: true });
  const icons = path.join(root, "ui", "Packaging", "icons");
  for (const s of [16, 32, 128, 256, 512]) {
    cpSync(path.join(icons, `AppIcon-${s}.png`), path.join(iconset, `icon_${s}x${s}.png`));
    cpSync(path.join(icons, `AppIcon-${s * 2}.png`), path.join(iconset, `icon_${s}x${s}@2x.png`));
  }
  run("iconutil", ["-c", "icns", iconset, "-o", path.join(contents, "Resources", "AppIcon.icns")]);
  return app;
}

function dmg(app: string): string {
  // Signed ad hoc: Apple Silicon runs only signed code. Without a Developer ID, the first open needs
  // right-click, Open (or Privacy and Security, Open Anyway).
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
  const folder = path.join(stage, "dmg");
  mkdirSync(folder, { recursive: true });
  cpSync(app, path.join(folder, "VideditBridge.app"), { recursive: true, verbatimSymlinks: true });
  symlinkSync("/Applications", path.join(folder, "Applications"));
  const file = path.join(out, `VideditBridge-${version}-macos-${arch}.dmg`);
  run("hdiutil", ["create", "-volname", "VideditBridge", "-srcfolder", folder, "-ov", "-format", "UDZO", file]);
  return file;
}

function linux(): string {
  const appDir = path.join(stage, "VideditBridge.AppDir");
  const bin = path.join(appDir, "usr", "bin");
  publishApp(`linux-${arch}`, bin);
  stageEngine(path.join(bin, "engine"));
  const id = "io.github.dev_henen.videditbridge";
  const packaging = path.join(root, "ui", "Packaging");
  cpSync(path.join(packaging, "linux", `${id}.desktop`), path.join(appDir, `${id}.desktop`));
  cpSync(path.join(packaging, "icons", "AppIcon-256.png"), path.join(appDir, `${id}.png`));
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const dir = path.join(appDir, "usr", "share", "icons", "hicolor", `${s}x${s}`, "apps");
    mkdirSync(dir, { recursive: true });
    cpSync(path.join(packaging, "icons", `AppIcon-${s}.png`), path.join(dir, `${id}.png`));
  }
  mkdirSync(path.join(appDir, "usr", "share", "metainfo"), { recursive: true });
  cpSync(path.join(packaging, "linux", `${id}.metainfo.xml`), path.join(appDir, "usr", "share", "metainfo", `${id}.appdata.xml`));
  const appRun = path.join(appDir, "AppRun");
  writeFileSync(appRun, `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/VideditBridge" "$@"\n`);
  chmodSync(appRun, 0o755);
  return appDir;
}

function appImage(appDir: string): string {
  const tool = path.join(stage, "appimagetool");
  if (!existsSync(tool)) {
    run("curl", ["-fsSL", "-o", tool, "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"]);
    chmodSync(tool, 0o755);
  }
  const file = path.join(out, `VideditBridge-${version}-linux-x86_64.AppImage`);
  // Runs without FUSE (CI runners have none).
  run(tool, [appDir, file], { env: { ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" } });
  return file;
}

// ------------------------------------------------------------------ main

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
let installer: string;
if (win) {
  const appDir = windows();
  const engine = path.join(appDir, "engine");
  await stageModels(engine);
  smokeTest(engine);
  installer = innoSetup(appDir);
} else if (platform === "darwin") {
  const app = mac();
  const engine = path.join(app, "Contents", "Resources", "engine");
  await stageModels(engine);
  smokeTest(engine);
  installer = dmg(app);
} else {
  const appDir = linux();
  const engine = path.join(appDir, "usr", "bin", "engine");
  await stageModels(engine);
  smokeTest(engine);
  installer = appImage(appDir);
}
console.log(`\nInstaller: ${installer} (${gb(installer)})`);
