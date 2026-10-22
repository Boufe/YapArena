import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  authenticateSandboxNotification,
  createSandboxWebhookRouter,
  parseSandboxNotification,
} from "../dist/features/account-wallet/sandbox-webhooks.js";

const secret = "synthetic-local-webhook-secret-of-32-bytes";
const now = 1_800_000_000_000;
const payload = {
  requestId: randomUUID(),
  status: "pending",
  transactionId: null,
};
function signed(value = payload, changes = {}) {
  const body = Buffer.from(JSON.stringify(value));
  const timestamp = String(Math.floor(now / 1000));
  const deliveryId = randomUUID();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`)
    .update(body)
    .digest("hex");
  return { secret, now, body, timestamp, deliveryId, signature, ...changes };
}
it("authenticates timestamp, delivery identity and exact raw body, without deriving account authority", () => {
  const valid = signed();
  const result = authenticateSandboxNotification(valid);
  assert.deepEqual(result.payload, payload);
  assert.equal(result.deliveryId, valid.deliveryId);
  assert.match(result.payloadDigest, /^[a-f0-9]{64}$/);
  for (const change of [
    { timestamp: undefined },
    { timestamp: "1e9" },
    { deliveryId: undefined },
    { deliveryId: "x\nheader" },
    { signature: undefined },
    { signature: "a".repeat(63) },
    { signature: "0".repeat(64) },
    { body: Buffer.from("{}") },
    { body: Buffer.alloc(0) },
    { body: Buffer.alloc(32769) },
    { now: now + 300001 },
    { now: now - 300001 },
    { deliveryId: randomUUID() },
  ])
    assert.throws(
      () => authenticateSandboxNotification({ ...valid, ...change }),
      /authentication failed/,
    );
  assert.throws(
    () => authenticateSandboxNotification({ ...valid, secret: "short" }),
    /32 bytes/,
  );
});
it("rejects unrecognized financial claims and malformed notification shapes", () => {
  for (const value of [
    null,
    [],
    {},
    { ...payload, requestId: "other-account" },
    { ...payload, status: "approved" },
    { ...payload, transactionId: undefined },
    { ...payload, transactionId: "" },
    { ...payload, transactionId: "a".repeat(201) },
    { ...payload, sender: "arbitrary" },
    { ...payload, finalNoTransfer: true },
    { ...payload, accountId: "1" },
    { ...payload, amount: "5000000" },
  ])
    assert.throws(
      () => parseSandboxNotification(value),
      /invalid sandbox notification/,
    );
  assert.deepEqual(
    parseSandboxNotification({ ...payload, sender: `0x${"11".repeat(20)}` }),
    { ...payload, sender: `0x${"11".repeat(20)}` },
  );
  const invalidJson = signed();
  invalidJson.body = Buffer.from("{broken");
  invalidJson.signature = createHmac("sha256", secret)
    .update(`${invalidJson.timestamp}.${invalidJson.deliveryId}.`)
    .update(invalidJson.body)
    .digest("hex");
  assert.throws(
    () => authenticateSandboxNotification(invalidJson),
    /invalid sandbox notification/,
  );
});
it("rejects invalid HMAC before requesting any database connection", async () => {
  const app = express();
  let connections = 0;
  const database = {
    connect() {
      connections++;
      throw new Error("must not connect");
    },
  };
  app.use(
    "/hook",
    createSandboxWebhookRouter({ database, rail: "simulation", secret }),
  );
  await request(app)
    .post("/hook")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(payload))
    .expect(401);
  const valid = signed(payload, {
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  await request(app)
    .post("/hook")
    .set("Content-Type", "application/json")
    .set("x-yap-timestamp", valid.timestamp)
    .set("x-yap-delivery", valid.deliveryId)
    .set("x-yap-signature", valid.signature)
    .send(valid.body.toString("utf8"))
    .expect(401);
  assert.equal(connections, 0);
  assert.throws(
    () =>
      createSandboxWebhookRouter({
        database,
        rail: "simulation",
        secret: "short",
      }),
    /32 bytes/,
  );
});
