import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  buildReplayPackage,
  inspectReplayPackage,
  run,
  ReplayFailure,
} from "../dist/features/media/replay-packaging.js";
import { createReplayWorker } from "../dist/features/media/replay-worker.js";
import { replayStorageFixture } from "./helpers/replay-storage.js";

const room = "00000000-0000-4000-8000-000000000001";
const sourceKey = `debates/${room}/recording.mp4`;
const packageKey = `debates/${room}/package-00000000-0000-4000-8000-000000000002.mp4`;
const captions = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSynthetic tone\n";
const errorCode = (code) => (error) =>
  error instanceof ReplayFailure && error.code === code;
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "yaparena-replay-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = resolve(directory, "input.mp4");
  await writeFile(input, "synthetic mp4");
  const output = resolve(directory, "output");
  const runProcess = async (command, args) => {
    if (command === "ffprobe")
      return JSON.stringify({
        format: { duration: "2", format_name: "mov,mp4" },
        streams: [
          { codec_type: "video", width: 1280, height: 720 },
          { codec_type: "audio", channels: 2 },
        ],
      });
    const playlist = args.at(-1);
    await writeFile(
      playlist,
      "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2.000000,\nsegment00000.ts\n#EXT-X-ENDLIST\n",
    );
    await writeFile(resolve(playlist, "..", "segment00000.ts"), "synthetic ts");
    return "";
  };
  return { directory, input, output, runProcess };
}

test("encoder runner bounds output/time, drains cancellation and sanitizes failure", async () => {
  assert.equal(
    await run(process.execPath, ["-e", "process.stdout.write('ok')"]),
    "ok",
  );
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(3)"]),
    errorCode("encoder_failed"),
  );
  await assert.rejects(
    run("yaparena-synthetic-missing-command", []),
    errorCode("process_unavailable"),
  );
  await assert.rejects(
    run(process.execPath, ["-e", "process.stdout.write('123456789')"], {
      maxOutputBytes: 2,
    }),
    errorCode("process_output_limit"),
  );
  await assert.rejects(
    run(process.execPath, ["-e", "setTimeout(()=>{},1000)"], { timeoutMs: 10 }),
    errorCode("process_timeout"),
  );
  const controller = new AbortController();
  const pending = run(process.execPath, ["-e", "setTimeout(()=>{},1000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, errorCode("cancelled"));
  await assert.rejects(
    run(process.execPath, [], { signal: controller.signal }),
    errorCode("cancelled"),
  );
});

test("stuck encoder ignores SIGTERM then is killed and drained within shutdown budget", async () => {
  const controller = new AbortController();
  let pid;
  const before = performance.now();
  const pending = run(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
    ],
    {
      signal: controller.signal,
      spawnProcess(command, args, options) {
        const child = spawn(command, args, options);
        pid = child.pid;
        child.stdout.once("data", () => controller.abort());
        return child;
      },
    },
  );
  await assert.rejects(pending, errorCode("cancelled"));
  assert.ok(performance.now() - before < 8000);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("three aligned immutable renditions work with optional reviewed captions", async (t) => {
  const f = await fixture(t);
  const manifest = await buildReplayPackage(f.input, f.output, null, {
    runProcess: f.runProcess,
  });
  assert.equal(manifest.files.length, 7);
  assert.equal(manifest.captionsSha256, null);
  await assert.rejects(
    buildReplayPackage(f.input, f.output, null, { runProcess: f.runProcess }),
    { code: "EEXIST" },
  );
  const captioned = await buildReplayPackage(
    f.input,
    resolve(f.directory, "captioned"),
    captions,
    { runProcess: f.runProcess },
  );
  assert.equal(captioned.files.length, 8);
  assert.match(captioned.captionsSha256, /^[a-f0-9]{64}$/);
  for (const value of [
    "missing",
    "WEBVTT\n<script>bad</script>",
    `WEBVTT\n${"é".repeat(100_000)}`,
  ])
    await assert.rejects(
      buildReplayPackage(f.input, f.output, value),
      errorCode("invalid_captions"),
    );
  await assert.rejects(
    buildReplayPackage(f.input, f.output, null, { maxInputBytes: 1 }),
    errorCode("source_limit"),
  );
  await assert.rejects(
    buildReplayPackage(f.input, resolve(f.directory, "small"), null, {
      maxOutputBytes: 1,
      runProcess: f.runProcess,
    }),
    errorCode("output_limit"),
  );
  await assert.rejects(
    buildReplayPackage(f.input, f.output, null, {
      runProcess: async () =>
        JSON.stringify({ format: { duration: "-1", format_name: "mp4" } }),
    }),
    errorCode("invalid_source"),
  );
});

test("package inspection rejects missing end, traversal, alignment, file and byte limits", async (t) => {
  const f = await fixture(t);
  const manifest = await buildReplayPackage(f.input, f.output, null, {
    runProcess: f.runProcess,
  });
  const inspect = (options) =>
    inspectReplayPackage(f.output, 2, manifest.sourceSha256, null, options);
  await assert.rejects(inspect({ maxFiles: 2 }), errorCode("file_limit"));
  await assert.rejects(
    inspect({ maxOutputBytes: 1 }),
    errorCode("output_limit"),
  );
  const playlist = resolve(f.output, "480/index.m3u8");
  const original = await readFile(playlist, "utf8");
  await writeFile(playlist, original.replace("#EXT-X-ENDLIST", ""));
  await assert.rejects(inspect(), errorCode("incomplete_playlist"));
  await writeFile(
    playlist,
    original.replace("segment00000.ts", "../../private.mp4"),
  );
  await assert.rejects(inspect(), errorCode("unaligned_playlist"));
  await writeFile(playlist, original.replace("2.000000", "1.700000"));
  await assert.rejects(inspect(), errorCode("unaligned_playlist"));
  await writeFile(playlist, "#".repeat(1_000_001));
  await assert.rejects(inspect(), errorCode("playlist_limit"));
  await rm(playlist);
  await symlink(f.input, playlist);
  await assert.rejects(inspect(), errorCode("invalid_output_file"));
  await rm(playlist);
  await writeFile(playlist, original);
  await writeFile(resolve(f.output, "480/not-allowlisted"), "bad");
  await assert.rejects(inspect(), errorCode("invalid_output_path"));
  await rm(resolve(f.output, "480/not-allowlisted"));
  await writeFile(resolve(f.output, "480/segment00000.ts"), "");
  await assert.rejects(inspect(), errorCode("invalid_output_file"));
});

test("encoding disk monitor aborts runaway output before all renditions run", async (t) => {
  const f = await fixture(t);
  let encodes = 0;
  const slow = async (command, args, options) => {
    if (command === "ffprobe") return f.runProcess(command, args, options);
    encodes++;
    await writeFile(
      resolve(args.at(-1), "..", "segment00000.ts"),
      Buffer.alloc(4_000_001),
    );
    await new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      ),
    );
    return "";
  };
  await assert.rejects(
    buildReplayPackage(f.input, f.output, null, { runProcess: slow }),
    errorCode("output_limit"),
  );
  assert.equal(encodes, 1);
});

test("package rejects master injection and corrupted reviewed captions", async (t) => {
  const f = await fixture(t);
  const manifest = await buildReplayPackage(f.input, f.output, captions, {
    runProcess: f.runProcess,
  });
  await writeFile(resolve(f.output, "captions.vtt"), "WEBVTT\ncorrupt");
  await assert.rejects(
    inspectReplayPackage(f.output, 2, manifest.sourceSha256, captions),
    errorCode("output_changed"),
  );
  await writeFile(
    resolve(f.output, "master.m3u8"),
    "#EXTM3U\nhttps://private.invalid/media",
  );
  await assert.rejects(
    inspectReplayPackage(f.output, 2, manifest.sourceSha256, null),
    errorCode("invalid_master"),
  );
});

test("storage pins a bounded source, verifies immutable files, publishes marker last and cleans only its prefix", async (t) => {
  const f = await fixture(t);
  const manifest = await buildReplayPackage(f.input, f.output, null, {
    runProcess: f.runProcess,
  });
  const s = replayStorageFixture();
  const body = await readFile(f.input);
  s.put(sourceKey, body);
  let pinned;
  await s.storage.download(sourceKey, resolve(f.directory, "download.mp4"), {
    acceptSource: async (etag) => {
      pinned = etag;
      return true;
    },
  });
  assert.equal(pinned, s.objects.get(sourceKey).etag);
  assert.deepEqual(await readFile(resolve(f.directory, "download.mp4")), body);
  await assert.rejects(s.storage.download(sourceKey, f.input), {
    code: "EEXIST",
  });
  await assert.rejects(
    s.storage.download(sourceKey, f.input, { acceptSource: async () => false }),
    errorCode("source_changed"),
  );
  await assert.rejects(
    s.storage.download(sourceKey, f.input, { maxInputBytes: 1 }),
    errorCode("source_limit"),
  );
  await assert.rejects(
    s.storage.download("../private", f.input),
    errorCode("invalid_key"),
  );
  let checked = false;
  const digest = await s.storage.upload(
    f.output,
    manifest,
    packageKey,
    undefined,
    async () => {
      checked = true;
      assert.equal(
        [...s.objects.keys()].some((key) => key.endsWith("ready.json")),
        false,
      );
    },
  );
  assert.equal(checked, true);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const markerKey = packageKey.slice(0, -4) + "/hls/ready.json";
  assert.equal(s.commands.at(-1).input.Key, markerKey);
  assert.equal(
    JSON.parse(s.objects.get(markerKey).body).reviewedCaptions,
    false,
  );
  await assert.rejects(
    s.storage.upload(f.output, manifest, packageKey),
    /immutable precondition/,
  );
  assert.equal(await s.storage.removePackage(packageKey), 8);
  assert.equal(s.objects.size, 1);
  assert.ok(s.objects.has(sourceKey));
  await assert.rejects(
    s.storage.removePackage(sourceKey),
    errorCode("invalid_cleanup_key"),
  );
  s.storage.close();
  assert.equal(s.closed, true);
});

test("partial upload, failed verification and revoked lease never write ready marker", async (t) => {
  const f = await fixture(t);
  const manifest = await buildReplayPackage(f.input, f.output, null, {
    runProcess: f.runProcess,
  });
  for (const fault of ["put", "verify", "lease"]) {
    const s = replayStorageFixture(async (command) => {
      if (fault === "put" && command.constructor.name === "PutObjectCommand")
        throw new Error("synthetic outage");
      if (
        fault === "verify" &&
        command.constructor.name === "HeadObjectCommand"
      )
        return { ContentLength: 999 };
    });
    await assert.rejects(
      s.storage.upload(f.output, manifest, packageKey, undefined, async () => {
        if (fault === "lease") throw new ReplayFailure("lease_lost");
      }),
    );
    assert.equal(
      [...s.objects.keys()].some((key) => key.endsWith("ready.json")),
      false,
    );
  }
  const s = replayStorageFixture();
  await assert.rejects(
    s.storage.upload(f.output, { ...manifest, files: [] }, packageKey),
    errorCode("invalid_manifest"),
  );
  await assert.rejects(
    s.storage.upload(
      f.output,
      { ...manifest, files: [{ ...manifest.files[0], path: "../private" }] },
      packageKey,
    ),
    errorCode("invalid_manifest"),
  );
  await writeFile(resolve(f.output, manifest.files[0].path), "modified");
  await assert.rejects(
    s.storage.upload(f.output, manifest, packageKey),
    errorCode("output_changed"),
  );
});

test("source streaming and cleanup reject corrupt size, missing body, foreign prefix and partial deletion", async (t) => {
  const f = await fixture(t);
  for (const response of [
    {},
    {
      Body: (async function* () {
        yield Buffer.alloc(20);
      })(),
    },
    {
      Body: (async function* () {
        yield Buffer.alloc(1);
      })(),
    },
  ]) {
    const s = replayStorageFixture(async (command) => {
      if (command.constructor.name === "HeadObjectCommand")
        return { ContentLength: 10, ETag: '"fixed"' };
      if (command.constructor.name === "GetObjectCommand") return response;
    });
    await assert.rejects(
      s.storage.download(
        sourceKey,
        resolve(f.directory, `bad-${Math.random()}`),
      ),
    );
  }
  const foreign = replayStorageFixture(async (command) => {
    if (command.constructor.name === "ListObjectsV2Command")
      return { Contents: [{ Key: "another-room/private" }] };
  });
  await assert.rejects(
    foreign.storage.removePackage(packageKey),
    errorCode("invalid_cleanup_listing"),
  );
  const partial = replayStorageFixture(async (command) => {
    if (command.constructor.name === "DeleteObjectsCommand")
      return { Errors: [{ Code: "Denied" }] };
  });
  partial.put(packageKey.slice(0, -4) + "/hls/master.m3u8", "synthetic");
  await assert.rejects(
    partial.storage.removePackage(packageKey),
    errorCode("cleanup_failed"),
  );
});

test("cleanup pages repeatedly, bounds deletion work and honors abortion", async () => {
  const s = replayStorageFixture();
  const prefix = packageKey.slice(0, -4) + "/hls/";
  for (let index = 0; index < 1201; index++)
    s.put(
      prefix + `240/segment${String(index).padStart(5, "0")}.ts`,
      "synthetic",
    );
  assert.equal(await s.storage.removePackage(packageKey), 1201);
  assert.equal(
    s.commands.filter((c) => c.constructor.name === "ListObjectsV2Command")
      .length,
    3,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    s.storage.removePackage(packageKey, controller.signal),
    errorCode("cancelled"),
  );
  const oversized = replayStorageFixture(async (command) => {
    if (command.constructor.name === "ListObjectsV2Command")
      return {
        Contents: Array.from({ length: 1000 }, (_, index) => ({
          Key: prefix + `240/segment${String(index).padStart(5, "0")}.ts`,
        })),
      };
  });
  await assert.rejects(
    oversized.storage.removePackage(packageKey),
    errorCode("cleanup_limit"),
  );
});

test("poll failure remains bounded and logs fixed queue event", async () => {
  const f = workerFixture({
    jobs: {
      async reconcile() {
        throw new Error("private database details");
      },
    },
  });
  f.worker.start();
  await delay(5);
  await f.worker.stop();
  assert.ok(f.calls.includes("replay_queue_failed"));
  assert.equal(JSON.stringify(f.calls).includes("private"), false);
});

function workerFixture(overrides = {}) {
  const calls = [];
  let claimed = false;
  const job = {
    id: room,
    debateId: room,
    sourceKey,
    packageKey,
    leaseId: room,
    captionHash: "a".repeat(64),
    captionsVtt: null,
    attempts: 1,
    sourceEtag: null,
  };
  const jobs = {
    async reconcile() {
      calls.push("reconcile");
    },
    async prune() {},
    async claim() {
      if (claimed) return null;
      claimed = true;
      return job;
    },
    async heartbeat() {
      return true;
    },
    async bindSource() {
      return true;
    },
    async complete() {
      calls.push("complete");
      return true;
    },
    async fail(_job, code, retryable) {
      calls.push(["fail", code, retryable]);
    },
    async claimCleanup() {
      return null;
    },
    async finishCleanup(_attempt, success) {
      calls.push(["cleanup", success]);
    },
    ...overrides.jobs,
  };
  const storage = {
    async download(_source, path, options) {
      assert.equal(await options.acceptSource('"fixed"'), true);
      await writeFile(path, "synthetic");
    },
    async upload(_dir, _manifest, _key, _signal, check) {
      await check();
      calls.push("upload");
      return "a".repeat(64);
    },
    async removePackage() {},
    close() {},
    ...overrides.storage,
  };
  const logger = {
    info(value) {
      calls.push(value.event);
    },
    warn(value) {
      calls.push(value.event);
    },
  };
  const worker = createReplayWorker({
    jobs,
    storage,
    logger,
    options: overrides.options,
    packageMedia:
      overrides.packageMedia ??
      (async (_source, dir, captions) => {
        assert.equal(captions, null);
        await mkdir(dir);
        return { files: [], bytes: 123 };
      }),
  });
  return { worker, calls };
}

test("worker batches once, publishes without captions and removes private temporary media", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "yaparena-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = workerFixture({ options: { tempRoot: root, concurrency: 2 } });
  const a = f.worker.tick();
  assert.equal(f.worker.tick(), a);
  await a;
  assert.deepEqual(f.calls, [
    "reconcile",
    "upload",
    "complete",
    "replay_ready",
  ]);
  assert.deepEqual(await readdir(root), []);
  await f.worker.stop();
  await f.worker.tick();
});

test("worker treats lease loss as fenced failure, retries cleanup and logs sanitized codes", async () => {
  const f = workerFixture({
    jobs: {
      async heartbeat() {
        return false;
      },
      async claimCleanup() {
        return { id: room, packageKey, token: room };
      },
    },
    storage: {
      async removePackage() {
        throw new Error("synthetic secret");
      },
    },
  });
  await f.worker.tick();
  assert.ok(
    f.calls.some(
      (call) =>
        Array.isArray(call) && call[0] === "fail" && call[1] === "lease_lost",
    ),
  );
  assert.ok(
    f.calls.some(
      (call) =>
        Array.isArray(call) && call[0] === "cleanup" && call[1] === false,
    ),
  );
  assert.equal(JSON.stringify(f.calls).includes("secret"), false);
  await f.worker.stop();
  for (const options of [
    { concurrency: 3 },
    { leaseMs: 5000 },
    { maxJobMs: 5000 },
    { heartbeatMs: 0 },
  ])
    assert.throws(() => workerFixture({ options }), RangeError);
});

test("shutdown aborts active media work, drains and stops polling", async () => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const f = workerFixture({
    storage: {
      async download(_source, _path, { signal }) {
        began();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
  });
  f.worker.start();
  f.worker.start();
  await started;
  const before = performance.now();
  await f.worker.stop();
  assert.ok(performance.now() - before < 8000);
  assert.ok(
    f.calls.some((call) => Array.isArray(call) && call[1] === "cancelled"),
  );
  f.worker.start();
  await delay(5);
  assert.equal(f.calls.filter((call) => call === "reconcile").length, 1);
});

test("worker periodic heartbeat cancels lost lease during packaging and drains sibling failures", async () => {
  let heartbeat = 0;
  const f = workerFixture({
    options: { leaseMs: 5000, heartbeatMs: 100, maxJobMs: 5000 },
    jobs: {
      async heartbeat() {
        heartbeat++;
        throw new Error("synthetic offline database");
      },
    },
    packageMedia: async (_input, _directory, _captions, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  });
  await f.worker.tick();
  assert.equal(heartbeat, 1);
  assert.ok(
    f.calls.some((call) => Array.isArray(call) && call[1] === "lease_lost"),
  );
  await f.worker.stop();
  const bad = workerFixture({
    jobs: {
      async complete() {
        return false;
      },
    },
  });
  await bad.worker.tick();
  assert.ok(
    bad.calls.some((call) => Array.isArray(call) && call[1] === "lease_lost"),
  );
  await bad.worker.stop();
  const db = workerFixture({
    jobs: {
      async fail() {
        throw new Error("synthetic database failure");
      },
    },
    storage: {
      async download() {
        throw new Error("private provider credentials");
      },
    },
  });
  await assert.rejects(db.worker.tick(), /synthetic database failure/);
  await db.worker.stop();
});
