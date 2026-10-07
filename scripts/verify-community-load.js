import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect as connectSocket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";

async function until(test, timeout = 15000) {
  const start = performance.now();
  while (!(await test())) {
    if (performance.now() - start > timeout) throw Error("load trial deadline");
    await delay(20);
  }
}
async function scrape(base) {
  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 200);
  const data = await response.text();
  const metric = (name) =>
    Number(new RegExp(`^${name} ([0-9.e+]+)$`, "m").exec(data)?.[1] ?? 0);
  return {
    rss: metric("yaparena_process_resident_memory_bytes"),
    heapUsed: metric("yaparena_nodejs_heap_size_used_bytes"),
    heapTotal: metric("yaparena_nodejs_heap_size_total_bytes"),
    external: metric("yaparena_nodejs_external_memory_bytes"),
    streams: metric("yaparena_community_streams"),
    rooms: metric("yaparena_community_rooms"),
    pressure: Number(
      /yaparena_community_delivery_total\{kind="buffer_pressure"\} ([0-9]+)/.exec(
        data,
      )?.[1] ?? 0,
    ),
  };
}
async function subscriber(base, room, resume, onFrame = () => {}) {
  const controller = new AbortController();
  const res = await fetch(
    `${base}/api/community/events/${room}/stream${resume ? `?cursor=${encodeURIComponent(resume)}` : ""}`,
    { signal: controller.signal },
  );
  assert.equal(res.status, 200, "admission at declared capacity");
  const state = {
    controller,
    cursor: resume,
    frames: 0,
    ready: false,
    done: undefined,
  };
  state.done = (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        pending += decoder.decode(value.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const raw = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = raw
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!line) continue;
          const frame = JSON.parse(line.slice(6));
          state.frames++;
          state.ready = true;
          if (frame.cursor) {
            const next = BigInt(frame.cursor.split(":")[2]);
            if (!state.cursor || next > BigInt(state.cursor.split(":")[2]))
              state.cursor = frame.cursor;
          }
          onFrame(frame);
        }
      }
    } catch (error) {
      if (error.name !== "AbortError" && error.name !== "TypeError")
        throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return state;
}
export async function verifyCommunityLoad({
  owner,
  base,
  secondBase,
  restart,
}) {
  const seconds = Number(process.env.COMMUNITY_SOAK_SECONDS ?? "300");
  assert.ok(Number.isInteger(seconds) && seconds >= 10 && seconds <= 3600);
  const tag = randomUUID().slice(0, 8);
  const rooms = [];
  const users = [];
  const cookies = [];
  let viewers = [];
  let shadow;
  let secondProcessMutations = 0;
  let maxRuntimeConnections = 0;
  const slow = [];
  let restartDelivered = false;
  const submitted = new Map();
  const latency = [];
  let writes = 0;
  let maximumRss = 0;
  let maximumStreams = 0;
  let maximumRooms = 0;
  let maximumHeapUsed = 0;
  let maximumHeapTotal = 0;
  let maximumExternal = 0;
  const baseline = await scrape(base);
  maximumRss = baseline.rss;
  const topic = (
    await owner.query(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'Synthetic capacity','Synthetic','For','Against','published') RETURNING id",
      [`load-${tag}`],
    )
  ).rows[0].id;
  for (let i = 0; i < 50; i++)
    rooms.push(
      (
        await owner.query(
          "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT $1,$2,'Synthetic capacity','live','published',version,rules FROM event_rule_versions WHERE version='preview-1' RETURNING id",
          [`load-${tag}-${i}`, topic],
        )
      ).rows[0].id,
    );
  for (let i = 0; i < 200; i++) {
    const user = (
      await owner.query(
        "INSERT INTO users(email,password_hash) VALUES($1,'synthetic') RETURNING id",
        [`load-${tag}-${i}@example.test`],
      )
    ).rows[0].id;
    users.push(user);
    await owner.query(
      "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,$2,'Synthetic load author','published')",
      [user, `load-${tag}-${i}`],
    );
    const session = createSessionToken();
    await owner.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at,auth_generation) SELECT id,$2,clock_timestamp()+INTERVAL '1 hour',auth_generation FROM users WHERE id=$1",
      [user, session.tokenHash],
    );
    cookies.push(`session=${session.token}`);
  }
  const observe = (frame) => {
    for (const change of frame.changes ?? []) {
      if (change.message?.body === "Synthetic restart durable message")
        restartDelivered = true;
      const text = change.message?.body;
      const match = /^Synthetic load (\d+)$/.exec(text ?? "");
      if (match && submitted.has(Number(match[1])))
        latency.push(performance.now() - submitted.get(Number(match[1])));
    }
  };
  async function open(resumes = []) {
    const result = [];
    for (let group = 0; group < 50; group++) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, (_, j) =>
          subscriber(base, rooms[group], resumes[group * 10 + j], observe),
        ),
      );
      result.push(...batch);
    }
    await until(() => result.every((v) => v.ready));
    return result;
  }
  async function close() {
    for (const v of viewers) v.controller.abort();
    await Promise.allSettled(viewers.map((v) => v.done));
    viewers = [];
  }
  async function measure() {
    const value = await scrape(base);
    const connections = (
      await owner.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='yaparena_runtime'",
      )
    ).rows[0].n;
    maxRuntimeConnections = Math.max(maxRuntimeConnections, connections);
    assert.ok(
      connections <= 22,
      "ten pool connections plus one listener per web process",
    );
    maximumRss = Math.max(maximumRss, value.rss);
    maximumHeapUsed = Math.max(maximumHeapUsed, value.heapUsed);
    maximumHeapTotal = Math.max(maximumHeapTotal, value.heapTotal);
    maximumExternal = Math.max(maximumExternal, value.external);
    maximumStreams = Math.max(maximumStreams, value.streams);
    maximumRooms = Math.max(maximumRooms, value.rooms);
    return value;
  }
  try {
    console.log(
      JSON.stringify({
        phase: "load-start",
        viewers: 500,
        rooms: 50,
        seconds,
        mutationRate: 10,
        localApiRateLimit: 10000,
        nodeOptions: "--max-semi-space-size=4",
      }),
    );
    shadow = await subscriber(secondBase, rooms[0], null, (frame) => {
      secondProcessMutations += (frame.changes ?? []).filter((e) =>
        /^Synthetic load \d+$/.test(e.message?.body ?? ""),
      ).length;
    });
    viewers = await open();
    assert.equal((await measure()).streams, 500);
    assert.equal(maximumRooms, 50);
    const refused = await fetch(
      `${base}/api/community/events/${rooms[0]}/stream`,
    );
    assert.equal(refused.status, 503);
    await refused.arrayBuffer();
    const start = performance.now();
    const total = seconds * 10;
    for (let n = 0; n < total; n++) {
      const due = start + n * 100;
      const wait = due - performance.now();
      if (wait > 0) await delay(wait);
      const room = rooms[n % 5 === 0 ? 0 : 1 + (n % 49)];
      submitted.set(n, performance.now());
      const response = await fetch(
        `${base}/api/community/events/${room}/chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookies[n % 200],
          },
          body: JSON.stringify({
            body: `Synthetic load ${n}`,
            clientMessageId: randomUUID(),
          }),
        },
      );
      assert.equal(
        response.status,
        201,
        `synthetic authorized HTTP mutation ${n}`,
      );
      await response.json();
      writes++;
      if (n % 10 === 0) await measure();
    }
    await until(() => latency.length >= writes * 8);
    await until(() => secondProcessMutations >= seconds * 2);
    shadow.controller.abort();
    await shadow.done;
    await measure();
    const resume = viewers.map((v) => v.cursor);
    await close();
    await until(async () => !(await scrape(base)).streams);
    const stormAt = performance.now();
    viewers = await open(resume);
    const stormRecoveryMs = Math.round(performance.now() - stormAt);
    assert.ok(stormRecoveryMs <= 10000);
    assert.equal((await measure()).streams, 500);
    // Graceful stop/restart uses the same disposable database and exact built artifact.
    const restartResume = viewers.map((v) => v.cursor);
    const restartAt = performance.now();
    await restart(async () => {
      await owner.query(
        "INSERT INTO event_chat_messages(debate_id,author_user_id,body) VALUES($1,$2,'Synthetic restart durable message')",
        [rooms[0], users[0]],
      );
    });
    await close();
    viewers = await open(restartResume);
    await until(() => restartDelivered);
    const restartRecoveryMs = Math.round(performance.now() - restartAt);
    await measure();
    await close();
    // Real TCP clients stop reading. Feed batches are deliberately above the steady
    // budget to force Node writable backpressure; a healthy probe gates each batch.
    const probe = await subscriber(base, rooms[0], null);
    for (let i = 0; i < 10; i++) {
      const socket = connectSocket(new URL(base).port, "127.0.0.1");
      slow.push(socket);
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.write(
            `GET /api/community/events/${rooms[0]}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`,
          );
          resolve();
        });
      });
      socket.once("data", () => socket.pause());
    }
    let pressured = false;
    let stressMutations = 0;
    for (let batch = 0; batch < 250; batch++) {
      const result = await owner.query(
        "INSERT INTO event_chat_messages(debate_id,author_user_id,body) SELECT $1,$2,$3 FROM generate_series(1,20) RETURNING stream_revision::text",
        [rooms[0], users[0], "界".repeat(500)],
      );
      const head = result.rows.at(-1).stream_revision;
      stressMutations += 20;
      await until(
        () =>
          probe.cursor && BigInt(probe.cursor.split(":")[2]) >= BigInt(head),
      );
      const value = await measure();
      if (value.pressure > 0) {
        pressured = true;
        break;
      }
    }
    probe.controller.abort();
    await probe.done;
    for (const socket of slow) socket.destroy();
    assert.ok(
      pressured,
      "paused TCP clients must eventually trigger bounded disconnect",
    );
    await until(async () => !(await scrape(base)).streams);
    const final = await measure();
    console.log(
      JSON.stringify({
        phase: "load-measured",
        baselineRssMiB: +(baseline.rss / 1024 / 1024).toFixed(2),
        maxRssMiB: +(maximumRss / 1024 / 1024).toFixed(2),
        rssGrowthMiB: +((maximumRss - baseline.rss) / 1024 / 1024).toFixed(2),
        stormRecoveryMs,
        restartRecoveryMs,
        stressMutations,
        bufferPressure: final.pressure,
        maxHeapUsedMiB: +(maximumHeapUsed / 1024 / 1024).toFixed(2),
        maxHeapTotalMiB: +(maximumHeapTotal / 1024 / 1024).toFixed(2),
        maxExternalMiB: +(maximumExternal / 1024 / 1024).toFixed(2),
      }),
    );
    assert.equal(final.rooms, 0);
    assert.ok(
      maximumRss - baseline.rss <= 128 * 1024 * 1024,
      "RSS growth budget",
    );
    latency.sort((a, b) => a - b);
    const p95 = latency[Math.floor(latency.length * 0.95)];
    assert.ok(p95 <= 1000, "local p95 delivery budget");
    console.log(
      JSON.stringify({
        trial: "community-http-load",
        result: "PASS",
        viewers: 500,
        rooms: 50,
        seconds,
        writes,
        deliverySamples: latency.length,
        deliveryP50Ms: Math.round(latency[Math.floor(latency.length * 0.5)]),
        deliveryP95Ms: Math.round(p95),
        stormRecoveryMs,
        restartRecoveryMs,
        maxStreams: maximumStreams,
        maxRooms: maximumRooms,
        rssGrowthMiB: +((maximumRss - baseline.rss) / 1024 / 1024).toFixed(2),
        slowClientStressMutations: stressMutations,
        bufferPressure: final.pressure,
        finalStreams: final.streams,
        maxRuntimeConnections,
        secondProcessMutations,
      }),
    );
  } finally {
    shadow?.controller.abort();
    await shadow?.done;
    await close();
    for (const socket of slow) socket.destroy();
    await owner.query(
      "DELETE FROM event_chat_messages WHERE debate_id=ANY($1::uuid[])",
      [rooms],
    );
    await owner.query(
      "DELETE FROM event_chat_controls WHERE debate_id=ANY($1::uuid[])",
      [rooms],
    );
    await owner.query("DELETE FROM debates WHERE id=ANY($1::uuid[])", [rooms]);
    await owner.query("DELETE FROM topics WHERE id=$1", [topic]);
    await owner.query(
      "DELETE FROM public_profiles WHERE user_id=ANY($1::bigint[])",
      [users],
    );
    await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [users]);
  }
}
