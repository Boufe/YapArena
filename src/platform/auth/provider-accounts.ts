import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ProviderIdentity } from "./privy.ts";
import { passkeyActivationPending } from "./provider-passkeys.ts";
import { recordProviderCredentials } from "./provider-methods.ts";
import { enqueueEmbeddedWalletProvisioning } from "./embedded-wallet-provisioning.ts";
import {
  insertSession,
  lockAccount,
  SessionUnavailableError,
} from "./sessions.ts";
import type { AuthenticationUser } from "./users.ts";
import {
  verifiedStoredCredentials,
  type ProviderCredential,
} from "./provider-credentials.ts";

export type ProviderAccountErrorCode =
  | "provider_identity_retired"
  | "provider_reset_pending"
  | "provider_reset_review_required"
  | "provider_access_review_required"
  | "provider_session_revoked"
  | "provider_signin_paused";

export class ProviderAccountError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code?: ProviderAccountErrorCode,
  ) {
    super(message);
  }
}

export function createProviderAccounts(database: Pool) {
  return {
    async exchange(
      identity: ProviderIdentity,
      tokenHash: string,
      expiresAt: Date,
    ) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        // Serialize callbacks before account creation; never acquire an existing
        // account lock while holding a wallet-identity advisory lock.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`privy:${identity.subject}`],
        );
        const controls = await client.query<{ enabled: boolean }>(
          "SELECT signup_enabled AS enabled FROM auth_controls WHERE singleton",
        );
        if (!controls.rows[0]?.enabled)
          throw new ProviderAccountError(
            "sign-in is paused for maintenance",
            503,
            "provider_signin_paused",
          );
        const mapped = await client.query<{
          userId: string | null;
          generation: string;
          minimumIssuedAt: string;
          credentialsDigest: string;
        }>(
          `SELECT user_id AS "userId",auth_generation AS generation,minimum_issued_at AS "minimumIssuedAt",credentials_digest AS "credentialsDigest" FROM provider_identities WHERE provider='privy' AND subject=$1`,
          [identity.subject],
        );
        let user: AuthenticationUser;
        let created = false;
        if (mapped.rows[0]) {
          if (!mapped.rows[0].userId)
            throw new ProviderAccountError(
              "this previous identity requires new ownership verification",
              403,
              "provider_identity_retired",
            );
          const account = await lockAccount(client, mapped.rows[0].userId);
          if (!account)
            throw new SessionUnavailableError("account unavailable");
          // A new iat or unrecognized sid is not fresh authentication. Do not let
          // any surviving provider session cross a local revocation boundary.
          if (account.authGeneration !== mapped.rows[0].generation) {
            // A delayed/uncertain provider reset is not a credential delta.
            // Inspect only this identity's current local revocation boundary;
            // an unrelated or retired identity's job conveys no authority.
            const job = (
              await client.query<{ state: string }>(
                `SELECT state FROM provider_revocation_jobs
                 WHERE user_id=$1 AND subject=$2 AND generation=$3`,
                [account.id, identity.subject, account.authGeneration],
              )
            ).rows[0];
            if (job?.state === "pending" || job?.state === "running")
              throw new ProviderAccountError(
                "previous provider sessions are still being reset; try a new sign-in shortly",
                503,
                "provider_reset_pending",
              );
            if (job?.state === "manual")
              throw new ProviderAccountError(
                "previous provider sessions could not be safely reset; operator review is required before sign-in",
                403,
                "provider_reset_review_required",
              );
            throw new ProviderAccountError(
              "account access changed; ownership verification is required",
              403,
              "provider_access_review_required",
            );
          }
          if (identity.issuedAt < Number(mapped.rows[0].minimumIssuedAt))
            throw new ProviderAccountError(
              "authenticate again after the provider session reset",
              401,
              "provider_session_revoked",
            );
          // Record a method change, unless it is the passkey that this
          // account is activating right now; activation records that itself.
          if (
            mapped.rows[0].credentialsDigest !== identity.credentialsDigest &&
            !(await passkeyActivationPending(client, {
              userId: account.id,
              authGeneration: account.authGeneration,
              subject: identity.subject,
              beforeDigest: mapped.rows[0].credentialsDigest,
              current: identity,
            }))
          )
            await recordProviderCredentials(client, {
              userId: account.id,
              subject: identity.subject,
              previousDigest: mapped.rows[0].credentialsDigest,
              identity,
              source: "exchange",
            });
          user = account;
        } else {
          const account = await client.query<AuthenticationUser>(
            `INSERT INTO users DEFAULT VALUES RETURNING id,email,created_at AS "createdAt",auth_generation AS "authGeneration"`,
          );
          user = account.rows[0]!;
          await client.query(
            `INSERT INTO provider_identities(provider,subject,user_id,email,methods,auth_generation,credentials_digest,credentials_snapshot)
            VALUES('privy',$1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)`,
            [
              identity.subject,
              user.id,
              identity.email,
              JSON.stringify(identity.methods),
              user.authGeneration,
              identity.credentialsDigest,
              identity.credentials
                ? JSON.stringify(identity.credentials)
                : null,
            ],
          );
          created = true;
        }
        const consumed = await client.query(
          `INSERT INTO provider_session_exchanges(provider,subject,session_digest,user_id)
          VALUES('privy',$1,$2,$3) ON CONFLICT DO NOTHING RETURNING session_digest`,
          [
            identity.subject,
            createHash("sha256").update(identity.sessionId).digest("hex"),
            user.id,
          ],
        );
        if (!consumed.rowCount)
          throw new ProviderAccountError(
            "this sign-in session has already been used; authenticate again",
            401,
            "provider_session_revoked",
          );
        // This exchange is a fresh Privy read. A deferred method change
        // (a passkey being activated) keeps its stored methods until then.
        await client.query(
          `UPDATE provider_identities SET checked_at=clock_timestamp(),
            email=CASE WHEN credentials_digest=$5 THEN $2 ELSE email END,
            methods=CASE WHEN credentials_digest=$5 THEN $3::jsonb ELSE methods END,
            credentials_snapshot=CASE WHEN credentials_digest=$5
              THEN COALESCE($4::jsonb,credentials_snapshot) ELSE credentials_snapshot END
          WHERE provider='privy' AND subject=$1`,
          [
            identity.subject,
            identity.email,
            JSON.stringify(identity.methods),
            identity.credentials ? JSON.stringify(identity.credentials) : null,
            identity.credentialsDigest,
          ],
        );
        await insertSession(
          client,
          user.id,
          tokenHash,
          expiresAt,
          user.authGeneration,
        );
        // Persist the user-owned wallet intent with the verified account. The
        // provider call runs separately and cannot delay signup or its return.
        await enqueueEmbeddedWalletProvisioning(
          client,
          user.id,
          identity.subject,
          identity.credentialsDigest,
        );
        await client.query("COMMIT");
        return { user, created };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async details(userId: string) {
      const result = await database.query<{
        subject: string;
        email: string | null;
        methods: string[];
        credentialsDigest: string;
        credentialsSnapshot: ProviderCredential[] | null;
      }>(
        `SELECT subject,email,methods,credentials_digest AS "credentialsDigest",credentials_snapshot AS "credentialsSnapshot" FROM provider_identities WHERE user_id=$1`,
        [userId],
      );
      const mapping = result.rows[0];
      return mapping
        ? {
            subject: mapping.subject,
            email: mapping.email,
            methods: mapping.methods,
            credentials: verifiedStoredCredentials(mapping),
          }
        : null;
    },
  };
}
