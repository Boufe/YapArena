import type { Pool } from "pg";
import type { AuthenticationUser } from "./users.ts";
import { lockAccount, insertSession, assertActiveSession } from "./sessions.ts";

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
export class WalletAlreadyLinkedError extends Error {}

export function createWalletRepository(database: Pool) {
  return Object.freeze({
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

    async completeLink(
      id: string,
      userId: string,
      sessionTokenHash: string,
    ): Promise<LinkedWallet> {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const account = await lockAccount(client, userId);
        if (!account)
          throw new ChallengeUnavailableError("account is unavailable");
        await assertActiveSession(client, userId, sessionTokenHash);
        const consumed = await client.query<{
          address: string;
          chainId: string;
        }>(
          `UPDATE wallet_challenges SET consumed_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND purpose = 'link' AND user_id = $2
             AND session_token_hash = $3 AND consumed_at IS NULL
             AND auth_generation = $4 AND expires_at > clock_timestamp()
           RETURNING address, chain_id AS "chainId"`,
          [id, userId, sessionTokenHash, account.authGeneration],
        );
        const challenge = consumed.rows[0];
        if (!challenge)
          throw new ChallengeUnavailableError("challenge is unavailable");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${challenge.chainId}:${challenge.address}`,
        ]);
        const existing = await client.query<LinkedWallet & { userId: string }>(
          `SELECT id, user_id AS "userId", address, chain_id AS "chainId",
             created_at AS "createdAt"
           FROM wallet_identities WHERE chain_id = $1 AND address = $2`,
          [challenge.chainId, challenge.address],
        );
        const existingWallet = existing.rows[0];
        if (existingWallet && existingWallet.userId !== userId) {
          throw new WalletAlreadyLinkedError(
            "wallet belongs to another account",
          );
        }
        let wallet: LinkedWallet | undefined = existingWallet;
        if (!wallet) {
          const created = await client.query<LinkedWallet>(
            `INSERT INTO wallet_identities (user_id, chain_id, address)
             VALUES ($1, $2, $3)
             RETURNING id, address, chain_id AS "chainId", created_at AS "createdAt"`,
            [userId, challenge.chainId, challenge.address],
          );
          wallet = created.rows[0];
        }
        if (!wallet) throw new Error("linked wallet was not returned");
        await client.query("COMMIT");
        return {
          id: wallet.id,
          address: wallet.address,
          chainId: wallet.chainId,
          createdAt: wallet.createdAt,
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

    async unlinkWallet(
      userId: string,
      walletId: string,
    ): Promise<"removed" | "missing" | "last_credentials"> {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const user = await lockAccount(client, userId);
        const target = await client.query(
          "SELECT id FROM wallet_identities WHERE id = $1 AND user_id = $2",
          [walletId, userId],
        );
        if (!target.rows[0]) {
          await client.query("COMMIT");
          return "missing";
        }
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM wallet_identities WHERE user_id = $1",
          [userId],
        );
        if (!user?.email && Number(count.rows[0]?.count ?? 0) <= 1) {
          await client.query("COMMIT");
          return "last_credentials";
        }
        await client.query(
          "DELETE FROM wallet_identities WHERE id = $1 AND user_id = $2",
          [walletId, userId],
        );
        await client.query("COMMIT");
        return "removed";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteExpiredChallenges() {
      const result = await database.query(
        "DELETE FROM wallet_challenges WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '1 day'",
      );
      return result.rowCount ?? 0;
    },
  });
}
