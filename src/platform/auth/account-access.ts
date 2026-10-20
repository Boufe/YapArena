import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import {
  AccountOperationError,
  type AccountOperationCredential,
} from "./account-operations.ts";
import { createSessionToken } from "./session-tokens.ts";
import {
  insertSession,
  lockAccount,
  revokeAccountSessions,
} from "./sessions.ts";
import { verifyPassword } from "./passwords.ts";
import { verifyChallengeSignature } from "./siwe.ts";
import { ProviderUnavailableError, type IdentityVerifier } from "./privy.ts";
import {
  verifiedStoredCredentials,
  type ProviderCredential,
} from "./provider-credentials.ts";

type AccessChallenge = {
  id: string;
  userId: string | null;
  authGeneration: string | null;
  purpose: "security.login" | "provider.credentials.reconcile";
  nonce: string;
  providerSubject: string | null;
  providerSessionDigest: string | null;
  oldCredentialsDigest: string | null;
  newCredentialsDigest: string | null;
  newCredentialsSnapshot: ProviderCredential[] | null;
  credentialType: "passkey" | "wallet" | "password";
  authorizingPasskeyIds: string[];
  authorizingWalletId: string | null;
  authorizingAddress: string | null;
  authorizingChainId: string | null;
  authorizationMessage: string | null;
  createdAt: Date;
  expiresAt: Date;
};
const columns = `id,user_id AS "userId",auth_generation AS "authGeneration",purpose,nonce,
  provider_subject AS "providerSubject",provider_session_digest AS "providerSessionDigest",
  old_credentials_digest AS "oldCredentialsDigest",new_credentials_digest AS "newCredentialsDigest",
  new_credentials_snapshot AS "newCredentialsSnapshot",credential_type AS "credentialType",
  authorizing_passkey_ids AS "authorizingPasskeyIds",authorizing_wallet_id AS "authorizingWalletId",
  authorizing_address AS "authorizingAddress",authorizing_chain_id AS "authorizingChainId",
  authorization_message AS "authorizationMessage",created_at AS "createdAt",expires_at AS "expiresAt"`;
function unavailable(): never {
  throw new AccountOperationError(
    410,
    "This verification expired or account access changed. Start again.",
  );
}
function sessionDigest(sessionId: string) {
  return createHash("sha256").update(sessionId).digest("hex");
}
export async function deleteExpiredAccessChallenges(database: Pool) {
  return (
    (
      await database.query(
        "DELETE FROM account_access_challenges WHERE expires_at<clock_timestamp()-interval '1 day'",
      )
    ).rowCount ?? 0
  );
}
async function issueClock(client: PoolClient) {
  const createdAt = (
    await client.query<{ createdAt: Date }>(
      `SELECT date_trunc('milliseconds',clock_timestamp()) AS "createdAt"`,
    )
  ).rows[0]!.createdAt;
  return { createdAt, expiresAt: new Date(createdAt.getTime() + 300000) };
}

// No app cookie exists until an independently retained credential has verified
// this exact one-use challenge. Provider JWTs identify a DID and SID only.
export function createAccountAccessRepository(
  database: Pool,
  verifier: Pick<IdentityVerifier, "verify" | "inspect">,
  {
    authorizeAttempt = async () => {},
  }: {
    authorizeAttempt?: (
      userId: string,
      purpose: AccessChallenge["purpose"],
    ) => Promise<void>;
  } = {},
) {
  async function verified(token: string) {
    try {
      return await verifier.verify(token);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new AccountOperationError(
        401,
        "Verify your provider sign-in before continuing.",
      );
    }
  }
  async function mapping(client: PoolClient, subject: string) {
    const result = (
      await client.query<{
        userId: string | null;
        credentialsDigest: string;
        credentialsSnapshot: ProviderCredential[] | null;
        email: string | null;
        methods: string[];
      }>(
        `SELECT user_id AS "userId",credentials_digest AS "credentialsDigest",credentials_snapshot AS "credentialsSnapshot",email,methods
      FROM provider_identities WHERE provider='privy' AND subject=$1`,
        [subject],
      )
    ).rows[0];
    if (!result?.userId)
      throw new AccountOperationError(
        409,
        "Account ownership review is required. No accounts were merged.",
      );
    const oldCredentials = verifiedStoredCredentials(result);
    if (!oldCredentials)
      throw new AccountOperationError(
        409,
        "The earlier sign-in methods need ownership review before changes can be accepted.",
      );
    return { ...result, userId: result.userId, oldCredentials };
  }
  async function choices(client: PoolClient, userId: string) {
    const passkeys = (
      await client.query<{ id: string; credentialId: string; createdAt: Date }>(
        `SELECT id,credential_id AS "credentialId",created_at AS "createdAt" FROM account_security_keys
        WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at,id`,
        [userId],
      )
    ).rows;
    const wallets = (
      await client.query<{ id: string; address: string; chainId: string }>(
        `SELECT id,address,chain_id AS "chainId" FROM wallet_identities WHERE user_id=$1 ORDER BY created_at,id`,
        [userId],
      )
    ).rows;
    return { passkeys, wallets };
  }
  async function loadChallenge(
    id: string,
    purpose: AccessChallenge["purpose"],
  ) {
    const row = (
      await database.query<AccessChallenge>(
        `SELECT ${columns} FROM account_access_challenges WHERE id=$1 AND purpose=$2
        AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
        [id, purpose],
      )
    ).rows[0];
    if (!row) unavailable();
    return row;
  }
  async function lockChallenge(client: PoolClient, challenge: AccessChallenge) {
    const row = await client.query(
      `SELECT id FROM account_access_challenges
      WHERE id=$1 AND nonce=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
      [challenge.id, challenge.nonce],
    );
    if (!row.rowCount) unavailable();
  }
  async function consume(client: PoolClient, challenge: AccessChallenge) {
    const result = await client.query(
      `UPDATE account_access_challenges SET consumed_at=clock_timestamp()
      WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
      [challenge.id],
    );
    if (!result.rowCount) unavailable();
  }
  async function passkey(
    client: PoolClient,
    userId: string,
    challenge: AccessChallenge,
    authentication: AuthenticationResponseJSON | undefined,
    origin: string,
  ) {
    if (!authentication)
      throw new AccountOperationError(
        401,
        "Security passkey verification is required.",
      );
    const key = (
      await client.query<{
        id: string;
        credentialId: string;
        publicKey: Buffer;
        counter: string;
        deviceType: "singleDevice" | "multiDevice";
        userHandle: string;
      }>(
        `SELECT k.id,k.credential_id AS "credentialId",k.public_key AS "publicKey",k.counter,
      k.device_type AS "deviceType",u.user_handle AS "userHandle" FROM account_security_keys k
      JOIN account_security_users u ON u.user_id=k.user_id
      WHERE k.user_id=$1 AND k.credential_id=$2 AND k.revoked_at IS NULL FOR UPDATE OF k`,
        [userId, authentication.id],
      )
    ).rows[0];
    if (
      !key ||
      (challenge.purpose !== "security.login" &&
        !challenge.authorizingPasskeyIds.includes(key.id))
    )
      throw new AccountOperationError(
        401,
        "Security passkey verification failed.",
      );
    try {
      if (
        (challenge.purpose === "security.login" &&
          authentication.response.userHandle !== key.userHandle) ||
        (authentication.response.userHandle &&
          authentication.response.userHandle !== key.userHandle)
      )
        throw new Error("user handle mismatch");
      const result = await verifyAuthenticationResponse({
        response: authentication,
        expectedChallenge: Buffer.from(challenge.nonce, "hex").toString(
          "base64url",
        ),
        expectedOrigin: new URL(origin).origin,
        expectedRPID: new URL(origin).hostname,
        requireUserVerification: true,
        credential: {
          id: key.credentialId,
          publicKey: new Uint8Array(key.publicKey),
          counter: Number(key.counter),
        },
      });
      if (
        !result.verified ||
        result.authenticationInfo.credentialDeviceType !== key.deviceType
      )
        throw new Error("invalid assertion");
      await client.query(
        "UPDATE account_security_keys SET counter=$2,backed_up=$3 WHERE id=$1",
        [
          key.id,
          result.authenticationInfo.newCounter,
          result.authenticationInfo.credentialBackedUp,
        ],
      );
    } catch {
      throw new AccountOperationError(
        401,
        "Security passkey verification failed.",
      );
    }
  }
  async function newSession(
    client: PoolClient,
    userId: string,
    sessionDurationMs: number,
  ) {
    const account = await lockAccount(client, userId);
    if (!account) unavailable();
    const token = createSessionToken();
    await insertSession(
      client,
      userId,
      token.tokenHash,
      new Date(Date.now() + sessionDurationMs),
      account.authGeneration,
    );
    return token.token;
  }
  return Object.freeze({
    async loginOptions(input: { origin: string }) {
      const client = await database.connect();
      try {
        const { createdAt, expiresAt } = await issueClock(client),
          id = randomUUID(),
          nonce = randomBytes(32).toString("hex");
        await client.query(
          `INSERT INTO account_access_challenges(id,purpose,nonce,credential_type,created_at,expires_at)
          VALUES($1,'security.login',$2,'passkey',$3,$4)`,
          [id, nonce, createdAt, expiresAt],
        );
        return {
          id,
          expiresAt,
          authenticationOptions: await generateAuthenticationOptions({
            rpID: new URL(input.origin).hostname,
            challenge: Buffer.from(nonce, "hex"),
            userVerification: "required",
            timeout: 300000,
          }),
        };
      } finally {
        client.release();
      }
    },
    async login(input: {
      id: string;
      authentication: AuthenticationResponseJSON;
      origin: string;
      sessionDurationMs: number;
    }) {
      const challenge = await loadChallenge(input.id, "security.login");
      const found = (
        await database.query<{ userId: string }>(
          `SELECT k.user_id AS "userId" FROM account_security_keys k
        JOIN account_security_users s ON s.user_id=k.user_id WHERE k.credential_id=$1 AND s.user_handle=$2 AND k.revoked_at IS NULL`,
          [
            input.authentication.id,
            input.authentication.response.userHandle ?? "",
          ],
        )
      ).rows[0];
      if (!found)
        throw new AccountOperationError(
          401,
          "Security passkey verification failed.",
        );
      await authorizeAttempt(found.userId, "security.login");
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        if (!(await lockAccount(client, found.userId))) unavailable();
        await lockChallenge(client, challenge);
        const unchangedGeneration = await client.query(
          `SELECT id FROM users WHERE id=$1 AND auth_changed_at<$2::timestamptz`,
          [found.userId, challenge.createdAt],
        );
        if (!unchangedGeneration.rowCount) unavailable();
        await passkey(
          client,
          found.userId,
          challenge,
          input.authentication,
          input.origin,
        );
        const provider = (
          await client.query<{ subject: string; digest: string }>(
            `SELECT subject,credentials_digest AS digest FROM provider_identities WHERE user_id=$1`,
            [found.userId],
          )
        ).rows[0];
        if (provider) {
          const current = await verifier.inspect(provider.subject);
          if (
            current.subject !== provider.subject ||
            current.credentialsDigest !== provider.digest
          ) {
            await revokeAccountSessions(client, found.userId, {
              action: "sessions.incident",
            });
            await consume(client, challenge);
            await client.query("COMMIT");
            throw new AccountOperationError(
              403,
              "Sign-in methods changed. Verify your provider sign-in and review the changes with your retained security credential.",
            );
          }
        }
        const token = await newSession(
          client,
          found.userId,
          input.sessionDurationMs,
        );
        await consume(client, challenge);
        await client.query(
          `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
          VALUES($1,'security.passkey.login',$2,'{"outcome":"success"}'::jsonb)`,
          [found.userId, challenge.id],
        );
        await client.query("COMMIT");
        return { token };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async reconciliationCandidate(token: string) {
      const identity = await verified(token),
        client = await database.connect();
      try {
        const mapped = await mapping(client, identity.subject),
          account = (
            await client.query<{ legacyPassword: boolean }>(
              "SELECT password_hash IS NOT NULL AS \"legacyPassword\" FROM users WHERE id=$1 AND account_status='active'",
              [mapped.userId],
            )
          ).rows[0];
        if (!account || !identity.credentials) unavailable();
        const retained = await choices(client, mapped.userId);
        return {
          before: mapped.oldCredentials,
          after: identity.credentials,
          legacyPassword: account.legacyPassword,
          passkeys: retained.passkeys.map(({ id, createdAt }) => ({
            id,
            createdAt,
          })),
          wallets: retained.wallets,
        };
      } finally {
        client.release();
      }
    },
    async reconciliationOptions(input: {
      token: string;
      credential: AccountOperationCredential;
      origin: string;
    }) {
      const identity = await verified(input.token),
        client = await database.connect();
      try {
        await client.query("BEGIN");
        const mapped = await mapping(client, identity.subject),
          account = await lockAccount(client, mapped.userId);
        if (!account || !identity.credentials) unavailable();
        const retained = await choices(client, mapped.userId),
          { createdAt, expiresAt } = await issueClock(client),
          id = randomUUID(),
          nonce = randomBytes(32).toString("hex");
        const selected = input.credential;
        const key =
          selected.type === "passkey"
            ? retained.passkeys.find((k) => k.id === selected.keyId)
            : undefined;
        const wallet =
          selected.type === "wallet"
            ? retained.wallets.find((w) => w.id === selected.walletId)
            : undefined;
        if (
          (input.credential.type === "passkey" && !key) ||
          (input.credential.type === "wallet" && !wallet) ||
          (input.credential.type === "password" && !account.passwordHash)
        )
          throw new AccountOperationError(
            403,
            "Use a retained trusted credential. If none is available, ownership review is required.",
          );
        const site = new URL(input.origin);
        const message = wallet
          ? createSiweMessage({
              address: getAddress(wallet.address),
              chainId: Number(wallet.chainId),
              domain: site.host,
              uri: site.origin,
              scheme: site.protocol.slice(0, -1),
              version: "1",
              nonce,
              issuedAt: createdAt,
              expirationTime: expiresAt,
              requestId: id,
              statement: `Restore YAP Arena account ${mapped.userId} access and accept these exact sign-in changes. Before: ${JSON.stringify(mapped.oldCredentials)}. After: ${JSON.stringify(identity.credentials)}. This does not authorize a blockchain transaction.`,
              resources: [
                `urn:yaparena:provider-credentials:${identity.credentialsDigest}`,
              ],
            })
          : null;
        await client.query(
          `INSERT INTO account_access_challenges(id,user_id,auth_generation,purpose,nonce,provider_subject,provider_session_digest,
          old_credentials_digest,new_credentials_digest,new_credentials_snapshot,credential_type,authorizing_passkey_ids,
          authorizing_wallet_id,authorizing_address,authorizing_chain_id,authorization_message,created_at,expires_at)
          VALUES($1,$2,$3,'provider.credentials.reconcile',$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            id,
            mapped.userId,
            account.authGeneration,
            nonce,
            identity.subject,
            sessionDigest(identity.sessionId),
            mapped.credentialsDigest,
            identity.credentialsDigest,
            JSON.stringify(identity.credentials),
            input.credential.type,
            key ? [key.id] : [],
            wallet?.id ?? null,
            wallet?.address ?? null,
            wallet?.chainId ?? null,
            message,
            createdAt,
            expiresAt,
          ],
        );
        await client.query("COMMIT");
        return {
          id,
          expiresAt,
          before: mapped.oldCredentials,
          after: identity.credentials,
          authorizationMessage: message,
          authenticationOptions: key
            ? await generateAuthenticationOptions({
                rpID: site.hostname,
                challenge: Buffer.from(nonce, "hex"),
                allowCredentials: [{ id: key.credentialId }],
                userVerification: "required",
                timeout: 300000,
              })
            : undefined,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async reconcile(input: {
      id: string;
      token: string;
      origin: string;
      password?: string;
      signature?: string;
      authentication?: AuthenticationResponseJSON;
      rpcUrls: Readonly<Record<string, string>>;
      sessionDurationMs: number;
    }) {
      const challenge = await loadChallenge(
          input.id,
          "provider.credentials.reconcile",
        ),
        identity = await verified(input.token);
      if (
        identity.subject !== challenge.providerSubject ||
        sessionDigest(identity.sessionId) !== challenge.providerSessionDigest ||
        identity.credentialsDigest !== challenge.newCredentialsDigest ||
        !identity.credentials
      )
        unavailable();
      await authorizeAttempt(
        challenge.userId!,
        "provider.credentials.reconcile",
      );
      if (
        challenge.credentialType === "wallet" &&
        (!input.signature ||
          !(await verifyChallengeSignature({
            challenge: {
              address: challenge.authorizingAddress!,
              chainId: challenge.authorizingChainId!,
              message: challenge.authorizationMessage!,
              expiresAt: challenge.expiresAt,
            },
            signature: input.signature,
            origin: input.origin,
            rpcUrls: input.rpcUrls,
          })))
      )
        throw new AccountOperationError(
          401,
          "Linked wallet verification failed.",
        );
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`privy:${identity.subject}`],
        );
        const account = await lockAccount(client, challenge.userId!);
        if (!account || account.authGeneration !== challenge.authGeneration)
          unavailable();
        await lockChallenge(client, challenge);
        const mapped = await mapping(client, identity.subject);
        if (
          mapped.userId !== challenge.userId ||
          mapped.credentialsDigest !== challenge.oldCredentialsDigest
        )
          unavailable();
        if (challenge.credentialType === "passkey")
          await passkey(
            client,
            mapped.userId,
            challenge,
            input.authentication,
            input.origin,
          );
        else if (challenge.credentialType === "password") {
          if (
            !account.passwordHash ||
            !input.password ||
            !(await verifyPassword(account.passwordHash, input.password))
          )
            throw new AccountOperationError(
              401,
              "Current password is incorrect.",
            );
        } else {
          const retained = await client.query(
            "SELECT id FROM wallet_identities WHERE id=$1 AND user_id=$2 AND address=$3 AND chain_id=$4",
            [
              challenge.authorizingWalletId,
              mapped.userId,
              challenge.authorizingAddress,
              challenge.authorizingChainId,
            ],
          );
          if (!retained.rowCount) unavailable();
        }
        const current = await verifier.inspect(identity.subject);
        if (
          current.subject !== identity.subject ||
          current.credentialsDigest !== challenge.newCredentialsDigest
        )
          unavailable();
        await client.query(
          `UPDATE provider_identities SET credentials_digest=$2,credentials_snapshot=$3::jsonb,email=$4,methods=$5::jsonb WHERE provider='privy' AND subject=$1`,
          [
            identity.subject,
            identity.credentialsDigest,
            JSON.stringify(identity.credentials),
            identity.email,
            JSON.stringify(identity.methods),
          ],
        );
        // Existing consumed SIDs remain fenced. This exact strong proof may
        // restore one cookie for its own DID/SID, never an ordinary exchange.
        await client.query(
          `INSERT INTO provider_session_exchanges(provider,subject,session_digest,user_id) VALUES('privy',$1,$2,$3) ON CONFLICT DO NOTHING`,
          [identity.subject, challenge.providerSessionDigest, mapped.userId],
        );
        const sid = await client.query(
          "SELECT 1 FROM provider_session_exchanges WHERE provider='privy' AND subject=$1 AND session_digest=$2 AND user_id=$3",
          [identity.subject, challenge.providerSessionDigest, mapped.userId],
        );
        if (!sid.rowCount) unavailable();
        await revokeAccountSessions(client, mapped.userId, {
          action: "sessions.incident",
        });
        const token = await newSession(
          client,
          mapped.userId,
          input.sessionDurationMs,
        );
        await consume(client, challenge);
        await client.query(
          `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'provider.credentials.reconciled',$2,$3::jsonb)`,
          [
            mapped.userId,
            challenge.id,
            JSON.stringify({
              outcome: "success",
              credentialType: challenge.credentialType,
              oldDigest: challenge.oldCredentialsDigest,
              newDigest: challenge.newCredentialsDigest,
            }),
          ],
        );
        await client.query(
          `INSERT INTO account_notifications(user_id,event_type,message) VALUES($1,'account.signin_changed','Sign-in methods were changed after verification with a retained security credential. Other sessions were signed out. Review account security if you did not request this change.')`,
          [mapped.userId],
        );
        await client.query("COMMIT");
        return { token };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteExpiredChallenges() {
      return deleteExpiredAccessChallenges(database);
    },
  });
}
