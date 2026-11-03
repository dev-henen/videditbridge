/**
 * Build the Rust code for this machine: the kernels (native/ave-native), put where the loader looks
 * for the addon (engine/tools/native/index.ts), and the GPU render engine (native/ave-render), put
 * where engine/tools/render/engine.ts looks for it. Needs Rust (rustup); on Windows also the Visual Studio C++
 * build tools and the Windows SDK. Usage: npm run native [-- --debug]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { nativeTarget } from "../engine/tools/native/index.js";
import { engineFile } from "../engine/tools/render/engine.js";

const root = path.resolve(import.meta.dirname, "..");
const workspace = path.join(root, "native");
const release = !process.argv.includes("--debug");
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";

// Node addons on Windows are MSVC builds, whatever rustup's default host is.
const target = process.platform === "win32" ? `${arch}-pc-windows-msvc` : undefined;
const cargoArgs = ["build", "-p", "ave-native", "-p", "ave-render", ...(release ? ["--release"] : []), ...(target ? ["--target", target] : [])];

function run(command: string, args: string[], shell = false): void {
  const r = spawnSync(command, args, { cwd: workspace, stdio: "inherit", shell });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** vcvars64.bat of the newest Visual Studio with the C++ tools, so cargo finds MSVC's link.exe and the SDK. */
function vcvars(): string | undefined {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return undefined;
  const r = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const dir = r.stdout.trim().split(/\r?\n/)[0];
  const bat = dir && path.join(dir, "VC", "Auxiliary", "Build", process.arch === "arm64" ? "vcvarsarm64.bat" : "vcvars64.bat");
  return bat && existsSync(bat) ? bat : undefined;
}

if (target) run("rustup", ["target", "add", target]);
const bat = process.platform === "win32" && !process.env.VSCMD_VER ? vcvars() : undefined;
// Inside the Visual Studio environment MSVC's link.exe comes first on PATH (Git Bash ships a
// different "link" that would otherwise be found).
if (bat) run(`call "${bat}" >nul && cargo ${cargoArgs.join(" ")}`, [], true);
else run("cargo", cargoArgs);

const outDir = path.join(workspace, "target", ...(target ? [target] : []), release ? "release" : "debug");
const lib = process.platform === "win32" ? "ave_native.dll" : process.platform === "darwin" ? "libave_native.dylib" : "libave_native.so";
const dest = path.join(workspace, "ave-native", nativeTarget().file);
copyFileSync(path.join(outDir, lib), dest);
console.log(`Built ${path.relative(root, dest)}`);
const engine = path.join(workspace, "ave-render", engineFile());
copyFileSync(path.join(outDir, process.platform === "win32" ? "ave-render.exe" : "ave-render"), engine);
console.log(`Built ${path.relative(root, engine)}`);
