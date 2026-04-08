// netlify/functions/audio.js
const { Client } = require("pg");

exports.handler = async (event) => {
  // API key authentication (constant-time comparison prevents timing attacks)
  const apiKey = process.env.WILDMIND_API_KEY;
  if (apiKey) {
    const provided = event.headers["x-api-key"] || "";
    const crypto = require("crypto");
    const valid = provided.length === apiKey.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey));
    if (!valid) {
      return { statusCode: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, x-api-key" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }
  }

  const sound = event.queryStringParameters?.sound;
  if (!sound) return { statusCode: 400, body: "Missing sound parameter" };
  // Input validation — sound names are proto-language tokens (letters, hyphens only)
  if (!/^[a-zA-Z\-]{1,80}$/.test(sound)) {
    return { statusCode: 400, body: "Invalid sound format" };
  }

  const client = new Client({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();

  const result = await client.query(
    "SELECT audio_b64, audio_format FROM voice_clips WHERE sound = $1 LIMIT 1",
    [sound]
  );
  await client.end();

  if (result.rows.length === 0) return { statusCode: 404, body: "Not found" };

  const row = result.rows[0];
  const audioBuffer = Buffer.from(row.audio_b64, 'base64');

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
    },
    body: audioBuffer.toString('base64'),
    isBase64Encoded: true,
  };
};
