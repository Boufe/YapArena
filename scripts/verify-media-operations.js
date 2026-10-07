import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { fork } from "node:child_process";
import { createApp } from "../dist/app.js";
import { createMediaProvider } from "../dist/features/media/provider.js";
import { createMessageRepository } from "../dist/features/messages/repository.js";
import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createMatchingRepository } from "../dist/features/matching/repository.js";
import { createCommunityRepository } from "../dist/features/community/repository.js";
import { createUserRepository } from "../dist/platform/auth/users.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { runExclusiveDatabaseJob } from "../dist/platform/database-jobs.js";
import { createMediaOperations } from "../dist/features/media/operations.js";
import { createMediaRepository } from "../dist/features/media/repository.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const percentile = (items, p) =>
  [...items].sort((a, b) => a - b)[
    Math.min(items.length - 1, Math.floor(items.length * p))
  ];
export async function verifyMediaOperations({ pool, owner, admin, url }) {
  const suffix = randomUUID().slice(0, 8);
  const topic = (
    await owner.query(
      `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
    VALUES($1,'Synthetic media operations','Disposable test','A','B','published') RETURNING id`,
      [`media-ops-${suffix}`],
    )
  ).rows[0].id;
  const rooms = [];
  const recordingRooms = [];
  const resources = [];
  let server;
  let child;
  const media = createMediaRepository(pool);
  try {
    for (let i = 0; i < 5; i++) {
      const id = (
        await owner.query(
          `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot)
        VALUES($1,$2,'Synthetic automated media test','live','published','prototype-media-1',
        '{"initial_speaking_time_seconds":10,"maximum_duration_seconds":20}') RETURNING id`,
          [`media-ops-${suffix}-${i}`, topic],
        )
      ).rows[0].id;
      rooms.push(id);
      await owner.query(
        `INSERT INTO debate_media(debate_id,state,active_side,turn_number,turn_deadline_at,remaining_ms,active_ms,last_resumed_at,recording_status,egress_id,recording_key)
        VALUES($1,'running','A',1,clock_timestamp()-INTERVAL '1 second',10000,0,clock_timestamp()-INTERVAL '11 seconds','recording',$2,$3)`,
        [id, `synthetic-${id}`, `debates/${id}/${randomUUID()}.mp4`],
      );
    }
    const held = deferred();
    const release = deferred();
    const leader = runExclusiveDatabaseJob(pool, "media-clock", async () => {
      held.resolve();
      await release.promise;
      return "first";
    });
    await held.promise;
    const contentionStart = performance.now();
    assert.deepEqual(
      await runExclusiveDatabaseJob(pool, "media-clock", () =>
        assert.fail("overlapping owner"),
      ),
      { acquired: false },
    );
    const contentionMs = performance.now() - contentionStart;
    release.resolve();
    assert.equal((await leader).value, "first");
    await assert.rejects(
      runExclusiveDatabaseJob(pool, "media-clock", async () => {
        throw Error("controlled owner failure");
      }),
      /controlled/,
    );
    assert.equal(
      (await runExclusiveDatabaseJob(pool, "media-clock", async () => 1))
        .acquired,
      true,
    );

    child = fork(new URL("./verify-media-clock-child.js", import.meta.url), {
      env: { PATH: process.env.PATH, MEDIA_TRIAL_RUNTIME_URL: url },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("clock child did not acquire ownership")),
        5000,
      );
      child.once("message", (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      child.once("error", reject);
    });
    assert.equal(ready.type, "ready");
    assert.equal(ready.identity, "yaparena_runtime");
    assert.deepEqual(
      await runExclusiveDatabaseJob(pool, "media-clock", () =>
        assert.fail("second process became owner"),
      ),
      { acquired: false },
    );
    const restartStart = performance.now();
    child.kill("SIGKILL");
    let reclaimed = false;
    for (let i = 0; i < 40; i++) {
      if (
        (await runExclusiveDatabaseJob(pool, "media-clock", async () => 1))
          .acquired
      ) {
        reclaimed = true;
        break;
      }
      await delay(25);
    }
    assert.equal(
      reclaimed,
      true,
      "process death must release ownership without a lease delay",
    );
    const clockProcessRecoveryMs = performance.now() - restartStart;

    const lossEntered = deferred();
    const lossFinish = deferred();
    const lost = runExclusiveDatabaseJob(
      pool,
      "media-loss-fixture",
      async (client) => {
        lossEntered.resolve(
          (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        await lossFinish.promise;
      },
    );
    const lossOutcome = assert.rejects(lost);
    const lostPid = await lossEntered.promise;
    await admin.query("SELECT pg_terminate_backend($1)", [lostPid]);
    await delay(50);
    lossFinish.resolve();
    await lossOutcome;
    assert.equal(
      (await runExclusiveDatabaseJob(pool, "media-loss-fixture", async () => 1))
        .acquired,
      true,
    );

    const localNow = Date.now;
    let clockResults;
    try {
      Date.now = () => localNow() - 3600000;
      clockResults = await Promise.all([
        media.tick(),
        createMediaRepository(pool).tick(),
      ]);
    } finally {
      Date.now = localNow;
    }
    assert.equal(
      clockResults.reduce((sum, result) => sum + result.turns.length, 0),
      5,
    );
    const clocks = await owner.query(
      "SELECT turn_number,active_ms,active_side FROM debate_media WHERE debate_id=ANY($1::uuid[])",
      [rooms],
    );
    assert.ok(
      clocks.rows.every(
        (row) =>
          row.turn_number === 2 &&
          row.active_ms === 10000 &&
          row.active_side === "B",
      ),
    );

    const id = rooms[0];
    const entered = deferred();
    const finish = deferred();
    const applied = [];
    let calls = 0;
    let concurrent = 0;
    let peak = 0;
    const provider = {
      async setTurn(_id, side) {
        peak = Math.max(peak, ++concurrent);
        if (++calls === 1) {
          entered.resolve();
          await finish.promise;
        }
        applied.push(side);
        concurrent--;
      },
    };
    const quiet = { warn() {} };
    const one = createMediaOperations({
      database: pool,
      media,
      provider,
      logger: quiet,
    });
    const two = createMediaOperations({
      database: pool,
      media,
      provider,
      logger: quiet,
    });
    resources.push(one, two);
    const stale = one.provider.setTurn(id, "A");
    await entered.promise;
    await media.pause(id, null, "Synthetic concurrent operator pause.");
    const latest = two.provider.setTurn(id, "B");
    finish.resolve();
    await Promise.all([stale, latest]);
    assert.equal(
      peak,
      1,
      "independent controllers must serialize remote writes",
    );
    assert.equal(applied.at(-1), null, "late turn must repair to pause");
    assert.ok(applied.includes("B"));
    await owner.query(
      "UPDATE topics SET publication_state='draft' WHERE id=$1",
      [topic],
    );
    assert.equal(await media.getPublicSnapshot(id), null);
    assert.equal(await media.getPublicEvent(id), null);
    await one.provider.setTurn(id, "B");
    assert.equal(applied.at(-1), null);
    await owner.query(
      "UPDATE topics SET publication_state='published' WHERE id=$1",
      [topic],
    );
    const publicState = await media.getPublicSnapshot(id);
    assert.match(publicState.streamRevision, /^\d+$/);
    for (const privateField of ["egressId", "recordingKey", "incident"])
      assert.equal(Object.hasOwn(publicState.state, privateField), false);

    let repairs = 0;
    const recovering = createMediaOperations({
      database: pool,
      media,
      logger: quiet,
      provider: {
        async setTurn() {
          repairs++;
        },
      },
    });
    resources.push(recovering);
    await recovering.tick();
    await delay(100);
    assert.ok(
      repairs >= 5,
      "unchanged active rooms must repair after missed provider work/restart",
    );

    for (let i = 0; i < 6; i++) {
      const recordingId = (
        await owner.query(
          `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot)
          VALUES($1,$2,'Synthetic missed webhook','ended','published','prototype-media-1','{}') RETURNING id`,
          [`media-recording-${suffix}-${i}`, topic],
        )
      ).rows[0].id;
      recordingRooms.push(recordingId);
      await owner.query(
        `INSERT INTO debate_media(debate_id,state,recording_status,egress_id,recording_key,updated_at)
        VALUES($1,'ended','processing',$2,$3,clock_timestamp()-INTERVAL '20 seconds')`,
        [
          recordingId,
          `synthetic-${recordingId}`,
          `debates/${recordingId}/${randomUUID()}.mp4`,
        ],
      );
    }
    recordingRooms.sort();
    let probeTime = 0;
    const probed = [];
    const confirmations = createMediaOperations({
      database: pool,
      media,
      logger: quiet,
      now: () => probeTime,
      provider: {
        async setTurn() {},
        async recordingResult(egressId, key) {
          probed.push(egressId);
          if (egressId === `synthetic-${recordingRooms[0]}`)
            throw Error("Synthetic isolated recording outage");
          return egressId === `synthetic-${recordingRooms[5]}`
            ? { success: true, key }
            : null;
        },
      },
    });
    resources.push(confirmations);
    await confirmations.tick();
    for (let i = 0; i < 100 && probed.length < 5; i++) await delay(10);
    assert.deepEqual(
      probed,
      recordingRooms.slice(0, 5).map((id) => `synthetic-${id}`),
    );
    probeTime += 30000;
    await confirmations.tick();
    for (
      let i = 0;
      i < 100 &&
      (await media.get(recordingRooms[5])).recordingStatus !== "ready";
      i++
    )
      await delay(10);
    assert.equal((await media.get(recordingRooms[5])).recordingStatus, "ready");
    assert.equal(probed.at(-1), `synthetic-${recordingRooms[5]}`);
    assert.equal(
      (await media.get(recordingRooms[0])).recordingStatus,
      "processing",
    );
    await confirmations.stop();

    const app = createApp({
      messages: createMessageRepository(pool),
      discovery: createDiscoveryRepository(pool),
      identity: createIdentityRepository(pool),
      matching: createMatchingRepository(pool),
      community: createCommunityRepository(pool),
      users: createUserRepository(pool),
      sessions: createSessionRepository(pool),
      media,
      mediaProvider: createMediaProvider({
        livekitUrl: "https://live.synthetic.invalid",
        livekitPublicUrl: "wss://live.synthetic.invalid",
        livekitKey: "synthetic",
        livekitSecret: "synthetic-32-byte-signing-secret-not-real",
        s3Region: "auto",
        s3Bucket: "synthetic",
        s3AccessKey: "synthetic",
        s3SecretKey: "synthetic",
      }),
      mediaAdmissionSecret: "synthetic-shared-IP-trial-secret",
      environment: "test",
      logger: pino({ level: "silent" }),
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const durations = [];
    const cookies = Array(500);
    const trialStart = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        for (;;) {
          const viewer = next++;
          if (viewer >= 500) return;
          const path = `${origin}/api/media/events/${rooms[viewer % 5]}`;
          const start = performance.now();
          const landing = await fetch(
            `${origin}/debates/media-ops-${suffix}-${viewer % 5}`,
          );
          assert.equal(landing.status, 200);
          assert.match(await landing.text(), /data-media-event/);
          cookies[viewer] = landing.headers.get("set-cookie").split(";")[0];
          const headers = { Cookie: cookies[viewer] };
          const bootstrap = await Promise.all([
            fetch(`${origin}/assets/site.css`, { headers }),
            fetch(`${origin}/api/auth/me`, { headers }),
            fetch(`${origin}/api/community/events/${rooms[viewer % 5]}/chat`, {
              headers,
            }),
            fetch(
              `${origin}/api/community/events/${rooms[viewer % 5]}/my-like`,
              { headers },
            ),
          ]);
          assert.deepEqual(
            bootstrap.map((response) => response.status),
            [200, 401, 200, 401],
          );
          await Promise.all(bootstrap.map((response) => response.text()));
          const response = await fetch(path, { headers });
          assert.equal(response.status, 200);
          await response.json();
          const grant = await fetch(`${path}/viewer-token`, {
            method: "POST",
            headers: { Cookie: cookies[viewer] },
          });
          assert.equal(grant.status, 200);
          await grant.json();
          durations.push(performance.now() - start);
        }
      }),
    );
    // Repeat polling rather than proving only an initial join burst.
    for (let round = 0; round < 3; round++) {
      let poll = 0;
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          for (;;) {
            const viewer = poll++;
            if (viewer >= 500) return;
            const start = performance.now();
            const response = await fetch(
              `${origin}/api/media/events/${rooms[viewer % 5]}`,
              { headers: { Cookie: cookies[viewer] } },
            );
            assert.equal(response.status, 200);
            await response.json();
            durations.push(performance.now() - start);
          }
        }),
      );
    }
    assert.ok(pool.totalCount <= 10);
    for (let i = 0; i < 300; i++) {
      const response = await fetch(
        `${origin}/api/media/events/${rooms[0]}/pause`,
        { method: "POST", headers: { Cookie: cookies[0] } },
      );
      assert.equal(
        response.status,
        401,
        "public reads must not spend the protected-write allowance",
      );
      await response.text();
    }
    const blocked = await fetch(
      `${origin}/api/media/events/${rooms[0]}/pause`,
      { method: "POST", headers: { Cookie: cookies[0] } },
    );
    assert.equal(blocked.status, 429);
    await blocked.text();
    console.log(
      JSON.stringify({
        trial: "media-operations-real-postgres",
        node: process.version,
        postgres: (await owner.query("SHOW server_version")).rows[0]
          .server_version,
        independentControllers: 2,
        peakConcurrentProviderWritesPerRoom: peak,
        clockLockContentionMs: Number(contentionMs.toFixed(2)),
        clockProcessRecoveryMs: Number(clockProcessRecoveryMs.toFixed(2)),
        independentClockProcesses: 2,
        missedRecordingProbeRooms: 6,
        pendingProbeStarvationPrevented: true,
        viewersOnOneIP: 500,
        rooms: 5,
        httpRequests: 5000 + 301,
        protectedWriteLimitPreserved: true,
        publicDeliveryRefusals: 0,
        protectedWriteRefusals: 1,
        requestPairAndPollP95Ms: Number(percentile(durations, 0.95).toFixed(2)),
        elapsedMs: Math.round(performance.now() - trialStart),
        runtimePoolConnections: pool.totalCount,
        limitations:
          "synthetic provider; local HTTP; not a LiveKit media capacity or hosted latency trial",
      }),
    );
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(resources.map((resource) => resource.stop()));
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await owner.query("DELETE FROM debates WHERE id=ANY($1::uuid[])", [
      rooms.concat(recordingRooms),
    ]);
    await owner.query("DELETE FROM topics WHERE id=$1", [topic]);
  }
}
