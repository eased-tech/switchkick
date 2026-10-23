// Checks that a release tag matches the version of every published package, and writes that
// version's section of the changelog, which becomes the GitHub Release notes.
//
//   node scripts/release/check-tag.mjs v0.2.0 release-notes.md
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, notesFile] = process.argv.slice(2);
const root = join(import.meta.dirname, "..", "..");
const fail = (message) => {
  console.error(`check-tag: ${message}`);
  process.exit(1);
};

const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "")?.[1];
if (!version) fail(`"${tag}" isn't a release tag like v1.2.3`);

for (const dir of ["core", "jev", "proxy"]) {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  if (pkg.version !== version) fail(`${pkg.name} is at ${pkg.version}, but the tag is ${tag}`);
}

const changelogPath = join(root, "packages", "proxy", "CHANGELOG.md");
if (!existsSync(changelogPath))
  fail("packages/proxy/CHANGELOG.md doesn't exist; run `pnpm version-packages`");
const lines = readFileSync(changelogPath, "utf8").split("\n");
const start = lines.indexOf(`## ${version}`);
if (start === -1) fail(`packages/proxy/CHANGELOG.md has no "## ${version}" section`);
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end === -1) end = lines.length;
const notes = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (notesFile) writeFileSync(notesFile, `${notes}\n`);
console.log(`${tag} matches every package; ${notes.split("\n").length} lines of release notes`);
