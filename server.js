/**
 * A New World Dashboard — Express server for Replit
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

app.get("/api/guide", async (req, res) => {
  try {
    const { neon } = require("@neondatabase/serverless");
    const sql = neon(process.env.NEON_DATABASE_URL);

    const [guideRows, chaptersRows] = await Promise.all([
      sql`
        SELECT version, total_worlds, total_ticks, total_decisions,
               guide_text, executive_summary, key_principles, generated_at
        FROM civilization_guide
        ORDER BY version DESC LIMIT 1
      `,
      sql`
        SELECT world_id, chapter_number, survival_duration_ticks,
               peak_population, shared_words_at_end, stage_reached,
               key_findings, generated_at
        FROM guide_chapters
        ORDER BY chapter_number ASC
      `,
    ]);

    res.json({
      guide:    guideRows[0]    || null,
      chapters: chaptersRows    || [],
    });
  } catch (e) {
    res.json({ guide: null, chapters: [] });
  }
});

app.get("/api/benchmarks", async (req, res) => {
  try {
    const { neon } = require("@neondatabase/serverless");
    const sql = neon(process.env.NEON_DATABASE_URL);
    const rows = await sql`
      SELECT world_id, tick, score, stage, summary, results, timestamp
      FROM benchmark_results
      ORDER BY world_id ASC
    `;
    res.json({ benchmarks: rows });
  } catch (e) {
    // Table may not exist yet — return empty gracefully
    res.json({ benchmarks: [] });
  }
});

app.get("/api/decisions", async (req, res) => {
  try {
    const { neon } = require("@neondatabase/serverless");
    const sql = neon(process.env.NEON_DATABASE_URL);
    const [summaryRows, pressureRows] = await Promise.all([
      sql`
        SELECT decision_type, choice, COUNT(*) as total,
          SUM(CASE WHEN outcome = 'thrived' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) as thrive_rate,
          SUM(CASE WHEN outcome = 'survived' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) as survive_rate,
          SUM(CASE WHEN outcome = 'died' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) as death_rate,
          AVG(pressure) as avg_pressure
        FROM decision_log
        GROUP BY decision_type, choice
        ORDER BY total DESC
        LIMIT 100
      `,
      sql`
        SELECT decision_type,
          AVG(CASE WHEN outcome = 'thrived' THEN pressure END) as thrive_pressure,
          AVG(CASE WHEN outcome = 'survived' THEN pressure END) as survive_pressure,
          AVG(CASE WHEN outcome = 'died' THEN pressure END) as death_pressure,
          COUNT(*) as total
        FROM decision_log
        WHERE pressure IS NOT NULL
        GROUP BY decision_type
        ORDER BY total DESC
      `,
    ]);
    res.json({ summary: summaryRows, pressure_curves: pressureRows });
  } catch (e) {
    res.json({ summary: [], pressure_curves: [] });
  }
});

app.get("/api/training", async (req, res) => {
  try {
    const { neon } = require("@neondatabase/serverless");
    const sql = neon(process.env.NEON_DATABASE_URL);
    const [insightRows, runRows] = await Promise.all([
      sql`
        SELECT world_id, archetype, examples_added, avg_reward, improvement_pct, created_at
        FROM world_training_insights
        ORDER BY world_id DESC, archetype
        LIMIT 200
      `,
      sql`
        SELECT world_id, total_examples, archetypes_updated, training_duration_ms, created_at
        FROM additive_training_runs
        ORDER BY world_id DESC
        LIMIT 50
      `,
    ]);
    res.json({ insights: insightRows, runs: runRows });
  } catch (e) {
    // Tables may not exist yet — return empty gracefully
    res.json({ insights: [], runs: [] });
  }
});

app.get("/api/narratives", async (req, res) => {
  try {
    const { neon } = require("@neondatabase/serverless");
    const sql = neon(process.env.NEON_DATABASE_URL);
    const rows = await sql`
      SELECT world_id, tick, citizen_id, event_type, narrative_text, drama_score, created_at
      FROM narratives
      ORDER BY drama_score DESC, world_id DESC
      LIMIT 100
    `;
    res.json({ narratives: rows });
  } catch (e) {
    // Table may not exist yet — return empty gracefully
    res.json({ narratives: [] });
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
  console.log(`A New World Dashboard running on port ${PORT}`);
  console.log(`Open: http://localhost:${PORT}`);
});
