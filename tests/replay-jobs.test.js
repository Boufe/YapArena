import assert from "node:assert/strict";
import { test } from "node:test";
import { createReplayJobs } from "../dist/features/media/replay-jobs.js";

const room = "00000000-0000-4000-8000-000000000001";
const job = {
  id: room,
  debateId: room,
  leaseId: room,
  sourceKey: `debates/${room}/source.mp4`,
};
const digest = "a".repeat(64);
function fixture(mode = "ready") {
  const queries = [];
  let released = false;
  const query = async (text, values) => {
    queries.push({ text, values });
    if (
      mode === "failure" &&
      text.includes("UPDATE yaparena.media_replay_jobs SET state='ready'")
    )
      throw new Error("synthetic database fault");
    if (text.includes("SELECT t.id"))
      return { rows: mode === "hidden" ? [] : [{ id: room }], rowCount: 1 };
    if (text.includes("SELECT status,topic_id"))
      return {
        rows: [
          {
            status: mode === "finalized" ? "finalized" : "ended",
            topic_id: room,
          },
        ],
        rowCount: 1,
      };
    if (text.includes("SELECT j.id FROM") && mode === "expired")
      return { rows: [], rowCount: 0 };
    if (
      text.includes("SELECT id FROM yaparena.media_replay_attempts") &&
      mode === "missing"
    )
      return { rows: [], rowCount: 0 };
    return {
      rows: mode === "empty" ? [] : [{ id: room }],
      rowCount: mode === "empty" ? null : 1,
    };
  };
  const jobs = createReplayJobs({
    query,
    async connect() {
      return {
        query,
        release() {
          released = true;
        },
      };
    },
  });
  return {
    db: {
      query,
      async connect() {
        return {
          query,
          release() {
            released = true;
          },
        };
      },
    },
    jobs,
    queries,
    get released() {
      return released;
    },
  };
}
test("queue accepts bounded scheduling and rejects invalid worker inputs before querying", async () => {
  const f = fixture();
  assert.equal(await f.jobs.reconcile(), 1);
  assert.deepEqual(await f.jobs.claim(), { id: room });
  assert.equal(await f.jobs.heartbeat(job), true);
  assert.equal(await f.jobs.bindSource(job, '"source"'), true);
  await f.jobs.fail(job, "encoder_failed", false);
  assert.deepEqual(await f.jobs.ready(room, job.sourceKey), { id: room });
  const cleanup = await f.jobs.claimCleanup();
  assert.deepEqual(cleanup, { id: room });
  assert.equal(
    await f.jobs.finishCleanup({ id: room, token: room }, true),
    true,
  );
  assert.equal(await f.jobs.prune(), 1);
  for (const operation of [
    () => f.jobs.reconcile(0),
    () => f.jobs.prune(1001),
    () => f.jobs.claim(1),
    () => f.jobs.claim(5000, 1),
    () => f.jobs.heartbeat(job, Infinity),
    () => f.jobs.claimCleanup(0),
    () => f.jobs.bindSource(job, ""),
    () => f.jobs.bindSource(job, "x".repeat(201)),
    () => f.jobs.complete(job, "invalid"),
    () => f.jobs.fail(job, "unsafe/private"),
  ])
    await assert.rejects(operation(), RangeError);
  const empty = fixture("empty");
  assert.equal(await empty.jobs.reconcile(), 0);
  assert.equal(await empty.jobs.claim(), null);
  assert.equal(await empty.jobs.ready(room, job.sourceKey), null);
  assert.equal(await empty.jobs.claimCleanup(), null);
  assert.equal(await empty.jobs.heartbeat(job), false);
  assert.equal(await empty.jobs.bindSource(job, '"source"'), false);
  assert.equal(
    await empty.jobs.finishCleanup({ id: room, token: room }, false),
    false,
  );
  assert.equal(await empty.jobs.prune(), 0);
});

test("room allowlist is validated, copied and fences all publication operations", async () => {
  const f = fixture();
  for (const rooms of [["invalid"], [room, room], Array(1001).fill(room)])
    assert.throws(() => createReplayJobs(f.db, rooms), RangeError);
  const rooms = [room];
  const scoped = createReplayJobs(f.db, rooms);
  rooms.length = 0;
  await scoped.reconcile();
  await scoped.claim();
  assert.deepEqual(
    f.queries.find((q) =>
      q.text.includes("INSERT INTO yaparena.media_replay_jobs"),
    ).values[1],
    [room],
  );
  assert.deepEqual(
    f.queries.find(
      (q) => q.text.includes("WITH due AS") && q.text.includes("claimed AS"),
    ).values[3],
    [room],
  );
  const excluded = createReplayJobs(f.db, []);
  assert.equal(await excluded.bindSource(job, '"source"'), false);
  assert.equal(await excluded.heartbeat(job), false);
  assert.equal(await excluded.complete(job, digest), false);
  assert.equal(await excluded.ready(room, job.sourceKey), null);
});
test("completion releases transactions on revoked visibility, stale lease, missing attempt and database failure", async () => {
  for (const mode of [
    "hidden",
    "expired",
    "missing",
    "failure",
    "ready",
    "finalized",
  ]) {
    const f = fixture(mode);
    if (mode === "failure")
      await assert.rejects(
        f.jobs.complete(job, digest),
        /synthetic database fault/,
      );
    else
      assert.equal(
        await f.jobs.complete(job, digest),
        mode === "ready" || mode === "finalized",
      );
    assert.equal(f.released, true);
    const writes = f.queries.map((q) => q.text).join("\n");
    assert.equal(
      writes.includes("INSERT INTO yaparena.event_history"),
      mode === "ready",
    );
    assert.equal(
      f.queries.at(-1).text,
      mode === "ready" || mode === "finalized" ? "COMMIT" : "ROLLBACK",
    );
    assert.equal(writes.includes("financial_"), false);
  }
});
