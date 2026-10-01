import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createCommunityRepository,
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityRateError,
} from "../dist/features/community/repository.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
});
const community = createCommunityRepository(pool);
const suffix = randomUUID().slice(0, 8);
const eventId = randomUUID();
let topicId;
const users = [];
const profiles = [];

async function person(name) {
  const user = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, 'verification-only') RETURNING id",
    [`community-${name}-${suffix}@example.test`],
  );
  const id = user.rows[0].id;
  users.push(id);
  const profile = await pool.query(
    `INSERT INTO public_profiles (user_id, handle, display_name, publication_state)
     VALUES ($1, $2, $3, 'published') RETURNING id`,
    [id, `community-${name}-${suffix}`, name],
  );
  profiles.push(profile.rows[0].id);
  return id;
}

try {
  const author = await person("author");
  const reporter = await person("reporter");
  const moderatorA = await person("moderator-a");
  const moderatorB = await person("moderator-b");
  const topic = await pool.query(
    `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
     VALUES ($1, 'Community verification', 'Integration test topic', 'For', 'Against', 'published')
     RETURNING id`,
    [`community-topic-${suffix}`],
  );
  topicId = topic.rows[0].id;
  await pool.query(
    `INSERT INTO debates (id, slug, topic_id, proposition, status, publication_state,
      rules_version, rules_snapshot, scheduled_at, live_started_at)
     SELECT $1, $2, $3, 'Should community participation stay separate from results?',
       'live', 'published', version, rules, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     FROM event_rule_versions WHERE version = 'prototype-media-1'`,
    [eventId, `community-event-${suffix}`, topicId],
  );
  assert.equal((await community.summary(eventId)).likes, 0);
  assert.equal(
    (await community.publicEvent(eventId)).slug,
    `community-event-${suffix}`,
  );

  const attempts = await Promise.allSettled([
    community.postChat(eventId, author, "First message"),
    community.postChat(eventId, author, "Concurrent message"),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.ok(
    attempts.find((result) => result.status === "rejected").reason instanceof
      CommunityRateError,
  );
  const first = (await community.listChat(eventId)).items[0];
  assert.equal(first.body.length > 0, true);
  assert.equal("authorUserId" in first, false);
  assert.deepEqual(
    (await community.syncChat(eventId, "0", [])).items.map((item) => item.id),
    [first.id],
  );

  await Promise.all(
    Array.from({ length: 3 }, () => community.setLike(eventId, reporter, true)),
  );
  assert.equal((await community.summary(eventId, reporter)).likes, 1);
  assert.equal((await community.summary(eventId, reporter)).liked, true);
  await community.setLike(eventId, reporter, false);
  await community.setLike(eventId, reporter, false);
  assert.equal((await community.summary(eventId)).likes, 0);
  const repeatedLike = await pool.query(
    "SELECT COUNT(*)::int AS count FROM event_like_changes WHERE user_id = $1",
    [reporter],
  );
  assert.equal(repeatedLike.rows[0].count, 2);

  const duplicate = await Promise.allSettled([
    community.report(
      reporter,
      "chat",
      first.id,
      "spam",
      "Repeated unsafe content",
    ),
    community.report(
      reporter,
      "chat",
      first.id,
      "spam",
      "Repeated unsafe content",
    ),
  ]);
  assert.equal(
    duplicate.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    duplicate.find((result) => result.status === "rejected").reason.code,
    "23505",
  );
  const caseId = duplicate.find((result) => result.status === "fulfilled").value
    .id;
  await assert.rejects(
    () =>
      community.decideCase(
        caseId,
        reporter,
        "remove_chat",
        "spam",
        "Removing unsafe content",
      ),
    CommunityForbiddenError,
  );
  await community.decideCase(
    caseId,
    moderatorA,
    "remove_chat",
    "spam",
    "Removing unsafe content",
  );
  assert.equal((await community.listChat(eventId)).items.length, 0);
  assert.deepEqual(
    (await community.syncChat(eventId, first.id, [first.id])).watched,
    [],
  );
  const evidence = await community.getCase(caseId);
  assert.equal(evidence.chatBody, first.body);
  assert.deepEqual(
    evidence.history.map((entry) => entry.action),
    ["reported", "remove_chat"],
  );
  const appeal = await community.appeal(
    caseId,
    author,
    "The report misunderstood the context",
  );
  await assert.rejects(
    () =>
      community.decideAppeal(
        appeal.id,
        moderatorA,
        "overturned",
        "A mistake was made",
      ),
    CommunityForbiddenError,
  );
  await community.decideAppeal(
    appeal.id,
    moderatorB,
    "overturned",
    "The content is permissible",
  );
  assert.equal((await community.listChat(eventId)).items.length, 1);
  assert.deepEqual(
    (await community.syncChat(eventId, first.id, [first.id])).watched.map(
      (item) => item.id,
    ),
    [first.id],
  );
  await assert.rejects(
    () => community.appeal(caseId, author, "A repeated appeal is not allowed"),
    CommunityConflictError,
  );

  await pool.query(
    "UPDATE event_chat_messages SET created_at = CURRENT_TIMESTAMP - INTERVAL '20 seconds' WHERE id = $1",
    [first.id],
  );
  const second = await community.postChat(eventId, author, "Another message");
  const restrictionReport = await community.report(
    reporter,
    "chat",
    second.id,
    "harassment",
    "This is directed harassment",
  );
  await community.decideCase(
    restrictionReport.id,
    moderatorA,
    "restrict_account",
    "harassment",
    "Repeated targeted conduct",
  );
  await assert.rejects(
    () => community.postChat(eventId, author, "Blocked"),
    CommunityForbiddenError,
  );
  await assert.rejects(
    () => community.setLike(eventId, author, true),
    CommunityForbiddenError,
  );
  await assert.rejects(
    () =>
      community.report(
        author,
        "event",
        eventId,
        "other",
        "Blocked account report",
      ),
    CommunityForbiddenError,
  );
  const restrictionAppeal = await community.appeal(
    restrictionReport.id,
    author,
    "I did not direct this at anyone",
  );
  await community.decideAppeal(
    restrictionAppeal.id,
    moderatorB,
    "overturned",
    "Restriction is not justified",
  );
  assert.equal((await community.setLike(eventId, author, true)).liked, true);

  const eventReport = await community.report(
    reporter,
    "event",
    eventId,
    "other",
    "Chat needs an operational pause",
  );
  await community.decideCase(
    eventReport.id,
    moderatorA,
    "pause_chat",
    "other",
    "Pause for active moderation",
  );
  assert.equal((await community.summary(eventId)).chatState, "paused");
  await assert.rejects(
    () => community.postChat(eventId, author, "Paused"),
    CommunityConflictError,
  );
  await community.resumeChat(
    eventReport.id,
    moderatorB,
    "Review finished and chat can resume",
  );
  assert.equal((await community.summary(eventId)).chatState, "open");
  await assert.rejects(
    () =>
      community.resumeChat(
        eventReport.id,
        moderatorB,
        "Repeated resume is invalid",
      ),
    CommunityConflictError,
  );

  const reportCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM moderation_cases WHERE reporter_user_id = $1",
    [reporter],
  );
  assert.equal(reportCount.rows[0].count, 3);
  for (let number = 0; number < 2; number += 1) {
    const row = await pool.query(
      `INSERT INTO event_chat_messages (debate_id, author_user_id, body)
       VALUES ($1, $2, $3) RETURNING id`,
      [eventId, author, `Test target ${number}`],
    );
    await community.report(
      reporter,
      "chat",
      row.rows[0].id,
      "other",
      "Additional valid report",
    );
  }
  const sixth = await pool.query(
    `INSERT INTO event_chat_messages (debate_id, author_user_id, body)
     VALUES ($1, $2, 'Sixth target') RETURNING id`,
    [eventId, author],
  );
  await assert.rejects(
    () =>
      community.report(
        reporter,
        "chat",
        sixth.rows[0].id,
        "other",
        "Sixth report is limited",
      ),
    CommunityRateError,
  );
  const after = await pool.query(
    "SELECT status, rules_snapshot FROM debates WHERE id = $1",
    [eventId],
  );
  assert.equal(after.rows[0].status, "live");
  assert.equal(after.rows[0].rules_snapshot.financial_terms, "not_active");
  console.log("Community PostgreSQL integration verified");
} finally {
  try {
    await pool.query("DELETE FROM moderation_cases WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM event_chat_messages WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM event_like_changes WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM event_likes WHERE debate_id = $1", [eventId]);
    await pool.query("DELETE FROM event_chat_controls WHERE debate_id = $1", [
      eventId,
    ]);
    await pool.query("DELETE FROM debates WHERE id = $1", [eventId]);
    if (topicId)
      await pool.query("DELETE FROM topics WHERE id = $1", [topicId]);
    for (const id of profiles)
      await pool.query("DELETE FROM public_profiles WHERE id = $1", [id]);
    for (const id of users)
      await pool.query("DELETE FROM users WHERE id = $1", [id]);
  } finally {
    await pool.end();
  }
}
