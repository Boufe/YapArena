import type { Pool } from "pg";
import type { AuthenticationUser } from "./users.ts";
import { lockAccount, insertSession } from "./sessions.ts";
import { createWalletOperationRepository } from "./wallet-operations.ts";
export { WalletAlreadyLinkedError } from "./wallet-operations.ts";

export interface WalletChallenge {
  id: string;
  address: string;
  chainId: string;
  purpose: "login" | "link";
  message: string;
  userId: string | null;
  sessionTokenHash: string | null;
  expiresAt: Date;
  accountId: string | null;
  walletId: string | null;
  authGeneration: string | null;
}

export interface LinkedWallet {
  id: string;
  address: string;
  chainId: string;
  createdAt: Date;
}

export class ChallengeUnavailableError extends Error {}

export function createWalletRepository(database: Pool) {
  return Object.freeze({
    operations: createWalletOperationRepository(database),
    async createChallenge(input: {
      address: string;
      chainId: number;
      purpose: "login" | "link";
      message: string;
      userId?: string;
      sessionTokenHash?: string;
      expiresAt: Date;
    }): Promise<WalletChallenge> {
      const result = await database.query<WalletChallenge>(
        `INSERT INTO wallet_challenges
           (address, chain_id, purpose, message, user_id, session_token_hash, expires_at,
            account_id, wallet_id, auth_generation)
         SELECT $1, $2, $3, $4, $5, $6, $7, u.id, w.id, u.auth_generation
         FROM (SELECT 1) seed
         LEFT JOIN wallet_identities w ON w.address = $1 AND w.chain_id = $2
         LEFT JOIN users u ON u.id = COALESCE($5::bigint, w.user_id)
         RETURNING id, address, chain_id AS "chainId", purpose, message,
           user_id AS "userId", session_token_hash AS "sessionTokenHash",
           expires_at AS "expiresAt", account_id AS "accountId", wallet_id AS "walletId",
           auth_generation AS "authGeneration"`,
        [
          input.address,
          input.chainId,
          input.purpose,
          input.message,
          input.userId ?? null,
          input.sessionTokenHash ?? null,
          input.expiresAt,
        ],
      );
      if (!result.rows[0])
        throw new Error("created challenge was not returned");
      return result.rows[0];
    },

    async getChallenge(id: string): Promise<WalletChallenge | null> {
      const result = await database.query<WalletChallenge>(
        `SELECT id, address, chain_id AS "chainId", purpose, message,
           user_id AS "userId", session_token_hash AS "sessionTokenHash",
           expires_at AS "expiresAt", account_id AS "accountId", wallet_id AS "walletId",
           auth_generation AS "authGeneration"
         FROM wallet_challenges
         WHERE id = $1 AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
        [id],
      );
      return result.rows[0] ?? null;
    },

    async completeLogin(
      id: string,
      issuance: { tokenHash: string; expiresAt: Date },
    ): Promise<AuthenticationUser> {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const pending = await client.query<WalletChallenge>(
          `SELECT id, address, chain_id AS "chainId", account_id AS "accountId",
             wallet_id AS "walletId", auth_generation AS "authGeneration"
           FROM wallet_challenges WHERE id = $1 AND purpose = 'login'
             AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
          [id],
        );
        const challenge = pending.rows[0];
        if (!challenge)
          throw new ChallengeUnavailableError("challenge is unavailable");
        let account = challenge.accountId
          ? await lockAccount(client, challenge.accountId)
          : null;
        if (
          challenge.accountId &&
          (!account || account.authGeneration !== challenge.authGeneration)
        )
          throw new ChallengeUnavailableError("authentication state changed");
        // Existing accounts are locked first. An unknown wallet has no account to
        // lock; its advisory lock serializes only new account provisioning.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${challenge.chainId}:${challenge.address}`,
        ]);
        const found = await client.query<{ id: string; userId: string }>(
          `SELECT id, user_id AS "userId" FROM wallet_identities WHERE chain_id = $1 AND address = $2`,
          [challenge.chainId, challenge.address],
        );
        const wallet = found.rows[0];
        if (
          (challenge.accountId &&
            (wallet?.id !== challenge.walletId ||
              wallet.userId !== challenge.accountId)) ||
          (!challenge.accountId && wallet)
        )
          throw new ChallengeUnavailableError(
            "wallet ownership changed; request a fresh challenge",
          );
        const consumed = await client.query(
          `UPDATE wallet_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1 AND consumed_at IS NULL
             AND expires_at > CURRENT_TIMESTAMP RETURNING id`,
          [id],
        );
        if (!consumed.rows[0])
          throw new ChallengeUnavailableError("challenge is unavailable");
        if (!account) {
          const created = await client.query<AuthenticationUser>(
            `INSERT INTO users (email, password_hash) VALUES (NULL, NULL)
             RETURNING id, email, created_at AS "createdAt", auth_generation AS "authGeneration"`,
          );
          const user = created.rows[0];
          if (!user) throw new Error("created wallet user was not returned");
          await client.query(
            `INSERT INTO wallet_identities (user_id, chain_id, address) VALUES ($1, $2, $3)`,
            [user.id, challenge.chainId, challenge.address],
          );
          account = { ...user, passwordHash: null };
        }
        await insertSession(
          client,
          account.id,
          issuance.tokenHash,
          issuance.expiresAt,
          account.authGeneration,
        );
        await client.query("COMMIT");
        return {
          id: account.id,
          email: account.email,
          createdAt: account.createdAt,
          authGeneration: account.authGeneration,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listWallets(userId: string): Promise<LinkedWallet[]> {
      const result = await database.query<LinkedWallet>(
        `SELECT id, address, chain_id AS "chainId", created_at AS "createdAt"
         FROM wallet_identities WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      );
      return result.rows;
    },

    async deleteExpiredChallenges() {
      await createWalletOperationRepository(database).deleteExpired();
      const result = await database.query(
        "DELETE FROM wallet_challenges WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '1 day'",
      );
      return result.rowCount ?? 0;
    },
  });
}
