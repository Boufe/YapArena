import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../transaction.ts";
import type { VerifiedIdentity } from "./auth0.ts";
import { assertActiveSession, lockAccount } from "./sessions.ts";

export class AccountOperationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AccountOperationTerms = Readonly<Record<string, string>>;

// Callers validate domain rules first. Exact monetary amounts must be strings,
// never floating point numbers. Sorting makes object insertion order irrelevant.
export function accountOperationTermsDigest(terms: AccountOperationTerms) {
  const entries = Object.entries(terms).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (
    entries.length > 32 ||
    entries.some(
      ([key, value]) =>
        !/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(key) ||
        typeof value !== "string" ||
        value.length > 2048 ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127;
        }),
    )
  )
    throw new AccountOperationError(400, "invalid operation terms");
  const canonical = JSON.stringify(entries);
  if (canonical.length > 16_384)
    throw new AccountOperationError(400, "invalid operation terms");
  return createHash("sha256").update(canonical).digest("hex");
}

function unavailable(): never {
  throw new AccountOperationError(
    410,
    "confirmation expired or invalid; start again",
  );
}

export type ConfirmationFailure = "expired" | "other_account" | "stale_sign_in";
export class ConfirmationError extends Error {
  constructor(readonly code: ConfirmationFailure) {
    super(`confirmation refused: ${code}`);
  }
}

// Decision 0009, point 8: a sensitive operation creates a one-use,
// five-minute challenge bound to the account, the session and the exact
// terms. The browser confirms it by signing in again (prompt=login,
// max_age=0); the callback requires a subject of the same account and an
// auth_time at or after the challenge's creation. Only then can the
// operation be consumed, once, with its feature mutation.
export function createAccountOperationRepository(database: Pool) {
  const repository = {
    async create(input: {
      userId: string;
      sessionTokenHash: string;
      purpose: string;
      terms: AccountOperationTerms;
    }) {
      if (!/^[a-z][a-z0-9_.]{0,79}$/.test(input.purpose))
        throw new AccountOperationError(400, "invalid operation purpose");
      const termsDigest = accountOperationTermsDigest(input.terms);
      return withTransaction(database, async (client) => {
        const account = await lockAccount(client, input.userId);
        if (!account)
          throw new AccountOperationError(401, "authentication required");
        await assertActiveSession(client, input.userId, input.sessionTokenHash);
        const id = randomUUID();
        const result = await client.query<{ expiresAt: Date }>(
          `WITH now AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
           INSERT INTO account_operations(id,user_id,session_token_hash,auth_generation,
             purpose,terms,terms_digest,nonce,credential_type,created_at,expires_at)
           SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8,'sign_in',at,at+interval '5 minutes' FROM now
           RETURNING expires_at AS "expiresAt"`,
          [
            id,
            input.userId,
            input.sessionTokenHash,
            account.authGeneration,
            input.purpose,
            JSON.stringify(input.terms),
            termsDigest,
            randomBytes(32).toString("hex"),
          ],
        );
        return Object.freeze({
          id,
          expiresAt: result.rows[0]!.expiresAt,
          // The browser adds &return=<path> and navigates here.
          confirmPath: `/api/auth/confirm?operation=${id}`,
        });
      });
    },

    // Before sending the browser to the provider: the operation must belong
    // to this signed-in device and still await its confirmation.
    async pending(input: {
      id: string;
      userId: string;
      sessionTokenHash: string;
    }) {
      const row = (
        await database.query<{ id: string }>(
          `SELECT o.id FROM account_operations o
           JOIN sessions s ON s.user_id=o.user_id AND s.token_hash=o.session_token_hash
           JOIN users u ON u.id=o.user_id
           WHERE o.id=$1 AND o.user_id=$2 AND o.session_token_hash=$3
             AND o.credential_type='sign_in' AND o.confirmed_at IS NULL
             AND o.consumed_at IS NULL AND o.expires_at>clock_timestamp()
             AND u.account_status='active' AND s.auth_generation=u.auth_generation
             AND s.expires_at>clock_timestamp()`,
          [input.id, input.userId, input.sessionTokenHash],
        )
      ).rows[0];
      return Boolean(row);
    },

    // Called by the provider callback with a verified fresh sign-in.
    async confirm(input: {
      id: string;
      userId: string;
      identity: Pick<VerifiedIdentity, "subject" | "authTime">;
    }) {
      if (input.identity.authTime === null)
        throw new ConfirmationError("stale_sign_in");
      const authTime = input.identity.authTime;
      return withTransaction(database, async (client) => {
        const operation = (
          await client.query<{ createdSecond: string }>(
            `SELECT extract(epoch FROM date_trunc('second',created_at))::bigint::text AS "createdSecond"
             FROM account_operations WHERE id=$1 AND user_id=$2
               AND credential_type='sign_in' AND confirmed_at IS NULL
               AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
            [input.id, input.userId],
          )
        ).rows[0];
        if (!operation) throw new ConfirmationError("expired");
        const owner = (
          await client.query<{ userId: string | null }>(
            `SELECT user_id::text AS "userId" FROM provider_identities
             WHERE provider='auth0' AND subject=$1`,
            [input.identity.subject],
          )
        ).rows[0];
        if (owner?.userId !== input.userId)
          throw new ConfirmationError("other_account");
        if (authTime < Number(operation.createdSecond))
          throw new ConfirmationError("stale_sign_in");
        await client.query(
          `UPDATE account_operations SET confirmed_at=clock_timestamp(),
             confirmed_subject=$2,confirmed_auth_time=to_timestamp($3)
           WHERE id=$1`,
          [input.id, input.identity.subject, authTime],
        );
      });
    },

    async prepare(input: {
      id: string;
      userId: string;
      sessionTokenHash: string;
      purpose: string;
      terms: AccountOperationTerms;
      requestId?: string;
    }) {
      const digest = accountOperationTermsDigest(input.terms);
      const operation = (
        await database.query<{
          id: string;
          authGeneration: string;
          confirmedSubject: string;
        }>(
          `SELECT id,auth_generation AS "authGeneration",confirmed_subject AS "confirmedSubject"
           FROM account_operations WHERE id=$1 AND user_id=$2
             AND session_token_hash=$3 AND purpose=$4 AND terms_digest=$5
             AND credential_type='sign_in' AND confirmed_at IS NOT NULL
             AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [
            input.id,
            input.userId,
            input.sessionTokenHash,
            input.purpose,
            digest,
          ],
        )
      ).rows[0];
      if (!operation) unavailable();

      return Object.freeze({
        purpose: input.purpose,
        termsDigest: digest,
        assertContext(userId: string, sessionTokenHash: string) {
          if (
            userId !== input.userId ||
            sessionTokenHash !== input.sessionTokenHash
          )
            throw new AccountOperationError(
              403,
              "confirmation belongs to another session",
            );
        },
        // The caller owns BEGIN/COMMIT. Invoke this before taking feature locks;
        // callback writes and one-use consumption must share that transaction.
        async consume<T>(client: PoolClient, mutation: () => Promise<T>) {
          const account = await lockAccount(client, input.userId);
          if (!account || account.authGeneration !== operation.authGeneration)
            unavailable();
          const session = await assertActiveSession(
            client,
            input.userId,
            input.sessionTokenHash,
          );
          const locked = await client.query(
            `SELECT o.id FROM account_operations o
             JOIN provider_identities p ON p.provider='auth0'
               AND p.subject=o.confirmed_subject AND p.user_id=o.user_id
             WHERE o.id=$1 AND o.user_id=$2 AND o.session_token_hash=$3
               AND o.auth_generation=$4 AND o.purpose=$5 AND o.terms_digest=$6
               AND o.confirmed_at IS NOT NULL AND o.consumed_at IS NULL
               AND o.expires_at>clock_timestamp() FOR UPDATE OF o`,
            [
              operation.id,
              input.userId,
              input.sessionTokenHash,
              account.authGeneration,
              input.purpose,
              digest,
            ],
          );
          if (!locked.rows[0]) unavailable();
          const result = await mutation();
          const consumed = await client.query(
            `UPDATE account_operations SET consumed_at=clock_timestamp()
             WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()
             AND $2::timestamptz>clock_timestamp() RETURNING id`,
            [operation.id, session.expiresAt],
          );
          if (!consumed.rows[0]) unavailable();
          await client.query(
            `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
             VALUES($1,'account.operation_authorized',$2,$3::jsonb)`,
            [
              input.userId,
              operation.id,
              JSON.stringify({
                purpose: input.purpose,
                termsDigest: digest,
                actorSessionId: session.id,
                credentialType: "sign_in",
                confirmedSubject: operation.confirmedSubject,
                requestId: input.requestId,
                outcome: "success",
              }),
            ],
          );
          return result;
        },
      });
    },

    async deleteExpired() {
      const result = await database.query(
        "DELETE FROM account_operations WHERE expires_at<clock_timestamp()-interval '1 day'",
      );
      return result.rowCount ?? 0;
    },
  };
  return Object.freeze({
    ...repository,
    async authorize(input: Parameters<typeof repository.prepare>[0]) {
      const approval = await repository.prepare(input);
      await withTransaction(database, async (client) => {
        await approval.consume(client, async () => {});
      });
    },
  });
}

export type AccountOperations = ReturnType<
  typeof createAccountOperationRepository
>;

// Parses {"id": "<uuid>"}, the confirmed operation a browser presents.
export function parseConfirmation(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.id,
    )
  )
    throw new AccountOperationError(400, "invalid confirmation");
  return { id: value.id };
}
