// Explicit operator task for a staging/local demonstration. It never writes a
// real wallet, submission, settlement or existing private run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  simulationArguments,
  syntheticRound,
  argumentEndorsements,
} from "../dist/features/a4/public-bots.js";
import { digest } from "../dist/features/a4/engine.js";
const origin = process.env.PUBLIC_BOTS_STAGE_ORIGIN;
assert.ok(
  origin === "https://yaparena-staging-web.onrender.com" ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? ""),
  "Explicit staging/local origin required",
);
assert.equal(
  process.env.PUBLIC_BOTS_SEED_ACK,
  "synthetic-only",
  "Explicit synthetic seed acknowledgment required",
);
const rounds = 36,
  population = 500;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  assert.equal(
    (await db.query<{ role: string }>("SELECT current_user AS role")).rows[0]!
      .role,
    "yaparena_owner",
  );
  const debates = (
    await db.query<{ id: string; proposition: string }>(
      "SELECT d.id,d.proposition FROM yaparena.debates d JOIN yaparena.topics t ON t.id=d.topic_id WHERE d.publication_state='published' AND t.publication_state='published' ORDER BY d.id LIMIT 100",
    )
  ).rows;
  let inserted = 0;
  for (const debate of debates) {
    const catalog = simulationArguments(debate.proposition);
    const base = Date.now();
    const batch = Array.from({ length: rounds }, (_, i) => {
      const seed = digest({
        version: "public-bot-v1",
        debate: debate.id,
        period: i + 1,
      });
      return {
        id: randomUUID(),
        seed,
        key: `public-bot-v1:${debate.id}:${i + 1}`,
        at: new Date(base - (rounds - i - 1) * 3600000),
        result: {
          ...syntheticRound(seed, i + 1, population),
          argumentResults: argumentEndorsements(
            seed,
            catalog.arguments,
            population,
          ),
        },
      };
    });
    await db.query("BEGIN");
    await db.query(
      "INSERT INTO yaparena.a4_synthetic_debates(debate_id,arguments,category) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [debate.id, JSON.stringify(catalog.arguments), catalog.category],
    );
    const result = await db.query(
      `INSERT INTO yaparena.a4_synthetic_rounds(id,debate_id,seed_key,simulated_at,seed,result)
      SELECT id::uuid,$1,key,at,seed,result FROM jsonb_to_recordset($2) AS r(id text,key text,at timestamptz,seed text,result jsonb)
      ON CONFLICT(seed_key) DO NOTHING`,
      [debate.id, JSON.stringify(batch)],
    );
    inserted += result.rowCount!;
    await db.query("COMMIT");
  }
  // Existing personal aggregates require a specific consented public profile,
  // never all creators. Caller records the user's authorization for this handle.
  const handle = process.env.PUBLIC_BOTS_PUBLISH_HANDLE;
  if (handle) {
    const owner = await db.query<{ user_id: string }>(
      "SELECT user_id FROM yaparena.public_profiles WHERE handle=$1 AND user_id IS NOT NULL",
      [handle],
    );
    assert.equal(
      owner.rowCount,
      1,
      "Consented profile must identify one account",
    );
    await db.query(
      "INSERT INTO yaparena.a4_public_publishers(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [owner.rows[0]!.user_id],
    );
  }
  console.log(
    JSON.stringify({
      result: "SEEDED",
      debates: debates.length,
      inserted,
      roundsPerDebate: rounds,
      population,
      preset: "heterogeneous",
      argumentDefinitionsPerDebate: 6,
      publishedConsentedProfile: Boolean(handle),
      walletsChanged: false,
    }),
  );
} catch (error) {
  await db.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await db.end();
}
