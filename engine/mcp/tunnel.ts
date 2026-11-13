import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appDir } from "../tools/appdirs.js";

/**
 * A public https address for the MCP connector, for apps that reach servers only over the internet
 * (the Gemini app, ChatGPT). It runs Cloudflare's free quick tunnel (cloudflared, no account): the
 * program is downloaded once into the app's data folder, then started with the local port, and it
 * prints an address on trycloudflare.com that forwards to this computer. The address changes every
 * time the tunnel starts.
 */

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

/** The release file for this system, and whether it is a .tgz to unpack (macOS). */
function releaseFile(): { name: string; tgz: boolean } {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch === "arm" ? "arm" : process.arch === "ia32" ? "386" : undefined;
  if (!arch) throw new Error(`No tunnel program for this processor (${process.arch}).`);
  if (process.platform === "win32") return { name: `cloudflared-windows-${arch === "arm64" ? "amd64" : arch}.exe`, tgz: false };
  if (process.platform === "darwin") return { name: `cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`, tgz: true };
  if (process.platform === "linux") return { name: `cloudflared-linux-${arch}`, tgz: false };
  throw new Error(`No tunnel program for this system (${process.platform}).`);
}

/** $AVE_CLOUDFLARED (an installed cloudflared), else the copy in the app's data folder. */
export const cloudflaredPath = () => process.env.AVE_CLOUDFLARED || path.join(appDir("data"), "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

/** How the setup goes: a short line for people, and the share done (0..1) when known. */
export type TunnelStatus = (text: string, progress?: number) => void;

/** No bytes for this long means the download is stuck. */
const STALL_MS = 30_000;

/** Download to a file as it arrives, with progress, giving up when it stalls. */
async function download(url: string, to: string, onStatus?: TunnelStatus): Promise<void> {
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), STALL_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Could not download the tunnel program (${res.status} ${res.statusText}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    const out = createWriteStream(to);
    let done = 0;
    let shown = -1;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_MS);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        done += chunk.length;
        const pct = total ? Math.floor((100 * done) / total) : -1;
        if (pct !== shown) {
          shown = pct;
          onStatus?.("Setting up", total ? done / total : undefined);
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
    if (total && done < total) throw new Error("The download of the tunnel program was cut short. Try again.");
  } catch (e) {
    await rm(to, { force: true });
    if (controller.signal.aborted) throw new Error("The download of the tunnel program stopped. Check the internet connection, then try again.");
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

/** The tunnel program, downloaded on first use. */
export async function ensureCloudflared(onStatus?: TunnelStatus): Promise<string> {
  const file = cloudflaredPath();
  if (existsSync(file)) return file;
  const { name, tgz } = releaseFile();
  onStatus?.("Setting up", 0);
  await mkdir(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  if (tgz) {
    const archive = `${part}.tgz`;
    await download(`${RELEASES}/${name}`, archive, onStatus);
    const dir = `${part}.d`;
    await mkdir(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-xzf", archive, "-C", dir], { stdio: "ignore" });
      tar.once("error", reject);
      tar.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack the tunnel program (tar exited ${code}).`))));
    });
    await rename(path.join(dir, "cloudflared"), part);
    await rm(archive, { force: true });
    await rm(dir, { recursive: true, force: true });
  } else await download(`${RELEASES}/${name}`, part, onStatus);
  if (process.platform !== "win32") await chmod(part, 0o755);
  await rename(part, file);
  return file;
}

export interface Tunnel {
  /** The public https address, e.g. https://name.trycloudflare.com. */
  url: string;
  close(): void;
  /** Called once if the tunnel stops by itself. */
  onExit?: (message: string) => void;
}

/**
 * A config file of the app's own, with no rules. Without it the program reads ~/.cloudflared/config.yml,
 * and a person's own tunnel rules there answer every request to the quick tunnel with 404.
 */
async function emptyConfig(): Promise<string> {
  const file = path.join(path.dirname(cloudflaredPath()), "quick-tunnel.yml");
  if (!existsSync(file)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# VideditBridge: no rules, so the quick tunnel serves the editor's --url.\n", "utf8");
  }
  return file;
}

/** Start a quick tunnel to a local port; resolves with its address once Cloudflare gives one and the tunnel is connected. */
export async function startTunnel(port: number, opts: { onStatus?: TunnelStatus; timeoutMs?: number } = {}): Promise<Tunnel> {
  const program = await ensureCloudflared(opts.onStatus);
  opts.onStatus?.("Starting");
  const args = ["tunnel", "--config", await emptyConfig(), "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
  const child: ChildProcess = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let closing = false;
  const tunnel = await new Promise<Tunnel>((resolve, reject) => {
    let log = "";
    let url: string | undefined;
    let registered = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Cloudflare did not give a public address in time. Check the internet connection, then try again."));
    }, opts.timeoutMs ?? 60_000);
    const read = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8000);
      url ??= log.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      registered ||= /Registered tunnel connection/i.test(log);
      // The address comes first; requests reach this computer only once a connection is registered.
      if (!url || !registered) return;
      clearTimeout(timer);
      resolve({
        url,
        close: () => {
          closing = true;
          child.kill();
        },
      });
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the tunnel program: ${e.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The tunnel program stopped (exit ${code}). ${log.split("\n").filter((l) => /ERR|error/i.test(l)).slice(-1)[0] ?? ""}`.trim()));
    });
  });
  // Stopping by itself after it started (the network went away, say): tell the host.
  child.removeAllListeners("exit");
  child.once("exit", (code) => {
    if (!closing) tunnel.onExit?.(`The public address stopped (exit ${code}). Connect again to make a new one.`);
  });
  return tunnel;
}
