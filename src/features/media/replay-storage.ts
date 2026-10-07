import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  checkReplaySignal,
  fileDigest,
  replayFileName,
  renditions,
  ReplayFailure,
  validRecordingKey,
  type ReplayManifest,
} from "./replay-packaging.ts";

export type ReplayStorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKey: string;
  secretKey: string;
};
function prefixOf(key: string) {
  if (!validRecordingKey(key)) throw new ReplayFailure("invalid_key", false);
  return `${key.slice(0, -4)}/hls/`;
}
export function createReplayStorage(
  config: ReplayStorageConfig,
  client: Pick<S3Client, "send"> &
    Partial<Pick<S3Client, "destroy">> = new S3Client({
    endpoint: config.endpoint,
    region: config.endpoint?.includes(".r2.cloudflarestorage.com")
      ? "auto"
      : config.region,
    forcePathStyle: Boolean(config.endpoint),
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: 30_000,
      socketTimeout: 30_000,
    },
  }),
) {
  return Object.freeze({
    async download(
      sourceKey: string,
      destination: string,
      {
        signal,
        maxInputBytes = 2 * 1024 ** 3,
        acceptSource = async () => true,
      }: {
        signal?: AbortSignal;
        maxInputBytes?: number;
        acceptSource?: (etag: string) => Promise<boolean>;
      } = {},
    ) {
      if (!validRecordingKey(sourceKey))
        throw new ReplayFailure("invalid_key", false);
      checkReplaySignal(signal);
      const head = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: sourceKey }),
        { abortSignal: signal },
      );
      if (
        !Number.isSafeInteger(head.ContentLength) ||
        !head.ContentLength ||
        head.ContentLength > maxInputBytes ||
        !head.ETag ||
        head.ETag.length > 200
      )
        throw new ReplayFailure("source_limit", false);
      if (!(await acceptSource(head.ETag)))
        throw new ReplayFailure("source_changed", false);
      const result = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: sourceKey,
          IfMatch: head.ETag,
        }),
        { abortSignal: signal },
      );
      if (!result.Body || !(Symbol.asyncIterator in result.Body))
        throw new ReplayFailure("source_unavailable");
      const stream = Readable.from(result.Body as AsyncIterable<Uint8Array>, {
        signal,
      });
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let bytes = 0;
      try {
        file = await open(destination, "wx", 0o600);
        for await (const piece of stream) {
          checkReplaySignal(signal);
          const chunk = Buffer.from(piece as Uint8Array);
          bytes += chunk.length;
          if (bytes > maxInputBytes || bytes > head.ContentLength)
            throw new ReplayFailure("source_limit", false);
          await file.writeFile(chunk);
        }
        if (bytes !== head.ContentLength)
          throw new ReplayFailure("source_changed", false);
      } finally {
        stream.destroy();
        await file?.close();
      }
      return { bytes, etag: head.ETag };
    },
    async upload(
      directory: string,
      manifest: ReplayManifest,
      packageKey: string,
      signal?: AbortSignal,
      beforeReady: () => Promise<void> = async () => {},
    ) {
      const prefix = prefixOf(packageKey);
      if (
        !manifest.files.length ||
        manifest.files.length > 11_000 ||
        new Set(manifest.files.map((f) => f.path)).size !==
          manifest.files.length
      )
        throw new ReplayFailure("invalid_manifest", false);
      for (const file of manifest.files) {
        checkReplaySignal(signal);
        if (
          !replayFileName.test(file.path) ||
          !/^[0-9a-f]{64}$/.test(file.sha256)
        )
          throw new ReplayFailure("invalid_manifest", false);
        const path = resolve(directory, file.path);
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.size !== file.bytes ||
          (await fileDigest(path, signal)) !== file.sha256
        )
          throw new ReplayFailure("output_changed", false);
        const body = createReadStream(path, signal ? { signal } : undefined);
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: prefix + file.path,
              Body: body,
              ContentLength: file.bytes,
              ContentType: file.contentType,
              Metadata: { sha256: file.sha256 },
              IfNoneMatch: "*",
            }),
            { abortSignal: signal },
          );
        } finally {
          body.destroy();
        }
        const uploaded = await client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: prefix + file.path,
          }),
          { abortSignal: signal },
        );
        if (
          uploaded.ContentLength !== file.bytes ||
          uploaded.Metadata?.sha256 !== file.sha256
        )
          throw new ReplayFailure("upload_verification_failed");
      }
      checkReplaySignal(signal);
      await beforeReady();
      checkReplaySignal(signal);
      const manifestDigest = createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex");
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: prefix + "ready.json",
          IfNoneMatch: "*",
          Body: JSON.stringify({
            version: 1,
            renditions: renditions.map((r) => r.name),
            reviewedCaptions: manifest.captionsSha256 !== null,
            manifestDigest,
            sourceSha256: manifest.sourceSha256,
            captionsSha256: manifest.captionsSha256,
            files: manifest.files.length,
            bytes: manifest.bytes,
            durationSeconds: manifest.durationSeconds,
          }),
          ContentType: "application/json",
        }),
        { abortSignal: signal },
      );
      return manifestDigest;
    },
    async removePackage(packageKey: string, signal?: AbortSignal) {
      // Automatic cleanup only owns attempt-specific prefixes, never a source
      // recording, manual legacy package, another room or an entire bucket.
      if (
        !/^debates\/[0-9a-f-]{36}\/package-[0-9a-f-]{36}\.mp4$/.test(packageKey)
      )
        throw new ReplayFailure("invalid_cleanup_key", false);
      const prefix = prefixOf(packageKey);
      let deleted = 0;
      // Re-list the first page after deletion. Opaque continuation tokens need
      // not remain valid when the namespace they describe changes underneath.
      // Up to twelve deletion pages (11,001 objects), plus the final empty
      // listing that proves cleanup completed rather than merely making progress.
      for (let page = 0; page < 13; page++) {
        checkReplaySignal(signal);
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            MaxKeys: 1000,
          }),
          { abortSignal: signal },
        );
        const keys = (result.Contents || []).map((object) => object.Key);
        if (!keys.length) return deleted;
        if (
          keys.some(
            (key) =>
              !key?.startsWith(prefix) ||
              (key.slice(prefix.length) !== "ready.json" &&
                !replayFileName.test(key.slice(prefix.length))),
          )
        )
          throw new ReplayFailure("invalid_cleanup_listing", false);
        deleted += keys.length;
        if (deleted > 11_001) throw new ReplayFailure("cleanup_limit", false);
        const removed = await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: {
              Objects: keys.map((Key) => ({ Key: Key! })),
              Quiet: true,
            },
          }),
          { abortSignal: signal },
        );
        if (removed.Errors?.length) throw new ReplayFailure("cleanup_failed");
      }
      throw new ReplayFailure("cleanup_limit", false);
    },
    close() {
      client.destroy?.();
    },
  });
}
