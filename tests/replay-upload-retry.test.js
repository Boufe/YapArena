import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { replayStorageFixture } from "./helpers/replay-storage.js";
import { ReplayFailure } from "../dist/features/media/replay-packaging.js";

const packageKey =
  "debates/00000000-0000-4000-8000-000000000001/package-00000000-0000-4000-8000-000000000002.mp4";
const prefix = packageKey.slice(0, -4) + "/hls/";
const transient = (code) =>
  Object.assign(new Error("private TLS/provider detail"), { code });
const status = (code) =>
  Object.assign(new Error("private provider response"), {
    $metadata: { httpStatusCode: code },
  });
const failure = (code) => (error) =>
  error instanceof ReplayFailure && error.code === code;
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), "yaparena-upload-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from("synthetic master body");
  await writeFile(resolve(directory, "master.m3u8"), body);
  return {
    directory,
    body,
    manifest: {
      version: 1,
      durationSeconds: 2,
      sourceSha256: "a".repeat(64),
      captionsSha256: null,
      bytes: body.length,
      files: [
        {
          path: "master.m3u8",
          bytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
          contentType: "application/vnd.apple.mpegurl",
        },
      ],
    },
  };
}
async function consume(command) {
  if (typeof command.input.Body === "string")
    return Buffer.from(command.input.Body);
  const chunks = [];
  for await (const chunk of command.input.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const retry = { pause: async () => {}, random: () => 0.5 };

test("transient TLS before commit retries with fresh closed streams, bounded jitter and immutable headers", async (t) => {
  const f = await fixture(t);
  let puts = 0;
  const pauses = [];
  const streams = [];
  const s = replayStorageFixture(
    async (command) => {
      if (
        command.constructor.name === "PutObjectCommand" &&
        command.input.Key.endsWith("master.m3u8")
      ) {
        puts++;
        streams.push(command.input.Body);
        if (puts < 3) throw transient("ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC");
      }
    },
    {
      pause: async (ms) => {
        pauses.push(ms);
      },
      random: () => 0.5,
    },
  );
  await s.storage.upload(f.directory, f.manifest, packageKey);
  assert.equal(puts, 3);
  assert.equal(new Set(streams).size, 3);
  assert.ok(streams.every((stream) => stream.destroyed && stream.closed));
  assert.deepEqual(pauses, [150, 300]);
  assert.ok(
    s.commands
      .filter((c) => c.constructor.name === "PutObjectCommand")
      .every((c) => c.input.IfNoneMatch === "*"),
  );
  assert.ok(s.objects.has(prefix + "ready.json"));
});

test("lost acknowledgment for media and ready marker accepts only exact own object provenance", async (t) => {
  const f = await fixture(t);
  let s;
  s = replayStorageFixture(async (command) => {
    if (command.constructor.name === "PutObjectCommand") {
      if (s.objects.has(command.input.Key)) return;
      s.put(command.input.Key, await consume(command), command.input.Metadata);
      throw transient("ECONNRESET");
    }
  }, retry);
  await s.storage.upload(f.directory, f.manifest, packageKey);
  assert.equal(
    s.commands.filter((c) => c.constructor.name === "PutObjectCommand").length,
    2,
  );
  const marker = JSON.parse(s.objects.get(prefix + "ready.json").body);
  assert.equal(marker.files, 1);
  assert.equal(marker.reviewedCaptions, false);
  assert.match(
    s.objects.get(prefix + "ready.json").metadata.sha256,
    /^[a-f0-9]{64}$/,
  );
  const before = s.commands.length;
  await assert.rejects(
    s.storage.upload(f.directory, f.manifest, packageKey),
    failure("upload_conflict"),
  );
  assert.equal(
    s.commands.length,
    before + 1,
    "an initial duplicate 412 is refused without recovery HEAD",
  );
});

test("uncertain PUT then uncertain HEAD resolves own conditional 412 without overwrite", async (t) => {
  const f = await fixture(t);
  let s,
    puts = 0,
    heads = 0;
  s = replayStorageFixture(async (command) => {
    if (command.input.Key !== prefix + "master.m3u8") return;
    if (command.constructor.name === "PutObjectCommand" && ++puts === 1) {
      s.put(command.input.Key, await consume(command), command.input.Metadata);
      throw transient("ETIMEDOUT");
    }
    if (command.constructor.name === "HeadObjectCommand" && ++heads === 1)
      throw transient("ECONNRESET");
  }, retry);
  await s.storage.upload(f.directory, f.manifest, packageKey);
  assert.equal(puts, 2);
  assert.equal(heads, 2);
  assert.deepEqual(s.objects.get(prefix + "master.m3u8").body, f.body);
});

test("successful PUT with transient HEAD failure retries verification without rewriting", async (t) => {
  const f = await fixture(t);
  let heads = 0;
  const s = replayStorageFixture(async (command) => {
    if (command.constructor.name === "HeadObjectCommand" && ++heads === 1)
      throw transient("EAI_AGAIN");
  }, retry);
  await s.storage.upload(f.directory, f.manifest, packageKey);
  assert.equal(
    s.commands.filter((c) => c.constructor.name === "PutObjectCommand").length,
    2,
  );
});

test("mismatch, foreign provenance and authorization refusal fail closed without retry/marker", async (t) => {
  const f = await fixture(t);
  for (const mismatch of ["bytes", "sha", "provenance"]) {
    let s;
    s = replayStorageFixture(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        const metadata = { ...command.input.Metadata };
        if (mismatch === "sha") metadata.sha256 = "b".repeat(64);
        if (mismatch === "provenance") metadata["upload-id"] = "someone-else";
        s.put(
          command.input.Key,
          mismatch === "bytes" ? Buffer.alloc(1) : await consume(command),
          metadata,
        );
        throw transient("EPIPE");
      }
    }, retry);
    await assert.rejects(
      s.storage.upload(f.directory, f.manifest, packageKey),
      failure("upload_verification_failed"),
    );
    assert.equal(
      s.commands.filter((c) => c.constructor.name === "PutObjectCommand")
        .length,
      1,
    );
    assert.equal(s.objects.has(prefix + "ready.json"), false);
  }
  const denied = replayStorageFixture(async (command) => {
    if (command.constructor.name === "PutObjectCommand") throw status(403);
  }, retry);
  await assert.rejects(
    denied.storage.upload(f.directory, f.manifest, packageKey),
    failure("upload_failed"),
  );
  assert.equal(denied.commands.length, 1);
});

test("retries exhaust after three PUTs and sanitize transport details", async (t) => {
  const f = await fixture(t);
  const s = replayStorageFixture(async (command) => {
    if (command.constructor.name === "PutObjectCommand")
      throw transient("ENETUNREACH");
  }, retry);
  await assert.rejects(
    s.storage.upload(f.directory, f.manifest, packageKey),
    (error) =>
      failure("upload_retry_exhausted")(error) &&
      !error.message.includes("private"),
  );
  assert.equal(
    s.commands.filter((c) => c.constructor.name === "PutObjectCommand").length,
    3,
  );
  assert.equal(s.objects.size, 0);
});

test("abort during retry backoff stops further attempts and drained streams", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let body;
  const s = replayStorageFixture(
    async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        body = command.input.Body;
        throw transient("ECONNRESET");
      }
    },
    {
      pause: async () => {
        controller.abort();
        throw new Error("synthetic wait aborted");
      },
    },
  );
  await assert.rejects(
    s.storage.upload(f.directory, f.manifest, packageKey, controller.signal),
    failure("cancelled"),
  );
  assert.equal(
    s.commands.filter((c) => c.constructor.name === "PutObjectCommand").length,
    1,
  );
  assert.ok(body.destroyed && body.closed);
});

test("retryable provider statuses recover and unprovable HEAD exhausts without blind overwrite", async (t) => {
  const f = await fixture(t);
  let puts = 0;
  const s = replayStorageFixture(async (command) => {
    if (command.constructor.name === "PutObjectCommand" && ++puts === 1)
      throw status(503);
  }, retry);
  await s.storage.upload(f.directory, f.manifest, packageKey);
  assert.ok(s.objects.has(prefix + "ready.json"));
  const unknown = replayStorageFixture(async (command) => {
    if (command.constructor.name === "HeadObjectCommand")
      throw transient("ETIMEDOUT");
  }, retry);
  await assert.rejects(
    unknown.storage.upload(f.directory, f.manifest, packageKey),
    failure("upload_retry_exhausted"),
  );
  assert.equal(
    unknown.commands.filter((c) => c.constructor.name === "PutObjectCommand")
      .length,
    1,
  );
  assert.equal(unknown.objects.has(prefix + "ready.json"), false);
});
