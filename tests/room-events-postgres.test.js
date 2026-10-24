import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, it, before, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createDatabase } from "../dist/platform/database.js";
import { createLogger } from "../dist/platform/logger.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { defaultFanoutOptions } from "../dist/platform/room-fanout.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { createA4Repository } from "../dist/features/a4/repository.js";
import {
  createCommunityDelivery,
  publicFrame,
} from "../dist/features/community/delivery.js";
import { createCommunityStreams } from "../dist/features/community/streams.js";

// Room signals against a disposable database: commit-time capture and lock
// order, A4 privacy, payload allowlists, and SSE ordering and recovery.
// Other PostgreSQL suites share this database in parallel, so these tests
// never run the global media or A4 clocks; they drive their own rows only.
const enabled = !!process.env.A4_TEST_DATABASE_URL;
if (enabled) {
  const runtime = new URL(process.env.A4_TEST_DATABASE_URL),
    owner = new URL(process.env.A4_TEST_OWNER_URL);
  for (const url of [runtime, owner]) {
    assert.ok(
      ["localhost", "127.0.0.1"].includes(url.hostname),
      "room event tests require a local disposable database",
    );
    assert.match(
      url.pathname,
      /^\/(?:revocation_test|yaparena_a4_test)[a-z0-9_]*$/,
    );
  }
  assert.equal(runtime.username, "yaparena_runtime");
  assert.equal(owner.username, "yaparena_owner");
}
const logger = createLogger({ enabled: false });
const rules = {
  initial_speaking_time_seconds: 10,
  maximum_duration_seconds: 40,
};
// Every key a public room frame may carry, at any depth (protocol v1).
const publicKeys = new Set([
  "version",
  "roomId",
  "cursor",
  "kind",
  "snapshot",
  "changes",
  "more",
  "summary",
  "items",
  "hasMore",
  "type",
  "message",
  "refresh",
  "eventId",
  "likes",
  "chatState",
  "chatWritable",
  "eventStatus",
  "revision",
  "id",
  "debateId",
  "authorName",
  "body",
  "state",
  "createdAt",
  "streamRevision",
  "clientMessageId",
]);
function assertPublic(value, path = "frame") {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPublic(item, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(publicKeys.has(key), `${path}.${key} is not a public field`);
    assertPublic(child, `${path}.${key}`);
  }
  if ("refresh" in value) {
    assert.equal(value.type, "summary");
    assert.equal(value.message, null);
    assert.ok(["media", "round", "activity"].includes(value.refresh));
  }
}
class Response extends EventEmitter {
  writableLength = 0;
  frames = [];
  status() {
    return this;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  write(frame) {
    this.frames.push(frame.toString());
    return true;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
  destroy() {
    this.emit("close");
  }
  json(value) {
    this.body = value;
    return this;
  }
  community() {
    return this.frames
      .filter((f) => f.includes("event: community\n"))
      .map((f) => JSON.parse(f.split("\ndata: ")[1].trim()));
  }
}
const refreshes = (frames) =>
  frames.flatMap((f) => (f.changes ?? []).flatMap((c) => c.refresh ?? []));
const position = (cursor) => BigInt(cursor.split(":")[2]);
async function until(fn, label) {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error(`test deadline: ${label}`);
}

let pool, owner, sessions, media, a4, topicId;
const key = () => randomUUID();
// Live fixtures are demos: a published non-demo live debate with media would
// compete for the global featured slot that featured-postgres checks in parallel.
// Stream-eligible fixtures are therefore scheduled, non-demo debates.
async function debate(status = "live") {
  const tag = randomUUID();
  return (
    await owner.query(
      `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot,
        live_started_at,is_demo)
      VALUES($1,$2,'Should room events replace debate polling?',$3,'published','preview-1',$4,
        CASE WHEN $5 THEN clock_timestamp()-INTERVAL '1 minute' END,$5) RETURNING id`,
      [
        `rooms-${tag}`,
        topicId,
        status,
        JSON.stringify(rules),
        status === "live",
      ],
    )
  ).rows[0].id;
}
async function runningMedia(id, deadline = "60 seconds") {
  await owner.query(
    `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,
      remaining_ms,active_ms,last_resumed_at,recording_status)
    VALUES($1,'running','A',1,clock_timestamp()+$2::interval,10000,0,
      clock_timestamp()-INTERVAL '1 second','recording')`,
    [id, deadline],
  );
}
async function head(room) {
  return (
    await owner.query(
      "SELECT COALESCE((SELECT cursor::text FROM community_rooms WHERE room_id=$1),'0') AS head",
      [room],
    )
  ).rows[0].head;
}
async function events(room, after) {
  return (
    await owner.query(
      `SELECT cursor::text,kind,refresh,message_id,message_revision FROM community_room_events
      WHERE room_id=$1 AND cursor>$2 ORDER BY cursor`,
      [room, after],
    )
  ).rows;
}
// A signal is logged as a summary row naming the projection to re-read.
const kinds = (rows) => rows.map((row) => row.refresh ?? row.kind);
async function user() {
  return (await pool.query("INSERT INTO users DEFAULT VALUES RETURNING id"))
    .rows[0].id;
}
async function actor() {
  const u = (
    await pool.query(
      `INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation AS "authGeneration"`,
    )
  ).rows[0];
  const token = createSessionToken();
  await sessions.create(u.id, token.tokenHash, new Date(Date.now() + 3600000), {
    authGeneration: u.authGeneration,
  });
  return { userId: u.id, tokenHash: token.tokenHash };
}
// Drives one private sandbox to settlement through its creator's step control.
async function settleSandbox(creator, id) {
  await owner.query(
    "UPDATE a4_sessions SET reveal_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [id],
  );
  for (let i = 0; i < 8; i++) {
    const view = await a4.view(creator, id);
    if (view.state === "complete") return;
    await a4.control(creator, key(), id, "step");
  }
  throw new Error("sandbox did not settle");
}
// Human rounds advance only on the shared A4 clock; apply its guarded
// transitions to this run's rows, one transaction each. Creation already
// opens a first round whose window has started.
async function advanceHuman(id) {
  const steps = [
    ["scheduled", "state='open'"],
    ["open", "state='locked',locked_at=clock_timestamp(),snapshot='[]'"],
    [
      "locked",
      `state='priced',pricing='{"share":{"n":"7","d":"10"},"price":{"n":"3","d":"10"}}'`,
    ],
    ["priced", "state='pending'"],
    ["pending", "state='settled',revealed_at=clock_timestamp()"],
  ];
  let applied = 0;
  for (const [from, step] of steps)
    applied += (
      await pool.query(
        `UPDATE a4_rounds SET ${step} WHERE session_id=$1 AND state=$2`,
        [id, from],
      )
    ).rowCount;
  return applied;
}

describe(
  "room signals in PostgreSQL",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      pool = createDatabase(process.env.A4_TEST_DATABASE_URL, logger);
      owner = new pg.Pool({
        connectionString: process.env.A4_TEST_OWNER_URL,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      sessions = createSessionRepository(pool);
      media = createMediaRepository(pool);
      a4 = createA4Repository(pool, "bots");
      await owner.query(
        "UPDATE a4_controls SET enabled=true,bots_enabled=true",
      );
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Room events topic','Synthetic room event fixture topic','Support','Oppose','published') RETURNING id",
          [`rooms-${key()}`],
        )
      ).rows[0].id;
    });
    after(async () => {
      await pool?.end();
      await owner?.end();
    });

    it("allocates media references at commit, after a held room counter, in commit order", async () => {
      const room = await debate();
      await runningMedia(room);
      const author = await user();
      const start = await head(room);
      // An uncommitted chat message holds this room's counter until COMMIT.
      const holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query(
        "INSERT INTO event_chat_messages(debate_id,author_user_id,body,created_at) VALUES($1,$2,'First in commit order',clock_timestamp())",
        [room, author],
      );
      let paused = false;
      const pausing = media
        .pause(room, null, "Synthetic incident pauses the clock")
        .then((state) => {
          paused = true;
          return state;
        });
      await delay(300);
      // The pause already holds the media row; only its commit-time reference waits.
      assert.equal(paused, false);
      await holder.query("COMMIT");
      holder.release();
      assert.equal((await pausing).state, "paused");
      const log = await events(room, start);
      assert.deepEqual(kinds(log), ["message", "media"]);
      assert.ok(BigInt(log[0].cursor) < BigInt(log[1].cursor));
      // A server from before signals reads only the original columns, so it
      // sends this row as the summary change its clients already accept.
      assert.equal(log[1].kind, "summary");
      assert.equal(log[1].message_id, null);
      assert.equal(log[1].message_revision, null);
      const snapshot = await media.getPublicSnapshot(room);
      assert.equal(snapshot.streamRevision, log[1].cursor);
      assert.equal(snapshot.state.state, "paused");
    });

    it("signals once per transaction, never for private columns, and nothing on rollback", async () => {
      const room = await debate();
      await runningMedia(room);
      let start = await head(room);
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        for (let i = 0; i < 2; i++)
          await writer.query(
            "UPDATE debate_media SET turn_number=turn_number+1,revision=revision+1 WHERE debate_id=$1",
            [room],
          );
        const inside = await writer.query(
          "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
          [room],
        );
        assert.equal(inside.rows[0].cursor, start, "deferred to COMMIT");
        await writer.query("COMMIT");
        assert.deepEqual(kinds(await events(room, start)), ["media"]);
        start = await head(room);
        await writer.query("BEGIN");
        await writer.query(
          "UPDATE debate_media SET turn_number=turn_number+1,revision=revision+1 WHERE debate_id=$1",
          [room],
        );
        await writer.query("ROLLBACK");
        await writer.query(
          `UPDATE debate_media SET incident='Private operator note',stop_requested_at=clock_timestamp(),
          updated_at=clock_timestamp() WHERE debate_id=$1`,
          [room],
        );
      } finally {
        writer.release();
      }
      assert.deepEqual(await events(room, start), []);
      assert.equal(await head(room), start);
    });

    it("orders an automatic ending's lifecycle summary before its media reference", async () => {
      const room = await debate();
      await runningMedia(room, "-1 second");
      const start = await head(room);
      // The media clock's maximum-duration ending, written as one transaction.
      const clock = await pool.connect();
      try {
        await clock.query("BEGIN");
        await clock.query(
          `UPDATE debates SET status='ended',live_ended_at=clock_timestamp(),
          ended_reason='maximum_duration',updated_at=clock_timestamp() WHERE id=$1`,
          [room],
        );
        await clock.query(
          `UPDATE debate_media SET state='ended',active_side=NULL,turn_deadline_at=NULL,
          last_resumed_at=NULL,recording_status='processing',revision=revision+1 WHERE debate_id=$1`,
          [room],
        );
        await clock.query("COMMIT");
      } finally {
        clock.release();
      }
      // The debate row's immediate capture precedes the commit-time media reference.
      assert.deepEqual(kinds(await events(room, start)), ["summary", "media"]);
      const snapshot = await media.getPublicSnapshot(room);
      assert.equal(snapshot.streamRevision, await head(room));
      assert.equal(snapshot.state.state, "ended");
    });

    it("signals human rounds, and private sandboxes only once their result is public", async () => {
      const shared = await debate("scheduled");
      const creator = await actor();
      let start = await head(shared);
      const human = await a4.create(creator, key(), {
        debateId: shared,
        mode: "human",
        config: { roundSeconds: 60 },
      });
      assert.deepEqual(kinds(await events(shared, start)), ["round"]);
      start = await head(shared);
      // Locked, priced, executed and settled: one reference each.
      assert.equal(await advanceHuman(human.id), 4);
      assert.deepEqual(
        kinds(await events(shared, start)),
        Array(4).fill("round"),
      );
      // Several rounds changing in one transaction produce one reference.
      const batch = await debate("scheduled");
      const periods = await a4.create(await actor(), key(), {
        debateId: batch,
        mode: "human",
        config: { roundSeconds: 60, periods: 3, delayed: true },
      });
      start = await head(batch);
      await pool.query(
        "UPDATE a4_rounds SET state='void' WHERE session_id=$1",
        [periods.id],
      );
      assert.deepEqual(kinds(await events(batch, start)), ["round"]);

      const sandboxRoom = await debate("scheduled");
      start = await head(sandboxRoom);
      const sandbox = await a4.create(creator, key(), {
        debateId: sandboxRoom,
        mode: "mixed",
        config: { population: 10, roundSeconds: 60 },
      });
      await settleSandbox(creator, sandbox.id);
      assert.deepEqual(await events(sandboxRoom, start), []);

      start = await head(sandboxRoom);
      await a4.publication(creator, true);
      assert.deepEqual(kinds(await events(sandboxRoom, start)), ["activity"]);
      start = await head(sandboxRoom);
      const published = await a4.create(creator, key(), {
        debateId: sandboxRoom,
        mode: "mixed",
        config: { population: 10, roundSeconds: 60 },
      });
      await settleSandbox(creator, published.id);
      // Opening, locking and pricing stay silent; settlement publishes.
      assert.deepEqual(kinds(await events(sandboxRoom, start)), ["activity"]);
      start = await head(sandboxRoom);
      const sharedStart = await head(shared);
      await a4.publication(creator, false);
      assert.deepEqual(kinds(await events(sandboxRoom, start)), ["activity"]);
      assert.deepEqual(await events(shared, sharedStart), []);

      const seeded = await debate("scheduled");
      start = await head(seeded);
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO a4_synthetic_debates(debate_id,arguments,category)
          VALUES($1,'[{"stance":"for","text":"One"},{"stance":"against","text":"Two"}]','Ideas')`,
          [seeded],
        );
        for (let i = 1; i <= 3; i++)
          await client.query(
            `INSERT INTO a4_synthetic_rounds(id,debate_id,seed_key,simulated_at,seed,result)
            VALUES($1,$2,$3,clock_timestamp()-INTERVAL '1 hour','seed','{}')`,
            [randomUUID(), seeded, `rooms-${key()}`],
          );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assert.deepEqual(kinds(await events(seeded, start)), ["activity"]);
    });

    it("projects references through allowlisted public frames only", async () => {
      const room = await debate("scheduled");
      await runningMedia(room);
      const start = await head(room);
      const creator = await actor();
      await media.stop(room, "Private incident reason never leaves");
      const run = await a4.create(creator, key(), {
        debateId: room,
        mode: "human",
        config: { roundSeconds: 60 },
      });
      await advanceHuman(run.id);
      await a4.publication(creator, true);
      const sandbox = await a4.create(creator, key(), {
        debateId: room,
        mode: "mixed",
        config: { population: 10, roundSeconds: 60 },
      });
      await settleSandbox(creator, sandbox.id);
      const delivery = createCommunityDelivery(pool);
      const value = await delivery.read(room, start);
      const frame = publicFrame(room, start, value);
      assert.equal(frame.kind, "changes");
      assertPublic(frame);
      assert.deepEqual(refreshes([frame]), [
        "media",
        ...Array(5).fill("round"),
        "activity",
      ]);
      const text = JSON.stringify(frame);
      const round = (
        await owner.query(
          "SELECT seed,seed_commitment FROM a4_rounds WHERE session_id=$1",
          [run.id],
        )
      ).rows[0];
      for (const secret of [
        "Private incident reason",
        round.seed,
        round.seed_commitment,
        sandbox.id,
        run.id,
      ])
        assert.ok(!text.includes(secret));
      assertPublic(publicFrame(room, null, value));
      delivery.stop();
    });

    it("streams signals in commit order and recovers them from a cursor or a snapshot", async () => {
      const room = await debate("scheduled");
      await runningMedia(room);
      const streams = createCommunityStreams(
        pool,
        process.env.A4_TEST_DATABASE_URL,
        { warn() {} },
        { count() {}, streams() {}, rooms() {}, lag() {} },
        { ...defaultFanoutOptions, reconcileMs: 100, heartbeatMs: 60000 },
      );
      await streams.start();
      try {
        const live = new Response();
        streams.subscribe(room, null, "198.51.100.7", live);
        await until(() => live.community().length, "snapshot");
        const [snapshot] = live.community();
        assert.equal(snapshot.kind, "snapshot");
        const author = await user();
        const creator = await actor();
        await pool.query(
          "INSERT INTO event_chat_messages(debate_id,author_user_id,body,created_at) VALUES($1,$2,'Signals follow chat',clock_timestamp())",
          [room, author],
        );
        await media.stop(room, "Synthetic incident ends the media");
        await a4.create(creator, key(), {
          debateId: room,
          mode: "human",
          config: { roundSeconds: 60 },
        });
        await until(() => refreshes(live.community()).length >= 2, "signals");
        const frames = live.community();
        frames.forEach((frame) => assertPublic(frame));
        for (let i = 1; i < frames.length; i++)
          assert.ok(
            position(frames[i].cursor) > position(frames[i - 1].cursor),
          );
        const changes = frames.slice(1).flatMap((frame) => frame.changes);
        assert.deepEqual(
          changes.map((c) => c.refresh ?? c.type),
          ["message", "media", "round"],
        );

        // A reconnect from the snapshot cursor replays the same references.
        const resumed = new Response();
        streams.subscribe(
          room,
          position(snapshot.cursor).toString(),
          "198.51.100.8",
          resumed,
        );
        await until(
          () => refreshes(resumed.community()).length >= 2,
          "catch-up",
        );
        assert.equal(resumed.community()[0].kind, "changes");
        assert.deepEqual(
          resumed
            .community()
            .flatMap((frame) => frame.changes)
            .map((c) => c.refresh ?? c.type),
          ["message", "media", "round"],
        );
        const http = publicFrame(
          room,
          position(snapshot.cursor).toString(),
          await createCommunityDelivery(pool).read(
            room,
            position(snapshot.cursor).toString(),
          ),
        );
        assert.deepEqual(
          http.changes.map((c) => c.refresh ?? c.type),
          ["message", "media", "round"],
        );

        // Below the retained floor the client receives a fresh snapshot instead.
        await owner.query(
          "UPDATE community_rooms SET retained_after=cursor WHERE room_id=$1",
          [room],
        );
        const expired = new Response();
        streams.subscribe(
          room,
          position(snapshot.cursor).toString(),
          "198.51.100.9",
          expired,
        );
        await until(() => expired.community().length, "reset");
        assert.equal(expired.community()[0].kind, "snapshot");
        assertPublic(expired.community()[0]);
      } finally {
        await streams.stop();
      }
    });
  },
);
