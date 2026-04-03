/**
 * WildMind Dashboard — Express server for Replit
 * Replaces Netlify Functions with Express routes.
 * Set env vars: NEON_DATABASE_URL, WILDMIND_API_KEY (optional)
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Adapters: convert Express req → Netlify event shape ──────────────────────

function netlifyEvent(req) {
  return {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: req.query || {},
    body: null,
  };
}

function sendNetlifyResponse(res, result) {
  res.status(result.statusCode || 200);
  if (result.headers) {
    Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v));
  }
  if (result.isBase64Encoded) {
    res.send(Buffer.from(result.body, "base64"));
  } else {
    res.send(result.body || "");
  }
}

// ── Load function handlers ────────────────────────────────────────────────────

const stateHandler   = require("./netlify/functions/state").handler;
const audioHandler   = require("./netlify/functions/audio").handler;
const historyHandler = require("./netlify/functions/history").handler;
const apiHandler     = require("./netlify/functions/api").handler;

// ── CORS middleware ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// ── API routes ────────────────────────────────────────────────────────────────

app.get("/api/state", async (req, res) => {
  try {
    const result = await stateHandler(netlifyEvent(req));
    sendNetlifyResponse(res, result);
  } catch (e) {
    console.error("/api/state error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/audio", async (req, res) => {
  try {
    const result = await audioHandler(netlifyEvent(req));
    sendNetlifyResponse(res, result);
  } catch (e) {
    console.error("/api/audio error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const result = await historyHandler(netlifyEvent(req));
    sendNetlifyResponse(res, result);
  } catch (e) {
    console.error("/api/history error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/:endpoint", async (req, res) => {
  try {
    const event = netlifyEvent(req);
    // Merge path param into query so api.js endpoint routing works
    if (!event.queryStringParameters.endpoint) {
      event.queryStringParameters.endpoint = req.params.endpoint;
    }
    const result = await apiHandler(event);
    sendNetlifyResponse(res, result);
  } catch (e) {
    console.error("/api/* error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Static files ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname)));

// Fallback: serve index.html for any unmatched route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`WildMind Dashboard running on port ${PORT}`);
  console.log(`Open: http://localhost:${PORT}`);
});
