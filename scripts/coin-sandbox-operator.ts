import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getAddress, type Hash } from "viem";
import {
  assertSandboxRail,
  createCoinSandboxOperatorRepository,
  type SandboxRequest,
  type SandboxTransferReceipt,
} from "../dist/features/account-wallet/sandbox-repository.js";
import {
  parseSandboxNotification,
  type SandboxNotification,
} from "../dist/features/account-wallet/sandbox-webhooks.js";
import {
  baseSepoliaAsset,
  createBaseSepoliaAdapter,
} from "../dist/features/account-wallet/base-sepolia.js";
import { createCoinDebateSandbox } from "../dist/features/account-wallet/debate-sandbox.js";
import {
  CoinOperationError,
  type ExternalObservation,
} from "../dist/features/account-wallet/external-operations.js";

// Explicit owner process. No .env loading, HTTP listener, signing, broadcasting,
// live chain selection or automatic startup invocation exists in this command.
class CommandError extends Error {}
function invalid(message: string): never {
  throw new CommandError(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid("invalid command fields");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200)
    invalid("bounded text value required");
  return value;
}
function uuid(value: unknown): string {
  const id = text(value);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    invalid("request identifier required");
  return id;
}
function accountId(value: unknown): string {
  const id = text(value);
  if (!/^[1-9][0-9]{0,18}$/.test(id)) invalid("account identifier required");
  return id;
}
function isTransactionHash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function transactionHash(value: unknown): Hash {
  if (!isTransactionHash(value)) invalid("transaction hash required");
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function limit(value: unknown): number {
  if (value === undefined) return 20;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 100
  )
    invalid("limit must be an integer from 1 to 100");
  return value;
}

export async function runCoinSandboxOperator(input: {
  command: string;
  body: unknown;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  const rail = input.environment.COIN_SANDBOX_RAIL;
  if (rail !== "simulation" && rail !== "base-sepolia")
    invalid(
      "COIN_SANDBOX_RAIL must explicitly select simulation or base-sepolia",
    );
  const connectionString = input.environment.COIN_SANDBOX_OWNER_DATABASE_URL;
  if (!connectionString) invalid("COIN_SANDBOX_OWNER_DATABASE_URL is required");
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== "yaparena_owner"
  )
    invalid("dedicated owner connection required");
  const custodyText = input.environment.COIN_SANDBOX_CUSTODY_ADDRESS;
  const custody =
    rail === "base-sepolia" ? getAddress(text(custodyText)) : undefined;
  const database = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
    options:
      "-c search_path=pg_catalog,yaparena,pg_temp -c statement_timeout=15000 -c lock_timeout=10000",
  });
  const operator = createCoinSandboxOperatorRepository(database, {
    rail,
    ...(custody ? { depositDestination: custody } : {}),
  });
  try {
    const identity = (
      await database.query<{ safe: boolean }>(
        "SELECT current_user='yaparena_owner' AND session_user='yaparena_owner' AS safe",
      )
    ).rows[0];
    if (!identity?.safe) invalid("dedicated owner login is required");
    const check = await database.connect();
    try {
      await check.query("BEGIN");
      await assertSandboxRail(check, rail);
      await check.query("COMMIT");
    } catch (error) {
      await check.query("ROLLBACK");
      throw error;
    } finally {
      check.release();
    }
    async function request(id: unknown) {
      const row = (
        await database.query<SandboxRequest>(
          `SELECT id,user_id AS "userId",kind,reference,terms_digest AS "termsDigest",terms,status,expires_at AS "expiresAt",created_at AS "createdAt"
        FROM coin_sandbox_requests WHERE id=$1`,
          [uuid(id)],
        )
      ).rows[0];
      if (
        !row ||
        row.terms.rail !== rail ||
        row.terms.environment !== "sandbox" ||
        row.terms.asset !== "USDC" ||
        row.terms.precision !== "6"
      )
        invalid("request is unavailable in the selected sandbox rail");
      return row;
    }
    async function reconcile(
      row: SandboxRequest,
      notification: SandboxNotification,
      eventId: string,
    ) {
      if (row.kind !== "funding" && row.kind !== "withdrawal")
        invalid("funding or withdrawal request required");
      const baseEvent = {
        externalId: row.id,
        termsDigest: row.termsDigest,
        source: "reconciliation" as const,
      };
      let event: ExternalObservation,
        receipt: SandboxTransferReceipt | undefined;
      if (rail === "simulation") {
        // These valueless outcomes exist only in the isolated deterministic rail.
        // A signed notifier or explicit owner command chooses the simulated
        // result. No corresponding chain payment can exist in this rail.
        if (row.kind === "funding" && notification.status === "completed") {
          await operator.confirmSimulatedFunding({
            userId: row.userId,
            requestId: row.id,
          });
          return "completed";
        }
        const tx = `simulation:payout:${row.id}`;
        if (
          notification.transactionId !== null &&
          notification.transactionId !== tx
        )
          invalid("simulation transfer identity conflicts");
        event = {
          ...baseEvent,
          id: eventId,
          status: notification.status,
          finalNoTransfer: notification.status === "failed",
          transactionId: notification.status === "completed" ? tx : null,
        };
        if (notification.status === "completed")
          receipt = {
            network: "simulation:usdc",
            transactionId: tx,
            locator: "debit:0",
            amount: text(row.terms.net),
            evidenceDigest: digest([
              "deterministic-simulation",
              row.id,
              row.termsDigest,
              "completed",
            ]),
          };
      } else {
        if (!custody || row.terms.network !== "base-sepolia:84532")
          invalid("fixed Base Sepolia custody terms required");
        let hash: Hash,
          from: ReturnType<typeof getAddress>,
          nonce: number | undefined;
        if (row.kind === "withdrawal") {
          const reserved = (
            await database.query<{
              transaction_id: string;
              sender: string;
              nonce: string;
            }>(
              "SELECT transaction_id,sender,nonce::text FROM coin_nonce_reservations WHERE request_id=$1 AND environment='sandbox' AND network='base-sepolia:84532'",
              [row.id],
            )
          ).rows[0];
          if (!reserved) invalid("missing-external-identity");
          hash = transactionHash(reserved.transaction_id);
          from = getAddress(reserved.sender);
          nonce = Number(reserved.nonce);
          if (
            from !== custody ||
            !Number.isSafeInteger(nonce) ||
            nonce < 0 ||
            (notification.transactionId !== null &&
              transactionHash(notification.transactionId).toLowerCase() !==
                hash.toLowerCase())
          )
            invalid("persisted payout identity conflicts");
        } else {
          hash = transactionHash(notification.transactionId);
          from = getAddress(text(notification.sender));
          if (getAddress(text(row.terms.destination)) !== custody)
            invalid("funding custody destination conflicts");
        }
        const observation = await createBaseSepoliaAdapter(
          baseSepoliaAsset,
        ).inspectTransfer(
          {
            environment: "sandbox",
            chainId: 84532,
            token: baseSepoliaAsset.token,
            from,
            to: getAddress(text(row.terms.destination)),
            amount: BigInt(
              text(row.kind === "funding" ? row.terms.amount : row.terms.net),
            ),
          },
          hash,
          nonce,
        );
        // Notification status/finalNoTransfer never supply authority here. The
        // fixed adapter checks canonical finalized state and the ORIGINAL nonce.
        event = {
          ...baseEvent,
          id: `${eventId}:${digest(observation)}`,
          status: observation.status,
          finalNoTransfer: observation.finalNoTransfer,
          transactionId: hash,
        };
        if (
          observation.status === "completed" &&
          observation.eventLogIndex !== null
        )
          receipt = {
            network: "base-sepolia:84532",
            transactionId: hash.toLowerCase(),
            locator: `log:${observation.eventLogIndex}`,
            amount: text(
              row.kind === "funding" ? row.terms.amount : row.terms.net,
            ),
            evidenceDigest: digest({
              network: "base-sepolia:84532",
              transactionId: hash.toLowerCase(),
              blockNumber: observation.blockNumber,
              blockHash: observation.blockHash,
              logIndex: observation.eventLogIndex,
              from,
              to: row.terms.destination,
              amount: row.kind === "funding" ? row.terms.amount : row.terms.net,
            }),
          };
      }
      if (row.kind === "funding") {
        if (event.status === "completed") {
          if (!receipt) invalid("reconciled receipt required");
          await operator.confirmFunding({
            userId: row.userId,
            requestId: row.id,
            receipt,
          });
        } else
          await operator.observeFunding({
            userId: row.userId,
            requestId: row.id,
            event,
          });
      } else
        await operator.observe({
          userId: row.userId,
          requestId: row.id,
          event,
          ...(receipt ? { receipt } : {}),
        });
      return event.status;
    }
    const command = input.command;
    let status: string = "recorded",
      processed = 0;
    switch (command) {
      case "void-round": {
        const body = fields(input.body, ["roundId", "reason"]);
        if (
          body.reason !== "debate_unavailable" &&
          body.reason !== "operator_cancelled"
        )
          invalid("void reason required");
        await createCoinDebateSandbox(database, rail).voidRound(
          uuid(body.roundId),
          body.reason,
        );
        break;
      }
      case "review": {
        const body = fields(input.body, [
            "requestId",
            "decision",
            "idempotencyKey",
          ]),
          row = await request(body.requestId);
        if (body.decision !== "approve" && body.decision !== "reject")
          invalid("review decision must be approve or reject");
        status = (
          await operator.review({
            userId: row.userId,
            requestId: row.id,
            decision: body.decision,
            idempotencyKey: text(body.idempotencyKey),
          })
        ).status;
        break;
      }
      case "seed-simulation": {
        const body = fields(input.body, [
          "userId",
          "purpose",
          "amount",
          "idempotencyKey",
        ]);
        if (rail !== "simulation")
          invalid("invented treasury credits require simulation rail");
        if (
          body.purpose !== "promotional" &&
          body.purpose !== "center" &&
          body.purpose !== "correction"
        )
          invalid("treasury purpose is required");
        await operator.seedSandboxTreasury({
          userId: accountId(body.userId),
          purpose: body.purpose,
          amount: text(body.amount),
          idempotencyKey: text(body.idempotencyKey),
        });
        break;
      }
      case "correct": {
        const body = fields(input.body, [
            "requestId",
            "reason",
            "idempotencyKey",
          ]),
          row = await request(body.requestId);
        if (
          body.reason !== "incorrect_funding" &&
          body.reason !== "operator_error"
        )
          invalid("correction reason required");
        await operator.correctFunding({
          userId: row.userId,
          requestId: row.id,
          reason: body.reason,
          idempotencyKey: text(body.idempotencyKey),
        });
        break;
      }
      case "retry-correction": {
        const body = fields(input.body, ["correctionId", "idempotencyKey"]),
          row = await request(body.correctionId);
        await operator.retryCorrection({
          userId: row.userId,
          correctionId: row.id,
          idempotencyKey: text(body.idempotencyKey),
        });
        break;
      }
      case "simulate":
      case "reconcile":
      case "confirm-funding": {
        const body = fields(input.body, [
            "requestId",
            "status",
            "transactionId",
            "sender",
          ]),
          row = await request(body.requestId);
        if ((command === "simulate") !== (rail === "simulation"))
          invalid("command does not match isolated rail");
        if (command === "confirm-funding" && row.kind !== "funding")
          invalid("funding request required");
        const notification = parseSandboxNotification({
          requestId: row.id,
          status: body.status ?? "uncertain",
          transactionId: body.transactionId ?? null,
          ...(body.sender !== undefined ? { sender: body.sender } : {}),
        });
        status = await reconcile(
          row,
          notification,
          `operator:${digest(notification)}`,
        );
        break;
      }
      case "drain-inbox": {
        const body = fields(input.body, ["limit"]),
          rows = (
            await database.query<{
              id: string;
              request_id: string;
              payload: unknown;
              payload_digest: string;
            }>(
              `SELECT i.id,i.request_id,i.payload,i.payload_digest FROM coin_sandbox_webhook_inbox i
          WHERE i.rail=$1 AND NOT EXISTS(SELECT 1 FROM coin_sandbox_webhook_outcomes o WHERE o.inbox_id=i.id)
          ORDER BY i.received_at,i.id LIMIT $2`,
              [rail, limit(body.limit)],
            )
          ).rows;
        for (const inbox of rows) {
          let disposition = "processed",
            reason = "applied";
          try {
            const row = await request(inbox.request_id),
              notification = parseSandboxNotification(inbox.payload);
            if (notification.requestId !== row.id)
              invalid("invalid-notification");
            await reconcile(row, notification, `inbox:${inbox.id}`);
          } catch (error) {
            if (
              !(error instanceof CommandError) &&
              !(error instanceof CoinOperationError)
            )
              throw error;
            disposition = "rejected";
            reason =
              error instanceof CommandError &&
              error.message === "missing-external-identity"
                ? "missing-external-identity"
                : "request-conflict";
          }
          await database.query(
            `INSERT INTO coin_sandbox_webhook_outcomes(inbox_id,disposition,event_digest,reason_code)
            VALUES($1,$2,$3,$4) ON CONFLICT(inbox_id) DO NOTHING`,
            [inbox.id, disposition, inbox.payload_digest, reason],
          );
          processed++;
        }
        break;
      }
      case "reconcile-pending": {
        const body = fields(input.body, ["limit"]);
        if (rail !== "base-sepolia")
          invalid("reconcile-pending requires actual isolated testnet rail");
        const rows = (
          await database.query<{ id: string }>(
            `SELECT r.id FROM coin_sandbox_requests r
          JOIN coin_nonce_reservations n ON n.request_id=r.id
          WHERE r.kind='withdrawal' AND r.terms->>'rail'=$1 AND r.status IN ('approved','pending','uncertain')
          ORDER BY r.created_at,r.id LIMIT $2`,
            [rail, limit(body.limit)],
          )
        ).rows;
        for (const item of rows) {
          const row = await request(item.id);
          await reconcile(
            row,
            { requestId: row.id, status: "uncertain", transactionId: null },
            `scan:${row.id}`,
          );
          processed++;
        }
        break;
      }
      default:
        invalid("unknown sandbox operator command");
    }
    return { command, environment: "sandbox", rail, status, processed };
  } finally {
    await database.end();
  }
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) invalid("JSON input bytes required");
    length += chunk.length;
    if (length > 32768) invalid("command input exceeds 32 KiB");
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed;
  } catch {
    invalid("JSON input required on stdin");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3)
      invalid("supply one explicit sandbox operator command");
    console.log(
      JSON.stringify(
        await runCoinSandboxOperator({
          command: process.argv[2]!,
          body: await readInput(),
          environment: process.env,
        }),
      ),
    );
  } catch (error) {
    // PG/RPC error objects and URLs may contain credentials; never print them.
    console.error(
      error instanceof CommandError
        ? error.message
        : "Sandbox operator command failed; inspect private database audit evidence.",
    );
    process.exitCode = 1;
  }
}
