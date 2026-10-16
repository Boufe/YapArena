import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import pg from "pg";
import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";

it(
  "ranks playable public debates by revealed human YAP volume, excluding private and pending activity",
  { skip: !process.env.A4_TEST_DATABASE_URL },
  async () => {
    for (const name of ["A4_TEST_DATABASE_URL", "A4_TEST_OWNER_URL"]) {
      const url = new URL(process.env[name]);
      assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
      assert.match(
        url.pathname,
        /^\/(?:revocation_test|yaparena_a4_test)[a-z0-9_]*$/,
      );
    }
    const owner = new pg.Pool({
      connectionString: process.env.A4_TEST_OWNER_URL,
      options: "-c search_path=pg_catalog,yaparena,pg_temp",
    });
    const runtime = new pg.Pool({
      connectionString: process.env.A4_TEST_DATABASE_URL,
      options: "-c search_path=pg_catalog,yaparena,pg_temp",
    });
    const tag = randomUUID(),
      debateIds = [],
      sessionIds = [];
    let topicId, userId;
    try {
      userId = (
        await owner.query(
          "INSERT INTO users(email,password_hash) VALUES ($1,'synthetic-test-only') RETURNING id",
          [`hero-${tag}@example.test`],
        )
      ).rows[0].id;
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES ($1,'Hero ranking fixture','Synthetic local trial','Yes','No','published') RETURNING id",
          [`hero-${tag}`],
        )
      ).rows[0].id;
      async function debate(
        name,
        year,
        { replay = false, hidden = false, demo = false, ready = true } = {},
      ) {
        const id = randomUUID();
        debateIds.push(id);
        await owner.query(
          `INSERT INTO debates(id,slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot,live_started_at,is_demo)
        SELECT $1,$2,$3,$4,$5,$6,version,rules,$7,$8 FROM event_rule_versions WHERE version='prototype-media-1'`,
          [
            id,
            `hero-${name}-${tag}`,
            topicId,
            name,
            replay ? "replay" : "live",
            hidden ? "hidden" : "published",
            `${year}-01-01T00:00:00Z`,
            demo,
          ],
        );
        await owner.query(
          "INSERT INTO debate_media(debate_id,state,recording_status,recording_key) VALUES ($1,$2,$3,$4)",
          [
            id,
            replay ? "ended" : "running",
            ready ? "ready" : "processing",
            ready ? `debates/${id}/test.mp4` : null,
          ],
        );
        return id;
      }
      async function volume(
        debateId,
        premium,
        {
          mode = "human",
          settled = true,
          future = false,
          executed = true,
        } = {},
      ) {
        const session = randomUUID(),
          round = randomUUID();
        sessionIds.push(session);
        await owner.query(
          "INSERT INTO a4_sessions(id,creator_id,debate_id,asset,mode,state,config,seed,reveal_at,proposition,topic_id) VALUES ($1,$2,$3,'YAP',$4,'complete','{}','test',clock_timestamp()+$5::interval,'Synthetic ranking fixture',$6)",
          [
            session,
            userId,
            debateId,
            mode,
            future ? "1 day" : "-1 day",
            topicId,
          ],
        );
        await owner.query(
          "INSERT INTO a4_rounds(id,session_id,asset,period,state,opens_at,closes_at,seed,seed_commitment,revealed_at) VALUES ($1,$2,'YAP',1,$3,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day','test','test',clock_timestamp()-interval '1 hour')",
          [round, session, settled ? "settled" : "pending"],
        );
        await owner.query(
          "INSERT INTO a4_submissions(round_id,asset,participant,user_id,kind,side,limit_value,quantity,request_key,outcome) VALUES ($1,'YAP',$2,$3,'human','YES','1',1,$4,$5)",
          [
            round,
            `user:${userId}`,
            userId,
            randomUUID(),
            { executed, premium: String(premium) },
          ],
        );
      }
      const a = await debate("a", 2091),
        b = await debate("b", 2092),
        c = await debate("c", 2093),
        replay = await debate("replay", 2094, { replay: true });
      await volume(a, 100);
      await volume(b, 200);
      await volume(replay, 900000000000);
      await volume(c, 900000000000, { mode: "mixed" });
      await volume(c, 900000000000, { mode: "observer" });
      await volume(c, 900000000000, { settled: false });
      await volume(c, 900000000000, { future: true });
      await volume(c, 900000000000, { executed: false });
      await owner.query(
        "INSERT INTO event_likes(debate_id,user_id) VALUES ($1,$2)",
        [c, userId],
      );
      for (const options of [
        { hidden: true },
        { demo: true },
        { replay: true, ready: false },
      ]) {
        const excluded = await debate(
          `excluded-${debateIds.length}`,
          2095,
          options,
        );
        await volume(excluded, 900000000000);
      }
      const repository = createDiscoveryRepository(runtime);
      assert.equal((await repository.getFeaturedDebate()).id, b);
      await volume(a, 100);
      assert.equal(
        (await repository.getFeaturedDebate()).id,
        b,
        "newer live debate wins equal-volume tie",
      );
      await volume(a, 1);
      assert.equal((await repository.getFeaturedDebate()).id, a);
      await owner.query(
        "UPDATE debates SET publication_state='hidden' WHERE id=ANY($1::uuid[]) AND status='live'",
        [debateIds],
      );
      assert.equal((await repository.getFeaturedDebate()).id, replay);
      await owner.query(
        "UPDATE topics SET publication_state='hidden' WHERE id=$1",
        [topicId],
      );
      assert.notEqual((await repository.getFeaturedDebate())?.id, replay);
    } finally {
      if (sessionIds.length) {
        await owner.query(
          "DELETE FROM a4_submissions WHERE round_id IN (SELECT id FROM a4_rounds WHERE session_id=ANY($1::uuid[]))",
          [sessionIds],
        );
        await owner.query(
          "DELETE FROM a4_rounds WHERE session_id=ANY($1::uuid[])",
          [sessionIds],
        );
        await owner.query("DELETE FROM a4_sessions WHERE id=ANY($1::uuid[])", [
          sessionIds,
        ]);
      }
      if (debateIds.length)
        await owner.query(
          "DELETE FROM event_likes WHERE debate_id=ANY($1::uuid[])",
          [debateIds],
        );
      if (debateIds.length)
        await owner.query("DELETE FROM debates WHERE id=ANY($1::uuid[])", [
          debateIds,
        ]);
      if (topicId)
        await owner.query("DELETE FROM topics WHERE id=$1", [topicId]);
      if (userId) await owner.query("DELETE FROM users WHERE id=$1", [userId]);
      await Promise.all([owner.end(), runtime.end()]);
    }
  },
);
