// Fails when an optional dependency did not install. npm skips an optional package whose install
// fails (and everything that needs it) without an error, which would leave CI typechecking against
// nothing and an installer shipping without transcription, voices or models.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const { optionalDependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
const missing = Object.keys(optionalDependencies).filter((name) => !existsSync(path.join("node_modules", name, "package.json")));
if (missing.length) {
  console.error(`Optional dependencies that did not install: ${missing.join(", ")}. Run npm ci with --foreground-scripts to see why.`);
  process.exit(1);
}
console.log(`All ${Object.keys(optionalDependencies).length} optional dependencies installed.`);
