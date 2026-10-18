import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  createReplayStorage,
  type ReplayStorageResponse,
  type ReplayUploadRetry,
} from "../../dist/features/media/replay-storage.js";
import type {
  PutObjectCommandInput,
  DeleteObjectsCommandInput,
} from "@aws-sdk/client-s3";

type FixtureObject = {
  body: Buffer;
  metadata: Record<string, string>;
  contentType: string;
  etag: string;
};
type FixtureCommandInput = {
  Bucket?: string;
  Key?: string;
  Prefix?: string;
  Body?: PutObjectCommandInput["Body"];
  Metadata?: Record<string, string>;
  ContentType?: string;
  IfMatch?: string;
  MaxKeys?: number;
  Delete?: DeleteObjectsCommandInput["Delete"];
};
type FixtureOptions = { abortSignal?: AbortSignal };
type FixtureCommand = {
  input: FixtureCommandInput;
  constructor: { name: string };
};

export function replayStorageFixture(
  onCommand: (
    command: FixtureCommand,
    options: FixtureOptions,
  ) => Promise<ReplayStorageResponse | void> = async () => {},
  retry: ReplayUploadRetry = {},
) {
  const objects = new Map<string, FixtureObject>();
  const commands: FixtureCommand[] = [];
  let closed = false;
  const put = (
    key: string,
    body: string | Uint8Array,
    metadata: Record<string, string> = {},
    contentType = "application/octet-stream",
  ) =>
    objects.set(key, {
      body: Buffer.from(body),
      metadata,
      contentType,
      etag: `"${createHash("sha256").update(body).digest("hex")}"`,
    });
  const client = {
    async send(
      command: FixtureCommand,
      options: FixtureOptions = {},
    ): Promise<ReplayStorageResponse> {
      if (options.abortSignal?.aborted) throw options.abortSignal.reason;
      commands.push(command);
      const override = await onCommand(command, options);
      if (override !== undefined) return override;
      const { Key, Prefix, Body } = command.input;
      const object = objects.get(Key!);
      switch (command.constructor.name) {
        case "HeadObjectCommand":
          if (!object)
            throw Object.assign(new Error("synthetic missing object"), {
              $metadata: { httpStatusCode: 404 },
            });
          return {
            ContentLength: object.body.length,
            ETag: object.etag,
            Metadata: object.metadata,
            ContentType: object.contentType,
          };
        case "GetObjectCommand":
          if (
            !object ||
            (command.input.IfMatch !== undefined &&
              command.input.IfMatch !== object.etag)
          )
            throw new Error("synthetic precondition");
          return {
            Body: Readable.from([object.body]),
            ContentLength: object.body.length,
          };
        case "PutObjectCommand": {
          if (objects.has(Key!))
            throw Object.assign(new Error("synthetic immutable precondition"), {
              $metadata: { httpStatusCode: 412 },
            });
          const chunks: Uint8Array[] = [];
          if (typeof Body === "string" || Body instanceof Uint8Array)
            chunks.push(Buffer.from(Body));
          else
            for await (const chunk of Body as AsyncIterable<Uint8Array>)
              chunks.push(chunk);
          put(
            Key!,
            Buffer.concat(chunks),
            command.input.Metadata,
            command.input.ContentType,
          );
          return {};
        }
        case "ListObjectsV2Command":
          return {
            Contents: [...objects.keys()]
              .filter((key) => key.startsWith(Prefix!))
              .slice(0, command.input.MaxKeys)
              .map((Key) => ({ Key })),
          };
        case "DeleteObjectsCommand":
          for (const item of command.input.Delete!.Objects!)
            objects.delete(item.Key!);
          return {};
        default:
          throw new Error("unexpected synthetic command");
      }
    },
    destroy() {
      closed = true;
    },
  };
  const storage = createReplayStorage(
    {
      bucket: "synthetic",
      region: "auto",
      accessKey: "synthetic",
      secretKey: "synthetic",
    },
    client,
    retry,
  );
  return {
    storage,
    objects,
    commands,
    put,
    get closed() {
      return closed;
    },
  };
}
