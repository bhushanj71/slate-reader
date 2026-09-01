import express from "express";
import compression from "compression";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(compression());

/* ── Reading voices ───────────────────────────────────────────────────
   The browser's own voices cost nothing and need no server. ElevenLabs
   sounds better and costs money per character, which makes the key worth
   protecting: it stays in this process and is never sent to the page. The
   browser asks this server to speak a sentence; the key never leaves it. */

const KEY = process.env.ELEVENLABS_API_KEY || "";
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

// This endpoint spends real money and sits on a public URL, so it is bounded
// in three directions: per request, per caller, and per day for everyone.
const MAX_CHARS_PER_REQUEST = 1200;
const CHARS_PER_CALLER_HOURLY = Number(process.env.ELEVENLABS_CALLER_LIMIT || 30000);
const CHARS_PER_DAY = Number(process.env.ELEVENLABS_DAILY_LIMIT || 150000);

const HOUR = 3600e3;
const DAY = 86400e3;

const callers = new Map();          // ip -> { chars, until }
const daily = { chars: 0, until: Date.now() + DAY };
const audio = new Map();            // hash -> { body, bytes } , a small FIFO cache
let audioBytes = 0;
const AUDIO_CACHE_BYTES = 64 * 1024 * 1024;

let voiceCache = { at: 0, list: [] };

async function voiceList() {
  if (Date.now() - voiceCache.at < HOUR && voiceCache.list.length) return voiceCache.list;

  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": KEY } });
  if (!res.ok) throw new Error(`voice list failed: ${res.status}`);

  const { voices } = await res.json();
  voiceCache = {
    at: Date.now(),
    list: voices.map(v => ({
      id: v.voice_id,
      name: v.name,
      description: v.description || "",
      labels: v.labels || {},
      // ElevenLabs hosts a sample for each voice. It costs nothing to play, so
      // a reader can hear a voice before spending anything on it.
      preview: v.preview_url || null
    }))
  };
  return voiceCache.list;
}

function spend(ip, chars) {
  const now = Date.now();

  if (now > daily.until) { daily.chars = 0; daily.until = now + DAY; }
  if (daily.chars + chars > CHARS_PER_DAY) return "the daily reading budget is spent";

  const caller = callers.get(ip);
  if (!caller || now > caller.until) callers.set(ip, { chars, until: now + HOUR });
  else if (caller.chars + chars > CHARS_PER_CALLER_HOURLY) return "you have read a lot this hour";
  else caller.chars += chars;

  daily.chars += chars;
  return null;
}

function remember(hash, body) {
  audio.set(hash, body);
  audioBytes += body.length;
  // Re-reading a page should not be charged for twice; anything is better than
  // nothing here, so evict oldest-first and keep it simple.
  while (audioBytes > AUDIO_CACHE_BYTES && audio.size) {
    const [oldest, value] = audio.entries().next().value;
    audio.delete(oldest);
    audioBytes -= value.length;
  }
}

app.get("/api/voice", async (_req, res) => {
  if (!KEY) return res.json({ available: false });
  try {
    res.json({ available: true, model: MODEL, voices: await voiceList() });
  } catch (err) {
    console.error("[voice]", err.message);
    res.json({ available: false });
  }
});

app.post("/api/voice/speak", express.json({ limit: "16kb" }), async (req, res) => {
  if (!KEY) return res.status(503).json({ error: "No reading voice is configured." });

  const text = String(req.body?.text || "").trim();
  const voiceId = String(req.body?.voiceId || "");

  if (!text) return res.status(400).json({ error: "Nothing to say." });
  if (text.length > MAX_CHARS_PER_REQUEST) {
    return res.status(413).json({ error: "That passage is too long to speak in one go." });
  }

  // Only voices this account actually has: the endpoint is a door to a paid API
  // and must not forward whatever it is handed.
  let voices;
  try {
    voices = await voiceList();
  } catch {
    return res.status(502).json({ error: "The voice service is unreachable." });
  }
  const voice = voices.find(v => v.id === voiceId) || voices[0];
  if (!voice) return res.status(502).json({ error: "No voices are available." });

  const hash = crypto.createHash("sha256").update(`${MODEL}:${voice.id}:${text}`).digest("hex");
  const cached = audio.get(hash);
  if (cached) {
    res.set("content-type", "audio/mpeg").set("x-slate-cache", "hit");
    return res.send(cached);
  }

  const refused = spend(req.ip || "anon", text.length);
  if (refused) return res.status(429).json({ error: `Reading aloud is paused: ${refused}.` });

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice.id}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }
        })
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("[voice]", upstream.status, detail.slice(0, 200));
      return res.status(502).json({ error: "The voice service refused that passage." });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    remember(hash, body);
    res.set("content-type", "audio/mpeg").set("x-slate-cache", "miss").send(body);
  } catch (err) {
    console.error("[voice]", err.message);
    res.status(502).json({ error: "The voice service is unreachable." });
  }
});

/* ── The reader itself ────────────────────────────────────────────── */

// Long-lived caching is right in production and maddening while editing.
const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

// Everything the browser needs, pdf.js included, lives under public/ — see
// tools/copy-vendor.mjs. This server therefore holds no secret knowledge that a
// plain static host would lack, which is what keeps the two deployments honest.
app.use(express.static(path.join(__dirname, "public"), { maxAge: isProd ? "1h" : 0, etag: true }));

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

app.use((_req, res) => {
  res.status(200).sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Slate is reading on http://localhost:${PORT}`);
  console.log(KEY ? `ElevenLabs voice ready (${MODEL})` : "Device voices only (no ELEVENLABS_API_KEY set)");
});
