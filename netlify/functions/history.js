const { Client } = require("pg");

let cachedClient = null;
let cachedAt = 0;
const MAX_CLIENT_AGE = 60000;

async function getClient() {
  const now = Date.now();
  if (cachedClient && now - cachedAt < MAX_CLIENT_AGE) return cachedClient;
  if (cachedClient) { try { await cachedClient.end(); } catch (_) {} }
  cachedClient = new Client({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  await cachedClient.connect();
  cachedAt = now;
  return cachedClient;
}

function parseJSON(val) {
  if (!val) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch (_) { return val; }
  }
  return val;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Cache-Control": "public, max-age=30",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  // API key authentication
  const apiKey = process.env.WILDMIND_API_KEY;
  if (apiKey) {
    const provided = event.headers["x-api-key"] || event.queryStringParameters?.key;
    if (provided !== apiKey) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }
  }

  let client;
  try {
    client = await getClient();
    const t0 = Date.now();

    async function q(name, sql, params) {
      try {
        return params ? await client.query(sql, params) : await client.query(sql);
      } catch (err) {
        console.error(`[history] Query "${name}" failed:`, err.message);
        return { rows: [] };
      }
    }

    // ── Run all independent queries in parallel ──────────────────────────

    const [
      worldsRes,
      deathsRes,
      evolutionReportsRes,
      evolutionSnapshotsRes,
      insightsRes,
      scienceRes,
      behaviorRes,
      snapshotsRes,
      climateRes,
      consequenceCausesRes,
      consequenceEffectsRes,
      consequenceStatsRes,
      narrativesRes,
      voiceClipsCountRes,
      modelCheckpointsRes,
      citizenSummaryRes,
      deathsByWorldRes,
      deathsByAgeRes,
      citizenCountByWorldRes,
      modelDiffsRes,
    ] = await Promise.all([

      // 1. All worlds with full reports
      q("worlds", `
        SELECT world_id, started_at, ended_at, total_ticks, total_interactions,
               total_vocab, shared_words, milestones_achieved, milestone_list,
               citizen_count, status, notes, report
        FROM worlds ORDER BY world_id ASC
      `),

      // 2. All deaths with relationships
      q("deaths", `
        SELECT citizen_id, tick, cause, age, vocab_size, relationships
        FROM deaths ORDER BY tick ASC
      `),

      // 3. Evolution reports
      q("evolution_reports", `
        SELECT world_id, report
        FROM evolution_reports ORDER BY world_id ASC
      `),

      // 4. Evolution snapshots
      q("evolution_snapshots", `
        SELECT world_id, tick, snapshot
        FROM evolution_snapshots ORDER BY world_id ASC, tick ASC
      `),

      // 5. Training insights
      q("insights", `
        SELECT world_id, insight_type, description, data
        FROM world_training_insights
        ORDER BY world_id ASC
      `),

      // 6. Science metrics — extract key scalars only
      q("science", `
        SELECT tick, metrics FROM science_metrics ORDER BY tick ASC
      `),

      // 7. Behavior analysis — extract summary, leadership, social_dynamics
      q("behavior", `
        SELECT tick, analysis FROM behavior_analysis ORDER BY tick ASC
      `),

      // 8. State snapshots
      q("snapshots", `
        SELECT tick, day, season, time_of_day, alive_count, shared_vocab_size,
               total_interactions, communication_success_rate, stage
        FROM state_snapshots ORDER BY tick ASC
      `),

      // 9. Climate timeline
      q("climate", `
        SELECT tick, season, temperature_avg, rainfall, wind_speed, humidity, extreme_event
        FROM climate_state ORDER BY tick ASC
      `),

      // 10. Consequence memories — top 20 causes (aggregated)
      q("consequence_causes", `
        SELECT cause, COUNT(*) as count
        FROM consequence_memories
        GROUP BY cause
        ORDER BY count DESC
        LIMIT 20
      `),

      // 11. Consequence memories — top 20 effects (aggregated)
      q("consequence_effects", `
        SELECT effect, COUNT(*) as count
        FROM consequence_memories
        GROUP BY effect
        ORDER BY count DESC
        LIMIT 20
      `),

      // 12. Consequence memories — aggregate stats
      q("consequence_stats", `
        SELECT COUNT(*) as total, AVG(severity) as avg_severity
        FROM consequence_memories
      `),

      // 13. Top 30 narratives by drama score
      q("narratives", `
        SELECT tick, type, text, citizens, drama_score
        FROM narratives
        ORDER BY drama_score DESC NULLS LAST
        LIMIT 30
      `),

      // 14. Voice clips count
      q("voice_clips_count", `
        SELECT COUNT(*) as count FROM voice_clips
      `),

      // 15. Model checkpoints
      q("model_checkpoints", `
        SELECT world_id, checkpoint_path, timestamp
        FROM model_checkpoints ORDER BY world_id ASC
      `),

      // 16. Current world citizens summary
      q("citizen_summary", `
        SELECT role, sex, COUNT(*) as count,
               COUNT(*) FILTER (WHERE alive = true) as alive,
               AVG(age)::int as avg_age
        FROM citizens GROUP BY role, sex ORDER BY role, sex
      `),

      // 17. Deaths total count (deaths don't have world_id, frontend filters by tick ranges)
      q("deaths_by_world", `
        SELECT 'all' as world_id, COUNT(*) as death_count FROM deaths
      `),

      // 18. Deaths by age bucket
      q("deaths_by_age", `
        SELECT
          CASE
            WHEN age < 16 THEN '0-15'
            WHEN age BETWEEN 16 AND 25 THEN '16-25'
            WHEN age BETWEEN 26 AND 35 THEN '26-35'
            WHEN age BETWEEN 36 AND 45 THEN '36-45'
            WHEN age BETWEEN 46 AND 55 THEN '46-55'
            WHEN age > 55 THEN '56+'
            ELSE 'unknown'
          END as age_bucket,
          COUNT(*) as count
        FROM deaths
        WHERE age IS NOT NULL
        GROUP BY age_bucket
        ORDER BY age_bucket ASC
      `),

      // 19. Citizen counts per world (for death rate calculation)
      q("citizen_counts", `
        SELECT world_id, citizen_count FROM worlds ORDER BY world_id ASC
      `),

      // 20. Model diffs by world (table may not exist yet, q() handles gracefully)
      q("model_diffs", `
        SELECT world_id, tick, diff FROM model_diffs ORDER BY world_id ASC, tick ASC
      `),
    ]);

    // ── Parse worlds ─────────────────────────────────────────────────────

    const worlds = worldsRes.rows.map(r => ({
      world_id: r.world_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      total_ticks: r.total_ticks || 0,
      total_interactions: r.total_interactions || 0,
      total_vocab: r.total_vocab || 0,
      shared_words: r.shared_words || 0,
      milestones_achieved: r.milestones_achieved || 0,
      milestone_list: parseJSON(r.milestone_list) || [],
      citizen_count: r.citizen_count || 0,
      status: r.status,
      notes: r.notes,
      report: parseJSON(r.report),
    }));

    // ── Cross-world analysis ─────────────────────────────────────────────

    const totalTicksAll = worlds.reduce((s, w) => s + (w.total_ticks || 0), 0);
    const totalInteractionsAll = worlds.reduce((s, w) => s + (w.total_interactions || 0), 0);
    const worldsWithTicks = worlds.filter(w => w.total_ticks > 0);
    const avgWorldLifespan = worldsWithTicks.length > 0
      ? Math.round(totalTicksAll / worldsWithTicks.length)
      : 0;

    const longestWorld = worldsWithTicks.reduce(
      (best, w) => (w.total_ticks > (best.ticks || 0) ? { world_id: w.world_id, ticks: w.total_ticks } : best),
      { world_id: null, ticks: 0 }
    );

    const mostInteractiveWorld = worlds.reduce(
      (best, w) => (w.total_interactions > (best.interactions || 0)
        ? { world_id: w.world_id, interactions: w.total_interactions } : best),
      { world_id: null, interactions: 0 }
    );

    // Deaths by cause
    const deathsByCause = {};
    for (const d of deathsRes.rows) {
      const cause = d.cause || "unknown";
      deathsByCause[cause] = (deathsByCause[cause] || 0) + 1;
    }

    // Deaths by world from query
    const deathsByWorld = {};
    for (const r of deathsByWorldRes.rows) {
      deathsByWorld[r.world_id] = parseInt(r.death_count) || 0;
    }

    // English leak trend — extract from world reports
    const englishLeakTrend = worlds
      .filter(w => w.report)
      .map(w => {
        const report = w.report;
        const rate = report.english_leak_rate
          ?? report.english_contamination_rate
          ?? report.englishLeakRate
          ?? (report.language_analysis && report.language_analysis.english_leak_rate)
          ?? null;
        return { world_id: w.world_id, rate };
      })
      .filter(e => e.rate !== null);

    // Training examples per world — extract from reports or insights
    const trainingExamplesPerWorld = worlds
      .filter(w => w.report)
      .map(w => {
        const report = w.report;
        const count = report.training_examples_added
          ?? report.trainingExamplesAdded
          ?? (report.training && report.training.examples_added)
          ?? null;
        return { world_id: w.world_id, count };
      })
      .filter(e => e.count !== null);

    const crossWorldAnalysis = {
      total_worlds: worlds.length,
      total_ticks_all_worlds: totalTicksAll,
      total_interactions_all_worlds: totalInteractionsAll,
      total_deaths: deathsRes.rows.length,
      deaths_by_cause: deathsByCause,
      deaths_by_world: deathsByWorld,
      avg_world_lifespan_ticks: avgWorldLifespan,
      longest_world: longestWorld,
      most_interactive_world: mostInteractiveWorld,
      english_leak_trend: englishLeakTrend,
      training_examples_added_per_world: trainingExamplesPerWorld,
    };

    // ── Evolution reports ────────────────────────────────────────────────

    const evolutionReports = evolutionReportsRes.rows.map(r => ({
      world_id: r.world_id,
      report: parseJSON(r.report),
    }));

    // ── Evolution snapshots ──────────────────────────────────────────────

    const evolutionSnapshots = evolutionSnapshotsRes.rows.map(r => ({
      world_id: r.world_id,
      tick: r.tick,
      snapshot: parseJSON(r.snapshot),
    }));

    // ── Insights by world ────────────────────────────────────────────────

    const insightsByWorld = {};
    for (const r of insightsRes.rows) {
      if (!insightsByWorld[r.world_id]) insightsByWorld[r.world_id] = [];
      insightsByWorld[r.world_id].push({
        type: r.insight_type,
        description: r.description,
        data: parseJSON(r.data) || {},
      });
    }

    // ── Death analysis ───────────────────────────────────────────────────

    const allAges = deathsRes.rows.filter(d => d.age != null).map(d => parseFloat(d.age));
    const avgAgeAtDeath = allAges.length > 0
      ? Math.round((allAges.reduce((s, a) => s + a, 0) / allAges.length) * 10) / 10
      : null;

    const deathsByAge = deathsByAgeRes.rows.map(r => ({
      age_bucket: r.age_bucket,
      count: parseInt(r.count),
    }));

    // Death rate by world — combine deaths_by_world with citizen counts
    const citizenCountMap = {};
    for (const r of citizenCountByWorldRes.rows) {
      citizenCountMap[r.world_id] = r.citizen_count || 0;
    }

    const deathRateByWorld = Object.entries(deathsByWorld).map(([wid, deaths]) => {
      const citizens = citizenCountMap[wid] || 0;
      return {
        world_id: parseInt(wid),
        deaths,
        citizens,
        rate: citizens > 0 ? Math.round((deaths / citizens) * 1000) / 1000 : null,
      };
    });

    const deadliestWorld = deathRateByWorld.reduce(
      (best, w) => (w.deaths > (best.deaths || 0) ? { world_id: w.world_id, deaths: w.deaths } : best),
      { world_id: null, deaths: 0 }
    );

    const deathAnalysis = {
      by_cause: deathsByCause,
      by_age: deathsByAge,
      death_rate_by_world: deathRateByWorld,
      avg_age_at_death: avgAgeAtDeath,
      deadliest_world: deadliestWorld,
    };

    // ── Science timeline — extract key scalar values ─────────────────────

    const scienceTimeline = scienceRes.rows.map(r => ({
      tick: r.tick,
      metrics: parseJSON(r.metrics) || {},
    }));

    // ── Behavior timeline — extract summary, leadership, social_dynamics ─

    const behaviorTimeline = behaviorRes.rows.map(r => {
      const a = parseJSON(r.analysis) || {};
      return {
        tick: r.tick,
        group_count: a.groups?.count ?? (Array.isArray(a.groups) ? a.groups.length : null),
        groups_summary: Array.isArray(a.groups)
          ? a.groups.map(g => ({ id: g.id, size: g.size ?? g.members?.length }))
          : null,
        movement_summary: a.movement?.summary ?? a.movement?.pattern ?? null,
        leadership: a.leadership ?? null,
        exploration_score: a.exploration?.score ?? a.exploration ?? null,
        observed_roles: a.observed_roles ?? null,
        crisis_response: a.crisis_response ?? null,
        social_dynamics: a.social_dynamics ?? null,
        resource_behavior: a.resource_behavior
          ? { strategy: a.resource_behavior.strategy ?? a.resource_behavior.dominant_strategy ?? null,
              sharing_rate: a.resource_behavior.sharing_rate ?? null }
          : null,
      };
    });

    // ── Climate timeline ─────────────────────────────────────────────────

    const climateTimeline = climateRes.rows.map(r => ({
      tick: r.tick,
      season: r.season,
      temperature_avg: r.temperature_avg != null ? parseFloat(r.temperature_avg) : null,
      rainfall: r.rainfall != null ? parseFloat(r.rainfall) : null,
      wind_speed: r.wind_speed != null ? parseFloat(r.wind_speed) : null,
      humidity: r.humidity != null ? parseFloat(r.humidity) : null,
      extreme_event: r.extreme_event || null,
    }));

    // ── Consequence analysis (aggregated only) ───────────────────────────

    const csStats = consequenceStatsRes.rows[0] || {};
    const consequenceAnalysis = {
      total_memories: parseInt(csStats.total) || 0,
      top_causes: consequenceCausesRes.rows.map(r => ({
        cause: r.cause,
        count: parseInt(r.count),
      })),
      top_effects: consequenceEffectsRes.rows.map(r => ({
        effect: r.effect,
        count: parseInt(r.count),
      })),
      avg_severity: csStats.avg_severity != null
        ? Math.round(parseFloat(csStats.avg_severity) * 1000) / 1000
        : null,
    };

    // ── Narrative highlights ─────────────────────────────────────────────

    const narrativeHighlights = narrativesRes.rows.map(r => ({
      tick: r.tick,
      type: r.type,
      text: r.text,
      citizens: parseJSON(r.citizens),
      drama_score: r.drama_score != null ? parseFloat(r.drama_score) : null,
    }));

    // ── State snapshots ──────────────────────────────────────────────────

    const snapshots = snapshotsRes.rows.map(r => ({
      tick: r.tick,
      day: r.day,
      season: r.season,
      time_of_day: r.time_of_day,
      alive_count: r.alive_count,
      shared_vocab_size: r.shared_vocab_size,
      total_interactions: r.total_interactions,
      communication_success_rate: r.communication_success_rate != null
        ? parseFloat(r.communication_success_rate) : null,
      stage: r.stage,
    }));

    // ── Voice clips count ────────────────────────────────────────────────

    const voiceClipsCount = parseInt((voiceClipsCountRes.rows[0] || {}).count) || 0;

    // ── Model checkpoints ────────────────────────────────────────────────

    const modelCheckpoints = modelCheckpointsRes.rows.map(r => ({
      world_id: r.world_id,
      checkpoint_path: r.checkpoint_path,
      timestamp: r.timestamp,
    }));

    // ── Current world live stats ─────────────────────────────────────────

    const currentWorld = worlds.find(w => w.status === "running" || w.status === "active")
      || worlds[worlds.length - 1]
      || null;

    const currentWorldInfo = currentWorld ? {
      world_id: currentWorld.world_id,
      started_at: currentWorld.started_at,
      total_ticks: currentWorld.total_ticks,
      total_interactions: currentWorld.total_interactions,
      total_vocab: currentWorld.total_vocab,
      shared_words: currentWorld.shared_words,
      citizen_count: currentWorld.citizen_count,
      status: currentWorld.status,
      citizen_summary: citizenSummaryRes.rows.map(r => ({
        role: r.role,
        sex: r.sex,
        count: parseInt(r.count),
        alive: parseInt(r.alive),
        avg_age: parseInt(r.avg_age) || null,
      })),
    } : null;

    // ── Assemble full response ───────────────────────────────────────────

    // ── Model diffs by world ──────────────────────────────────────────
    const modelDiffsByWorld = modelDiffsRes.rows.map(r => ({
      world_id: r.world_id,
      tick: r.tick,
      diff: parseJSON(r.diff),
    }));

    // ── Raw deaths array for frontend ─────────────────────────────────
    const deaths = deathsRes.rows.map(r => ({
      citizen_id: r.citizen_id,
      tick: r.tick,
      cause: r.cause,
      age: r.age,
      vocab_size: r.vocab_size,
    }));

    const response = {
      worlds,
      cross_world_analysis: crossWorldAnalysis,
      evolution_reports: evolutionReports,
      evolution_snapshots: evolutionSnapshots,
      insights_by_world: insightsByWorld,
      death_analysis: deathAnalysis,
      deaths,
      science_timeline: scienceTimeline,
      science_history: scienceTimeline,
      behavior_timeline: behaviorTimeline,
      climate_timeline: climateTimeline,
      consequence_analysis: consequenceAnalysis,
      narrative_highlights: narrativeHighlights,
      snapshots,
      voice_clips_count: voiceClipsCount,
      model_checkpoints: modelCheckpoints,
      model_diffs_by_world: modelDiffsByWorld,
      current_world: currentWorldInfo,
      server_time: Date.now(),
      query_time_ms: Date.now() - t0,
    };

    return { statusCode: 200, headers, body: JSON.stringify(response) };
  } catch (err) {
    console.error("[history] Error:", err);
    cachedClient = null;
    cachedAt = 0;
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "Database query failed" }),
    };
  }
};
