import type { Pool } from "pg";
import { ProviderAccountError } from "./provider-accounts.ts";
import {
  ProviderCredentialChangedError,
  type IdentityVerifier,
} from "./privy.ts";
import {
  assertActiveSession,
  lockAccount,
  revokeAccountSessions,
  SessionUnavailableError,
} from "./sessions.ts";

// PostgreSQL remains authoritative; provider snapshots are never a positive
// authorization cache. Every protected cookie lookup gets a server-side read.
export function createProviderSessionMonitor(
  database: Pool,
  inspector: Pick<IdentityVerifier, "inspect">,
) {
  return async (userId: string, tokenHash: string) => {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      if (!(await lockAccount(client, userId)))
        throw new SessionUnavailableError("account unavailable");
      await assertActiveSession(client, userId, tokenHash);
      const mapping = (
        await client.query<{ subject: string; credentialsDigest: string }>(
          `SELECT subject,credentials_digest AS "credentialsDigest" FROM provider_identities WHERE user_id=$1`,
          [userId],
        )
      ).rows[0];
      if (mapping) {
        let changed = false;
        try {
          const state = await inspector.inspect(mapping.subject);
          changed =
            state.subject !== mapping.subject ||
            state.credentialsDigest !== mapping.credentialsDigest;
          if (!changed && state.credentials)
            await client.query(
              "UPDATE provider_identities SET credentials_snapshot=$2::jsonb WHERE user_id=$1 AND credentials_snapshot IS NULL",
              [userId, JSON.stringify(state.credentials)],
            );
        } catch (error) {
          if (!(error instanceof ProviderCredentialChangedError)) throw error;
          changed = true;
        }
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
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}
