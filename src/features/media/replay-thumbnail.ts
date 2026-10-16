import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  run,
  ReplayFailure,
  validRecordingKey,
  checkReplaySignal,
} from "./replay-packaging.ts";
import { replayPrefix } from "./replay.ts";
import type { createReplayJobs } from "./replay-jobs.ts";
import type { Logger } from "pino";

export function replayThumbnailKey(sourceKey: string) {
  if (!validRecordingKey(sourceKey))
    throw new ReplayFailure("invalid_key", false);
  return `${sourceKey.slice(0, -4)}/thumbnail.jpg`;
}
export function validateReplayThumbnail(bytes: Uint8Array) {
  if (
    bytes.length < 4 ||
    bytes.length > 300_000 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[2] !== 255 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    throw new ReplayFailure("invalid_thumbnail", false);
  return bytes;
}
export function createReplayThumbnailStorage(
  { bucket }: { bucket: string },
  client: Pick<S3Client, "send">,
) {
  async function read(key: string, maximum: number, signal?: AbortSignal) {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: signal },
    );
    const body = result.Body as
      (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    let stream: Readable | undefined;
    try {
      if (
        !body ||
        !(Symbol.asyncIterator in body) ||
        !result.ContentLength ||
        result.ContentLength > maximum
      )
        throw new ReplayFailure("thumbnail_source_limit", false);
      const chunks: Buffer[] = [];
      let size = 0;
      if (signal && body instanceof Readable) addAbortSignal(signal, body);
      stream = Readable.from(body, { signal });
      for await (const chunk of stream) {
        checkReplaySignal(signal);
        size += chunk.length;
        if (size > maximum || size > result.ContentLength)
          throw new ReplayFailure("thumbnail_source_limit", false);
        chunks.push(Buffer.from(chunk));
      }
      if (size !== result.ContentLength)
        throw new ReplayFailure("thumbnail_source_changed");
      return Buffer.concat(chunks);
    } finally {
      stream?.destroy();
      body?.destroy?.();
    }
  }
  return {
    async exists(sourceKey: string, signal?: AbortSignal) {
      try {
        const head = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: replayThumbnailKey(sourceKey),
          }),
          { abortSignal: signal },
        );
        if (
          !head.ContentLength ||
          head.ContentLength > 300_000 ||
          head.ContentType !== "image/jpeg"
        )
          throw new ReplayFailure("invalid_thumbnail", false);
        return true;
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 404
        )
          return false;
        throw error;
      }
    },
    async read(sourceKey: string, signal?: AbortSignal) {
      return validateReplayThumbnail(
        await read(replayThumbnailKey(sourceKey), 300_000, signal),
      );
    },
    async segment(
      packageKey: string,
      destination: string,
      signal?: AbortSignal,
    ) {
      if (!validRecordingKey(packageKey))
        throw new ReplayFailure("invalid_key", false);
      const bytes = await read(
        `${replayPrefix(packageKey)}720/segment00000.ts`,
        4_000_000,
        signal,
      );
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    },
    async put(sourceKey: string, bytes: Uint8Array, signal?: AbortSignal) {
      validateReplayThumbnail(bytes);
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: replayThumbnailKey(sourceKey),
            Body: bytes,
            ContentLength: bytes.length,
            ContentType: "image/jpeg",
            IfNoneMatch: "*",
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode !== 412
        )
          throw error;
      }
    },
  };
}
export async function buildReplayThumbnail(
  input: string,
  output: string,
  signal?: AbortSignal,
  runProcess = run,
) {
  await runProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-n",
      "-protocol_whitelist",
      "file",
      "-threads",
      "1",
      "-i",
      resolve(input),
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      "thumbnail=30,scale=960:540,setsar=1",
      "-filter_threads",
      "1",
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-threads",
      "1",
      resolve(output),
    ],
    { signal, timeoutMs: 10_000 },
  );
  return validateReplayThumbnail(await readFile(output));
}
export function createReplayThumbnailTask({
  jobs,
  storage,
  logger,
  build = buildReplayThumbnail,
  now = Date.now,
}: {
  jobs: Pick<ReturnType<typeof createReplayJobs>, "thumbnailCandidates">;
  storage: ReturnType<typeof createReplayThumbnailStorage>;
  logger: Pick<Logger, "info" | "warn">;
  build?: typeof buildReplayThumbnail;
  now?: () => number;
}) {
  const checked = new Map<string, number>();
  return async (signal: AbortSignal) => {
    while (checked.size > 1000) checked.delete(checked.keys().next().value!);
    const excluded = [...checked]
      .filter(([, retryAt]) => retryAt > now())
      .map(([key]) => key);
    const candidates = await jobs.thumbnailCandidates(excluded);
    const candidate = candidates.find(
      (item) => (checked.get(item.sourceKey) ?? 0) <= now(),
    );
    if (!candidate) return;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    let directory: string | undefined;
    try {
      if (!(await storage.exists(candidate.sourceKey, bounded))) {
        directory = await mkdtemp(resolve(tmpdir(), "yaparena-thumbnail-"));
        const input = resolve(directory, "segment.ts"),
          output = resolve(directory, "thumbnail.jpg");
        await storage.segment(candidate.packageKey, input, bounded);
        const bytes = await build(input, output, bounded);
        await storage.put(candidate.sourceKey, bytes, bounded);
        logger.info(
          { event: "replay_thumbnail_ready", bytes: bytes.length },
          "Recording thumbnail ready",
        );
      }
      checked.set(candidate.sourceKey, Infinity);
    } catch {
      checked.set(candidate.sourceKey, now() + 300_000);
      logger.warn(
        { event: "replay_thumbnail_failed" },
        "Recording thumbnail will retry",
      );
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
