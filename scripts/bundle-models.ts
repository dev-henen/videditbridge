/**
 * Fills a folder with every model the app uses, for an installer: the folder goes into the installed
 * app as `engine/models` (see ui/Packaging/README.md), where the engine reads them in place.
 *
 *   npx tsx scripts/bundle-models.ts [out]      (default: dist/models)
 *
 * Models already in `out` are kept, so a second run only fetches what is missing.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { downloadBundledModels } from "../engine/tools/bundled-models.js";

const out = path.resolve(process.argv[2] ?? "dist/models");

function size(p: string): number {
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : s.size;
}

console.log(`Models into ${out}`);
await downloadBundledModels(out, (line) => console.log(`  ${line}`));
console.log(`Done: ${(size(out) / 1e9).toFixed(2)} GB`);
