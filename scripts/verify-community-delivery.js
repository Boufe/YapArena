import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createCommunityRepository } from "../dist/features/community/repository.js";
import {
  createCommunityDelivery,
  parseRoomCursor,
} from "../dist/features/community/delivery.js";
import { createCommunityStreams } from "../dist/features/community/streams.js";
import { createMatchingRepository } from "../dist/features/matching/repository.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import {
  createRoomFanout,
  defaultFanoutOptions,
} from "../dist/platform/room-fanout.js";

export class TrialResponse extends EventEmitter {
  writableLength = 0;
  frames = [];
  statusCode = 0;
  closed = false;
  blocked = false;
  status(code) {
    this.statusCode = code;
    return this;
  }
  set() {
    return this;
  }
  json(value) {
    this.jsonBody = value;
    this.end();
    return this;
  }
  flushHeaders() {}
  write(frame) {
    this.frames.push(frame.toString());
    return !this.blocked;
  }
  end() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }
  destroy() {
    this.end();
  }
  data() {
    return this.frames.flatMap((frame) => {
      const line = frame.split("\n").find((line) => line.startsWith("data: "));
      return line ? [JSON.parse(line.slice(6))] : [];
    });
  }
}
async function until(condition, timeout = 10000) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeout)
      throw new Error("durable trial deadline");
    await delay(10);
  }
}
export async function verifyCommunityDelivery({ pool, owner, admin, url }) {
  const resources = [];
  const repository = createCommunityRepository(pool);
  const delivery = createCommunityDelivery(pool);
  const tag = randomUUID().slice(0, 8);
  const topic = (
    await owner.query(
      `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
    VALUES($1,'Durable synthetic trial','Synthetic','For','Against','published') RETURNING id`,
      [`durable-${tag}`],
    )
  ).rows[0].id;
  const room = (
    await owner.query(
      `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot,live_started_at)
    SELECT $1,$2,'Synthetic durable trial','live','published',version,rules,clock_timestamp() FROM event_rule_versions WHERE version='preview-1' RETURNING id`,
      [`durable-${tag}`, topic],
    )
  ).rows[0].id;
  const users = [];
  for (let i = 0; i < 5; i++) {
    const user = (
      await owner.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id",
        [`durable-${tag}-${i}@example.test`],
      )
    ).rows[0].id;
    users.push(user);
    await owner.query(
      "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,$2,'Synthetic author','published')",
      [user, `durable-${tag}-${i}`],
    );
  }
  const counts = {};
  let active = 0;
  let activeRooms = 0;
  const metrics = {
    count: (kind) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
    },
    streams: (value) => {
      active = value;
    },
    rooms: (value) => {
      activeRooms = value;
    },
    lag() {},
  };
  const notify = new pg.Client({ connectionString: url });
  await notify.connect();
  const hints = [];
  notify.on("notification", (value) => hints.push(value.payload));
  await notify.query("LISTEN yaparena_community_v1");
  const head = async () =>
    (
      await owner.query(
        "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
        [room],
      )
    ).rows[0].cursor;
  const initial = await head();
  const a = await pool.connect();
  const b = await pool.connect();
  const insert = (client, body) =>
    client.query(
      "INSERT INTO event_chat_messages(debate_id,author_user_id,body) VALUES($1,$2,$3) RETURNING id,stream_revision::text",
      [room, users[0], body],
    );
  try {
    await a.query("BEGIN");
    await insert(a, "Rolled back synthetic message");
    assert.equal(await head(), initial);
    await a.query("ROLLBACK");
    await delay(30);
    assert.equal(await head(), initial);
    assert.equal(hints.length, 0);
    assert.equal((await delivery.read(room, initial)).events.length, 0);
    await a.query("BEGIN");
    const first = (await insert(a, "First synthetic commit")).rows[0];
    await b.query("BEGIN");
    let secondDone = false;
    const waitStart = performance.now();
    const secondPromise = insert(b, "Second synthetic commit").then((value) => {
      secondDone = true;
      return value.rows[0];
    });
    await delay(100);
    assert.equal(secondDone, false, "same-room allocator must block to commit");
    assert.equal(await head(), initial);
    assert.equal(hints.length, 0);
    await a.query("COMMIT");
    const second = await secondPromise;
    await b.query("COMMIT");
    assert.equal(
      BigInt(second.stream_revision),
      BigInt(first.stream_revision) + 1n,
    );
    await until(() => hints.length >= 2);
    const serializedWaitMs = Math.round(performance.now() - waitStart);
    const creationCursor = await head();
    // Remove the earlier acceptance before replay; even its creation projects a tombstone.
    await owner.query(
      "UPDATE event_chat_messages SET state='removed' WHERE id=$1",
      [first.id],
    );
    const safeReplay = await delivery.read(room, initial);
    assert.ok(
      safeReplay.events
        .filter((e) => e.message?.id === first.id)
        .every((e) => e.message.body === null),
    );
    assert.equal(safeReplay.summary.likes, "0");
    assert.ok(
      safeReplay.items.every(
        (item) =>
          item.clientMessageId === null && !Object.hasOwn(item, "authorUserId"),
      ),
    );
    await owner.query(
      "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '20 seconds' WHERE debate_id=$1",
      [room],
    );
    const key = randomUUID();
    const accepted = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.postChat(
          room,
          users[0],
          "Canonical synthetic submission",
          key,
        ),
      ),
    );
    assert.equal(new Set(accepted.map((m) => m.id)).size, 1);
    const acceptedHead = await head();
    await repository.postChat(
      room,
      users[0],
      "Canonical synthetic submission",
      key,
    );
    assert.equal(
      await head(),
      acceptedHead,
      "retry cannot append or consume another allowance",
    );
    await assert.rejects(
      repository.postChat(
        room,
        users[0],
        "Conflicting synthetic submission",
        key,
      ),
      (error) => error.code === "CHAT_PAYLOAD_CONFLICT",
    );
    const report = await repository.report(
      users[1],
      "chat",
      accepted[0].id,
      "spam",
      "Synthetic trial report detail",
    );
    await repository.decideCase(
      report.id,
      users[2],
      "remove_chat",
      "spam",
      "Synthetic removal decision",
    );
    const removed = await repository.postChat(
      room,
      users[0],
      "Canonical synthetic submission",
      key,
      false,
    );
    assert.equal(removed.body, null);
    assert.equal(removed.state, "removed");
    assert.ok(
      (await delivery.read(room, creationCursor)).events
        .filter((e) => e.message?.id === removed.id)
        .every((e) => e.message.body === null),
    );
    const appeal = await repository.appeal(
      report.id,
      users[0],
      "Synthetic appeal explanation",
    );
    await repository.decideAppeal(
      appeal.id,
      users[3],
      "overturned",
      "Synthetic independent reversal",
    );
    const restored = await repository.postChat(
      room,
      users[0],
      "Canonical synthetic submission",
      key,
      false,
    );
    assert.equal(restored.state, "visible");
    assert.ok(BigInt(restored.revision) > BigInt(removed.revision));
    assert.equal(
      (await repository.reconcileSubmissions(room, users[0], [key])).length,
      1,
    );
    assert.equal(
      (await repository.reconcileSubmissions(room, users[1], [key])).length,
      0,
    );

    const streams = createCommunityStreams(pool, url, { warn() {} }, metrics, {
      ...defaultFanoutOptions,
      reconcileMs: 50,
      heartbeatMs: 100,
    });
    const process2 = createCommunityStreams(pool, url, { warn() {} }, metrics, {
      ...defaultFanoutOptions,
      reconcileMs: 50,
      heartbeatMs: 100,
    });
    resources.push(streams, process2);
    await streams.start();
    await process2.start();
    const viewer = new TrialResponse();
    const other = new TrialResponse();
    streams.subscribe(room, null, "synthetic-shared-ip", viewer);
    process2.subscribe(room, null, "synthetic-shared-ip", other);
    await until(
      () =>
        viewer.data().some((f) => f.kind === "snapshot") &&
        other.data().some((f) => f.kind === "snapshot"),
    );
    const snapshot = viewer.data().find((f) => f.kind === "snapshot");
    assert.equal(snapshot.snapshot.summary.eventStatus, "live");
    assert.equal(
      parseRoomCursor(room, snapshot.cursor),
      snapshot.snapshot.summary.revision,
    );
    // Kill both listener sessions. Committed changes must survive lost wakeups and re-LISTEN.
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name='yaparena-community-listener' AND usename='yaparena_runtime'`);
    const restartAt = performance.now();
    await repository.setLike(room, users[1], true);
    await until(
      () =>
        viewer
          .data()
          .some((f) => f.changes?.some((e) => e.summary.likes === "1")) &&
        other
          .data()
          .some((f) => f.changes?.some((e) => e.summary.likes === "1")),
    );
    const missedHintRecoveryMs = Math.round(performance.now() - restartAt);
    await until(() => counts.listener_connected >= 4);
    assert.ok(counts.listener_failure >= 2);
    const eventReport = await repository.report(
      users[1],
      "event",
      room,
      "spam",
      "Synthetic event pause report",
    );
    await repository.decideCase(
      eventReport.id,
      users[2],
      "pause_chat",
      "spam",
      "Synthetic event pause decision",
    );
    assert.equal((await delivery.read(room, "0")).summary.chatWritable, false);
    await repository.resumeChat(
      eventReport.id,
      users[3],
      "Synthetic chat resume decision",
    );
    assert.equal((await delivery.read(room, "0")).summary.chatWritable, true);
    // Deletion changes both the public projection and its log in one transaction.
    await owner.query(
      "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '366 days' WHERE id=$1",
      [second.id],
    );
    await owner.query(
      "UPDATE event_likes SET created_at=clock_timestamp()-INTERVAL '366 days' WHERE debate_id=$1",
      [room],
    );
    const beforePrune = await head();
    const pruned = await repository.pruneExpired();
    assert.ok(pruned.chat >= 1 && pruned.likes >= 1);
    const retention = await delivery.read(room, beforePrune);
    assert.equal(retention.summary.likes, "0");
    assert.ok(
      retention.events.some(
        (e) => e.message?.id === second.id && e.message.state === "removed",
      ),
    );
    await owner.query(
      "UPDATE community_room_events SET occurred_at=clock_timestamp()-INTERVAL '8 days' WHERE room_id=$1",
      [room],
    );
    assert.ok((await delivery.prune()) > 0);
    const reset = new TrialResponse();
    streams.subscribe(room, "0", "synthetic-reset", reset);
    await until(() => reset.data().some((f) => f.kind === "snapshot"));
    assert.ok(BigInt((await delivery.read(room, "0")).floor) > 0n);
    const future = new TrialResponse();
    streams.subscribe(room, "9223372036854775807", "synthetic-future", future);
    await until(() => future.data().some((f) => f.kind === "snapshot"));
    await owner.query(
      "UPDATE topics SET publication_state='draft' WHERE id=$1",
      [topic],
    );
    await until(
      () => viewer.closed && other.closed && reset.closed && future.closed,
    );
    assert.ok(
      viewer
        .data()
        .some((f) => f.roomId === room && f.version === 1 && !f.kind),
    );
    assert.equal((await delivery.read(room, "0")).eligible, false);
    await streams.stop();
    await process2.stop();

    // Snapshot/subscription race with real durable reads and controlled timing.
    await owner.query(
      "UPDATE topics SET publication_state='published' WHERE id=$1",
      [topic],
    );
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let firstRead = true;
    let readStarted = false;
    const race = createRoomFanout(
      async (id, after) => {
        const value = await delivery.read(id, after);
        if (firstRead) {
          firstRead = false;
          readStarted = true;
          await barrier;
        }
        return {
          head: value.head,
          floor: value.floor,
          eligible: value.eligible,
          snapshot: {
            summary: value.summary,
            items: value.items,
            hasMore: value.hasMore,
          },
          events: value.events.map((e) => ({
            cursor: e.cursor,
            reset: e.kind === "reset",
            change: { message: e.message, summary: value.summary },
            at: e.occurredAt,
          })),
        };
      },
      metrics,
      { ...defaultFanoutOptions, reconcileMs: 50 },
    );
    resources.push(race);
    race.start();
    const racing = new TrialResponse();
    race.subscribe(room, null, "synthetic-race", racing);
    await until(() => readStarted);
    const raced = (await insert(owner, "Synthetic subscription race")).rows[0];
    race.wake(room);
    release();
    await until(() =>
      racing
        .data()
        .some((f) => f.changes?.some((e) => e.message?.id === raced.id)),
    );
    assert.ok(
      racing
        .data()
        .find((f) => f.kind === "snapshot")
        .snapshot.items.every((m) => m.id !== raced.id),
    );
    await race.stop();
    assert.equal(active, 0);
    assert.equal(activeRooms, 0);

    // Exercise the actual manual and automatic lifecycle repositories.
    await createMatchingRepository(pool).operatorTransition(
      users[2],
      room,
      "void_review",
      "Synthetic lifecycle review",
    );
    assert.equal((await delivery.read(room, "0")).summary.chatWritable, false);
    await owner.query(
      "UPDATE debates SET status='live',rules_version='prototype-media-1',rules_snapshot=(SELECT rules FROM event_rule_versions WHERE version='prototype-media-1') WHERE id=$1",
      [room],
    );
    await owner.query(
      `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,remaining_ms,active_ms,last_resumed_at,recording_status)
      VALUES($1,'running','A',9,clock_timestamp()-INTERVAL '1 second',60000,599999,clock_timestamp()-INTERVAL '10 seconds','recording')`,
      [room],
    );
    assert.ok((await createMediaRepository(pool).tick()).ended.includes(room));
    assert.equal((await delivery.read(room, "0")).summary.eventStatus, "ended");

    // Production-default reconciliation without any LISTEN/wake path.
    const repair = createRoomFanout(async (id, after) => {
      const value = await delivery.read(id, after);
      return {
        head: value.head,
        floor: value.floor,
        eligible: value.eligible,
        snapshot: { items: value.items },
        events: value.events.map((e) => ({
          cursor: e.cursor,
          reset: false,
          change: { message: e.message },
          at: e.occurredAt,
        })),
      };
    }, metrics);
    resources.push(repair);
    repair.start();
    const missed = new TrialResponse();
    repair.subscribe(room, null, "synthetic-no-hints", missed);
    await until(() => missed.data().some((f) => f.kind === "snapshot"));
    const repairAt = performance.now();
    const repaired = (
      await insert(owner, "Synthetic repair without notifications")
    ).rows[0];
    await until(
      () =>
        missed
          .data()
          .some((f) => f.changes?.some((e) => e.message?.id === repaired.id)),
      15000,
    );
    const defaultReconciliationRecoveryMs = Math.round(
      performance.now() - repairAt,
    );
    assert.ok(defaultReconciliationRecoveryMs <= 15000);
    await repair.stop();

    // Uncontended trigger/counter latency and bounded slow sinks/admission.
    const mutationMs = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      await insert(owner, `Synthetic counter measurement ${i}`);
      mutationMs.push(performance.now() - started);
    }
    mutationMs.sort((x, y) => x - y);
    let replayCursor = (await delivery.read(room, "0")).floor;
    const replayed = [];
    for (let batch = 0; batch < 10; batch++) {
      const page = await delivery.read(room, replayCursor);
      replayed.push(...page.events.map((e) => e.cursor));
      replayCursor = page.events.at(-1)?.cursor ?? replayCursor;
      if (replayCursor === page.head) break;
    }
    assert.ok(replayed.length >= 50);
    assert.ok(
      replayed.every(
        (cursor, i) => !i || BigInt(cursor) === BigInt(replayed[i - 1]) + 1n,
      ),
      "numeric replay ordering must remain contiguous across decimal widths",
    );
    const limited = createRoomFanout(
      async () => ({
        head: "1",
        floor: "0",
        eligible: true,
        snapshot: {},
        events: [],
      }),
      metrics,
      {
        ...defaultFanoutOptions,
        maxStreams: 2,
        maxRooms: 1,
        reconcileMs: 50,
        heartbeatMs: 10,
        bufferBytes: 256,
      },
    );
    resources.push(limited);
    limited.start();
    const slow = new TrialResponse();
    slow.blocked = true;
    limited.subscribe(room, null, "synthetic-slow", slow);
    const healthy = new TrialResponse();
    limited.subscribe(room, null, "synthetic-healthy", healthy);
    const refused = new TrialResponse();
    limited.subscribe(room, null, "synthetic-refused", refused);
    assert.equal(refused.statusCode, 503);
    await until(() => slow.closed);
    assert.ok(counts.buffer_pressure > 0);
    await limited.stop();
    assert.equal(active, 0);
    assert.equal(activeRooms, 0);
    console.log(
      JSON.stringify({
        trial: "durable-postgres",
        result: "PASS",
        node: process.version,
        postgres: (await owner.query("SHOW server_version")).rows[0]
          .server_version,
        serializedWaitMs,
        missedHintRecoveryMs,
        defaultReconciliationRecoveryMs,
        counterMutationP50Ms: +mutationMs[25].toFixed(2),
        counterMutationP95Ms: +mutationMs[47].toFixed(2),
        counts,
      }),
    );
  } finally {
    await Promise.allSettled(resources.map((resource) => resource.stop()));
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    a.release();
    b.release();
    await notify.end();
    // Avoid polluting the subsequent moderation-browser queue in this disposable cluster.
    await owner.query("DELETE FROM moderation_cases WHERE debate_id=$1", [
      room,
    ]);
    for (const table of [
      "event_chat_messages",
      "event_likes",
      "event_chat_controls",
      "event_like_changes",
    ])
      await owner.query(`DELETE FROM ${table} WHERE debate_id=$1`, [room]);
    await owner.query("DELETE FROM debates WHERE id=$1", [room]);
    await owner.query("DELETE FROM topics WHERE id=$1", [topic]);
    await owner.query(
      "DELETE FROM public_profiles WHERE user_id=ANY($1::bigint[])",
      [users],
    );
    await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [users]);
  }
}
