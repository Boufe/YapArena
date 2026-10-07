import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { createReplayJobs } from "../dist/features/media/replay-jobs.js";
import {
  buildReplayPackage,
  run,
} from "../dist/features/media/replay-packaging.js";
import { createReplayWorker } from "../dist/features/media/replay-worker.js";
import { verifyRuntimeIdentity } from "../dist/platform/database.js";
import { replayStorageFixture } from "../tests/helpers/replay-storage.js";
import { provisionDatabase } from "./provision-database.js";

// No .env, hosted URLs, provider access or bucket writes. Every role and object
// belongs to this disposable local cluster/synthetic in-memory storage adapter.
const exec = promisify(execFile);
const quiet = { info() {}, warn() {}, error() {} };
const directory = await mkdtemp("/tmp/yaparena-replay-trial-");
const passwords = Object.fromEntries(
  ["postgres", "yaparena_owner", "yaparena_runtime"].map((role) => [
    role,
    randomBytes(24).toString("hex"),
  ]),
);
let started = false;
let admin, owner, pool;
let peakEncoderRssKiB = 0;
let samples = [];
const spawned = (command, args, options) => {
  const child = spawn(command, args, options);
  if (child.pid) {
    const sample = () => {
      const pending = exec("ps", ["-o", "rss=", "-p", String(child.pid)])
        .then(({ stdout }) => {
          peakEncoderRssKiB = Math.max(
            peakEncoderRssKiB,
            Number(stdout.trim()) || 0,
          );
        })
        .catch(() => {});
      samples.push(pending);
    };
    const interval = setInterval(sample, 30);
    sample();
    child.once("close", () => clearInterval(interval));
  }
  return child;
};
const measuredRun = (command, args, options) =>
  run(command, args, { ...options, spawnProcess: spawned });
try {
  assert.match(process.version, /^v24\./);
  const postgresVersion = (await exec("initdb", ["--version"])).stdout.trim();
  assert.match(postgresVersion, /PostgreSQL\) (17|18)\./);
  const passwordFile = resolve(directory, "password");
  await writeFile(passwordFile, passwords.postgres, { mode: 0o600 });
  await exec("initdb", [
    "--pgdata",
    resolve(directory, "data"),
    "--username",
    "postgres",
    "--auth",
    "scram-sha-256",
    "--pwfile",
    passwordFile,
  ]);
  await rm(passwordFile);
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  await exec("pg_ctl", [
    "--pgdata",
    resolve(directory, "data"),
    "--log",
    resolve(directory, "postgres.log"),
    "--options",
    `-p ${port} -h 127.0.0.1 -k ${directory}`,
    "--wait",
    "start",
  ]);
  started = true;
  const config = (role) => ({
    host: "127.0.0.1",
    port,
    database: "postgres",
    user: role,
    password: passwords[role],
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
    query_timeout: 3000,
    connectionTimeoutMillis: 2000,
  });
  admin = new pg.Client(config("postgres"));
  await admin.connect();
  await provisionDatabase(admin, passwords);
  owner = new pg.Client(config("yaparena_owner"));
  await owner.connect();
  await runner({
    dbClient: owner,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    logger: quiet,
    log() {},
  });
  await admin.query(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN",
  );
  pool = new pg.Pool({ ...config("yaparena_runtime"), max: 8 });
  await verifyRuntimeIdentity(pool);
  const jobs = createReplayJobs(pool);
  const topic = (
    await owner.query(`INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
    VALUES('replay-trial','Synthetic replay','Synthetic','For','Against','published') RETURNING id`)
  ).rows[0].id;
  const event = async (name, status = "ended") => {
    const room = (
      await owner.query(
        `INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot)
      SELECT $1,$2,'Synthetic replay',$3,'published',version,rules FROM event_rule_versions WHERE version='prototype-media-1' RETURNING id`,
        [name, topic, status],
      )
    ).rows[0].id;
    const sourceKey = `debates/${room}/${randomUUID()}.mp4`;
    await owner.query(
      `INSERT INTO debate_media(debate_id,state,recording_status,egress_id,recording_key)
      VALUES($1,'ended','ready',$2,$3)`,
      [room, randomUUID(), sourceKey],
    );
    return { room, sourceKey };
  };
  const digest = "a".repeat(64);
  const initial = await event("replay-concurrent");
  const enqueued = await Promise.all([
    jobs.reconcile(),
    jobs.reconcile(),
    jobs.reconcile(),
  ]);
  assert.equal(
    enqueued.reduce((a, b) => a + b, 0),
    1,
  );
  const claims = await Promise.all(
    Array.from({ length: 5 }, () => jobs.claim()),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean);
  assert.equal(await jobs.bindSource(job, '"fixed-source"'), true);
  assert.equal(await jobs.bindSource(job, '"changed-source"'), false);
  assert.equal(await jobs.heartbeat({ ...job, leaseId: randomUUID() }), false);
  // Roll back after publication SQL has run, proving state/history/cursor/job
  // are one transaction rather than four separately committed writes.
  const cursor = (
    await owner.query(
      "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
      [initial.room],
    )
  ).rows[0].cursor;
  const injected = createReplayJobs({
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        query(text, args) {
          if (text.includes("INSERT INTO yaparena.event_history"))
            throw new Error("synthetic transaction fault");
          return client.query(text, args);
        },
        release() {
          client.release();
        },
      };
    },
  });
  await assert.rejects(
    injected.complete(job, digest),
    /synthetic transaction fault/,
  );
  assert.equal(await jobs.ready(initial.room, initial.sourceKey), null);
  assert.equal(
    (
      await owner.query("SELECT status FROM debates WHERE id=$1", [
        initial.room,
      ])
    ).rows[0].status,
    "ended",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT cursor::text FROM community_rooms WHERE room_id=$1",
        [initial.room],
      )
    ).rows[0].cursor,
    cursor,
  );
  assert.equal(await jobs.complete(job, digest), true);
  assert.equal(await jobs.complete(job, digest), false);
  assert.deepEqual(await jobs.ready(initial.room, initial.sourceKey), {
    packageKey: job.packageKey,
    hasCaptions: false,
  });
  assert.equal(
    (
      await owner.query(
        "SELECT status,live_ended_at FROM debates WHERE id=$1",
        [initial.room],
      )
    ).rows[0].status,
    "replay",
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int n FROM event_history WHERE debate_id=$1 AND action='automatic_replay' AND actor_user_id IS NULL",
        [initial.room],
      )
    ).rows[0].n,
    1,
  );
  await jobs.fail(job, "processing_failed");
  assert.equal(
    (
      await pool.query("SELECT state FROM media_replay_attempts WHERE id=$1", [
        job.leaseId,
      ])
    ).rows[0].state,
    "ready",
    "uncertain commit never cleans a published package",
  );
  console.log(
    "PostgreSQL concurrent enqueue/claim, source pin, transaction rollback, atomic automatic publication and idempotent completion PASS",
  );

  // A removal transaction holds the domain lock while a completion starts.
  // Completion must wait, re-read visibility and refuse after removal commits.
  const removed = await event("replay-removal");
  await jobs.reconcile();
  const removedJob = await jobs.claim();
  await jobs.bindSource(removedJob, '"fixed"');
  const remover = await pool.connect();
  await remover.query("BEGIN");
  await remover.query(
    "UPDATE debates SET publication_state='hidden' WHERE id=$1",
    [removed.room],
  );
  let finished = false;
  const pending = jobs.complete(removedJob, digest).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, false);
  await remover.query("COMMIT");
  remover.release();
  assert.equal(await pending, false);
  assert.equal(await jobs.ready(removed.room, removed.sourceKey), null);
  await jobs.fail(removedJob, "lease_lost");
  const cleanup = await jobs.claimCleanup();
  assert.equal(cleanup.packageKey, removedJob.packageKey);
  assert.equal(
    await jobs.finishCleanup({ ...cleanup, token: randomUUID() }, true),
    false,
  );
  assert.equal(await jobs.finishCleanup(cleanup, true), true);

  const expired = await event("replay-expiry");
  await jobs.reconcile();
  const expiredJob = await jobs.claim();
  await owner.query(
    "UPDATE media_replay_jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [expiredJob.id],
  );
  await jobs.reconcile();
  await owner.query(
    "UPDATE media_replay_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1",
    [expiredJob.id],
  );
  const replacement = await jobs.claim();
  assert.notEqual(replacement.leaseId, expiredJob.leaseId);
  assert.equal(await jobs.bindSource(expiredJob, '"old"'), false);
  assert.equal(await jobs.complete(expiredJob, digest), false);
  await jobs.bindSource(replacement, '"new"');
  await owner.query(
    "UPDATE debate_media SET captions_vtt=$2 WHERE debate_id=$1",
    [
      expired.room,
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nReviewed synthetic tone\n",
    ],
  );
  assert.equal(await jobs.complete(replacement, digest), false);
  await jobs.fail(replacement, "lease_lost");
  await jobs.reconcile();
  const captionJob = await jobs.claim();
  assert.equal(captionJob.attempts, 1);
  assert.ok(captionJob.captionsVtt);
  await jobs.bindSource(captionJob, '"new"');
  assert.equal(await jobs.complete(captionJob, digest), true);
  assert.equal(
    (await jobs.ready(expired.room, expired.sourceKey)).hasCaptions,
    true,
  );

  const deleted = await event("replay-delete");
  await jobs.reconcile();
  const deletedJob = await jobs.claim();
  await owner.query("DELETE FROM debates WHERE id=$1", [deleted.room]);
  assert.equal(await jobs.complete(deletedJob, digest), false);
  await jobs.fail(deletedJob, "lease_lost");
  assert.equal(
    (
      await pool.query("SELECT state FROM media_replay_jobs WHERE id=$1", [
        deletedJob.id,
      ])
    ).rows[0].state,
    "cancelled",
  );
  assert.ok(
    (
      await pool.query("SELECT id FROM media_replay_attempts WHERE job_id=$1", [
        deletedJob.id,
      ])
    ).rowCount,
  );

  const retry = await event("replay-retries");
  await jobs.reconcile();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const claimed = await jobs.claim();
    assert.equal(claimed.attempts, attempt);
    await jobs.fail(claimed, "encoder_failed");
    await owner.query(
      "UPDATE media_replay_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1",
      [claimed.id],
    );
  }
  await jobs.reconcile();
  assert.equal(await jobs.claim(), null);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM media_replay_jobs WHERE debate_id=$1",
        [retry.room],
      )
    ).rows[0].state,
    "failed",
  );
  await owner.query(
    "UPDATE topics SET publication_state='hidden' WHERE id=$1",
    [topic],
  );
  assert.equal(await jobs.ready(initial.room, initial.sourceKey), null);
  console.log(
    "PostgreSQL removal/complete race, stale lease fencing, caption invalidation, deletion tombstones, five-attempt budget and topic revocation PASS",
  );

  const denial =
    await admin.query(`SELECT r.rolname,has_schema_privilege(r.oid,'yaparena','USAGE') AS access
    FROM pg_roles r WHERE rolname IN('anon','authenticated')`);
  assert.ok(denial.rows.every((row) => !row.access));
  await assert.rejects(
    pool.query("UPDATE media_replay_jobs SET source_key=$2 WHERE id=$1", [
      job.id,
      job.sourceKey,
    ]),
    (error) => error.code === "42501",
  );
  await assert.rejects(
    pool.query(
      "ALTER TABLE yaparena.media_replay_jobs DISABLE ROW LEVEL SECURITY",
    ),
    (error) => error.code === "42501",
  );
  const tables = (
    await admin.query(
      "SELECT relname,relrowsecurity FROM pg_class WHERE relname IN('media_replay_jobs','media_replay_attempts')",
    )
  ).rows;
  assert.equal(tables.length, 2);
  assert.ok(tables.every((row) => row.relrowsecurity));
  await jobs.reconcile();
  await owner.query(
    "UPDATE media_replay_attempts SET state='cleaned' WHERE state<>'cleaned'",
  );
  await owner.query(
    "UPDATE media_replay_jobs SET updated_at=clock_timestamp()-INTERVAL '31 days' WHERE state='cancelled'",
  );
  assert.ok(await jobs.prune());
  console.log(
    "Runtime-only RLS/grants, immutable binding columns and bounded tombstone retention PASS",
  );

  await owner.query(
    "UPDATE topics SET publication_state='published' WHERE id=$1",
    [topic],
  );
  // Keep earlier fixtures ineligible before running the actual complete worker.
  await owner.query("UPDATE debates SET publication_state='hidden'");
  const synthetic = await event("replay-automatic-encoder");
  const input = resolve(directory, "synthetic.mp4");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    input,
  ]);
  const storage = replayStorageFixture();
  storage.put(synthetic.sourceKey, await readFile(input));
  const before = performance.now();
  const worker = createReplayWorker({
    jobs,
    storage: storage.storage,
    logger: quiet,
    options: { tempRoot: directory },
    packageMedia: (input, output, captions, options) =>
      buildReplayPackage(input, output, captions, {
        ...options,
        runProcess: measuredRun,
      }),
  });
  await worker.tick();
  await worker.stop();
  await Promise.all(samples);
  samples = [];
  const ready = await jobs.ready(synthetic.room, synthetic.sourceKey);
  assert.ok(ready);
  assert.equal(ready.hasCaptions, false);
  const prefix = ready.packageKey.slice(0, -4) + "/hls/";
  const marker = JSON.parse(storage.objects.get(prefix + "ready.json").body);
  assert.equal(marker.files, 13);
  assert.equal(marker.reviewedCaptions, false);
  assert.equal(
    storage.commands
      .filter((command) => command.constructor.name === "PutObjectCommand")
      .at(-1).input.Key,
    prefix + "ready.json",
  );
  assert.equal(
    (
      await owner.query("SELECT status FROM debates WHERE id=$1", [
        synthetic.room,
      ])
    ).rows[0].status,
    "replay",
  );
  assert.equal(
    (await readdir(directory)).filter((name) =>
      name.startsWith("yaparena-replay-"),
    ).length,
    0,
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      node: process.version,
      postgres: postgresVersion,
      ffmpeg: (await exec("ffmpeg", ["-version"])).stdout.split("\n")[0],
      sourceSeconds: 6,
      encoderThreads: 2,
      elapsedSeconds: Number(((performance.now() - before) / 1000).toFixed(3)),
      peakEncoderRssMiB: Number((peakEncoderRssKiB / 1024).toFixed(2)),
      workerPeakRssMiB: Number(
        (process.resourceUsage().maxRSS / 1024).toFixed(2),
      ),
      packageFiles: marker.files,
      packageBytes: marker.bytes,
      scope:
        "real PostgreSQL runtime transactions + FFmpeg, synthetic in-memory object adapter; no hosted storage/edge or physical-device evidence",
    }),
  );
} finally {
  await pool?.end();
  await owner?.end();
  await admin?.end();
  if (started)
    await exec("pg_ctl", [
      "--pgdata",
      resolve(directory, "data"),
      "--mode",
      "fast",
      "--wait",
      "stop",
    ]);
  await rm(directory, { recursive: true, force: true });
}
