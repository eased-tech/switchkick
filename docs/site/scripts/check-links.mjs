// Checks the built site: every link to a page under /switchkick/ points at a page that was
// built, every #fragment at an id on that page, and the schema is the repository's, byte for
// byte. Run after `pnpm docs:build`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const base = "/switchkick/";
const site = join(import.meta.dirname, "..");
const dist = join(site, "dist");
const pages = new Map();

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".html")) {
      const route = `${base}${relative(dist, path)}`.replace(/(^|\/)index\.html$/, "$1");
      const html = readFileSync(path, "utf8");
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      pages.set(route, { html, ids });
    }
  }
};
walk(dist);

const problems = [];
for (const [route, { html }] of pages) {
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (!href.startsWith(base) || href.startsWith(`${base}_astro/`)) continue;
    const [path, fragment] = href.split("#");
    if (/\.(xml|json|svg|png|ico|css|js)$/.test(path)) continue;
    const target = pages.get(path);
    if (!target) problems.push(`${route}: no page at ${href}`);
    else if (fragment && !target.ids.has(decodeURIComponent(fragment))) {
      problems.push(`${route}: no #${fragment} on ${path}`);
    }
  }
}

const schema = readFileSync(join(site, "..", "..", "schema", "v1.json"), "utf8");
if (readFileSync(join(dist, "schema", "v1.json"), "utf8") !== schema) {
  problems.push("dist/schema/v1.json differs from schema/v1.json");
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${pages.size} pages, links and schema OK`);
