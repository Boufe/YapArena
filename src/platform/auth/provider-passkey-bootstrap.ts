import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { AccountOperationError } from "./account-operations.ts";
import { ProviderAccountError } from "./provider-accounts.ts";
import {
  ProviderUnavailableError,
  type IdentityVerifier,
  type ProviderIdentity,
} from "./privy.ts";
import {
  providerCredentialsDigest,
  verifiedStoredCredentials,
  type ProviderCredential,
} from "./provider-credentials.ts";
import { inspectProviderPasskeyAddition } from "./provider-passkeys.ts";
import { insertSession, lockAccount } from "./sessions.ts";
import { createSessionToken } from "./session-tokens.ts";
import { firstProviderPasskeyBootstrapAllowed } from "./provider-passkey-policy.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class FirstPasskeyRestartError extends AccountOperationError {
  readonly code = "first_passkey_restart_unavailable";
  constructor() {
    super(
      410,
      "First passkey setup cannot be restarted here. Verify your retained sign-in method or request account review.",
    );
  }
}
function unavailable(): never {
  throw new FirstPasskeyRestartError();
}
type Mapping = {
  userId: string | null;
  subject: string;
  authGeneration: string;
  minimumIssuedAt: string;
  credentialsDigest: string;
  credentialsSnapshot: ProviderCredential[] | null;
  email: string | null;
  methods: string[];
};
type Original = {
  id: string;
  before: ProviderCredential[];
  candidateDigest: string | null;
  credentialId: string | null;
  publicKey: Buffer | null;
  publicKeyDigest: string | null;
};
type Bootstrap = {
  id: string;
  userId: string;
  originalIntentId: string;
  authGeneration: string;
  subject: string;
  sessionDigest: string;
  beforeDigest: string;
  afterDigest: string;
  credentialId: string;
  publicKey: Buffer;
  publicKeyDigest: string;
  origin: string;
  rpId: string;
  challenge: string;
  expiresAt: Date;
};
const columns = `id,user_id AS "userId",original_intent_id AS "originalIntentId",auth_generation AS "authGeneration",
 provider_subject AS subject,provider_session_digest AS "sessionDigest",before_digest AS "beforeDigest",after_digest AS "afterDigest",
 credential_id AS "credentialId",public_key AS "publicKey",public_key_digest AS "publicKeyDigest",origin,rp_id AS "rpId",challenge,expires_at AS "expiresAt"`;

// This narrowly restarts an unfinished FIRST key setup. It never promotes an
// email token into stronger financial authorization or reuses an expired proof.
export function createProviderPasskeyBootstrap(
  database: Pool,
  verifier: Pick<IdentityVerifier, "verify">,
  options: {
    authorizeAttempt: (
      userId: string,
      purpose: "provider.passkey.restart",
    ) => Promise<void>;
  },
) {
  async function verified(token: string) {
    if (!options || typeof options.authorizeAttempt !== "function")
      throw new AccountOperationError(
        503,
        "Passkey restart protection is unavailable.",
      );
    const identity = await verifier.verify(token).catch((error: unknown) => {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new AccountOperationError(
        401,
        "Verify your Privy sign-in before restarting passkey setup.",
      );
    });
    const row = (
      await database.query<{ userId: string | null }>(
        "SELECT user_id AS \"userId\" FROM provider_identities WHERE provider='privy' AND subject=$1",
        [identity.subject],
      )
    ).rows[0];
    if (!row?.userId)
      throw new ProviderAccountError(
        "Account ownership review is required.",
        403,
        "provider_identity_retired",
      );
    await options.authorizeAttempt(row.userId, "provider.passkey.restart");
    return { identity, userId: row.userId };
  }
  async function candidate(
    client: PoolClient,
    identity: ProviderIdentity,
    userId: string,
    origin: string,
  ) {
    const account = await lockAccount(client, userId);
    if (!account) unavailable();
    const mapped = (
      await client.query<Mapping>(
        `SELECT user_id AS "userId",subject,auth_generation AS "authGeneration",
      minimum_issued_at AS "minimumIssuedAt",credentials_digest AS "credentialsDigest",credentials_snapshot AS "credentialsSnapshot",email,methods
      FROM provider_identities WHERE provider='privy' AND subject=$1 FOR UPDATE`,
        [identity.subject],
      )
    ).rows[0];
    if (!mapped || mapped.userId !== userId) unavailable();
    const reset = (
      await client.query<{ state: string }>(
        "SELECT state FROM provider_revocation_jobs WHERE user_id=$1 AND subject=$2 AND state<>'complete' ORDER BY generation DESC LIMIT 1",
        [userId, identity.subject],
      )
    ).rows[0];
    if (reset || mapped.authGeneration !== account.authGeneration)
      throw new ProviderAccountError(
        "Provider session reset must finish before restarting passkey setup.",
        reset?.state === "pending" || reset?.state === "running" ? 503 : 403,
        reset?.state === "pending" || reset?.state === "running"
          ? "provider_reset_pending"
          : "provider_reset_review_required",
      );
    if (
      !Number.isSafeInteger(identity.issuedAt) ||
      identity.issuedAt < Number(mapped.minimumIssuedAt) ||
      (
        await client.query(
          "SELECT 1 FROM provider_session_exchanges WHERE provider='privy' AND session_digest=$1",
          [digest(identity.sessionId)],
        )
      ).rowCount
    )
      throw new ProviderAccountError(
        "Sign in with Privy again before restarting passkey setup.",
        401,
        "provider_session_revoked",
      );
    const allowed = await firstProviderPasskeyBootstrapAllowed(client, userId);
    const before = verifiedStoredCredentials(mapped);
    if (
      !allowed ||
      !before ||
      !before.length ||
      before.some((entry) => entry.type === "passkey")
    )
      unavailable();
    const addition = inspectProviderPasskeyAddition(before, identity);
    if (!addition) unavailable();
    const site = new URL(origin);
    const originals = (
      await client.query<Original>(
        `SELECT id,before_credentials AS before,candidate_digest AS "candidateDigest",
      candidate_credential_id AS "credentialId",candidate_public_key AS "publicKey",candidate_key_digest AS "publicKeyDigest"
      FROM provider_passkey_intents WHERE user_id=$1 AND provider_subject=$2 AND before_digest=$3 AND intent_mode='addition'
        AND consumed_at IS NULL AND origin=$4 AND rp_id=$5 ORDER BY created_at DESC,id`,
        [
          userId,
          identity.subject,
          mapped.credentialsDigest,
          site.origin,
          site.hostname,
        ],
      )
    ).rows;
    const original = originals.find(
      (row) =>
        providerCredentialsDigest(row.before) === mapped.credentialsDigest &&
        (row.candidateDigest === null ||
          (row.candidateDigest === identity.credentialsDigest &&
            row.credentialId === addition.credentialId &&
            row.publicKeyDigest === addition.publicKeyDigest &&
            row.publicKey?.equals(addition.publicKey))),
    );
    if (!original) unavailable();
    return {
      original,
      addition,
      account,
      mapped,
      before,
      origin: site.origin,
      rpId: site.hostname,
    };
  }
  async function transaction<T>(
    identity: ProviderIdentity,
    userId: string,
    origin: string,
    action: (
      client: PoolClient,
      value: Awaited<ReturnType<typeof candidate>>,
    ) => Promise<T>,
  ) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`privy:${identity.subject}`],
      );
      const result = await action(
        client,
        await candidate(client, identity, userId, origin),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({
    async candidate(input: { token: string; origin: string }) {
      const { identity, userId } = await verified(input.token);
      return transaction(identity, userId, input.origin, async () => ({
        code: "first_passkey_restart_available" as const,
      }));
    },
    async restart(input: { token: string; origin: string }) {
      const { identity, userId } = await verified(input.token);
      return transaction(
        identity,
        userId,
        input.origin,
        async (client, value) => {
          const challenge = randomBytes(32).toString("base64url"),
            id = randomUUID();
          const row = (
            await client.query<Bootstrap>(
              `WITH issued AS(SELECT clock_timestamp() AS at)
          INSERT INTO provider_passkey_bootstraps(id,user_id,original_intent_id,auth_generation,provider_subject,provider_session_digest,
            before_digest,after_digest,credential_id,public_key,public_key_digest,origin,rp_id,challenge,created_at,expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,at,at+interval '5 minutes' FROM issued RETURNING ${columns}`,
              [
                id,
                userId,
                value.original.id,
                value.account.authGeneration,
                identity.subject,
                digest(identity.sessionId),
                value.mapped.credentialsDigest,
                identity.credentialsDigest,
                value.addition.credentialId,
                value.addition.publicKey,
                value.addition.publicKeyDigest,
                value.origin,
                value.rpId,
                challenge,
              ],
            )
          ).rows[0];
          if (!row) unavailable();
          return {
            id,
            expiresAt: row.expiresAt,
            before: value.before,
            after: identity.credentials!,
            terms: {
              purpose: "provider.passkey.restart",
              originalIntentId: value.original.id,
              beforeDigest: row.beforeDigest,
              afterDigest: row.afterDigest,
            },
            authenticationOptions: await generateAuthenticationOptions({
              rpID: value.rpId,
              challenge: Buffer.from(challenge, "base64url"),
              allowCredentials: [{ id: value.addition.credentialId }],
              userVerification: "required",
              timeout: 300000,
            }),
          };
        },
      );
    },
    async complete(input: {
      id: string;
      token: string;
      origin: string;
      authentication: AuthenticationResponseJSON;
      sessionDurationMs: number;
    }) {
      const { identity, userId } = await verified(input.token);
      const snapshot = (
        await database.query<Bootstrap>(
          `SELECT ${columns} FROM provider_passkey_bootstraps WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [input.id, userId],
        )
      ).rows[0];
      if (
        !snapshot ||
        snapshot.subject !== identity.subject ||
        snapshot.sessionDigest !== digest(identity.sessionId) ||
        snapshot.afterDigest !== identity.credentialsDigest ||
        snapshot.origin !== new URL(input.origin).origin ||
        input.authentication.id !== snapshot.credentialId ||
        !Number.isSafeInteger(input.sessionDurationMs) ||
        input.sessionDurationMs <= 0
      )
        unavailable();
      const proof = await verifyAuthenticationResponse({
        response: input.authentication,
        expectedChallenge: snapshot.challenge,
        expectedOrigin: snapshot.origin,
        expectedRPID: snapshot.rpId,
        credential: {
          id: snapshot.credentialId,
          publicKey: new Uint8Array(snapshot.publicKey),
          counter: 0,
        },
        requireUserVerification: true,
      }).catch(() => {
        throw new AccountOperationError(
          401,
          "Verify the same Privy passkey to restart its setup.",
        );
      });
      if (!proof.verified || !proof.authenticationInfo.userVerified)
        unavailable();
      return transaction(
        identity,
        userId,
        input.origin,
        async (client, value) => {
          const current = (
            await client.query<Bootstrap>(
              `SELECT ${columns} FROM provider_passkey_bootstraps WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
              [input.id],
            )
          ).rows[0];
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(snapshot) ||
            value.account.authGeneration !== snapshot.authGeneration ||
            value.original.id !== snapshot.originalIntentId ||
            value.mapped.credentialsDigest !== snapshot.beforeDigest ||
            value.addition.credentialId !== snapshot.credentialId ||
            value.addition.publicKeyDigest !== snapshot.publicKeyDigest ||
            !value.addition.publicKey.equals(snapshot.publicKey)
          )
            unavailable();
          const consumed = await client.query(
            "UPDATE provider_passkey_bootstraps SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id",
            [input.id],
          );
          if (!consumed.rowCount) unavailable();
          await client.query(
            "INSERT INTO provider_session_exchanges(provider,subject,session_digest,user_id) VALUES('privy',$1,$2,$3)",
            [identity.subject, snapshot.sessionDigest, userId],
          );
          await client.query(
            "INSERT INTO account_security_users(user_id,user_handle) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
            [userId, randomBytes(32).toString("base64url")],
          );
          const keyId = randomUUID(),
            info = proof.authenticationInfo;
          await client.query(
            `INSERT INTO account_security_keys(id,user_id,credential_id,public_key,counter,device_type,backed_up,provenance,provider_subject,provider_public_key_digest,rp_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'privy',$8,$9,$10)`,
            [
              keyId,
              userId,
              snapshot.credentialId,
              snapshot.publicKey,
              info.newCounter,
              info.credentialDeviceType,
              info.credentialBackedUp,
              identity.subject,
              snapshot.publicKeyDigest,
              snapshot.rpId,
            ],
          );
          await client.query(
            "UPDATE provider_identities SET credentials_digest=$2,credentials_snapshot=$3::jsonb,email=$4,methods=$5::jsonb WHERE provider='privy' AND subject=$1 AND user_id=$6",
            [
              identity.subject,
              identity.credentialsDigest,
              JSON.stringify(identity.credentials),
              identity.email,
              JSON.stringify(identity.methods),
              userId,
            ],
          );
          const account = await lockAccount(client, userId);
          if (!account) unavailable();
          const token = createSessionToken();
          await insertSession(
            client,
            userId,
            token.tokenHash,
            new Date(Date.now() + input.sessionDurationMs),
            account.authGeneration,
          );
          await client.query(
            "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'provider.passkey.bootstrap_completed',$2,$3::jsonb)",
            [
              userId,
              keyId,
              JSON.stringify({
                outcome: "success",
                scope: "never-funded-first-key",
                originalIntentId: value.original.id,
                challengeId: input.id,
              }),
            ],
          );
          if (
            !(
              await client.query(
                "SELECT 1 FROM provider_passkey_bootstraps WHERE id=$1 AND expires_at>clock_timestamp()",
                [input.id],
              )
            ).rowCount
          )
            unavailable();
          return { keyId, token: token.token };
        },
      );
    },
  });
}
