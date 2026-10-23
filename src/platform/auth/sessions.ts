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
       auth_generation AS "authGeneration" FROM users WHERE id = $1 AND account_status = 'active' FOR UPDATE`,
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
       AND u.account_status = 'active'
       AND s.auth_generation = u.auth_generation AND s.expires_at > clock_timestamp()
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
// Only security incidents end every session; signing out ends one session.
export async function revokeAccountSessions(
  client: PoolClient,
  userId: string,
  options: {
    action: "sessions.incident";
    // Why an incident revocation happened, for example "provider_change".
    reason?: "provider_change";
  },
) {
  const result = await client.query<{
    authGeneration: string;
    actorDatabaseRole: string;
  }>(
    `UPDATE users SET auth_generation = auth_generation + 1 WHERE id = $1
     RETURNING auth_generation AS "authGeneration", current_user AS "actorDatabaseRole"`,
    [userId],
  );
  if (!result.rows[0])
    throw new SessionUnavailableError("account is unavailable");
  const authGeneration = result.rows[0].authGeneration;
  await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  await client.query(
    `INSERT INTO identity_audit_events (user_id, event_type, subject_id, metadata)
     VALUES ($1::bigint, $2, $1::bigint::text, $3::jsonb)`,
    [
      userId,
      options.action,
      JSON.stringify({
        actorDatabaseRole: result.rows[0].actorDatabaseRole,
        reason: options.reason,
        outcome: "success",
        authGeneration,
      }),
    ],
  );
  return authGeneration;
}

export type ProviderCheckScheduler = {
  // A mapping whose last Privy read is at least this old is due a re-check.
  staleAfterMs: number;
  // Starts the re-check without waiting for it; never throws.
  schedule(userId: string): void;
};

export function createSessionRepository(
  database: Pool,
  options: { providerCheck?: ProviderCheckScheduler } = {},
) {
  const providerCheck = options.providerCheck;
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

    // The request path: one indexed SELECT, no provider call and no row lock.
    // A stale Privy read only schedules an asynchronous re-check; the request
    // never waits for it. Local sign-out routes do not schedule one.
    async findUserByTokenHash(
      tokenHash: string,
      context?: { localRevocation: true },
    ): Promise<PublicUser | null> {
      const result = await database.query<
        PublicUser & { providerCheckDue: boolean }
      >(
        `SELECT users.id, users.email, users.created_at AS "createdAt",
           (p.subject IS NOT NULL AND (p.checked_at IS NULL
             OR p.checked_at <= clock_timestamp() - make_interval(secs => $2::double precision / 1000)))
             AS "providerCheckDue"
         FROM sessions
         INNER JOIN users ON users.id = sessions.user_id
         LEFT JOIN provider_identities p ON p.user_id = users.id AND p.provider = 'privy'
         WHERE sessions.token_hash = $1
           AND users.account_status = 'active'
           AND sessions.auth_generation = users.auth_generation
           AND sessions.expires_at > clock_timestamp()`,
        [tokenHash, providerCheck?.staleAfterMs ?? 0],
      );
      const row = result.rows[0];
      if (!row) return null;
      const { providerCheckDue, ...user } = row;
      if (providerCheckDue && providerCheck && !context?.localRevocation)
        providerCheck.schedule(user.id);
      return user;
    },

    async list(userId: string, currentTokenHash: string) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAccount(client, userId)))
          throw new SessionUnavailableError("account is unavailable");
        const current = await assertActiveSession(
          client,
          userId,
          currentTokenHash,
        );
        const result = await client.query<{
          id: string;
          createdAt: Date;
          expiresAt: Date;
          current: boolean;
        }>(
          `SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",id=$2::bigint AS current
          FROM sessions WHERE user_id=$1 AND auth_generation=(SELECT auth_generation FROM users WHERE id=$1)
            AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 101`,
          [userId, current.id],
        );
        await client.query("COMMIT");
        return {
          sessions: result.rows.slice(0, 100),
          hasMore: result.rows.length > 100,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    // Ends one session row. The account generation is unchanged, so every
    // other device stays signed in and no provider reset is queued.
    async revokeSession(
      userId: string,
      currentTokenHash: string,
      targetId?: string,
      requestId?: string,
    ) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAccount(client, userId)))
          throw new SessionUnavailableError("account is unavailable");
        const current = await assertActiveSession(
          client,
          userId,
          currentTokenHash,
        );
        const target = targetId ?? current.id;
        const removed = await client.query<{ id: string }>(
          "DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING id",
          [target, userId],
        );
        if (!removed.rows[0]) {
          await client.query("COMMIT");
          return null;
        }
        await client.query(
          `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
          VALUES($1,'sessions.logout_one',$2,$3::jsonb)`,
          [
            userId,
            target,
            JSON.stringify({
              actorUserId: userId,
              actorSessionId: current.id,
              requestId,
              outcome: "success",
            }),
          ],
        );
        await client.query("COMMIT");
        return { current: current.id === target };
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
