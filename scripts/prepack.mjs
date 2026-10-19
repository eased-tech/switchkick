// Runs before `pnpm pack` and `pnpm publish` in each package: copies the repository's LICENSE
// and NOTICE into the package, and with `--readme` the README too. The README's relative links
// point at files in the repository, so they are made absolute for the npm page.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const blob = "https://github.com/eased-tech/switchkick/blob/main/";

for (const name of ["LICENSE", "NOTICE"]) copyFileSync(join(root, name), name);

if (process.argv.includes("--readme")) {
  const readme = readFileSync(join(root, "README.md"), "utf8").replace(
    /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
    (_, path) => `](${blob}${path})`,
  );
  writeFileSync("README.md", readme);
}
