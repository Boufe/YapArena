import type { PoolClient } from "pg";
import { enqueueEmbeddedWalletProvisioning } from "./embedded-wallet-provisioning.ts";
import type { ProviderIdentity } from "./privy.ts";

const methodLabels: Record<string, string> = {
  email: "email code",
  google_oauth: "Google",
  passkey: "passkey",
};

// Decision 0008: a sign-in method change made in Privy is recorded with an
// audit event and an in-app notice. It no longer ends sessions or blocks
// sign-in. The caller holds the account lock and owns the transaction. The
// write applies only if the stored methods are still `previousDigest`.
export async function recordProviderCredentials(
  client: PoolClient,
  input: {
    userId: string;
    subject: string;
    previousDigest: string;
    identity: Pick<
      ProviderIdentity,
      "email" | "methods" | "credentialsDigest" | "credentials"
    >;
    source: "exchange" | "recheck" | "passkey_setup";
  },
) {
  const { identity } = input;
  const updated = await client.query(
    `UPDATE provider_identities SET email=$3,methods=$4::jsonb,credentials_digest=$5,
      credentials_snapshot=$6::jsonb,checked_at=clock_timestamp()
    WHERE provider='privy' AND subject=$1 AND user_id=$2 AND credentials_digest=$7`,
    [
      input.subject,
      input.userId,
      identity.email,
      JSON.stringify(identity.methods),
      identity.credentialsDigest,
      identity.credentials ? JSON.stringify(identity.credentials) : null,
      input.previousDigest,
    ],
  );
  if (!updated.rowCount) return false;
  await client.query(
    `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
    VALUES($1::bigint,'provider.credentials.changed',$1::bigint::text,$2::jsonb)`,
    [
      input.userId,
      JSON.stringify({
        outcome: "recorded",
        source: input.source,
        oldDigest: input.previousDigest,
        newDigest: identity.credentialsDigest,
        methods: identity.methods,
      }),
    ],
  );
  const methods = identity.methods
    .map((method) => methodLabels[method] ?? method)
    .join(", ");
  await client.query(
    `INSERT INTO account_notifications(user_id,event_type,message)
    VALUES($1,'account.signin_changed',$2)`,
    [
      input.userId,
      `Your sign-in methods changed in Privy. Current methods: ${methods}. If you did not make this change, use Sign out all sessions and review your account security.`,
    ],
  );
  // A wallet setup job parked on the previous methods may continue now.
  await enqueueEmbeddedWalletProvisioning(
    client,
    input.userId,
    input.subject,
    identity.credentialsDigest,
  );
  return true;
}
