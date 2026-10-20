import type { Pool, PoolClient } from "pg";
import { ProviderAccountError } from "./provider-accounts.ts";
import {
  ProviderCredentialChangedError,
  ProviderUnavailableError,
  type IdentityVerifier,
} from "./privy.ts";
import {
  assertActiveSession,
  lockAccount,
  revokeAccountSessions,
  SessionUnavailableError,
} from "./sessions.ts";

type MonitorSnapshot = {
  sessionId: string;
  authGeneration: string;
  subject: string | null;
  credentialsDigest: string | null;
  providerControl: string | null;
};
async function snapshot(
  database: Pick<Pool | PoolClient, "query">,
  userId: string,
  tokenHash: string,
) {
  return (
    await database.query<MonitorSnapshot>(
      `SELECT s.id::text AS "sessionId",u.auth_generation::text AS "authGeneration",
      p.subject,p.credentials_digest AS "credentialsDigest",
      (SELECT jsonb_build_array(j.generation::text,j.state,j.attempts)::text
        FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.subject=p.subject ORDER BY j.generation DESC LIMIT 1) AS "providerControl"
      FROM sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN provider_identities p ON p.user_id=u.id AND p.provider='privy'
      WHERE u.id=$1 AND s.token_hash=$2 AND u.account_status='active'
        AND s.auth_generation=u.auth_generation AND s.expires_at>clock_timestamp()`,
      [userId, tokenHash],
    )
  ).rows[0];
}

// PostgreSQL remains authoritative; provider snapshots are never a positive
// authorization cache. Every protected cookie lookup gets a server-side read.
export function createProviderSessionMonitor(
  database: Pool,
  inspector: Pick<IdentityVerifier, "inspect">,
) {
  return async (userId: string, tokenHash: string) => {
    const initial = await snapshot(database, userId, tokenHash);
    if (!initial) throw new SessionUnavailableError("session unavailable");
    if (!initial.subject) return;
    // A slow provider must never occupy the runtime pool or an account lock.
    // Its result conveys no authority until the complete local snapshot below
    // has been revalidated. This also lets local logout complete during outages.
    const inspection = await inspector.inspect(initial.subject).then(
      (state) => ({ state }),
      (failure: unknown) => ({ failure }),
    );
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockAccount(client, userId)))
        throw new SessionUnavailableError("account unavailable");
      const session = await assertActiveSession(client, userId, tokenHash),
        current = await snapshot(client, userId, tokenHash);
      if (!current || session.id !== initial.sessionId)
        throw new SessionUnavailableError("session unavailable");
      if (
        current.authGeneration !== initial.authGeneration ||
        current.subject !== initial.subject ||
        current.credentialsDigest !== initial.credentialsDigest ||
        current.providerControl !== initial.providerControl
      )
        throw new ProviderUnavailableError(
          "account verification changed; retry with a fresh provider inspection",
        );
      // A provider-control job can temporarily freeze the DID while revoking
      // old provider sessions. Its fingerprint is part of the snapshot, so an
      // overlapping observation cannot revoke the deliberately retained SID.
      const changed =
        "failure" in inspection
          ? inspection.failure instanceof ProviderCredentialChangedError
          : inspection.state.subject !== initial.subject ||
            inspection.state.credentialsDigest !== initial.credentialsDigest;
      if ("failure" in inspection && !changed) throw inspection.failure;
      if (changed) {
        await revokeAccountSessions(client, userId, {
          action: "sessions.incident",
        });
        await client.query("COMMIT");
        throw new ProviderAccountError(
          "sign-in methods changed; ownership reconciliation is required",
          403,
        );
      }
      if ("state" in inspection && inspection.state.credentials)
        await client.query(
          "UPDATE provider_identities SET credentials_snapshot=$2::jsonb WHERE user_id=$1 AND credentials_snapshot IS NULL",
          [userId, JSON.stringify(inspection.state.credentials)],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}
