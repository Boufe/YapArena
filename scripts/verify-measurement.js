import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createMeasurementRepository } from "../dist/features/measurement/repository.js";
import { createCommunityRepository } from "../dist/features/community/repository.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});
const measurement = createMeasurementRepository(pool);
const community = createCommunityRepository(pool);
const suffix = randomUUID().slice(0, 8);
const tokenHash = createHash("sha256").update(randomUUID()).digest("hex");
const users = [];
const profiles = [];
const topics = [];
const debates = [];

async function person(name) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'verification-only') RETURNING id",
    [`measure-${name}-${suffix}@example.test`],
  );
  const id = user.rows[0].id;
  users.push(id);
  const profile = await pool.query(
    `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
     VALUES ($1, $2, $3, 'published') RETURNING id`,
    [id, `measure-${name}-${suffix}`, name],
  );
  profiles.push(profile.rows[0].id);
  return id;
}

async function topic(name) {
  const result = await pool.query(
    `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
     VALUES ($1, $2, 'Measurement integration topic', 'For', 'Against', 'published') RETURNING id`,
    [`measure-${name}-${suffix}`, `${name} measurement`],
  );
  topics.push(result.rows[0].id);
  return result.rows[0].id;
}

async function debate(name, topicId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO debates (id, slug, topic_id, proposition, status, publication_state,
      rules_version, rules_snapshot, scheduled_at, live_started_at)
     SELECT $1, $2, $3, 'Should measurement require consent?',
       'live', 'published', version, rules, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM event_rule_versions WHERE version = 'prototype-media-1'`,
    [id, `measure-debate-${name}-${suffix}`, topicId],
  );
  debates.push(id);
  return id;
}

try {
  const founder = await person("founder");
  const independent = await person("independent");
  const firstTopic = await topic("first");
  const secondTopic = await topic("second");
  const first = await debate("first", firstTopic);
  const second = await debate("second", secondTopic);
  const unpublished = await debate("unpublished", secondTopic);
  await pool.query(
    "UPDATE debates SET publication_state = 'draft' WHERE id = $1",
    [unpublished],
  );
  await measurement.grant(tokenHash);
  assert.equal(await measurement.hasConsent(tokenHash), true);
  assert.equal(
    await measurement.recordDiscovery(tokenHash, founder, "debate", first),
    true,
  );
  assert.equal(
    await measurement.recordDiscovery(tokenHash, founder, "debate", first),
    true,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM product_measurement_events WHERE token_hash = $1",
        [tokenHash],
      )
    ).rows[0].n,
    1,
  );
  await pool.query(
    `UPDATE product_measurement_events SET occurred_at = CURRENT_TIMESTAMP - INTERVAL '1 day'
     WHERE token_hash = $1 AND event_type = 'discovery_view'`,
    [tokenHash],
  );
  assert.equal(
    await measurement.recordDiscovery(tokenHash, founder, "debate", second),
    true,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM product_measurement_events WHERE token_hash = $1 AND event_type = 'return_visit'",
        [tokenHash],
      )
    ).rows[0].n,
    1,
  );

  const sessionId = randomUUID();
  assert.equal(
    await measurement.startWatch(tokenHash, founder, sessionId, first, "live"),
    true,
  );
  assert.equal(
    await measurement.startWatch(tokenHash, founder, sessionId, first, "live"),
    false,
  );
  await pool.query(
    "UPDATE product_measurement_watch_sessions SET last_seen_at = CURRENT_TIMESTAMP - INTERVAL '20 seconds' WHERE id = $1",
    [sessionId],
  );
  const repeated = await Promise.all([
    measurement.progressWatch(tokenHash, sessionId),
    measurement.progressWatch(tokenHash, sessionId),
  ]);
  assert.deepEqual(repeated, [true, true]);
  const watch = await pool.query(
    "SELECT watched_seconds FROM product_measurement_watch_sessions WHERE id = $1",
    [sessionId],
  );
  assert.ok(
    watch.rows[0].watched_seconds >= 20 && watch.rows[0].watched_seconds <= 21,
  );
  assert.equal(
    await measurement.progressWatch(tokenHash, sessionId, true),
    true,
  );
  assert.equal(await measurement.progressWatch(tokenHash, sessionId), false);

  await pool.query(
    `INSERT INTO product_measurement_affiliations (user_id, affiliation, reason, reviewed_by)
     VALUES ($1, 'founder', 'Verification founder account', $1),
       ($2, 'independent', 'Verification independent account', $1)`,
    [founder, independent],
  );
  await pool.query(`INSERT INTO follows (user_id, topic_id) VALUES ($1, $2)`, [
    founder,
    firstTopic,
  ]);
  assert.equal(
    await measurement.recordAction(tokenHash, founder, {
      type: "follow_created",
      targetType: "topic",
      slug: `measure-first-${suffix}`,
    }),
    true,
  );
  const match = await pool.query(
    `INSERT INTO match_requests (kind, status, initiator_user_id, topic_id,
       proposition, requested_side, scheduled_at, expires_at)
     VALUES ('queue', 'open', $1, $2, 'Should measurement require consent?',
       'A', CURRENT_TIMESTAMP + INTERVAL '2 hours', CURRENT_TIMESTAMP + INTERVAL '1 hour')
     RETURNING id`,
    [founder, firstTopic],
  );
  assert.equal(
    await measurement.recordAction(tokenHash, founder, {
      type: "match_requested",
      requestId: match.rows[0].id,
    }),
    true,
  );
  await pool.query(
    `INSERT INTO event_participants (debate_id, user_id, side)
     VALUES ($1, $2, 'A'), ($1, $3, 'B')`,
    [first, founder, independent],
  );
  assert.equal(
    await measurement.recordAction(tokenHash, independent, {
      type: "match_accepted",
      debateId: first,
    }),
    true,
  );
  const report = await community.report(
    founder,
    "event",
    first,
    "other",
    "Measurement integration report",
  );
  assert.equal(
    await measurement.recordAction(tokenHash, founder, {
      type: "report_submitted",
      caseId: report.id,
    }),
    true,
  );
  await pool.query(
    `UPDATE debates SET status = 'ended', live_ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [first],
  );
  await pool.query(
    `UPDATE debates SET status = 'ended', live_ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [unpublished],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM product_measurement_events WHERE debate_id = $1 AND event_type = 'debate_completed'",
        [unpublished],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM product_measurement_events WHERE debate_id = $1 AND event_type = 'debate_completed'",
        [first],
      )
    ).rows[0].n,
    1,
  );
  await pool.query("UPDATE debates SET status = 'replay' WHERE id = $1", [
    first,
  ]);
  await pool.query(
    `INSERT INTO debate_media (debate_id, recording_status) VALUES ($1, 'ready')`,
    [first],
  );
  assert.equal(
    await measurement.startWatch(
      tokenHash,
      founder,
      randomUUID(),
      first,
      "replay",
    ),
    true,
  );
  const summary = await measurement.summary();
  assert.ok(
    summary.events.some(
      (row) =>
        row.eventType === "debate_completed" &&
        row.affiliation === "founder" &&
        row.count === 1,
    ),
  );
  assert.ok(
    summary.events.some(
      (row) =>
        row.eventType === "match_accepted" &&
        row.affiliation === "independent" &&
        row.count === 1,
    ),
  );
  assert.ok(
    summary.watch.some(
      (row) => row.mode === "live" && row.watchedSeconds >= 20,
    ),
  );

  assert.equal(await measurement.withdraw(tokenHash), 1);
  assert.equal(await measurement.hasConsent(tokenHash), false);
  assert.equal(
    await measurement.recordDiscovery(tokenHash, founder, "home", null),
    false,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM product_measurement_events WHERE token_hash = $1",
        [tokenHash],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM product_measurement_watch_sessions WHERE token_hash = $1",
        [tokenHash],
      )
    ).rows[0].n,
    0,
  );
  console.log("Product measurement PostgreSQL integration verified");
} finally {
  try {
    await pool.query(
      "DELETE FROM moderation_cases WHERE debate_id = ANY($1::uuid[])",
      [debates],
    );
    await pool.query(
      "DELETE FROM match_requests WHERE initiator_user_id = ANY($1::bigint[])",
      [users],
    );
    await pool.query("DELETE FROM debates WHERE id = ANY($1::uuid[])", [
      debates,
    ]);
    await pool.query("DELETE FROM topics WHERE id = ANY($1::uuid[])", [topics]);
    await pool.query("DELETE FROM public_profiles WHERE id = ANY($1::uuid[])", [
      profiles,
    ]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::bigint[])", [users]);
  } finally {
    await pool.end();
  }
}
