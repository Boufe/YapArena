import type { Pool, PoolClient } from "pg";
import type { PublicUser, StoredUser } from "./users.ts";

export interface StoredSession {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthenticationSnapshot {
  authGeneration: string;
  passwordHash?: string;
  email?: string;
  walletId?: string;
}

export class SessionUnavailableError extends Error {}

// All callers lock the account before sessions, approvals, or credentials. Hashing
// and RPC verification happen outside this transaction; their snapshot is rechecked.
export async function lockAccount(client: PoolClient, userId: string) {
  const result = await client.query<StoredUser>(
    `SELECT id, email, password_hash AS "passwordHash", created_at AS "createdAt",
       auth_generation AS "authGeneration" FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function assertActiveSession(
  client: PoolClient,
  userId: string,
  tokenHash: string,
) {
  const result = await client.query<StoredSession>(
    `SELECT s.id, s.user_id AS "userId", s.expires_at AS "expiresAt",
       s.created_at AS "createdAt" FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND s.token_hash = $2
       AND s.auth_generation = u.auth_generation AND s.expires_at > CURRENT_TIMESTAMP
     FOR UPDATE OF s`,
    [userId, tokenHash],
  );
  if (!result.rows[0])
    throw new SessionUnavailableError("session is unavailable");
  return result.rows[0];
}

export async function insertSession(
  client: PoolClient,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  authGeneration: string,
): Promise<StoredSession> {
  const result = await client.query<StoredSession>(
    `INSERT INTO sessions (user_id, token_hash, expires_at, auth_generation)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id AS "userId", expires_at AS "expiresAt", created_at AS "createdAt"`,
    [userId, tokenHash, expiresAt, authGeneration],
  );
  if (!result.rows[0]) throw new Error("created session was not returned");
  return result.rows[0];
}

// Caller owns the account lock and the transaction. The generation advance is
// the ordering point; commit makes it visible on every application instance.
export async function revokeAccountSessions(
  client: PoolClient,
  userId: string,
  options: {
    retainTokenHash?: string;
    action:
      "sessions.logout_all" | "sessions.logout_others" | "sessions.incident";
    actorSessionId?: string;
    requestId?: string;
  },
) {
  const result = await client.query<{ authGeneration: string }>(
    `UPDATE users SET auth_generation = auth_generation + 1 WHERE id = $1
     RETURNING auth_generation AS "authGeneration"`,
    [userId],
  );
  if (!result.rows[0])
    throw new SessionUnavailableError("account is unavailable");
  const authGeneration = result.rows[0].authGeneration;
  await client.query(
    "DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)",
    [userId, options.retainTokenHash ?? null],
  );
  if (options.retainTokenHash) {
    await client.query(
      "UPDATE sessions SET auth_generation = $3 WHERE user_id = $1 AND token_hash = $2",
      [userId, options.retainTokenHash, authGeneration],
    );
  }
  await client.query(
    `INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $1::text, $3::jsonb)`,
    [
      userId,
      options.action,
      JSON.stringify({
        actorUserId: userId,
        actorSessionId: options.actorSessionId,
        requestId: options.requestId,
        outcome: "success",
        authGeneration,
      }),
    ],
  );
  return authGeneration;
}

export function createSessionRepository(database: Pool) {
  return Object.freeze({
    async create(
      userId: string,
      tokenHash: string,
      expiresAt: Date,
      expected: AuthenticationSnapshot,
    ): Promise<StoredSession> {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const account = await lockAccount(client, userId);
        if (
          !account ||
          account.authGeneration !== expected.authGeneration ||
          (expected.passwordHash !== undefined &&
            (account.passwordHash !== expected.passwordHash ||
              account.email !== expected.email))
        )
          throw new SessionUnavailableError(
            "authentication state changed; sign in again",
          );
        if (expected.walletId) {
          const wallet = await client.query(
            "SELECT id FROM wallet_identities WHERE id = $1 AND user_id = $2",
            [expected.walletId, userId],
          );
          if (!wallet.rows[0])
            throw new SessionUnavailableError("wallet is unavailable");
        }
        const session = await insertSession(
          client,
          userId,
          tokenHash,
          expiresAt,
          account.authGeneration,
        );
        await client.query("COMMIT");
        return session;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async findUserByTokenHash(tokenHash: string): Promise<PublicUser | null> {
      const result = await database.query<PublicUser>(
        `SELECT users.id, users.email, users.created_at AS "createdAt"
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1
           AND sessions.auth_generation = users.auth_generation
           AND sessions.expires_at > CURRENT_TIMESTAMP`,
        [tokenHash],
      );
      return result.rows[0] ?? null;
    },

    async revoke(
      userId: string,
      currentTokenHash: string,
      retainCurrent: boolean,
      requestId?: string,
    ) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAccount(client, userId)))
          throw new SessionUnavailableError("account is unavailable");
        const session = await assertActiveSession(
          client,
          userId,
          currentTokenHash,
        );
        await revokeAccountSessions(client, userId, {
          retainTokenHash: retainCurrent ? currentTokenHash : undefined,
          action: retainCurrent
            ? "sessions.logout_others"
            : "sessions.logout_all",
          actorSessionId: session.id,
          requestId,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteByTokenHash(tokenHash: string) {
      const result = await database.query(
        "DELETE FROM sessions WHERE token_hash = $1 RETURNING id",
        [tokenHash],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deleteExpired() {
      const result = await database.query(
        "DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP",
      );
      return result.rowCount ?? 0;
    },
  });
}
