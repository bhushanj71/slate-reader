import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const pdfjs = path.join(__dirname, "node_modules", "pdfjs-dist");
const immutable = { maxAge: "365d", immutable: true };

app.disable("x-powered-by");
app.use(compression());

// pdf.js ships as ES modules plus font/cmap data the renderer fetches on demand.
app.use("/vendor/pdfjs", express.static(path.join(pdfjs, "build"), immutable));
app.use("/vendor/cmaps", express.static(path.join(pdfjs, "cmaps"), immutable));
app.use("/vendor/standard_fonts", express.static(path.join(pdfjs, "standard_fonts"), immutable));

// Long-lived caching is right in production and maddening while editing.
const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
app.use(express.static(path.join(__dirname, "public"), { maxAge: isProd ? "1h" : 0, etag: true }));

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

app.use((_req, res) => {
  res.status(200).sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Slate is reading on http://localhost:${PORT}`);
});
