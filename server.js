import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(compression());

// Everything the browser needs, pdf.js included, lives under public/ — see
// tools/copy-vendor.mjs. This server therefore holds no secret knowledge that a
// plain static host would lack, which is what keeps the two deployments honest.
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
