// Explicit staging-only trial: writes synthetic objects under a fresh UUID,
// never changes application/financial state, and deletes only owned objects.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createReplayStorage } from "../dist/features/media/replay-storage.js";
import {
  buildReplayPackage,
  run,
  verifyReplayTools,
} from "../dist/features/media/replay-packaging.js";
import {
  createReplayAccess,
  replayPrefix,
} from "../dist/features/media/replay.js";

const required = (name) => {
  assert.ok(process.env[name], `Missing staging configuration: ${name}`);
  return process.env[name];
};
const endpoint = required("MEDIA_S3_ENDPOINT");
const edge = required("MEDIA_REPLAY_EDGE_URL");
const secret = required("MEDIA_REPLAY_SIGNING_SECRET");
assert.equal(new URL(endpoint).protocol, "https:");
assert.equal(new URL(edge).protocol, "https:");
const config = {
  endpoint,
  bucket: required("MEDIA_S3_BUCKET"),
  region: endpoint.includes(".r2.cloudflarestorage.com")
    ? "auto"
    : required("MEDIA_S3_REGION"),
  accessKey: required("MEDIA_S3_ACCESS_KEY"),
  secretKey: required("MEDIA_S3_SECRET_KEY"),
};
const client = new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
  },
  maxAttempts: 2,
  requestHandler: {
    connectionTimeout: 5000,
    requestTimeout: 30000,
    socketTimeout: 30000,
  },
});
const storage = createReplayStorage(config);
const directory = await mkdtemp("/tmp/yaparena-storage-trial-");
const room = randomUUID();
const sourceKey = `debates/${room}/source-${randomUUID()}.mp4`;
const packageKey = `debates/${room}/package-${randomUUID()}.mp4`;
const send = (command) =>
  client.send(command, { abortSignal: AbortSignal.timeout(30000) });
const request = (url) => fetch(url, { signal: AbortSignal.timeout(15000) });
const failureStatus = (expected) => (error) =>
  error.$metadata?.httpStatusCode === expected;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let sourceWritten = false;
let phase = "tools";
let result;
try {
  await verifyReplayTools();
  phase = "source_upload";
  const source = resolve(directory, "source.mp4");
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-filter_threads",
      "1",
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
      "-preset",
      "veryfast",
      "-b:v",
      "1500k",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      source,
    ],
    { timeoutMs: 30000 },
  );
  const bytes = await readFile(source);
  await send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: sourceKey,
      Body: bytes,
      IfNoneMatch: "*",
    }),
  );
  sourceWritten = true;
  phase = "pinned_download";
  const downloaded = resolve(directory, "download.mp4");
  let etag;
  await storage.download(sourceKey, downloaded, {
    acceptSource: async (value) => {
      etag = value;
      return true;
    },
  });
  assert.ok(etag);
  assert.equal(digest(await readFile(downloaded)), digest(bytes));
  const conversionStart = performance.now();
  phase = "encode";
  const output = resolve(directory, "hls");
  const manifest = await buildReplayPackage(downloaded, output, null);
  const conversionMs = performance.now() - conversionStart;
  const uploadStart = performance.now();
  phase = "immutable_upload";
  await storage.upload(
    output,
    manifest,
    packageKey,
    AbortSignal.timeout(90000),
    async () => {
      await assert.rejects(
        send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: replayPrefix(packageKey) + "ready.json",
          }),
        ),
        failureStatus(404),
      );
    },
  );
  const uploadMs = performance.now() - uploadStart;
  phase = "conditional_upload";
  await assert.rejects(
    storage.upload(output, manifest, packageKey, AbortSignal.timeout(30000)),
    (error) => error.code === "upload_conflict" || failureStatus(412)(error),
  );
  const access = createReplayAccess(packageKey, edge, secret);
  phase = "private_edge";
  const unsigned = new URL(access.url);
  unsigned.search = "";
  const denied = await request(unsigned);
  assert.equal(denied.status, 403);
  await denied.text();
  const master = await request(access.url);
  assert.equal(master.status, 200);
  assert.match(await master.text(), /#EXTM3U/);
  const delivered = [];
  for (const rendition of ["240", "480", "720"]) {
    const playlistUrl = new URL(`${rendition}/index.m3u8`, access.url);
    playlistUrl.search = new URL(access.url).search;
    const playlist = await request(playlistUrl);
    assert.equal(playlist.status, 200);
    const text = await playlist.text();
    const segment = text
      .split("\n")
      .find((line) => /^segment\d+[.]ts$/.test(line));
    assert.ok(segment);
    const segmentUrl = new URL(segment, playlistUrl);
    segmentUrl.search = playlistUrl.search;
    const response = await request(segmentUrl);
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    delivered.push(rendition);
  }
  const absentCaptions = await request(access.captionsUrl);
  assert.equal(absentCaptions.status, 404);
  await absentCaptions.text();
  // Replace only this synthetic source between HEAD and GET to establish the
  // real provider's If-Match protection, independently of the query mocks.
  phase = "pinned_download_mismatch";
  await assert.rejects(
    storage.download(sourceKey, resolve(directory, "changed.mp4"), {
      acceptSource: async () => {
        await send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: sourceKey,
            Body: "synthetic replacement",
          }),
        );
        return true;
      },
    }),
    failureStatus(412),
  );
  result = {
    at: new Date().toISOString(),
    result: "PASS",
    node: process.version,
    sourceSeconds: 6,
    packageFiles: manifest.files.length,
    packageBytes: manifest.bytes,
    conversionMs: Math.round(conversionMs),
    uploadAndHeadVerificationMs: Math.round(uploadMs),
    actualConditionalWrites: true,
    pinnedDownloadMismatchRejected: true,
    readyMarkerLast: true,
    unsignedDenied: true,
    noCaptionReplayDelivered: true,
    edgeRenditions: delivered,
    scope:
      "synthetic local encoder with actual staging R2 and private edge; no hosted worker/DB publication, browser playback, cache-hit provenance or capacity evidence",
  };
} catch (error) {
  process.exitCode = 1;
  result = {
    at: new Date().toISOString(),
    result: "FAIL",
    phase,
    code: error.code ?? error.name,
    httpStatus: error.$metadata?.httpStatusCode,
    scope: "synthetic staging storage trial",
  };
} finally {
  try {
    const objectsRemoved = await storage.removePackage(
      packageKey,
      AbortSignal.timeout(30000),
    );
    // An uncertain PUT may have committed remotely. Always delete this exact
    // owned source, including when its success confirmation was lost.
    await send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: sourceKey }),
    );
    const remaining = await send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `debates/${room}/`,
        MaxKeys: 1,
      }),
    );
    assert.equal(remaining.KeyCount, 0);
    result = {
      ...result,
      cleanup: "PASS",
      objectsRemoved: objectsRemoved + Number(sourceWritten),
      remainingOwnedObjects: 0,
    };
  } catch {
    process.exitCode = 1;
    result = { ...result, cleanup: "FAIL", cleanupDirectory: directory };
    await writeFile(
      resolve(directory, "cleanup.json"),
      JSON.stringify({ sourceKey, packageKey }) + "\n",
      { mode: 0o600 },
    );
  }
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify(result) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
  storage.close();
  client.destroy();
  if (result.cleanup === "PASS")
    await rm(directory, { recursive: true, force: true });
}
