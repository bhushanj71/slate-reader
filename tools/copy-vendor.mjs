// Slate runs entirely in the browser, so it should be hostable by dropping the
// public folder on any static host. pdf.js is the one piece that does not live
// there by default, so it is vendored into public/vendor and committed.
//
// Run this after changing the pdfjs-dist version; it is not part of deploying.
//
//   npm run vendor
//
// Only what the reader actually fetches is copied: the minified library and
// worker (the unminified copies and their source maps are ~10MB of nothing),
// the cmaps that decode CJK and other encodings, and the standard fonts that
// stand in for Helvetica, Times and Courier when a PDF does not embed them.

import { cp, mkdir, rm, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "node_modules", "pdfjs-dist");
const into = path.join(root, "public", "vendor");

const files = [
  ["build/pdf.min.mjs", "pdfjs/pdf.min.mjs"],
  ["build/pdf.worker.min.mjs", "pdfjs/pdf.worker.min.mjs"]
];
const folders = [
  ["cmaps", "cmaps"],
  ["standard_fonts", "standard_fonts"]
];

try {
  await stat(from);
} catch {
  console.error("pdfjs-dist is not installed. Run npm ci first.");
  process.exit(1);
}

await rm(into, { recursive: true, force: true });
await mkdir(path.join(into, "pdfjs"), { recursive: true });

for (const [source, target] of files) {
  await cp(path.join(from, source), path.join(into, target));
  console.log(`vendored ${source}`);
}

for (const [source, target] of folders) {
  await cp(path.join(from, source), path.join(into, target), { recursive: true });
  console.log(`vendored ${source}/ (${(await readdir(path.join(from, source))).length} files)`);
}

const { version } = JSON.parse(
  await (await import("node:fs/promises")).readFile(path.join(from, "package.json"), "utf8")
);
console.log(`public/vendor now holds pdf.js ${version}`);
