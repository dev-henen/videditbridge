import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** SHA-1 of a file's bytes, streamed. */
export function fileHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha1");
    createReadStream(file)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** The first candidate with the same bytes as `file` (sizes compared first; hashes only when they match). */
export async function findDuplicate(file: string, candidates: string[]): Promise<string | undefined> {
  const size = (await stat(file)).size;
  let hash: string | undefined;
  for (const c of candidates) {
    if (path.resolve(c) === path.resolve(file)) continue;
    const s = await stat(c).catch(() => undefined);
    if (!s?.isFile() || s.size !== size) continue;
    hash ??= await fileHash(file);
    if ((await fileHash(c)) === hash) return c;
  }
  return undefined;
}

/** Files directly inside a folder (none if it does not exist). */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
}
