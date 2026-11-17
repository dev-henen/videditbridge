// Sets the app's version everywhere it is written: package.json and package-lock.json, the engine
// (engine/version.ts), the desktop app (ui/VideditBridge.csproj) and the Linux metadata (a new
// release entry with today's date). test/repo/version.test.ts checks they agree.
//
//   npm run bump 0.1.3
//
// Then commit ("chore: release 0.1.3"), push, tag v0.1.3 and push the tag: the Release workflow
// builds the installers into a draft release. See "Releasing" in CLAUDE.md.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const next = process.argv[2]?.replace(/^v/, "");
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error("Give the new version as x.y.z, e.g. npm run bump 0.1.3");
  process.exit(1);
}
const current = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return false;
};
if (!newer(next, current)) {
  console.error(`${next} is not newer than the current version ${current}.`);
  process.exit(1);
}

/** Replace exactly one match in a file, or stop: a silent miss is how versions drift apart. */
function replaceIn(file: string, pattern: RegExp, replacement: string): void {
  const text = readFileSync(file, "utf8");
  if ((text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) ?? []).length !== 1) {
    console.error(`Expected one match of ${pattern} in ${file}.`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(pattern, replacement));
}

// package.json and package-lock.json, without a commit or tag.
// `next` is checked against x.y.z above, so it is safe in a command line.
execSync(`npm version ${next} --no-git-tag-version`, { stdio: "inherit" });
replaceIn("engine/version.ts", /export const VERSION = "[^"]+";/, `export const VERSION = "${next}";`);
replaceIn("ui/VideditBridge.csproj", /<Version>[^<]+<\/Version>/, `<Version>${next}</Version>`);
// Today on this computer, not in UTC.
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
replaceIn("ui/Packaging/linux/io.github.dev_henen.videditbridge.metainfo.xml", /(\n(\s*)<releases>\n)/, `$1$2  <release version="${next}" date="${today}"/>\n`);

console.log(`Version ${current} -> ${next}. Next: commit "chore: release ${next}", push, then git tag v${next} && git push origin v${next}.`);
