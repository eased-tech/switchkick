// Compiles the built CLI (packages/proxy/dist/cli.js, from `pnpm build`) into standalone
// executables with `bun build --compile`, one per target, in dist-bin/.
//
//   node scripts/release/build-binaries.mjs                # every target
//   node scripts/release/build-binaries.mjs darwin-arm64   # just these
//   node scripts/release/build-binaries.mjs --host         # the machine running it
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Release name → Bun target. x64 uses Bun's baseline builds, which don't need AVX2. */
export const TARGETS = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64-baseline",
};

const root = join(import.meta.dirname, "..", "..");
const entry = join(root, "packages", "proxy", "dist", "cli.js");
const out = join(root, "dist-bin");

const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
let names = process.argv.slice(2).map((arg) => (arg === "--host" ? host : arg));
if (names.length === 0) names = Object.keys(TARGETS);
for (const name of names) {
  if (!(name in TARGETS)) {
    console.error(`unknown target "${name}"; expected one of ${Object.keys(TARGETS).join(", ")}`);
    process.exit(2);
  }
}
if (!existsSync(entry)) {
  console.error(`${entry} doesn't exist; run \`pnpm build\` first`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
for (const name of names) {
  const file = join(out, `switchkick-${name}${name.startsWith("windows") ? ".exe" : ""}`);
  execFileSync(
    "bun",
    ["build", entry, "--compile", "--minify", `--target=${TARGETS[name]}`, `--outfile=${file}`],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  console.log(file);
}
