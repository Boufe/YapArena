import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  AccountOperationError,
  accountOperationTermsDigest,
  type createAccountOperationRepository,
} from "./account-operations.ts";
import { assertActiveSession, insertSession, lockAccount } from "./sessions.ts";
import { createSessionToken } from "./session-tokens.ts";

type PreparedApproval = Awaited<
  ReturnType<ReturnType<typeof createAccountOperationRepository>["prepare"]>
>;
type Challenge = {
  id: string;
  userId: string;
  sessionTokenHash: string;
  authGeneration: string;
  challenge: string;
  userHandle: string;
  expiresAt: Date;
};

async function bootstrapAllowed(client: PoolClient, userId: string) {
  // Every authorized financial issuer must take the shared account lock before
  // posting or creating grant lots. Auth runtime keeps read-only ledger access.
  const result = await client.query<{ allowed: boolean }>(
    `SELECT u.password_hash IS NULL
      AND EXISTS(SELECT 1 FROM provider_identities p WHERE p.user_id=u.id AND p.methods ? 'email')
      AND NOT EXISTS(SELECT 1 FROM wallet_identities w WHERE w.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM account_security_keys k WHERE k.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM coin_accounts a WHERE a.user_id=u.id AND
        (a.balance<>0 OR EXISTS(SELECT 1 FROM coin_postings p WHERE p.account_id=a.id)))
      AND NOT EXISTS(SELECT 1 FROM coin_grant_lots g WHERE g.user_id=u.id) AS allowed
     FROM users u WHERE u.id=$1`,
    [userId],
  );
  return result.rows[0]?.allowed === true;
}

function assertApproval(
  approval: PreparedApproval,
  purpose: string,
  terms: Record<string, string>,
) {
  if (
    approval.purpose !== purpose ||
    approval.termsDigest !== accountOperationTermsDigest(terms)
  )
    throw new AccountOperationError(
      403,
      "approval does not authorize this change",
    );
}

async function rotateSession(
  client: PoolClient,
  userId: string,
  durationMs: number,
) {
  const account = await lockAccount(client, userId);
  if (!account) throw new AccountOperationError(401, "account unavailable");
  const token = createSessionToken();
  await insertSession(
    client,
    userId,
    token.tokenHash,
    new Date(Date.now() + durationMs),
    account.authGeneration,
  );
  return token.token;
}

// These passkeys authorize YapArena operations directly. Privy login passkeys
// and wallet MFA remain separate provider credentials.
export function createSecurityPasskeyRepository(database: Pool) {
  return Object.freeze({
    async list(userId: string) {
      return (
        await database.query<{
          id: string;
          createdAt: Date;
          deviceType: "singleDevice" | "multiDevice";
          backedUp: boolean;
        }>(
          `SELECT id,created_at AS "createdAt",device_type AS "deviceType",backed_up AS "backedUp"
           FROM account_security_keys WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at,id`,
          [userId],
        )
      ).rows;
    },

    async enrollmentOptions(input: {
      userId: string;
      sessionTokenHash: string;
      origin: string;
    }) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const account = await lockAccount(client, input.userId);
        if (!account)
          throw new AccountOperationError(401, "authentication required");
        await assertActiveSession(client, input.userId, input.sessionTokenHash);
        await client.query(
          "INSERT INTO account_security_users(user_id,user_handle) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
          [input.userId, randomBytes(32).toString("base64url")],
        );
        const userHandle = (
          await client.query<{ userHandle: string }>(
            `SELECT user_handle AS "userHandle" FROM account_security_users WHERE user_id=$1`,
            [input.userId],
          )
        ).rows[0]!.userHandle;
        const keys = await client.query<{ credentialId: string }>(
          `SELECT credential_id AS "credentialId" FROM account_security_keys WHERE user_id=$1`,
          [input.userId],
        );
        const mayBootstrap = await bootstrapAllowed(client, input.userId);
        const options = await generateRegistrationOptions({
          rpName: "YapArena security",
          rpID: new URL(input.origin).hostname,
          userID: Buffer.from(userHandle, "base64url"),
          userName: "YapArena account",
          userDisplayName: "YapArena security passkey",
          attestationType: "none",
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
          excludeCredentials: keys.rows.map((key) => ({
            id: key.credentialId,
          })),
          timeout: 300_000,
        });
        const id = randomUUID();
        const issuedAt = (
          await client.query<{ issuedAt: Date }>(
            `SELECT date_trunc('milliseconds',clock_timestamp()) AS "issuedAt"`,
          )
        ).rows[0]!.issuedAt;
        const expiresAt = new Date(issuedAt.getTime() + 300_000);
        await client.query(
          `INSERT INTO account_security_challenges(id,user_id,session_token_hash,auth_generation,
           challenge,user_handle,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            input.userId,
            input.sessionTokenHash,
            account.authGeneration,
            options.challenge,
            userHandle,
            issuedAt,
            expiresAt,
          ],
        );
        await client.query("COMMIT");
        return { id, options, expiresAt, bootstrapAllowed: mayBootstrap };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async completeEnrollment(input: {
      id: string;
      userId: string;
      sessionTokenHash: string;
      origin: string;
      response: RegistrationResponseJSON;
      sessionDurationMs: number;
      approval?: PreparedApproval;
    }) {
      if (input.approval) {
        input.approval.assertContext(input.userId, input.sessionTokenHash);
        assertApproval(input.approval, "security.passkey.enroll", {
          challengeId: input.id,
        });
      }
      const challenge = (
        await database.query<Challenge>(
          `SELECT id,user_id AS "userId",session_token_hash AS "sessionTokenHash",
           auth_generation AS "authGeneration",challenge,user_handle AS "userHandle",expires_at AS "expiresAt"
         FROM account_security_challenges WHERE id=$1 AND user_id=$2 AND session_token_hash=$3
           AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [input.id, input.userId, input.sessionTokenHash],
        )
      ).rows[0];
      if (!challenge)
        throw new AccountOperationError(
          410,
          "enrollment expired or invalid; start again",
        );
      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: new URL(input.origin).origin,
        expectedRPID: new URL(input.origin).hostname,
        requireUserVerification: true,
      }).catch(() => {
        throw new AccountOperationError(
          401,
          "security passkey enrollment is invalid",
        );
      });
      if (!verification.verified || !verification.registrationInfo)
        throw new AccountOperationError(
          401,
          "security passkey enrollment is invalid",
        );
      const registration = verification.registrationInfo;
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const mutation = async () => {
          const account = await lockAccount(client, input.userId);
          if (!account || account.authGeneration !== challenge.authGeneration)
            throw new AccountOperationError(
              410,
              "enrollment expired or invalid; start again",
            );
          await assertActiveSession(
            client,
            input.userId,
            input.sessionTokenHash,
          );
          if (
            !input.approval &&
            !(await bootstrapAllowed(client, input.userId))
          )
            throw new AccountOperationError(
              403,
              "an existing trusted credential must approve this security passkey",
            );
          const consumed = await client.query(
            `UPDATE account_security_challenges SET consumed_at=clock_timestamp()
             WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
            [input.id],
          );
          if (!consumed.rowCount)
            throw new AccountOperationError(
              410,
              "enrollment expired or invalid; start again",
            );
          const keyId = randomUUID();
          await client.query(
            `INSERT INTO account_security_keys(id,user_id,credential_id,public_key,counter,device_type,backed_up,transports)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              keyId,
              input.userId,
              registration.credential.id,
              Buffer.from(registration.credential.publicKey),
              registration.credential.counter,
              registration.credentialDeviceType,
              registration.credentialBackedUp,
              registration.credential.transports ?? [],
            ],
          );
          const token = await rotateSession(
            client,
            input.userId,
            input.sessionDurationMs,
          );
          if (!input.approval)
            await client.query(
              `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
               VALUES($1,'security.passkey.bootstrap',$2,'{"outcome":"success","scope":"before-funds"}'::jsonb)`,
              [input.userId, keyId],
            );
          await client.query(
            `INSERT INTO account_notifications(user_id,event_type,message)
             VALUES($1,'security.passkey.enrolled','A security passkey was added. Other application sessions were signed out. Review your account security if you did not request this change.')`,
            [input.userId],
          );
          return { keyId, token };
        };
        const result = input.approval
          ? await input.approval.consume(client, mutation)
          : await mutation();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async remove(input: {
      keyId: string;
      userId: string;
      sessionTokenHash: string;
      sessionDurationMs: number;
      approval: PreparedApproval;
    }) {
      input.approval.assertContext(input.userId, input.sessionTokenHash);
      assertApproval(input.approval, "security.passkey.remove", {
        keyId: input.keyId,
      });
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const token = await input.approval.consume(client, async () => {
          const removed = await client.query(
            "UPDATE account_security_keys SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id",
            [input.keyId, input.userId],
          );
          if (!removed.rowCount)
            throw new AccountOperationError(
              404,
              "security passkey unavailable",
            );
          await client.query(
            `INSERT INTO account_notifications(user_id,event_type,message)
               VALUES($1,'security.passkey.revoked','A security passkey was removed. Other application sessions were signed out. Review your account security if you did not request this change.')`,
            [input.userId],
          );
          return rotateSession(client, input.userId, input.sessionDurationMs);
        });
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
      const result = await database.query(
        "DELETE FROM account_security_challenges WHERE expires_at<clock_timestamp()-interval '1 day'",
      );
      return result.rowCount ?? 0;
    },
  });
}
