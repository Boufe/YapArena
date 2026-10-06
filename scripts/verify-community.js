import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  createCommunityRepository,
  CommunityConflictError,
  CommunityForbiddenError,
  CommunityRateError,
  CommunityNotFoundError,
} from "../dist/features/community/repository.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_FIXTURE_URL ?? process.env.DATABASE_URL,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
  max: 8,
});
const runtimePool = process.env.COMMUNITY_RUNTIME_URL
  ? new pg.Pool({
      connectionString: process.env.COMMUNITY_RUNTIME_URL,
      max: 8,
      options: "-c search_path=pg_catalog,yaparena,pg_temp",
    })
  : pool;
const community = createCommunityRepository(runtimePool);
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

  const clientMessageId = randomUUID();
  const identical = await Promise.all(
    Array.from({ length: 8 }, () =>
      community.postChat(eventId, author, " First message ", clientMessageId),
    ),
  );
  assert.equal(new Set(identical.map((item) => item.id)).size, 1);
  assert.equal(identical[0].clientMessageId, clientMessageId);
  const acceptedCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM event_chat_messages WHERE author_user_id = $1",
    [author],
  );
  assert.equal(
    acceptedCount.rows[0].count,
    1,
    "eight identical requests consume one allowance",
  );
  const conflicts = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      community.postChat(eventId, author, "Changed text", clientMessageId),
    ),
  );
  assert.ok(
    conflicts.every(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "CHAT_PAYLOAD_CONFLICT",
    ),
  );
  const next = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      community.postChat(
        eventId,
        author,
        "Different logical submission",
        randomUUID(),
      ),
    ),
  );
  assert.ok(
    next.every(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof CommunityRateError &&
        result.reason.retryAfterSeconds >= 1 &&
        result.reason.retryAfterSeconds <= 10,
    ),
  );
  assert.deepEqual(
    await community.postChat(eventId, author, "First message", clientMessageId),
    identical[0],
  );
  const owned = (await community.listChat(eventId, undefined, author)).items[0];
  assert.deepEqual(
    owned,
    identical[0],
    "POST and history share the same message shape",
  );
  assert.deepEqual(
    (await community.syncChat(eventId, "0", [], author)).items[0],
    owned,
  );
  const collisionUser = await person("key-scope");
  const scoped = await community.postChat(
    eventId,
    collisionUser,
    "Other account same key",
    clientMessageId,
  );
  assert.notEqual(
    scoped.id,
    owned.id,
    "keys are scoped to authenticated account and event",
  );
  assert.equal(
    (await community.listChat(eventId, undefined, author)).items.find(
      (item) => item.id === scoped.id,
    ).clientMessageId,
    null,
  );
  await pool.query("DELETE FROM event_chat_messages WHERE id = $1", [
    scoped.id,
  ]);

  // Competing payloads for a previously unseen key choose one binding atomically.
  const competingUser = await person("competing");
  const competingKey = randomUUID();
  const competing = await Promise.allSettled([
    community.postChat(eventId, competingUser, "Payload A", competingKey),
    community.postChat(eventId, competingUser, "Payload B", competingKey),
  ]);
  assert.equal(
    competing.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.equal(
    competing.find((item) => item.status === "rejected").reason.code,
    "CHAT_PAYLOAD_CONFLICT",
  );
  await pool.query(
    "DELETE FROM event_chat_messages WHERE author_user_id = $1",
    [competingUser],
  );

  const distinctUser = await person("distinct-keys");
  const distinct = await Promise.allSettled([
    community.postChat(eventId, distinctUser, "New submission A", randomUUID()),
    community.postChat(eventId, distinctUser, "New submission B", randomUUID()),
  ]);
  assert.equal(
    distinct.filter((item) => item.status === "fulfilled").length,
    1,
  );
  assert.ok(
    distinct.find((item) => item.status === "rejected").reason instanceof
      CommunityRateError,
    "concurrent distinct keys cannot bypass the account allowance",
  );
  await pool.query("DELETE FROM event_chat_messages WHERE author_user_id=$1", [
    distinctUser,
  ]);

  const hourlyUser = await person("hourly");
  await pool.query(
    `INSERT INTO event_chat_messages (debate_id, author_user_id, body, created_at)
    SELECT $1, $2, 'Hourly synthetic ' || n, clock_timestamp() - (20 + n * 10) * INTERVAL '1 second' FROM generate_series(1, 30) n`,
    [eventId, hourlyUser],
  );
  await assert.rejects(
    () =>
      community.postChat(
        eventId,
        hourlyUser,
        "Over hourly quota",
        randomUUID(),
      ),
    (error) =>
      error.code === "CHAT_HOURLY_LIMIT" &&
      error.retryAfterSeconds > 3200 &&
      error.retryAfterSeconds <= 3600,
  );
  await pool.query(
    "DELETE FROM event_chat_messages WHERE author_user_id = $1",
    [hourlyUser],
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
  const removedAck = await community.postChat(
    eventId,
    author,
    "First message",
    clientMessageId,
  );
  assert.equal(removedAck.body, null);
  assert.equal(removedAck.state, "removed");
  assert.equal(removedAck.revision, "1");
  assert.deepEqual(
    (await community.syncChat(eventId, "0", [first.id], author)).removed,
    [removedAck],
  );
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
  const restrictedAck = await community.postChat(
    eventId,
    author,
    "First message",
    clientMessageId,
  );
  assert.equal(restrictedAck.id, first.id);
  assert.equal(
    restrictedAck.revision,
    "2",
    "restoration increments the moderation revision",
  );
  await pool.query(
    "UPDATE public_profiles SET publication_state='draft' WHERE user_id=$1",
    [author],
  );
  assert.equal(
    (
      await community.postChat(
        eventId,
        author,
        "First message",
        clientMessageId,
      )
    ).id,
    first.id,
    "unpublishing the author profile still allows acknowledgment",
  );
  await pool.query(
    "UPDATE public_profiles SET publication_state='published' WHERE user_id=$1",
    [author],
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
  assert.equal(
    (
      await community.postChat(
        eventId,
        author,
        "First message",
        clientMessageId,
      )
    ).id,
    first.id,
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
  assert.equal(
    (
      await community.postChat(
        eventId,
        author,
        "First message",
        clientMessageId,
        false,
      )
    ).id,
    first.id,
    "pause and revoked posting role still permit acknowledgment",
  );
  await pool.query("UPDATE debates SET status = 'ended' WHERE id = $1", [
    eventId,
  ]);
  assert.equal(
    (
      await community.postChat(
        eventId,
        author,
        "First message",
        clientMessageId,
      )
    ).id,
    first.id,
  );
  await assert.rejects(
    () => community.postChat(eventId, author, "Closed new write", randomUUID()),
    CommunityConflictError,
  );
  await pool.query(
    "UPDATE debates SET publication_state = 'draft' WHERE id = $1",
    [eventId],
  );
  await assert.rejects(
    () => community.postChat(eventId, author, "First message", clientMessageId),
    CommunityNotFoundError,
  );
  await pool.query(
    "UPDATE debates SET status = 'live', publication_state = 'published' WHERE id = $1",
    [eventId],
  );
  await pool.query("UPDATE topics SET publication_state='draft' WHERE id=$1", [
    topicId,
  ]);
  await assert.rejects(
    () => community.postChat(eventId, author, "First message", clientMessageId),
    CommunityNotFoundError,
  );
  await pool.query(
    "UPDATE topics SET publication_state='published' WHERE id=$1",
    [topicId],
  );
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
    CommunityNotFoundError,
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
    if (runtimePool !== pool) await runtimePool.end();
    await pool.end();
  }
}
