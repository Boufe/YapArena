import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createReplayStorage } from "../../dist/features/media/replay-storage.js";

export function replayStorageFixture(onCommand = async () => {}) {
  const objects = new Map();
  const commands = [];
  let closed = false;
  const put = (key, body, metadata = {}) =>
    objects.set(key, {
      body: Buffer.from(body),
      metadata,
      etag: `"${createHash("sha256").update(body).digest("hex")}"`,
    });
  const client = {
    async send(command, options = {}) {
      if (options.abortSignal?.aborted) throw options.abortSignal.reason;
      commands.push(command);
      const override = await onCommand(command, options);
      if (override !== undefined) return override;
      const { Key, Prefix, Body } = command.input;
      const object = objects.get(Key);
      switch (command.constructor.name) {
        case "HeadObjectCommand":
          if (!object) throw new Error("synthetic missing object");
          return {
            ContentLength: object.body.length,
            ETag: object.etag,
            Metadata: object.metadata,
          };
        case "GetObjectCommand":
          if (!object || command.input.IfMatch !== object.etag)
            throw new Error("synthetic precondition");
          return { Body: Readable.from([object.body]) };
        case "PutObjectCommand": {
          if (objects.has(Key))
            throw new Error("synthetic immutable precondition");
          const chunks = [];
          if (typeof Body === "string") chunks.push(Buffer.from(Body));
          else for await (const chunk of Body) chunks.push(chunk);
          put(Key, Buffer.concat(chunks), command.input.Metadata);
          return {};
        }
        case "ListObjectsV2Command":
          return {
            Contents: [...objects.keys()]
              .filter((key) => key.startsWith(Prefix))
              .slice(0, command.input.MaxKeys)
              .map((Key) => ({ Key })),
          };
        case "DeleteObjectsCommand":
          for (const item of command.input.Delete.Objects)
            objects.delete(item.Key);
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
