import type { PoolClient } from "pg";

// Current absence alone cannot establish that an account never had a stronger
// method. Credential/wallet audit history and retired key rows are retained.
export async function firstProviderPasskeyBootstrapAllowed(
  client: Pick<PoolClient, "query">,
  userId: string,
) {
  return (
    (
      await client.query<{ allowed: boolean }>(
        `SELECT u.password_hash IS NULL AND u.email IS NULL
    AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.user_id=u.id AND (p.methods ? 'email' OR p.methods ? 'google_oauth'))
    AND NOT EXISTS(SELECT 1 FROM account_security_keys k WHERE k.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM wallet_identities w WHERE w.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM identity_audit_events a WHERE a.user_id=u.id AND
      (a.event_type LIKE 'wallet%' OR a.event_type LIKE 'security.passkey.%' OR a.event_type IN ('credentials.password_changed','provider.credentials.reconciled')))
    AND NOT EXISTS(SELECT 1 FROM coin_accounts a WHERE a.user_id=u.id AND (a.balance<>0 OR EXISTS(SELECT 1 FROM coin_postings p WHERE p.account_id=a.id)))
    AND NOT EXISTS(SELECT 1 FROM coin_grant_lots g WHERE g.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM coin_sandbox_requests r WHERE r.user_id=u.id AND r.status<>'quoted') AS allowed FROM users u WHERE u.id=$1`,
        [userId],
      )
    ).rows[0]?.allowed === true
  );
}
