import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  AccountOperationError,
  createAccountOperationRepository,
  type AccountOperationCredential,
} from "./account-operations.ts";
import { ProviderUnavailableError, type IdentityVerifier } from "./privy.ts";
import {
  providerCredentialsDigest,
  verifiedStoredCredentials,
  type ProviderCredential,
} from "./provider-credentials.ts";
import { createSessionToken } from "./session-tokens.ts";
import { insertSession } from "./sessions.ts";

const purpose = "provider.identity.recover";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function unavailable(): never {
  throw new AccountOperationError(
    409,
    "Sign-in recovery changed or requires ownership review. No accounts were merged. Start again.",
  );
}
type Mapping = {
  subject: string;
  email: string | null;
  methods: string[];
  credentialsDigest: string;
  credentialsSnapshot: ProviderCredential[] | null;
};

// This recovers YapArena ownership by replacing a provider binding. It never
// changes/deletes the old Privy user, merges accounts or implements email OTP.
export function createProviderIdentityRecovery(
  database: Pool,
  verifier: Pick<IdentityVerifier, "verify" | "inspect">,
) {
  const operations = createAccountOperationRepository(database, verifier);
  async function mapped(
    source: Pick<Pool | PoolClient, "query">,
    userId: string,
  ) {
    const row = (
      await source.query<Mapping>(
        `SELECT p.subject,p.email,p.methods,p.credentials_digest AS "credentialsDigest",p.credentials_snapshot AS "credentialsSnapshot"
        FROM provider_identities p JOIN users u ON u.id=p.user_id
        WHERE p.provider='privy' AND u.id=$1 AND u.account_status='active'`,
        [userId],
      )
    ).rows[0];
    if (!row) unavailable();
    const credentials = verifiedStoredCredentials(row);
    if (
      credentials?.length !== 1 ||
      row.methods.length !== 1 ||
      (credentials[0]?.type !== "email" &&
        credentials[0]?.type !== "google_oauth") ||
      credentials[0].type !== row.methods[0]
    )
      unavailable();
    return { ...row, credential: credentials[0] };
  }
  async function verified(token: string) {
    try {
      return await verifier.verify(token);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new AccountOperationError(
        401,
        "Verify the new email with Privy before recovering sign-in.",
      );
    }
  }
  async function candidate(userId: string, token: string) {
    const old = await mapped(database, userId);
    // Provider network work never occupies the runtime pool or account lock.
    const [identity, currentOld] = await Promise.all([
      verified(token),
      verifier.inspect(old.subject).catch((error: unknown) => {
        if (error instanceof ProviderUnavailableError) throw error;
        return unavailable();
      }),
    ]);
    if (
      currentOld.subject !== old.subject ||
      currentOld.credentialsDigest !== old.credentialsDigest ||
      currentOld.methods.length !== 1 ||
      currentOld.methods[0] !== old.credential.type ||
      currentOld.credentials?.length !== 1 ||
      currentOld.credentials[0]?.type !== old.credential.type ||
      currentOld.credentials[0].id !== old.credential.id ||
      identity.subject === old.subject ||
      !identity.email ||
      identity.methods.length !== 1 ||
      identity.methods[0] !== "email" ||
      identity.credentials?.length !== 1 ||
      identity.credentials[0]?.type !== "email" ||
      identity.credentials[0].id !== identity.email ||
      providerCredentialsDigest(identity.credentials) !==
        identity.credentialsDigest ||
      (old.credential.type === "email" &&
        old.credential.id.toLowerCase() === identity.email.toLowerCase())
    )
      unavailable();
    if (
      (
        await database.query(
          "SELECT 1 FROM provider_identities WHERE provider='privy' AND subject=$1",
          [identity.subject],
        )
      ).rowCount
    )
      unavailable();
    return {
      old,
      identity,
      terms: {
        provider: "privy",
        accountId: userId,
        oldSubject: old.subject,
        oldMethod: old.credential.type,
        oldIdentifier: old.credential.id,
        oldCredentialsDigest: old.credentialsDigest,
        newSubject: identity.subject,
        newCredentialsDigest: identity.credentialsDigest,
        newSessionDigest: digest(identity.sessionId),
        newEmail: identity.email,
      },
    };
  }
  function view(value: Awaited<ReturnType<typeof candidate>>) {
    return {
      oldMethod: value.old.credential.type,
      oldIdentifier: value.old.credential.id,
      newEmail: value.identity.email!,
      terms: value.terms,
    };
  }
  return Object.freeze({
    async candidate(userId: string, token: string) {
      return view(await candidate(userId, token));
    },
    async create(input: {
      userId: string;
      sessionTokenHash: string;
      origin: string;
      token: string;
      credential: AccountOperationCredential;
    }) {
      if (input.credential.type !== "passkey")
        throw new AccountOperationError(
          403,
          "A retained YapArena security passkey is required for this recovery.",
        );
      const legacyKey = await database.query(
        `SELECT id FROM account_security_keys WHERE id=$1 AND user_id=$2
         AND provenance='yaparena' AND revoked_at IS NULL`,
        [input.credential.keyId, input.userId],
      );
      if (!legacyKey.rowCount)
        throw new AccountOperationError(403, "security passkey required");
      const value = await candidate(input.userId, input.token);
      const operation = await operations.create({
        ...input,
        purpose,
        terms: value.terms,
      });
      return {
        id: operation.id,
        expiresAt: operation.expiresAt,
        authorizationMessage: operation.authorizationMessage,
        authenticationOptions: operation.authenticationOptions,
        ...view(value),
      };
    },
    async complete(
      input: Omit<
        Parameters<typeof operations.prepare>[0],
        "purpose" | "terms"
      > & {
        token: string;
        sessionDurationMs: number;
      },
    ) {
      if (
        !input.authentication ||
        input.password !== undefined ||
        input.signature !== undefined
      )
        throw new AccountOperationError(
          403,
          "A retained YapArena security passkey is required for this recovery.",
        );
      const value = await candidate(input.userId, input.token);
      const kind = (
        await database.query<{ credentialType: string }>(
          `SELECT o.credential_type AS "credentialType" FROM account_operations o
           JOIN account_security_keys k ON k.id=o.authorizing_passkey_id
           WHERE o.id=$1 AND o.user_id=$2 AND o.purpose=$3 AND k.user_id=o.user_id
             AND k.provenance='yaparena' AND k.revoked_at IS NULL`,
          [input.id, input.userId, purpose],
        )
      ).rows[0];
      if (kind?.credentialType !== "passkey") unavailable();
      const approval = await operations.prepare({
        ...input,
        purpose,
        terms: value.terms,
      });
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        // Exchange and legacy linking take DID -> account. Acquire the complete
        // sorted DID union before consume takes account/session/proof/key locks.
        for (const subject of [
          value.old.subject,
          value.identity.subject,
        ].sort())
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`privy:${subject}`],
          );
        const result = await approval.consume(client, async () => {
          const current = await mapped(client, input.userId);
          if (
            current.subject !== value.old.subject ||
            current.credentialsDigest !== value.old.credentialsDigest
          )
            unavailable();
          const enabled = await client.query<{ enabled: boolean }>(
            "SELECT signup_enabled AS enabled FROM auth_controls WHERE singleton",
          );
          if (!enabled.rows[0]?.enabled)
            throw new AccountOperationError(
              503,
              "sign-in is paused for maintenance",
            );
          const next = (
            await client.query<{ generation: string }>(
              "SELECT yaparena.apply_provider_identity_recovery($1) AS generation",
              [input.id],
            )
          ).rows[0];
          if (!next) unavailable();
          const token = createSessionToken();
          await insertSession(
            client,
            input.userId,
            token.tokenHash,
            new Date(Date.now() + input.sessionDurationMs),
            next.generation,
          );
          await client.query(
            `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
            VALUES($1,'provider.identity.recovered',$2,$3::jsonb)`,
            [
              input.userId,
              input.id,
              JSON.stringify({
                outcome: "success",
                credentialType: "passkey",
                oldDigest: value.old.credentialsDigest,
                newDigest: value.identity.credentialsDigest,
              }),
            ],
          );
          await client.query(
            `INSERT INTO account_notifications(user_id,event_type,message)
            VALUES($1,'account.signin_recovered','Your sign-in was replaced using your retained security passkey. The previous provider sign-in cannot open this account. Other sessions were signed out. Your profile and balances were preserved.')`,
            [input.userId],
          );
          return { token: token.token };
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["23505", "23514", "23503"].includes(String(error.code))
        )
          unavailable();
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
