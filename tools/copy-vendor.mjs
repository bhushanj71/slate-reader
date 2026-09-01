// Slate runs entirely in the browser, so it can be hosted as a plain static
// site. The one thing standing in the way is pdf.js: the server maps /vendor/*
// straight into node_modules, and a static host has no node_modules. This copies
// the three things pdf.js fetches at runtime into public/vendor instead.
//
//   npm run build:static   ->   publish directory: public

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "node_modules", "pdfjs-dist");
const into = path.join(root, "public", "vendor");

const parts = [
  ["build", "pdfjs"],            // pdf.mjs and the worker
  ["cmaps", "cmaps"],            // character maps for CJK and other encodings
  ["standard_fonts", "standard_fonts"]
];

try {
  await stat(from);
} catch {
  console.error("pdfjs-dist is not installed. Run npm ci first.");
  process.exit(1);
}

await rm(into, { recursive: true, force: true });
await mkdir(into, { recursive: true });

for (const [source, target] of parts) {
  await cp(path.join(from, source), path.join(into, target), { recursive: true });
  console.log(`vendored ${source} -> public/vendor/${target}`);
}

console.log("Static build ready. Publish directory: public");
