const { Client } = require("pg");

let cachedClient = null;
let cachedAt = 0;
const MAX_CLIENT_AGE = 60000; // reconnect every 60s

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

function safeJSON(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); } catch (_) { return fallback; }
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // API key authentication (constant-time comparison prevents timing attacks)
  const apiKey = process.env.WILDMIND_API_KEY;
  if (apiKey) {
    const provided = event.headers["x-api-key"] || "";
    const crypto = require("crypto");
    const valid = provided.length === apiKey.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey));
    if (!valid) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
  }

  let client;
  try {
    client = await getClient();
    const t0 = Date.now();
    const queryErrors = [];

    // Safe query wrapper — logs errors but doesn't crash the whole response
    async function q(name, sql) {
      try {
        return await client.query(sql);
      } catch (err) {
        queryErrors.push({ query: name, error: err.message });
        console.error(`Query "${name}" failed:`, err.message);
        return { rows: [] };
      }
    }

    // Run all queries in parallel — each individually wrapped
    const [
      liveStateRes,
      interactionsRes,
      lexiconRes,
      sharedLexiconRes,
      milestonesRes,
      relationshipsRes,
      interactionCountRes,
      worldEventsRes,
      citizensRes,
      memoriesRes,
      utteranceCountRes,
      breedingRes,
      recentUtterancesRes,
      narrativesRes,
      scienceRes,
      worldsRes,
    ] = await Promise.all([
      q("live_state", "SELECT state, tick, updated_at FROM live_state WHERE id = 1 LIMIT 1"),
      q("interactions", "SELECT id, tick, citizen_a, citizen_b, speech_a, speech_b, summary, timestamp FROM interactions ORDER BY id DESC LIMIT 20"),
      q("lexicon", "SELECT id, citizen_id, sound, meaning, confidence, times_used, times_understood, tick_learned, tick_last_used FROM lexicon_entries ORDER BY citizen_id, confidence DESC"),
      q("shared_lexicon", "SELECT id, sound, meaning, confidence, established_by, citizen_count, tick_established FROM shared_lexicon ORDER BY confidence DESC"),
      q("milestones", "SELECT id, milestone, tick, description, timestamp FROM civilization_milestones ORDER BY tick ASC"),
      q("relationships", `SELECT citizen_a, citizen_b, score, type FROM relationship_history WHERE tick = (SELECT MAX(tick) FROM relationship_history)`),
      q("interaction_count", "SELECT COUNT(*)::int AS total FROM interactions"),
      q("world_events", "SELECT id, tick, event_type, description, affected_citizens, timestamp FROM world_events ORDER BY id DESC LIMIT 20"),
      q("citizens", "SELECT id, name, role, age, sex, x, y, mood, energy, status, home_landmark, personality, knowledge, vocabulary, parent_ids, birth_tick, alive, active FROM citizens"),
      q("memories", `SELECT DISTINCT ON (citizen_id, rn) citizen_id, event, tick FROM (SELECT citizen_id, event, tick, ROW_NUMBER() OVER (PARTITION BY citizen_id ORDER BY id DESC) AS rn FROM memories) sub WHERE rn <= 10 ORDER BY citizen_id, rn`),
      q("utterance_stats", `SELECT COUNT(*)::int AS total_utterances, COUNT(*) FILTER (WHERE communication_success = true)::int AS successful, COUNT(DISTINCT citizen_id)::int AS active_speakers FROM utterance_log`),
      q("breeding", "SELECT tick, parent_a, parent_b, offspring_id, timestamp FROM breeding_events ORDER BY tick ASC"),
      q("recent_utterances", "SELECT tick, citizen_id, utterance, context_type, understood_by, communication_success FROM utterance_log ORDER BY id DESC LIMIT 30"),
      q("narratives", "SELECT id, tick, type, text, citizens, drama_score, timestamp FROM narratives ORDER BY id DESC LIMIT 15"),
      q("science", "SELECT tick, metrics FROM science_metrics ORDER BY id DESC LIMIT 1"),
      q("worlds", "SELECT world_id, started_at, total_ticks, total_interactions, shared_words, milestones_achieved, status FROM worlds ORDER BY world_id DESC LIMIT 50"),
    ]);

    // Query ecosystem tables individually (may not exist yet)
    // Historical data queries
    const [snapshotsRes, scienceHistoryRes, trainingRunsRes] = await Promise.all([
      q("snapshots", "SELECT tick, day, season, time_of_day, alive_count, shared_vocab_size, total_interactions, communication_success_rate, stage, state_summary, timestamp FROM state_snapshots ORDER BY tick ASC LIMIT 500"),
      q("science_history", "SELECT tick, metrics FROM science_metrics ORDER BY tick ASC LIMIT 200"),
      q("training_runs", "SELECT citizen_id, version, base_examples, real_examples, vocab_reinforcement_examples, gesture_grounding_examples, total_examples, since_tick, through_tick, timestamp FROM additive_training_runs ORDER BY timestamp ASC LIMIT 500"),
    ]);

    const [climateRes, floraRes, faunaRes, deathsRes, voiceClipsRes, faunaEventsRes, benchmarksRes, decisionsRes] = await Promise.all([
      q("climate", "SELECT tick, season, temperature_avg, rainfall, wind_speed, humidity, extreme_event FROM climate_state ORDER BY id DESC LIMIT 1"),
      q("flora", "SELECT tick, total_food, plant_counts, depleted_cells FROM flora_state ORDER BY id DESC LIMIT 1"),
      q("fauna", "SELECT tick, species_counts, predator_positions, prey_positions, recent_hunts, recent_attacks FROM fauna_state ORDER BY id DESC LIMIT 1"),
      q("deaths", "SELECT citizen_id, tick, cause, age FROM deaths ORDER BY tick DESC LIMIT 20"),
      q("voice_clips", "SELECT id, sound, meaning, citizen_id, tick, audio_format, length(audio_b64) > 0 AS has_audio FROM voice_clips ORDER BY id ASC LIMIT 500"),
      q("fauna_events", "SELECT tick, species_counts, recent_hunts, recent_attacks FROM fauna_state ORDER BY tick DESC LIMIT 50"),
      q("benchmarks", "SELECT world_id, tick, score, stage, summary, results, timestamp FROM benchmark_results ORDER BY world_id ASC"),
      q("decisions", `
        SELECT
          decision_type,
          choice,
          COUNT(*) as total,
          SUM(CASE WHEN outcome = 'thrived' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) as thrive_rate,
          SUM(CASE WHEN outcome = 'survived' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) as survive_rate,
          SUM(CASE WHEN outcome = 'died' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*),0) as death_rate,
          AVG(pressure) as avg_pressure
        FROM decision_log
        GROUP BY decision_type, choice
        ORDER BY total DESC
        LIMIT 50
      `),
    ]);

    // Parse live state
    const liveState = liveStateRes.rows.length > 0
      ? (typeof liveStateRes.rows[0].state === "string"
          ? JSON.parse(liveStateRes.rows[0].state)
          : liveStateRes.rows[0].state)
      : null;

    // Group memories by citizen
    const memoriesByCitizen = {};
    for (const row of memoriesRes.rows) {
      if (!memoriesByCitizen[row.citizen_id]) memoriesByCitizen[row.citizen_id] = [];
      memoriesByCitizen[row.citizen_id].push({ event: row.event, tick: row.tick });
    }

    // Group lexicon by citizen
    const lexiconByCitizen = {};
    let totalLexiconEntries = 0;
    for (const row of lexiconRes.rows) {
      if (!lexiconByCitizen[row.citizen_id]) lexiconByCitizen[row.citizen_id] = [];
      lexiconByCitizen[row.citizen_id].push({
        sound: row.sound,
        meaning: row.meaning,
        confidence: parseFloat(row.confidence),
        times_used: row.times_used,
        times_understood: row.times_understood,
        tick_learned: row.tick_learned,
        tick_last_used: row.tick_last_used,
      });
      totalLexiconEntries++;
    }

    // Parse shared lexicon
    const sharedLexicon = sharedLexiconRes.rows.map((r) => ({
      sound: r.sound,
      meaning: r.meaning,
      confidence: parseFloat(r.confidence),
      established_by: safeJSON(r.established_by, []),
      citizen_count: r.citizen_count,
      tick_established: r.tick_established,
    }));

    // Parse relationships
    const relationships = relationshipsRes.rows.map((r) => ({
      citizen_a: r.citizen_a,
      citizen_b: r.citizen_b,
      score: parseFloat(r.score),
      type: r.type,
    }));

    // Parse interactions
    const interactions = interactionsRes.rows.map((r) => ({
      id: r.id,
      tick: r.tick,
      citizen_a: r.citizen_a,
      citizen_b: r.citizen_b,
      speech_a: r.speech_a,
      speech_b: r.speech_b,
      summary: r.summary,
      timestamp: r.timestamp,
    }));

    // Parse world events
    const worldEvents = worldEventsRes.rows.map((r) => ({
      id: r.id,
      tick: r.tick,
      event_type: r.event_type,
      description: r.description,
      affected_citizens: safeJSON(r.affected_citizens, []),
      timestamp: r.timestamp,
    }));

    // Parse citizens from DB
    const citizensFromDB = citizensRes.rows.map((r) => ({
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
      parent_ids: safeJSON(r.parent_ids, []),
      birth_tick: r.birth_tick,
      alive: r.alive,
      active: r.active,
    }));

    // Utterance stats
    const utteranceStats = utteranceCountRes.rows[0] || { total_utterances: 0, successful: 0, active_speakers: 0 };

    // Build response
    const response = {
      _api_version: 2,
      // Live state blob (contains citizens with current speech, tick, day, season, etc.)
      live_state: liveState,
      // Citizens from citizens table (authoritative positions, full data)
      citizens_db: citizensFromDB,
      // Recent interactions
      interactions: interactions,
      // Personal vocabularies by citizen
      lexicon_by_citizen: lexiconByCitizen,
      total_lexicon_entries: totalLexiconEntries,
      // Shared language dictionary
      shared_lexicon: sharedLexicon,
      // Milestones
      milestones: milestonesRes.rows.map((r) => ({
        milestone: r.milestone,
        tick: r.tick,
        description: r.description,
        timestamp: r.timestamp,
      })),
      // Relationships
      relationships: relationships,
      // Total interaction count
      total_interactions: interactionCountRes.rows[0]?.total || 0,
      // World events
      world_events: worldEvents,
      // Memories by citizen
      memories_by_citizen: memoriesByCitizen,
      // Utterance stats
      utterance_stats: utteranceStats,
      // Breeding events
      breeding_events: breedingRes.rows,
      // Recent utterances
      recent_utterances: recentUtterancesRes.rows.map((r) => ({
        tick: r.tick,
        citizen_id: r.citizen_id,
        utterance: r.utterance,
        context_type: r.context_type,
        understood_by: r.understood_by,
        success: r.communication_success,
      })),
      // Narratives — the story feed
      narratives: narrativesRes.rows.map((r) => ({
        id: r.id, tick: r.tick, type: r.type, text: r.text,
        citizens: safeJSON(r.citizens, []),
        drama_score: parseFloat(r.drama_score || 0),
        timestamp: r.timestamp,
      })),
      // Science metrics — keep semantic_fields and efficiency intact
      science: (() => {
        if (scienceRes.rows.length === 0) return null;
        let m = typeof scienceRes.rows[0].metrics === "string"
          ? JSON.parse(scienceRes.rows[0].metrics)
          : scienceRes.rows[0].metrics;
        return m;
      })(),
      science_tick: scienceRes.rows.length > 0 ? scienceRes.rows[0].tick : null,
      // World history
      worlds: worldsRes.rows.map((r) => ({
        world_id: r.world_id, started_at: r.started_at, ticks: r.total_ticks,
        interactions: r.total_interactions, shared_words: r.shared_words,
        milestones: r.milestones_achieved, status: r.status,
      })),
      // Ecosystem data
      climate: climateRes.rows[0] || null,
      flora: floraRes.rows[0] || null,
      fauna: faunaRes.rows[0] || null,
      fauna_history: faunaEventsRes.rows || [],
      deaths: deathsRes.rows || [],
      benchmarks: benchmarksRes.rows || [],
      decision_summary: decisionsRes.rows || [],
      // Voice clips (metadata only — audio fetched separately via /api/audio)
      voice_clips: voiceClipsRes.rows || [],
      // Historical snapshots (for timeline browsing)
      snapshots: snapshotsRes.rows.map((r) => ({
        tick: r.tick, day: r.day, season: r.season, time_of_day: r.time_of_day,
        alive_count: r.alive_count, shared_vocab_size: r.shared_vocab_size,
        total_interactions: r.total_interactions,
        communication_success_rate: parseFloat(r.communication_success_rate || 0),
        stage: r.stage,
        summary: safeJSON(r.state_summary, {}),
        timestamp: r.timestamp,
      })),
      // Science metrics history (for trend charts)
      science_history: scienceHistoryRes.rows.map((r) => {
        let m = safeJSON(r.metrics);
        if (!m) return { tick: r.tick, metrics: null };
        // Strip to only trend-relevant scalars for bandwidth efficiency
        return {
          tick: r.tick,
          metrics: {
            zipf: m.zipf ? { zipf_coefficient: m.zipf.zipf_coefficient, r_squared: m.zipf.r_squared } : null,
            heaps: m.heaps ? { heaps_beta: m.heaps.heaps_beta, heaps_K: m.heaps.heaps_K, r_squared: m.heaps.r_squared } : null,
            network: m.network ? { clustering_coefficient: m.network.clustering_coefficient, avg_path_length: m.network.avg_path_length, edge_count: m.network.edge_count } : null,
            growth_curve: m.growth_curve ? { current_vocab_size: m.growth_curve.current_vocab_size, growth_model: m.growth_curve.growth_model } : null,
            efficiency: m.efficiency && m.efficiency.success_rate_over_time ? { latest_success: m.efficiency.success_rate_over_time.length > 0 ? m.efficiency.success_rate_over_time[m.efficiency.success_rate_over_time.length - 1].success_rate : null } : null,
          },
        };
      }),
      // Training history (per-citizen model training runs)
      training_runs: trainingRunsRes.rows.map((r) => ({
        citizen_id: r.citizen_id, version: r.version,
        base_examples: r.base_examples, real_examples: r.real_examples,
        vocab_reinforcement: r.vocab_reinforcement_examples,
        gesture_grounding: r.gesture_grounding_examples,
        total_examples: r.total_examples,
        since_tick: r.since_tick, through_tick: r.through_tick,
        timestamp: r.timestamp,
      })),
      // Server diagnostics
      server_time: Date.now(),
      query_time_ms: Date.now() - t0,
      query_errors: queryErrors.length > 0 ? queryErrors : undefined,
    };

    if (queryErrors.length > 0) {
      console.warn(`State response built with ${queryErrors.length} query error(s):`, queryErrors.map(e => e.query).join(", "));
    }
    console.log(`State response built in ${Date.now() - t0}ms | queries: ${16 + 8} | errors: ${queryErrors.length}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error("State query error:", err);
    // Reset client on error
    cachedClient = null;
    cachedAt = 0;
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Database query failed",
        
      }),
    };
  }
};
