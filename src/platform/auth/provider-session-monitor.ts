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
import {
  parseProviderPasskeyPublicKey,
  pendingProviderPasskeyAddition,
} from "./provider-passkeys.ts";

type AcceptedProviderKey = {
  credentialId: string;
  subject: string;
  digest: string;
};
type MonitorSnapshot = {
  sessionId: string;
  authGeneration: string;
  subject: string | null;
  credentialsDigest: string | null;
  providerControl: string | null;
  providerResetActive: boolean;
  providerPhasePending: boolean;
  acceptedProviderKeys: AcceptedProviderKey[];
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
      (SELECT jsonb_build_array(j.generation::text,j.state,j.attempts,j.control_phase,
        j.control_id,j.control_lease_id,j.control_reads,j.freeze_acknowledged_at,j.unfreeze_acknowledged_at)::text
        FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.subject=p.subject ORDER BY j.generation DESC LIMIT 1) AS "providerControl",
      EXISTS(SELECT 1 FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.subject=p.subject
        AND j.generation=u.auth_generation AND (j.state IN ('pending','running')
          OR (j.state='manual' AND j.failure_reason='uncertain_provider_outcome'))) AS "providerResetActive",
      EXISTS(SELECT 1 FROM provider_revocation_jobs j WHERE j.user_id=u.id AND j.subject=p.subject
        AND j.generation=u.auth_generation AND j.state IN ('pending','running')
        AND j.control_phase<>'legacy') AS "providerPhasePending",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('credentialId',k.credential_id,
        'subject',k.provider_subject,'digest',k.provider_public_key_digest) ORDER BY k.id)
        FROM account_security_keys k WHERE k.user_id=u.id AND k.provenance='privy'
        AND k.revoked_at IS NULL),'[]'::jsonb) AS "acceptedProviderKeys"
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
        current.providerControl !== initial.providerControl ||
        current.providerResetActive !== initial.providerResetActive ||
        current.providerPhasePending !== initial.providerPhasePending ||
        JSON.stringify(current.acceptedProviderKeys) !==
          JSON.stringify(initial.acceptedProviderKeys)
      )
        throw new ProviderUnavailableError(
          "account verification changed; retry with a fresh provider inspection",
        );
      // A provider-control job can temporarily freeze the DID while revoking
      // old provider sessions. Its fingerprint is part of the snapshot, so an
      // overlapping observation cannot revoke the deliberately retained SID.
      let changed =
        "failure" in inspection
          ? inspection.failure instanceof ProviderCredentialChangedError
          : inspection.state.subject !== initial.subject ||
            inspection.state.credentialsDigest !== initial.credentialsDigest;
      if (
        "failure" in inspection &&
        inspection.failure instanceof ProviderCredentialChangedError &&
        current.providerResetActive
      )
        throw new ProviderUnavailableError(
          "provider session reset is awaiting confirmation; retry shortly",
        );
      if ("failure" in inspection && !changed) throw inspection.failure;
      let keyChanged = false;
      if ("state" in inspection) {
        for (const key of initial.acceptedProviderKeys) {
          const linked = inspection.state.passkeys?.filter(
            (entry) => entry.credentialId === key.credentialId,
          );
          if (
            key.subject !== inspection.state.subject ||
            !inspection.state.credentials?.some(
              (entry) =>
                entry.type === "passkey" && entry.id === key.credentialId,
            )
          ) {
            changed = true;
            keyChanged = true;
            continue;
          }
          if (linked?.length !== 1 || !linked[0]?.publicKey)
            throw new ProviderUnavailableError(
              "provider passkey verification unavailable",
            );
          let publicKeyDigest: string;
          try {
            publicKeyDigest = parseProviderPasskeyPublicKey(
              linked[0].publicKey,
            ).publicKeyDigest;
          } catch {
            throw new ProviderUnavailableError(
              "provider passkey verification unavailable",
            );
          }
          if (publicKeyDigest !== key.digest) {
            changed = true;
            keyChanged = true;
          }
        }
      }
      if (
        changed &&
        !keyChanged &&
        "state" in inspection &&
        initial.subject &&
        initial.credentialsDigest &&
        inspection.state.credentialsDigest !== initial.credentialsDigest
      ) {
        let pending = false;
        try {
          pending = await pendingProviderPasskeyAddition(client, {
            userId,
            authGeneration: initial.authGeneration,
            subject: initial.subject,
            beforeDigest: initial.credentialsDigest,
            current: inspection.state,
          });
        } catch {
          throw new ProviderUnavailableError(
            "provider passkey setup verification unavailable",
          );
        }
        if (pending) {
          // The still-live original session owns activation. Every other valid
          // session must also remain denied, without destroying that session's
          // exact in-progress setup through an account-wide incident reset.
          throw new ProviderUnavailableError(
            "finish passkey setup to continue",
          );
        }
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
      if (current.providerPhasePending)
        throw new ProviderUnavailableError(
          "provider session reset is awaiting confirmation; retry shortly",
        );
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
