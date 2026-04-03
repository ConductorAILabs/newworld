const { Client } = require("pg");

let cachedClient = null;
let cachedAt = 0;
const MAX_CLIENT_AGE = 60000;

async function getClient() {
  const now = Date.now();
  if (cachedClient && now - cachedAt < MAX_CLIENT_AGE) {
    return cachedClient;
  }
  if (cachedClient) {
    try { await cachedClient.end(); } catch (_) {}
  }
  cachedClient = new Client({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
  });
  await cachedClient.connect();
  cachedAt = now;
  return cachedClient;
}

// Whitelisted tables for the history endpoint
const ALLOWED_HISTORY_TABLES = [
  "science_metrics",
  "state_snapshots",
  "utterance_log",
];

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function ok(body, cache = true) {
  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": cache ? "public, max-age=10" : "no-cache",
    },
    body: JSON.stringify(body),
  };
}

function err(statusCode, message) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

// Clamp an integer parameter to a safe range
function clampInt(value, defaultVal, min, max) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(max, n));
}

// --- Endpoint handlers ---

async function handleCitizens(client) {
  const citizensRes = await client.query(
    `SELECT id, name, role, age, sex, x, y, mood, energy, status,
            home_landmark, personality, knowledge, vocabulary,
            parent_ids, birth_tick, alive, active
     FROM citizens WHERE alive = true`
  );
  const tickRes = await client.query(
    "SELECT tick FROM live_state WHERE id = 1 LIMIT 1"
  );
  const tick = tickRes.rows.length > 0 ? tickRes.rows[0].tick : null;

  const citizens = citizensRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    age: r.age,
    sex: r.sex,
    x: r.x,
    y: r.y,
    mood: parseFloat(r.mood),
    energy: parseFloat(r.energy),
    status: r.status,
    home_landmark: r.home_landmark,
    personality: r.personality,
    knowledge: r.knowledge,
    vocabulary: r.vocabulary,
    parent_ids: typeof r.parent_ids === "string" ? JSON.parse(r.parent_ids) : (r.parent_ids || []),
    birth_tick: r.birth_tick,
    alive: r.alive,
    active: r.active,
  }));

  return ok({ citizens, count: citizens.length, tick });
}

async function handleLexicon(client) {
  const [lexiconRes, sharedRes] = await Promise.all([
    client.query(
      `SELECT id, citizen_id, sound, meaning, confidence, times_used,
              times_understood, tick_learned, tick_last_used
       FROM lexicon_entries ORDER BY citizen_id, confidence DESC`
    ),
    client.query(
      `SELECT id, sound, meaning, confidence, established_by, citizen_count, tick_established
       FROM shared_lexicon ORDER BY confidence DESC`
    ),
  ]);

  const lexiconByCitizen = {};
  let totalEntries = 0;
  for (const r of lexiconRes.rows) {
    if (!lexiconByCitizen[r.citizen_id]) lexiconByCitizen[r.citizen_id] = [];
    lexiconByCitizen[r.citizen_id].push({
      sound: r.sound,
      meaning: r.meaning,
      confidence: parseFloat(r.confidence),
      times_used: r.times_used,
      times_understood: r.times_understood,
      tick_learned: r.tick_learned,
      tick_last_used: r.tick_last_used,
    });
    totalEntries++;
  }

  const sharedLexicon = sharedRes.rows.map((r) => ({
    sound: r.sound,
    meaning: r.meaning,
    confidence: parseFloat(r.confidence),
    established_by: typeof r.established_by === "string" ? JSON.parse(r.established_by) : (r.established_by || []),
    citizen_count: r.citizen_count,
    tick_established: r.tick_established,
  }));

  return ok({
    lexicon_by_citizen: lexiconByCitizen,
    shared_lexicon: sharedLexicon,
    total_entries: totalEntries,
  });
}

async function handleInteractions(client, params) {
  const limit = clampInt(params.limit, 100, 1, 500);
  const offset = clampInt(params.offset, 0, 0, 100000);

  const [dataRes, countRes] = await Promise.all([
    client.query(
      `SELECT id, tick, citizen_a, citizen_b, speech_a, speech_b, summary, timestamp
       FROM interactions ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    client.query("SELECT COUNT(*)::int AS total FROM interactions"),
  ]);

  const interactions = dataRes.rows.map((r) => ({
    id: r.id,
    tick: r.tick,
    citizen_a: r.citizen_a,
    citizen_b: r.citizen_b,
    speech_a: r.speech_a,
    speech_b: r.speech_b,
    summary: r.summary,
    timestamp: r.timestamp,
  }));

  return ok({
    interactions,
    total: countRes.rows[0]?.total || 0,
    limit,
    offset,
  });
}

async function handleScience(client) {
  const res = await client.query(
    "SELECT tick, metrics FROM science_metrics ORDER BY id DESC LIMIT 1"
  );
  if (res.rows.length === 0) {
    return ok({ tick: null, metrics: null });
  }
  const row = res.rows[0];
  const metrics = typeof row.metrics === "string"
    ? JSON.parse(row.metrics)
    : row.metrics;
  return ok({ tick: row.tick, metrics });
}

async function handleHistory(client, params) {
  const table = params.table;
  if (!table || !ALLOWED_HISTORY_TABLES.includes(table)) {
    return err(400, `Invalid or missing table parameter. Allowed: ${ALLOWED_HISTORY_TABLES.join(", ")}`);
  }
  const limit = clampInt(params.limit, 50, 1, 500);

  // Each table has different columns; use SELECT * for flexibility,
  // but always order by a sensible default and limit rows.
  const res = await client.query(
    `SELECT * FROM ${table} ORDER BY id DESC LIMIT $1`,
    [limit]
  );

  return ok({ table, rows: res.rows, count: res.rows.length });
}

async function handleUtterances(client, params) {
  const limit = clampInt(params.limit, 50, 1, 500);
  const citizenId = params.citizen_id;

  let dataRes, countRes;

  if (citizenId) {
    [dataRes, countRes] = await Promise.all([
      client.query(
        `SELECT id, tick, citizen_id, utterance, context_type,
                understood_by, communication_success
         FROM utterance_log WHERE citizen_id = $1
         ORDER BY id DESC LIMIT $2`,
        [citizenId, limit]
      ),
      client.query(
        "SELECT COUNT(*)::int AS total FROM utterance_log WHERE citizen_id = $1",
        [citizenId]
      ),
    ]);
  } else {
    [dataRes, countRes] = await Promise.all([
      client.query(
        `SELECT id, tick, citizen_id, utterance, context_type,
                understood_by, communication_success
         FROM utterance_log ORDER BY id DESC LIMIT $1`,
        [limit]
      ),
      client.query("SELECT COUNT(*)::int AS total FROM utterance_log"),
    ]);
  }

  return ok({
    utterances: dataRes.rows,
    count: countRes.rows[0]?.total || 0,
  });
}

function handleMeta() {
  return ok(
    {
      version: 1,
      endpoints: [
        "citizens",
        "lexicon",
        "interactions",
        "science",
        "history",
        "utterances",
        "meta",
      ],
      description: "WildMind Research API \u2014 query live simulation data",
      source: "https://cosmic-piroshki-aeb441.netlify.app",
    },
    false // no cache for meta
  );
}

// --- Main handler ---

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return err(405, "Method not allowed. Use GET.");
  }

  const params = event.queryStringParameters || {};
  const endpoint = params.endpoint;

  if (!endpoint) {
    return err(400, "Missing ?endpoint= parameter. Try ?endpoint=meta for documentation.");
  }

  // Meta doesn't need a database connection
  if (endpoint === "meta") {
    return handleMeta();
  }

  let client;
  try {
    client = await getClient();

    switch (endpoint) {
      case "citizens":
        return await handleCitizens(client);
      case "lexicon":
        return await handleLexicon(client);
      case "interactions":
        return await handleInteractions(client, params);
      case "science":
        return await handleScience(client);
      case "history":
        return await handleHistory(client, params);
      case "utterances":
        return await handleUtterances(client, params);
      default:
        return err(400, `Unknown endpoint: "${endpoint}". Try ?endpoint=meta for documentation.`);
    }
  } catch (e) {
    console.error("API error:", e);
    // Reset client on connection failure
    cachedClient = null;
    cachedAt = 0;
    return err(500, "Database query failed");
  }
};
