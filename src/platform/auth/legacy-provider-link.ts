import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  AccountOperationError,
  createAccountOperationRepository,
  type AccountOperationCredential,
} from "./account-operations.ts";
import {
  ProviderUnavailableError,
  type IdentityVerifier,
  type ProviderIdentity,
} from "./privy.ts";
import { insertSession, lockAccount } from "./sessions.ts";
import { createSessionToken } from "./session-tokens.ts";

function terms(identity: ProviderIdentity) {
  return {
    provider: "privy",
    subject: identity.subject,
    credentialsDigest: identity.credentialsDigest,
  };
}

// Initial linking preserves the legacy account ID and credentials. A DID that
// ever mapped another account is deliberately ineligible; this is not a merger.
export function createLegacyProviderLink(
  database: Pool,
  verifier: Pick<IdentityVerifier, "verify">,
) {
  const operations = createAccountOperationRepository(database);
  async function verifiedIdentity(token: string) {
    try {
      return await verifier.verify(token);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new AccountOperationError(401, "provider authentication required");
    }
  }
  async function candidate(userId: string, token: string) {
    const identity = await verifiedIdentity(token);
    const mapped = await database.query(
      "SELECT 1 FROM provider_identities WHERE user_id=$1 OR subject=$2",
      [userId, identity.subject],
    );
    if (mapped.rowCount)
      throw new AccountOperationError(
        409,
        "these accounts require deliberate ownership review; no accounts were merged",
      );
    return identity;
  }
  return Object.freeze({
    async candidate(userId: string, token: string) {
      const identity = await candidate(userId, token);
      return { email: identity.email, methods: identity.methods };
    },
    async create(input: {
      userId: string;
      sessionTokenHash: string;
      origin: string;
      token: string;
      credential: AccountOperationCredential;
    }) {
      const identity = await candidate(input.userId, input.token);
      const operation = await operations.create({
        ...input,
        purpose: "provider.identity.link",
        terms: terms(identity),
      });
      return {
        id: operation.id,
        expiresAt: operation.expiresAt,
        authorizationMessage: operation.authorizationMessage,
        authenticationOptions: operation.authenticationOptions,
        email: identity.email,
        methods: identity.methods,
      };
    },
    async complete(
      input: Omit<
        Parameters<typeof operations.prepare>[0],
        "purpose" | "terms"
      > & { token: string; sessionDurationMs: number },
    ) {
      const identity = await verifiedIdentity(input.token);
      const approval = await operations.prepare({
        ...input,
        purpose: "provider.identity.link",
        terms: terms(identity),
      });
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        // Match the existing exchange's DID -> account lock order. No provider
        // calls happen while these database ordering locks are held.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`privy:${identity.subject}`],
        );
        const result = await approval.consume(client, async () => {
          const account = await lockAccount(client, input.userId);
          if (!account)
            throw new AccountOperationError(401, "authentication required");
          const enabled = await client.query<{ enabled: boolean }>(
            "SELECT signup_enabled AS enabled FROM auth_controls WHERE singleton",
          );
          if (!enabled.rows[0]?.enabled)
            throw new AccountOperationError(
              503,
              "sign-in is paused for maintenance",
            );
          const mapped = await client.query(
            "SELECT 1 FROM provider_identities WHERE user_id=$1 OR subject=$2",
            [input.userId, identity.subject],
          );
          if (mapped.rowCount)
            throw new AccountOperationError(
              409,
              "these accounts require deliberate ownership review; no accounts were merged",
            );
          await client.query(
            `INSERT INTO provider_identities(provider,subject,user_id,email,methods,auth_generation,credentials_digest)
            VALUES('privy',$1,$2,$3,$4::jsonb,$5,$6)`,
            [
              identity.subject,
              input.userId,
              identity.email,
              JSON.stringify(identity.methods),
              account.authGeneration,
              identity.credentialsDigest,
            ],
          );
          const consumed = await client.query(
            `INSERT INTO provider_session_exchanges(provider,subject,session_digest,user_id)
            VALUES('privy',$1,$2,$3) ON CONFLICT DO NOTHING RETURNING session_digest`,
            [
              identity.subject,
              createHash("sha256").update(identity.sessionId).digest("hex"),
              input.userId,
            ],
          );
          if (!consumed.rowCount)
            throw new AccountOperationError(
              401,
              "this provider sign-in session has already been used; authenticate again",
            );
          await client.query(
            "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
            [input.userId],
          );
          await client.query("DELETE FROM sessions WHERE user_id=$1", [
            input.userId,
          ]);
          const current = await lockAccount(client, input.userId);
          if (!current)
            throw new AccountOperationError(401, "authentication required");
          const token = createSessionToken();
          await insertSession(
            client,
            input.userId,
            token.tokenHash,
            new Date(Date.now() + input.sessionDurationMs),
            current.authGeneration,
          );
          await client.query(
            `INSERT INTO account_notifications(user_id,event_type,message)
            VALUES($1,'account.signin_linked','An additional sign-in method was linked to your account. Other sessions were signed out. Review your account security if you did not request this change.')`,
            [input.userId],
          );
          return { token: token.token };
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
