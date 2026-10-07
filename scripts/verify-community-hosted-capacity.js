import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Called by the separately authorized operator runner with its private fixture
// connection. No credentials are accepted on argv or put in the web environment.
export async function verifyHostedCommunityCapacity({
  owner,
  observer,
  base,
  restart,
  seconds = 60,
}) {
  assert.equal(base, "https://yaparena-staging-web.onrender.com");
  assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 300);
  assert.equal(
    (await owner.query("SELECT current_user AS identity")).rows[0].identity,
    "yaparena_owner",
  );
  assert.equal(
    (await observer.query("SELECT current_user AS identity")).rows[0].identity,
    "yaparena_runtime",
  );
  const tag = `sse-host-${randomUUID().slice(0, 8)}`;
  const rooms = [];
  const frames = [];
  let viewers = [];
  let user;
  let topic;
  let firstMessage;
  let maximumRss = 0;
  let maximumConnections = 0;
  let maximumEventLoopP99Seconds = 0;
  let listenerVerified = false;
  const starts = new Map();
  const latency = [];
  const until = async (test, deadline = 20000) => {
    const start = performance.now();
    while (!(await test())) {
      assert.ok(performance.now() - start < deadline, "hosted trial deadline");
      await delay(50);
    }
  };
  async function metrics() {
    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    const text = await response.text();
    const value = (name) =>
      Number(new RegExp(`^${name} ([0-9.e+]+)$`, "m").exec(text)?.[1] ?? 0);
    const result = {
      rss: value("yaparena_process_resident_memory_bytes"),
      streams: value("yaparena_community_streams"),
      rooms: value("yaparena_community_rooms"),
      cpuSeconds:
        value("yaparena_process_cpu_user_seconds_total") +
        value("yaparena_process_cpu_system_seconds_total"),
      eventLoopP99Seconds: value("yaparena_nodejs_eventloop_lag_p99_seconds"),
      poolWaitSeconds: value("yaparena_database_pool_wait_seconds_sum"),
      poolAcquisitions: value("yaparena_database_pool_wait_seconds_count"),
    };
    maximumRss = Math.max(maximumRss, result.rss);
    maximumEventLoopP99Seconds = Math.max(
      maximumEventLoopP99Seconds,
      result.eventLoopP99Seconds,
    );
    const identities = (
      await observer.query(
        "SELECT application_name, state, query FROM pg_stat_activity WHERE usename=current_user AND datname=current_database()",
      )
    ).rows;
    maximumConnections = Math.max(maximumConnections, identities.length);
    listenerVerified ||= identities.some(
      (row) =>
        row.state === "idle" && row.query === "LISTEN yaparena_community_v1",
    );
    return result;
  }
  async function subscriber(room, cursor) {
    const controller = new AbortController();
    const response = await fetch(
      `${base}/api/community/events/${room}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal: controller.signal },
    );
    assert.equal(response.status, 200, "hosted capacity admission");
    const state = {
      controller,
      cursor,
      ready: false,
      closed: false,
      done: undefined,
    };
    state.done = (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          pending += decoder.decode(item.value, { stream: true });
          assert.ok(pending.length < 128 * 1024, "bounded trial parser");
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const raw = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const line = raw.split("\n").find((v) => v.startsWith("data: "));
            if (!line) continue;
            const frame = JSON.parse(line.slice(6));
            if (!frame.cursor) {
              // A caught-up resume confirms freshness with an ID-less heartbeat;
              // it does not invent or advance the successfully applied cursor.
              if (
                state.cursor &&
                raw.startsWith("event: heartbeat") &&
                frame.version === 1
              )
                state.ready = true;
              continue;
            }
            const match = /^v1:([a-f0-9-]{36}):([0-9]+)$/.exec(frame.cursor);
            assert.ok(match && match[1] === room, "room-scoped trial cursor");
            const previous = state.cursor?.split(":")[2];
            state.ready = true;
            if (previous !== undefined && BigInt(match[2]) <= BigInt(previous))
              continue;
            state.cursor = frame.cursor;
            frames.push({ room, cursor: frame.cursor });
            if (frames.length > 1000) frames.shift();
            for (const change of frame.changes ?? []) {
              const started = starts.get(change.message?.body);
              if (started !== undefined)
                latency.push(performance.now() - started);
            }
          }
        }
      } catch (error) {
        if (!["AbortError", "TypeError"].includes(error.name)) throw error;
      } finally {
        state.closed = true;
        reader.releaseLock();
      }
    })();
    return state;
  }
  async function close() {
    const resume = viewers.map((v) => v.cursor);
    for (const v of viewers) v.controller.abort();
    await Promise.allSettled(viewers.map((v) => v.done));
    viewers = [];
    return resume;
  }
  async function open(resume = []) {
    for (let i = 0; i < 50; i++) {
      const group = await Promise.allSettled(
        Array.from({ length: 10 }, (_, j) =>
          subscriber(rooms[i], resume[i * 10 + j]),
        ),
      );
      for (const item of group)
        if (item.status === "fulfilled") viewers.push(item.value);
      const failed = group.find((item) => item.status === "rejected");
      if (failed) throw failed.reason;
    }
    await until(() => viewers.every((v) => v.ready));
  }
  async function write(room, body) {
    const row = (
      await owner.query(
        "INSERT INTO event_chat_messages(debate_id,author_user_id,body) VALUES($1,$2,$3) RETURNING id::text,stream_revision::text",
        [room, user, body],
      )
    ).rows[0];
    return row;
  }
  async function cleanupRooms() {
    for (const room of rooms) {
      await owner.query("BEGIN");
      try {
        const safe = (
          await owner.query("SELECT slug FROM debates WHERE id=$1 FOR UPDATE", [
            room,
          ])
        ).rows[0];
        assert.ok(!safe || safe.slug.startsWith(tag));
        await owner.query(
          "DELETE FROM event_chat_messages WHERE debate_id=$1",
          [room],
        );
        await owner.query("DELETE FROM debates WHERE id=$1", [room]);
        await owner.query(
          "DELETE FROM community_room_events WHERE room_id=$1",
          [room],
        );
        await owner.query("DELETE FROM community_rooms WHERE room_id=$1", [
          room,
        ]);
        await owner.query("COMMIT");
      } catch (e) {
        await owner.query("ROLLBACK");
        throw e;
      }
    }
  }
  try {
    const baseline = await metrics();
    assert.equal(
      baseline.streams,
      0,
      "run capacity on an idle synthetic stage",
    );
    user = (
      await owner.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'unused-synthetic') RETURNING id",
        [tag + "@example.test"],
      )
    ).rows[0].id;
    topic = (
      await owner.query(
        "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Synthetic hosted capacity','Synthetic temporary trial','For','Against','published') RETURNING id",
        [tag],
      )
    ).rows[0].id;
    for (let i = 0; i < 50; i++)
      rooms.push(
        (
          await owner.query(
            "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT $1,$2,'Synthetic hosted capacity','live','published',version,rules FROM event_rule_versions WHERE version='preview-1' RETURNING id",
            [`${tag}-${i}`, topic],
          )
        ).rows[0].id,
      );
    await open();
    const atCapacity = await metrics();
    assert.equal(atCapacity.streams, 500);
    assert.equal(atCapacity.rooms, 50);
    const writes = seconds * 10;
    const start = performance.now();
    for (let i = 0; i < writes; i++) {
      const body = `Synthetic hosted load ${i}`;
      starts.set(body, performance.now());
      const row = await write(rooms[i % 50], body);
      if (!firstMessage) firstMessage = row.id;
      if (i % 50 === 0) await metrics();
      await delay(Math.max(0, start + (i + 1) * 100 - performance.now()));
    }
    const measured = await metrics();
    const measuredSeconds = (performance.now() - start) / 1000;
    console.log(
      JSON.stringify({
        phase: "hosted-delivery-observed",
        expectedSamples: writes * 10,
        samples: latency.length,
        closedViewers: viewers.filter((v) => v.closed).length,
        metrics: measured,
      }),
    );
    try {
      await until(() => latency.length === writes * 10);
    } catch (error) {
      const cursors = viewers.map((v) => BigInt(v.cursor.split(":")[2]));
      console.log(
        JSON.stringify({
          phase: "hosted-delivery-deadline",
          expectedSamples: writes * 10,
          samples: latency.length,
          closedViewers: viewers.filter((v) => v.closed).length,
          minCursor: cursors.reduce((a, b) => (a < b ? a : b)).toString(),
          maxCursor: cursors.reduce((a, b) => (a > b ? a : b)).toString(),
          metrics: await metrics(),
        }),
      );
      throw error;
    }
    const resumes = await close();
    await owner.query(
      "UPDATE event_chat_messages SET state='removed' WHERE id=$1 AND debate_id=$2",
      [firstMessage, rooms[0]],
    );
    const missed = await write(rooms[0], "Synthetic disconnect catch-up");
    const stormStart = performance.now();
    await open(resumes);
    await until(() =>
      viewers
        .slice(0, 10)
        .every(
          (v) =>
            BigInt(v.cursor.split(":")[2]) >= BigInt(missed.stream_revision),
        ),
    );
    const reconnectMs = Math.round(performance.now() - stormStart);
    let restartMs;
    if (restart) {
      const saved = viewers.map((v) => v.cursor);
      const restartStart = performance.now();
      await restart();
      await until(() => viewers.some((v) => v.closed), 90000);
      await close();
      const changed = await write(rooms[0], "Synthetic deployment recovery");
      await until(async () => {
        try {
          return (await fetch(`${base}/ready`)).ok;
        } catch {
          return false;
        }
      }, 120000);
      await open(saved);
      await until(() =>
        viewers
          .slice(0, 10)
          .every(
            (v) =>
              BigInt(v.cursor.split(":")[2]) >= BigInt(changed.stream_revision),
          ),
      );
      restartMs = Math.round(performance.now() - restartStart);
    }
    await close();
    await until(async () => !(await metrics()).streams);
    const final = await metrics();
    latency.sort((a, b) => a - b);
    const record = {
      trial: "hosted-community-capacity",
      at: new Date().toISOString(),
      viewers: 500,
      rooms: 50,
      seconds,
      writes,
      writer:
        "separate owner process; synthetic SQL mutations, not HTTP send capacity",
      mutationRate: 10,
      samples: latency.length,
      p50Ms: Math.round(latency[Math.floor(latency.length * 0.5)]),
      p95Ms: Math.round(latency[Math.floor(latency.length * 0.95)]),
      reconnectMs,
      restartMs,
      measuredLoadSeconds: +measuredSeconds.toFixed(2),
      processAverageCpuCores: +(
        (measured.cpuSeconds - atCapacity.cpuSeconds) /
        measuredSeconds
      ).toFixed(4),
      maxObservedEventLoopP99Ms: +(maximumEventLoopP99Seconds * 1000).toFixed(
        2,
      ),
      loadAveragePoolWaitMs: +(
        ((measured.poolWaitSeconds - atCapacity.poolWaitSeconds) * 1000) /
        Math.max(1, measured.poolAcquisitions - atCapacity.poolAcquisitions)
      ).toFixed(2),
      baselineRssMiB: +(baseline.rss / 1024 / 1024).toFixed(2),
      peakRssMiB: +(maximumRss / 1024 / 1024).toFixed(2),
      rssGrowthMiB: +((maximumRss - baseline.rss) / 1024 / 1024).toFixed(2),
      maxRuntimeConnectionsIncludingObserver: maximumConnections,
      deployedRuntimeListenIdentityVerified: listenerVerified,
      finalStreams: final.streams,
      finalRooms: final.rooms,
    };
    console.log(JSON.stringify(record));
    assert.ok(listenerVerified);
    assert.equal(final.rooms, 0);
    assert.ok(maximumConnections <= 12);
    assert.ok(record.rssGrowthMiB <= 128);
    assert.ok(record.p95Ms <= 1000, "declared delivery budget");
    assert.ok(reconnectMs <= 10000, "declared reconnect budget");
    // Free restart duration is reported separately from stream catch-up.
    return record;
  } finally {
    await close();
    await cleanupRooms();
    if (topic)
      await owner.query("DELETE FROM topics WHERE id=$1 AND slug=$2", [
        topic,
        tag,
      ]);
    if (user)
      await owner.query("DELETE FROM identity_audit_events WHERE user_id=$1", [
        user,
      ]);
    if (user)
      await owner.query("DELETE FROM users WHERE id=$1 AND email=$2", [
        user,
        tag + "@example.test",
      ]);
  }
}
