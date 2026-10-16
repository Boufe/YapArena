import assert from "node:assert/strict";
import { it } from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createReplayThumbnailStorage,
  createReplayThumbnailTask,
  buildReplayThumbnail,
  replayThumbnailKey,
  validateReplayThumbnail,
} from "../dist/features/media/replay-thumbnail.js";

const id = "33333333-3333-4333-8333-333333333333",
  source = `debates/${id}/recording.mp4`,
  packageKey = `debates/${id}/package-recording.mp4`;
const jpeg = Buffer.from([255, 216, 255, 0, 255, 217]);
it(
  "keeps thumbnails tied to validated recording keys and bounds storage reads and image data",
  { timeout: 5000 },
  async () => {
    assert.equal(
      replayThumbnailKey(source),
      `debates/${id}/recording/thumbnail.jpg`,
    );
    assert.throws(() => replayThumbnailKey("../private"), /invalid_key/);
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.alloc(400000),
      Buffer.from([255, 216, 255, 0]),
    ])
      assert.throws(() => validateReplayThumbnail(bytes), /invalid_thumbnail/);
    let object,
      badLength = false,
      calls = 0;
    const storage = createReplayThumbnailStorage(
      { bucket: "synthetic" },
      {
        async send(command) {
          calls++;
          if (command.constructor.name === "PutObjectCommand") {
            assert.equal(command.input.IfNoneMatch, "*");
            if (object) throw { $metadata: { httpStatusCode: 412 } };
            object = Buffer.from(command.input.Body);
            return {};
          }
          if (!object) throw { $metadata: { httpStatusCode: 404 } };
          if (command.constructor.name === "HeadObjectCommand")
            return {
              ContentLength: badLength ? 400000 : object.length,
              ContentType: "image/jpeg",
            };
          assert.equal(command.constructor.name, "GetObjectCommand");
          return {
            ContentLength: badLength ? object.length + 1 : object.length,
            Body: Readable.from([object]),
          };
        },
      },
    );
    assert.equal(await storage.exists(source), false);
    await storage.put(source, jpeg);
    await storage.put(source, jpeg);
    assert.equal(await storage.exists(source), true);
    assert.deepEqual(Buffer.from(await storage.read(source)), jpeg);
    const directory = await mkdtemp(
      resolve(tmpdir(), "thumbnail-storage-test-"),
    );
    try {
      await storage.segment(packageKey, resolve(directory, "segment.ts"));
      assert.deepEqual(await readFile(resolve(directory, "segment.ts")), jpeg);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    badLength = true;
    await assert.rejects(storage.exists(source), /invalid_thumbnail/);
    await assert.rejects(storage.read(source), /thumbnail_source_changed/);
    await assert.rejects(storage.segment("invalid", "/unused"), /invalid_key/);
    assert.ok(calls > 5);
    const unavailable = createReplayThumbnailStorage(
      { bucket: "synthetic" },
      {
        send: async () => {
          throw Error("synthetic unavailable");
        },
      },
    );
    await assert.rejects(unavailable.exists(source), /unavailable/);
    await assert.rejects(unavailable.put(source, jpeg), /unavailable/);
    const invalid = createReplayThumbnailStorage(
      { bucket: "synthetic" },
      {
        send: async () => ({
          ContentLength: 4000001,
          Body: Readable.from([jpeg]),
        }),
      },
    );
    await assert.rejects(invalid.read(source), /thumbnail_source_limit/);
    const overflow = createReplayThumbnailStorage(
      { bucket: "synthetic" },
      { send: async () => ({ ContentLength: 1, Body: Readable.from([jpeg]) }) },
    );
    await assert.rejects(overflow.read(source), /thumbnail_source_limit/);
    const stalledBody = new Readable({ read() {} });
    const stalled = createReplayThumbnailStorage(
      { bucket: "synthetic" },
      { send: async () => ({ ContentLength: 6, Body: stalledBody }) },
    );
    const controller = new AbortController();
    const pending = stalled.read(source, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(stalledBody.destroyed, true);
  },
);

it("extracts one bounded local frame and reuses the private thumbnail across restarts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "thumbnail-build-test-"));
  try {
    const output = resolve(directory, "poster.jpg");
    const bytes = await buildReplayThumbnail(
      resolve(directory, "input.ts"),
      output,
      undefined,
      async (command, args, options) => {
        assert.equal(command, "ffmpeg");
        assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
        assert.equal(options.timeoutMs, 10000);
        assert.equal(args[args.indexOf("-frames:v") + 1], "1");
        await writeFile(output, jpeg);
        return "";
      },
    );
    assert.deepEqual(Buffer.from(bytes), jpeg);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const job = { sourceKey: source, packageKey },
    events = [];
  let saved = false,
    segments = 0,
    path,
    tickTime = 1;
  const options = {
    jobs: { thumbnailCandidates: async () => [job] },
    logger: {
      info: (event) => events.push(event.event),
      warn: (event) => events.push(event.event),
    },
    now: () => tickTime,
    storage: {
      exists: async () => saved,
      segment: async (_key, input) => {
        segments++;
        path = input;
        await writeFile(input, "synthetic segment");
      },
      put: async (_key, bytes) => {
        assert.deepEqual(bytes, jpeg);
        saved = true;
      },
    },
    build: async () => jpeg,
  };
  const work = createReplayThumbnailTask(options),
    signal = new AbortController().signal;
  await work(signal);
  await work(signal);
  assert.equal(segments, 1);
  assert.equal(saved, true);
  await assert.rejects(access(path), /ENOENT/);
  await createReplayThumbnailTask(options)(signal);
  assert.equal(
    segments,
    1,
    "restart observes persisted image without decoding again",
  );
  assert.deepEqual(events, ["replay_thumbnail_ready"]);
  options.storage.exists = async () => {
    throw Error("synthetic storage failure");
  };
  const retry = createReplayThumbnailTask(options);
  await retry(signal);
  await retry(signal);
  assert.equal(
    events.filter((event) => event === "replay_thumbnail_failed").length,
    1,
  );
  tickTime += 300001;
  await retry(signal);
  assert.equal(
    events.filter((event) => event === "replay_thumbnail_failed").length,
    2,
  );
  await createReplayThumbnailTask({
    ...options,
    jobs: { thumbnailCandidates: async () => [] },
  })(signal);
});
