import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Router, raw } from "express";
import type { Pool } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { CoinOperationError } from "./external-operations.ts";
import { assertSandboxRail, type SandboxRail } from "./sandbox-repository.ts";

export interface SandboxNotification {
  requestId: string;
  status: "pending" | "completed" | "failed" | "uncertain";
  transactionId: string | null;
  sender?: string;
}
export interface AuthenticatedSandboxNotification {
  deliveryId: string;
  payloadDigest: string;
  payload: SandboxNotification;
}
export const sandboxWebhookProvider = (rail: SandboxRail) =>
  rail === "simulation" ? "deterministic-simulation" : "base-sepolia-notifier";

function fail(message: string, status = 400): never {
  throw new CoinOperationError(message, status);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseSandboxNotification(value: unknown): SandboxNotification {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["requestId", "status", "transactionId", "sender"].includes(key),
    ) ||
    typeof value.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value.requestId,
    ) ||
    (value.status !== "pending" &&
      value.status !== "completed" &&
      value.status !== "failed" &&
      value.status !== "uncertain") ||
    (value.transactionId !== null &&
      (typeof value.transactionId !== "string" ||
        !value.transactionId ||
        value.transactionId.length > 200)) ||
    (value.sender !== undefined &&
      (typeof value.sender !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(value.sender)))
  )
    fail("invalid sandbox notification");
  return {
    requestId: value.requestId,
    status: value.status,
    transactionId: value.transactionId,
    ...(typeof value.sender === "string" ? { sender: value.sender } : {}),
  };
}

export function authenticateSandboxNotification(input: {
  secret: string;
  timestamp: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  body: Buffer;
  now?: number;
}): AuthenticatedSandboxNotification {
  if (Buffer.byteLength(input.secret) < 32)
    throw new Error("sandbox webhook secret requires at least 32 bytes");
  if (
    !input.timestamp ||
    !/^[0-9]{10}$/.test(input.timestamp) ||
    Math.abs((input.now ?? Date.now()) / 1000 - Number(input.timestamp)) >
      300 ||
    !input.deliveryId ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.deliveryId) ||
    !input.signature ||
    !/^[a-f0-9]{64}$/.test(input.signature) ||
    input.body.length === 0 ||
    input.body.length > 32768
  )
    fail("sandbox webhook authentication failed", 401);
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.deliveryId}.`)
    .update(input.body)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(input.signature, "hex")))
    fail("sandbox webhook authentication failed", 401);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body.toString("utf8"));
  } catch {
    fail("invalid sandbox notification");
  }
  return {
    deliveryId: input.deliveryId,
    payloadDigest: createHash("sha256").update(input.body).digest("hex"),
    payload: parseSandboxNotification(parsed),
  };
}

export function createSandboxWebhookInbox(database: Pool, rail: SandboxRail) {
  return {
    async enqueue(notification: AuthenticatedSandboxNotification) {
      return withTransaction(database, async (client) => {
        await assertSandboxRail(client, rail);
        if (
          !(
            await client.query(
              "SELECT 1 FROM coin_sandbox_requests WHERE id=$1 AND kind IN ('funding','withdrawal') AND terms->>'rail'=$2",
              [notification.payload.requestId, rail],
            )
          ).rowCount
        )
          fail("sandbox notification request not found", 404);
        const inserted = (
          await client.query<{ id: string }>(
            `INSERT INTO coin_sandbox_webhook_inbox(id,rail,provider,delivery_id,request_id,payload,payload_digest)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(rail,provider,delivery_id) DO NOTHING RETURNING id`,
            [
              randomUUID(),
              rail,
              sandboxWebhookProvider(rail),
              notification.deliveryId,
              notification.payload.requestId,
              JSON.stringify(notification.payload),
              notification.payloadDigest,
            ],
          )
        ).rows[0];
        if (!inserted) {
          const previous = (
            await client.query<{
              id: string;
              payload_digest: string;
              request_id: string;
            }>(
              "SELECT id,payload_digest,request_id FROM coin_sandbox_webhook_inbox WHERE rail=$1 AND provider=$2 AND delivery_id=$3",
              [rail, sandboxWebhookProvider(rail), notification.deliveryId],
            )
          ).rows[0];
          if (
            !previous ||
            previous.payload_digest !== notification.payloadDigest ||
            previous.request_id !== notification.payload.requestId
          )
            fail(
              "sandbox notification delivery conflicts with recorded payload",
              409,
            );
        }
        return { accepted: true, duplicate: !inserted };
      });
    },
  };
}

// Mount this factory BEFORE express.json(): authentication covers the exact raw
// bytes. It receives runtime credentials only, never the operator/owner pool.
// This transport is YapArena's notification protocol, not provider acceptance.
export function createSandboxWebhookRouter(input: {
  database: Pool;
  rail: SandboxRail;
  secret: string;
}) {
  if (Buffer.byteLength(input.secret) < 32)
    throw new Error("sandbox webhook secret requires at least 32 bytes");
  const router = Router(),
    inbox = createSandboxWebhookInbox(input.database, input.rail);
  router.post(
    "/",
    raw({ type: "application/json", limit: 32768, inflate: false }),
    async (request, response) => {
      if (!Buffer.isBuffer(request.body))
        return response
          .status(400)
          .json({ error: "raw JSON notification required" });
      try {
        const notification = authenticateSandboxNotification({
          secret: input.secret,
          timestamp: request.get("x-yap-timestamp"),
          deliveryId: request.get("x-yap-delivery"),
          signature: request.get("x-yap-signature"),
          body: request.body,
        });
        return response
          .status(202)
          .set("Cache-Control", "no-store")
          .json(await inbox.enqueue(notification));
      } catch (error) {
        if (error instanceof CoinOperationError)
          return response.status(error.status).json({ error: error.message });
        throw error;
      }
    },
  );
  return router;
}
