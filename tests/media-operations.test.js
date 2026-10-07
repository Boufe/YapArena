import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import { runExclusiveDatabaseJob } from "../dist/platform/database-jobs.js";
import { createSharedRead } from "../dist/platform/shared-read.js";
import { createMediaOperations } from "../dist/features/media/operations.js";

const id = "33333333-3333-4333-8333-333333333333";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture({ acquired = true, selected = true } = {}) {
  let state = { revision: 1, side: "A" };
  let time = 10000;
  const calls = [];
  const kinds = [];
  const query = async (sql) => {
    calls.push(sql);
    if (sql.includes("pg_try_advisory")) return { rows: [{ acquired }] };
    if (sql.startsWith("SELECT m.revision"))
      return { rows: selected ? [state] : [] };
    return { rows: [] };
  };
  const client = Object.assign(new EventEmitter(), {
    query,
    release() {
      calls.push("release");
    },
  });
  const database = { connect: async () => client, query };
  client.setMaxListeners(32);
  const provider = {
    async setTurn(_id, side) {
      calls.push(`permission:${side}`);
    },
  };
  const media = {
    async tick() {
      return { turns: [{ debateId: id, side: "B" }], ended: ["ended"] };
    },
    async get() {
      return { state: "running" };
    },
    async pause() {
      calls.push("pause");
    },
  };
  const operations = createMediaOperations({
    database,
    media,
    provider,
    logger: {
      warn() {
        calls.push("warning");
      },
    },
    count: (kind) => kinds.push(kind),
    now: () => time,
    wait: async () => {},
  });
  return {
    operations,
    calls,
    kinds,
    database,
    client,
    provider,
    media,
    state(value) {
      state = value;
    },
    advance() {
      time += 5000;
    },
  };
}
it("releases transaction-scoped job locks on commit, contention and failure", async () => {
  const f = fixture();
  assert.deepEqual(
    await runExclusiveDatabaseJob(f.database, "clock", async () => 42),
    { acquired: true, value: 42 },
  );
  assert.equal(f.calls.at(-1), "release");
  const busy = fixture({ acquired: false });
  assert.deepEqual(
    await runExclusiveDatabaseJob(busy.database, "clock", () => assert.fail()),
    { acquired: false },
  );
  assert.ok(busy.calls.includes("ROLLBACK"));
  await assert.rejects(
    runExclusiveDatabaseJob(f.database, "clock", () => {
      throw Error("rollback me");
    }),
    /rollback me/,
  );
  assert.equal(f.calls.at(-2), "ROLLBACK");
  const failed = {
    connect: async () => ({
      on() {},
      removeListener() {},
      query: async () => {
        throw Error("connection lost");
      },
      release() {
        f.calls.push("destroyed");
      },
    }),
  };
  await assert.rejects(
    runExclusiveDatabaseJob(failed, "clock", async () => {}),
    /connection lost/,
  );
  assert.equal(f.calls.at(-1), "destroyed");
});
it("shares only overlapping public reads and frees capacity on success or failure", async () => {
  const read = createSharedRead(1);
  const pending = deferred();
  const first = read(id, () => pending.promise);
  assert.equal(
    read(id, () => assert.fail()),
    first,
  );
  await assert.rejects(
    read("other", async () => 1),
    /capacity/,
  );
  pending.resolve(2);
  assert.equal(await first, 2);
  await assert.rejects(
    read(id, () => {
      throw Error("read failed");
    }),
    /failed/,
  );
  assert.equal(await read(id, async () => 3), 3);
  assert.equal(await createSharedRead()(id, async () => 4), 4);
});
it("destroys a lost connection and cannot commit a job whose lock was released", async () => {
  const f = fixture();
  await assert.rejects(
    runExclusiveDatabaseJob(f.database, "lost", async () => {
      f.client.emit("error", Error("controlled connection loss"));
      return 1;
    }),
    /controlled connection loss/,
  );
  assert.equal(f.calls.includes("COMMIT"), false);
  assert.equal(f.client.listenerCount("error"), 0);
});
it("reconciles missed recording confirmations in bounded batches without blocking clocks", async () => {
  const f = fixture();
  f.advance();
  f.advance();
  f.advance();
  f.advance();
  f.media.pendingRecordingResults = async () => [
    { egressId: "egress", key: "source" },
  ];
  f.provider.recordingResult = async () => ({ success: true, key: "source" });
  f.media.recordingEnded = async (egress, success, key) => {
    assert.deepEqual([egress, success, key], ["egress", true, "source"]);
    f.calls.push("confirmed");
  };
  await f.operations.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.includes("confirmed"));
  f.provider.recordingResult = async () => {
    throw Error("storage outage");
  };
  for (let i = 0; i < 6; i++) f.advance();
  await f.operations.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.includes("warning"));
  await f.operations.stop();
});
it("rotates recording probes past stuck inputs and continues after one provider failure", async () => {
  const f = fixture();
  const cursors = [];
  const pending = Array.from({ length: 6 }, (_, i) => ({
    debateId: `room-${i}`,
    egressId: `egress-${i}`,
    key: `source-${i}`,
  }));
  f.media.pendingRecordingResults = async (after) => {
    cursors.push(after);
    return after === pending[4].debateId
      ? pending.slice(5)
      : pending.slice(0, 5);
  };
  f.provider.recordingResult = async (egress, key) => {
    if (egress === "egress-0") throw Error("isolated provider failure");
    return egress === "egress-1" || egress === "egress-5"
      ? { success: true, key }
      : null;
  };
  const confirmed = [];
  f.media.recordingEnded = async (egress) => confirmed.push(egress);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 6; i++) f.advance();
    await f.operations.tick();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(cursors, [
    "00000000-0000-0000-0000-000000000000",
    pending[4].debateId,
    "00000000-0000-0000-0000-000000000000",
  ]);
  assert.deepEqual(confirmed, ["egress-1", "egress-5", "egress-1"]);
  assert.ok(f.calls.includes("warning"));
  await f.operations.stop();
});
it("ignores captured turns and repairs only the latest authorized durable state", async () => {
  const f = fixture();
  await f.operations.provider.setTurn(id, "B");
  assert.ok(f.calls.includes("permission:A"));
  f.state({ revision: 2, side: null });
  await f.operations.provider.setTurn(id, "A");
  assert.equal(
    f.calls.filter((call) => call.startsWith("permission:")).at(-1),
    "permission:null",
  );
  assert.equal(
    f.kinds.filter((kind) => kind === "permission_repair").length,
    2,
  );
  await f.operations.stop();
  await assert.rejects(f.operations.reconcile(id), /unavailable/);
});
it("coalesces a room while rechecking requests that overlap the last read", async () => {
  const f = fixture();
  const started = deferred();
  const finish = deferred();
  let calls = 0;
  f.provider.setTurn = async (_id, side) => {
    f.calls.push(`applied:${side}`);
    if (++calls === 1) {
      started.resolve();
      await finish.promise;
    }
  };
  const one = f.operations.reconcile(id);
  await started.promise;
  f.state({ revision: 2, side: null });
  const two = f.operations.reconcile(id);
  assert.equal(one, two);
  finish.resolve();
  await two;
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith("applied:")),
    ["applied:A", "applied:null"],
  );
  await f.operations.stop();
});
it("handles removed rooms and bounds lock retries", async () => {
  const f = fixture({ selected: false });
  await f.operations.reconcile(id);
  assert.ok(f.calls.includes("permission:null"));
  const busy = fixture({ acquired: false });
  await assert.rejects(busy.operations.reconcile(id), /lock unavailable/);
  assert.equal(
    busy.calls.filter((call) => call.includes("pg_try_advisory")).length,
    12,
  );
});
it("fails closed on repeated revision changes, retries failed permissions, and stops pending work", async () => {
  const f = fixture();
  let revision = 1;
  f.provider.setTurn = async (_id, side) => {
    f.calls.push(`applied:${side}`);
    f.state({ revision: ++revision, side: "A" });
  };
  await assert.rejects(f.operations.reconcile(id), /changed repeatedly/);
  assert.equal(
    f.calls.filter((call) => call.startsWith("applied:")).at(-1),
    "applied:null",
  );
  f.provider.setTurn = async () => {
    throw Error("provider outage");
  };
  await f.operations.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await f.operations.stop();
  assert.ok(f.calls.includes("pause"));
  assert.ok(f.kinds.includes("permission_failure"));
});
it("keeps clock advancement separate from slow provider work and uses bounded repair pages", async () => {
  const f = fixture();
  const pending = deferred();
  f.provider.setTurn = async () => pending.promise;
  f.database.query = async () => ({
    rows: Array.from({ length: 8 }, (_, i) => ({ id: `room-${i}` })),
  });
  await f.operations.tick();
  assert.ok(f.kinds.includes("clock_acquired"));
  assert.equal(f.kinds.includes("permission_repair"), false);
  await f.operations.tick();
  f.advance();
  await f.operations.tick();
  const stopping = f.operations.stop();
  pending.resolve();
  await stopping;
  await f.operations.tick();
  const busy = fixture({ acquired: false });
  await busy.operations.tick();
  assert.ok(busy.kinds.includes("clock_contended"));
  await busy.operations.stop();
});
it("bounds process permission work and recovers after provider failures", async () => {
  const f = fixture();
  const pending = deferred();
  f.provider.setTurn = async () => pending.promise;
  const requests = Array.from({ length: 16 }, (_, i) =>
    f.operations.reconcile(`room-${i}`),
  );
  await assert.rejects(f.operations.reconcile("overflow"), /unavailable/);
  pending.resolve();
  await Promise.all(requests);
  await f.operations.stop();
});
