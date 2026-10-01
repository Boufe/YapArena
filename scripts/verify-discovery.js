import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().slice(0, 8);
const publicTopicSlug = `verify-public-${suffix}`;
const hiddenTopicSlug = `verify-hidden-${suffix}`;
const visibleDebateSlug = `verify-visible-${suffix}`;
const hiddenDebateSlug = `verify-private-${suffix}`;
const hiddenTopicDebateSlug = `verify-unlisted-${suffix}`;
const hiddenHandle = `verify-person-${suffix}`;

await client.connect();
try {
  await client.query("BEGIN");
  const insertTopic = async (slug, publicationState) => {
    const result = await client.query(
      `INSERT INTO topics (slug, title, summary, side_a_label, side_b_label, publication_state)
       VALUES ($1, 'Verification topic', 'Temporary test data', 'For', 'Against', $2)
       RETURNING id`,
      [slug, publicationState],
    );
    return result.rows[0].id;
  };
  const publicTopicId = await insertTopic(publicTopicSlug, "published");
  const hiddenTopicId = await insertTopic(hiddenTopicSlug, "hidden");
  const profileResult = await client.query(
    `INSERT INTO public_profiles (handle, display_name, publication_state)
     VALUES ($1, 'Private speaker', 'hidden') RETURNING id`,
    [hiddenHandle],
  );
  const hiddenProfileId = profileResult.rows[0].id;
  const insertDebate = async (
    slug,
    topicId,
    publicationState,
    profileId = null,
  ) => {
    await client.query(
      `INSERT INTO debates (slug, topic_id, proposition, speaker_a_profile_id,
        status, publication_state, rules_version, rules_snapshot)
       SELECT $1, $2, 'Verification proposition', $3, 'scheduled', $4, r.version, r.rules
       FROM event_rule_versions r WHERE r.version = 'preview-1'`,
      [slug, topicId, profileId, publicationState],
    );
  };
  await insertDebate(
    visibleDebateSlug,
    publicTopicId,
    "published",
    hiddenProfileId,
  );
  await insertDebate(hiddenDebateSlug, publicTopicId, "hidden");
  await insertDebate(hiddenTopicDebateSlug, hiddenTopicId, "published");

  const repository = createDiscoveryRepository(client);
  assert.equal(
    (await repository.getTopic(publicTopicSlug)).slug,
    publicTopicSlug,
  );
  assert.equal(await repository.getTopic(hiddenTopicSlug), null);
  assert.equal(await repository.getProfile(hiddenHandle), null);
  const visible = await repository.getDebate(visibleDebateSlug);
  assert.equal(visible.slug, visibleDebateSlug);
  assert.equal(visible.speakerA, null);
  assert.equal(await repository.getDebate(hiddenDebateSlug), null);
  assert.equal(await repository.getDebate(hiddenTopicDebateSlug), null);
  const list = await repository.listDebates({
    topicSlug: publicTopicSlug,
    limit: 1,
  });
  assert.deepEqual(
    list.items.map(({ slug }) => slug),
    [visibleDebateSlug],
  );
  assert.equal(list.pagination.hasMore, false);
  const hiddenList = await repository.listDebates({
    topicSlug: hiddenTopicSlug,
  });
  assert.deepEqual(hiddenList.items, []);
  console.log("PostgreSQL publication visibility verified.");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
