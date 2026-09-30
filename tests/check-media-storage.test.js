import assert from "node:assert/strict";
import test from "node:test";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { probeMediaStorage } from "../scripts/check-media-storage.js";

test("media storage probe creates and aborts a multipart upload", async () => {
  const commands = [];
  const storage = {
    async send(command) {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: "upload-1" };
      return {};
    },
  };

  await probeMediaStorage(storage, "test-bucket", "diagnostics/test.mp4");

  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].input, {
    Bucket: "test-bucket",
    Key: "diagnostics/test.mp4",
  });
  assert.ok(commands[1] instanceof AbortMultipartUploadCommand);
  assert.deepEqual(commands[1].input, {
    Bucket: "test-bucket",
    Key: "diagnostics/test.mp4",
    UploadId: "upload-1",
  });
});

test("media storage probe surfaces upload authentication failure", async () => {
  const unauthorized = Object.assign(new Error("Unauthorized"), {
    $metadata: { httpStatusCode: 401 },
  });
  let calls = 0;
  const storage = {
    async send() {
      calls += 1;
      throw unauthorized;
    },
  };

  await assert.rejects(
    probeMediaStorage(storage, "test-bucket", "diagnostics/test.mp4"),
    unauthorized,
  );
  assert.equal(calls, 1);
});
