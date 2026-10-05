import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LinkedWallet } from "./wallets.ts";
import { verifyPassword } from "./passwords.ts";
import { createSessionToken } from "./session-tokens.ts";
import { createChallengeMessage, verifyChallengeSignature } from "./siwe.ts";
import { lockAccount, assertActiveSession, insertSession } from "./sessions.ts";

export class WalletOperationError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class WalletAlreadyLinkedError extends Error {}

export type WalletCredential =
  { type: "password" } | { type: "wallet"; walletId: string };

export interface WalletOperation {
  id: string;
  userId: string;
  sessionTokenHash: string;
  purpose: "link" | "unlink";
  address: string;
  chainId: string;
  targetWalletId: string | null;
  credentialType: "password" | "wallet";
  authGeneration: string;
  authorizingWalletId: string | null;
  authorizingAddress: string | null;
  authorizingChainId: string | null;
  authorizationMessage: string | null;
  proposedMessage: string | null;
  expiresAt: Date;
}

const operationColumns = `id, user_id AS "userId", session_token_hash AS "sessionTokenHash",
  purpose, address, chain_id AS "chainId", target_wallet_id AS "targetWalletId",
  credential_type AS "credentialType", auth_generation AS "authGeneration",
  authorizing_wallet_id AS "authorizingWalletId", authorizing_address AS "authorizingAddress",
  authorizing_chain_id AS "authorizingChainId", authorization_message AS "authorizationMessage",
  proposed_message AS "proposedMessage", expires_at AS "expiresAt"`;
const walletColumns = `id, address, chain_id AS "chainId", created_at AS "createdAt"`;

function unavailable(): never {
  throw new WalletOperationError(
    410,
    "wallet operation expired or invalid; start again",
  );
}

async function transaction<T>(
  database: Pool,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Account -> current session -> operation -> credential -> target identity lock.
async function lockAccountSession(
  client: PoolClient,
  userId: string,
  tokenHash: string,
) {
  const user = await lockAccount(client, userId);
  if (!user) throw new WalletOperationError(401, "authentication required");
  const session = await assertActiveSession(client, userId, tokenHash);
  return { user, session };
}

export function createWalletOperationRepository(database: Pool) {
  return Object.freeze({
    async create(input: {
      userId: string;
      sessionTokenHash: string;
      purpose: "link" | "unlink";
      address: string;
      chainId: number;
      targetWalletId?: string;
      credential: WalletCredential;
      origin: string;
    }): Promise<WalletOperation> {
      return transaction(database, async (client) => {
        const { user } = await lockAccountSession(
          client,
          input.userId,
          input.sessionTokenHash,
        );
        if (input.purpose === "unlink") {
          const target = await client.query(
            `SELECT id FROM wallet_identities WHERE id = $1 AND user_id = $2
             AND address = $3 AND chain_id = $4`,
            [input.targetWalletId, input.userId, input.address, input.chainId],
          );
          if (!target.rows[0])
            throw new WalletOperationError(404, "wallet not found");
        }
        let authorizer: { address: string; chainId: string } | undefined;
        if (input.credential.type === "wallet") {
          const found = await client.query<{
            address: string;
            chainId: string;
          }>(
            `SELECT address, chain_id AS "chainId" FROM wallet_identities
             WHERE id = $1 AND user_id = $2`,
            [input.credential.walletId, input.userId],
          );
          authorizer = found.rows[0];
          if (
            !authorizer ||
            (authorizer.address === input.address &&
              Number(authorizer.chainId) === input.chainId)
          )
            throw new WalletOperationError(
              403,
              "use an existing credential that will remain linked",
            );
        } else if (!user.passwordHash) {
          throw new WalletOperationError(
            403,
            "current password is unavailable; use a linked wallet",
          );
        }
        const id = randomUUID();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 5 * 60 * 1_000);
        const target = { address: input.address, chainId: input.chainId };
        const context = { origin: input.origin, now, operationId: id, target };
        const authorizationMessage = authorizer
          ? createChallengeMessage({
              ...context,
              address: authorizer.address,
              chainId: Number(authorizer.chainId),
              purpose:
                input.purpose === "link" ? "approve-link" : "approve-unlink",
            }).message
          : null;
        const proposedMessage =
          input.purpose === "link"
            ? createChallengeMessage({ ...context, ...target, purpose: "link" })
                .message
            : null;
        const result = await client.query<WalletOperation>(
          `INSERT INTO wallet_operations (id, user_id, session_token_hash, purpose, address, chain_id,
             target_wallet_id, credential_type, auth_generation, authorizing_wallet_id,
             authorizing_address, authorizing_chain_id, authorization_message, proposed_message, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING ${operationColumns}`,
          [
            id,
            input.userId,
            input.sessionTokenHash,
            input.purpose,
            input.address,
            input.chainId,
            input.targetWalletId ?? null,
            input.credential.type,
            user.authGeneration,
            input.credential.type === "wallet"
              ? input.credential.walletId
              : null,
            authorizer?.address ?? null,
            authorizer?.chainId ?? null,
            authorizationMessage,
            proposedMessage,
            expiresAt,
          ],
        );
        return result.rows[0]!;
      });
    },

    async complete(input: {
      id: string;
      userId: string;
      sessionTokenHash: string;
      purpose: "link" | "unlink";
      address: string;
      chainId: number;
      password?: string;
      authorizationSignature?: string;
      proposedSignature?: string;
      origin: string;
      rpcUrls: Readonly<Record<string, string>>;
      sessionDurationMs: number;
      requestId?: string;
    }): Promise<{ wallet: LinkedWallet; token: string }> {
      const found = await database.query<WalletOperation>(
        `SELECT ${operationColumns} FROM wallet_operations
         WHERE id = $1 AND user_id = $2 AND session_token_hash = $3
           AND purpose = $4 AND address = $5 AND chain_id = $6
           AND consumed_at IS NULL AND expires_at > clock_timestamp()`,
        [
          input.id,
          input.userId,
          input.sessionTokenHash,
          input.purpose,
          input.address,
          input.chainId,
        ],
      );
      const operation = found.rows[0];
      if (!operation) unavailable();
      const verify = (
        address: string,
        chainId: string,
        message: string,
        signature?: string,
      ) =>
        signature
          ? verifyChallengeSignature({
              challenge: {
                address,
                chainId,
                message,
                expiresAt: operation.expiresAt,
              },
              signature,
              origin: input.origin,
              rpcUrls: input.rpcUrls,
            })
          : Promise.resolve(false);
      // RPC/cryptography happens before locks; eligibility and live session are checked again below.
      if (
        operation.credentialType === "wallet" &&
        !(await verify(
          operation.authorizingAddress!,
          operation.authorizingChainId!,
          operation.authorizationMessage!,
          input.authorizationSignature,
        ))
      )
        throw new WalletOperationError(
          401,
          "existing wallet authorization is invalid",
        );
      if (
        operation.purpose === "link" &&
        !(await verify(
          operation.address,
          operation.chainId,
          operation.proposedMessage!,
          input.proposedSignature,
        ))
      )
        throw new WalletOperationError(401, "new wallet signature is invalid");

      return transaction(database, async (client) => {
        const { user, session } = await lockAccountSession(
          client,
          input.userId,
          input.sessionTokenHash,
        );
        if (user.authGeneration !== operation.authGeneration) unavailable();
        await client.query(
          "SELECT set_config('yaparena.request_id', $1, true)",
          [input.requestId ?? ""],
        );
        const locked = await client.query(
          `SELECT id FROM wallet_operations WHERE id = $1 AND consumed_at IS NULL
           AND expires_at > clock_timestamp() FOR UPDATE`,
          [operation.id],
        );
        if (!locked.rows[0]) unavailable();
        if (operation.credentialType === "password") {
          if (!user.passwordHash) unavailable();
          if (
            !input.password ||
            !(await verifyPassword(user.passwordHash, input.password))
          )
            throw new WalletOperationError(
              401,
              "current password is incorrect",
            );
        } else {
          const credential = await client.query(
            `SELECT id FROM wallet_identities WHERE id = $1 AND user_id = $2
             AND address = $3 AND chain_id = $4`,
            [
              operation.authorizingWalletId,
              input.userId,
              operation.authorizingAddress,
              operation.authorizingChainId,
            ],
          );
          if (
            !credential.rows[0] ||
            (operation.address === operation.authorizingAddress &&
              operation.chainId === operation.authorizingChainId)
          )
            unavailable();
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${operation.chainId}:${operation.address}`,
        ]);
        const oldSession = await client.query(
          `DELETE FROM sessions WHERE user_id = $1 AND token_hash = $2
           AND expires_at > clock_timestamp() RETURNING id`,
          [input.userId, input.sessionTokenHash],
        );
        if (!oldSession.rows[0]) unavailable();
        let wallet: LinkedWallet;
        if (operation.purpose === "link") {
          const existing = await client.query(
            "SELECT id FROM wallet_identities WHERE chain_id = $1 AND address = $2",
            [operation.chainId, operation.address],
          );
          if (existing.rows[0])
            throw new WalletAlreadyLinkedError("wallet is already linked");
          const inserted = await client.query<LinkedWallet>(
            `INSERT INTO wallet_identities (user_id, chain_id, address) VALUES ($1,$2,$3)
             RETURNING ${walletColumns}`,
            [input.userId, operation.chainId, operation.address],
          );
          wallet = inserted.rows[0]!;
        } else {
          const methods = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM wallet_identities WHERE user_id = $1",
            [input.userId],
          );
          if (!user.passwordHash && Number(methods.rows[0]!.count) <= 1)
            throw new WalletOperationError(
              409,
              "cannot remove the last sign-in method",
            );
          const removed = await client.query<LinkedWallet>(
            `DELETE FROM wallet_identities WHERE id = $1 AND user_id = $2
             AND chain_id = $3 AND address = $4 RETURNING ${walletColumns}`,
            [
              operation.targetWalletId,
              input.userId,
              operation.chainId,
              operation.address,
            ],
          );
          if (!removed.rows[0]) unavailable();
          wallet = removed.rows[0];
        }
        const consumed = await client.query(
          `UPDATE wallet_operations SET consumed_at = clock_timestamp()
           WHERE id = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
           AND $2::timestamptz > clock_timestamp() RETURNING id`,
          [operation.id, session.expiresAt],
        );
        if (!consumed.rows[0]) unavailable();
        const { token, tokenHash } = createSessionToken();
        const current = (await lockAccount(client, input.userId))!;
        await insertSession(
          client,
          input.userId,
          tokenHash,
          new Date(Date.now() + input.sessionDurationMs),
          current.authGeneration,
        );
        await client.query(
          `INSERT INTO account_notifications (user_id, event_type, message) VALUES ($1,$2,$3)`,
          [
            input.userId,
            `wallet.${operation.purpose}`,
            `Wallet ${operation.address} on chain ${operation.chainId} was ${operation.purpose === "link" ? "linked" : "unlinked"}. Review your account activity if you did not request this change.`,
          ],
        );
        await client.query(
          `INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
           VALUES ($1, 'wallet.operation_authorized', $2, $3::jsonb)`,
          [
            input.userId,
            wallet.id,
            JSON.stringify({
              operationId: operation.id,
              purpose: operation.purpose,
              actorSessionId: session.id,
              credentialType: operation.credentialType,
              authorizingWalletId: operation.authorizingWalletId,
              requestId: input.requestId,
              outcome: "success",
            }),
          ],
        );
        return { wallet, token };
      });
    },

    async deleteExpired() {
      const result = await database.query(
        "DELETE FROM wallet_operations WHERE expires_at < clock_timestamp() - INTERVAL '1 day'",
      );
      return result.rowCount ?? 0;
    },
  });
}
