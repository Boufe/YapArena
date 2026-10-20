import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { verifyPassword } from "./passwords.ts";
import { verifyChallengeSignature } from "./siwe.ts";
import { assertActiveSession, lockAccount } from "./sessions.ts";

export class AccountOperationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AccountOperationTerms = Readonly<Record<string, string>>;
export type AccountOperationCredential =
  | { type: "password" }
  | { type: "wallet"; walletId: string }
  | { type: "passkey"; keyId: string };

export interface AccountOperation {
  id: string;
  userId: string;
  sessionTokenHash: string;
  authGeneration: string;
  purpose: string;
  terms: Record<string, string>;
  termsDigest: string;
  nonce: string;
  credentialType: "password" | "wallet" | "passkey";
  authorizingPasskeyId: string | null;
  authorizingWalletId: string | null;
  authorizingAddress: string | null;
  authorizingChainId: string | null;
  authorizationMessage: string | null;
  expiresAt: Date;
  authenticationOptions?: PublicKeyCredentialRequestOptionsJSON;
}

const columns = `id,user_id AS "userId",session_token_hash AS "sessionTokenHash",
  auth_generation AS "authGeneration",purpose,terms,terms_digest AS "termsDigest",nonce,
  credential_type AS "credentialType",authorizing_wallet_id AS "authorizingWalletId",
  authorizing_passkey_id AS "authorizingPasskeyId",
  authorizing_address AS "authorizingAddress",authorizing_chain_id AS "authorizingChainId",
  authorization_message AS "authorizationMessage",expires_at AS "expiresAt"`;

// Callers validate domain rules first. Exact monetary amounts must be strings,
// never floating point numbers. Sorting makes object insertion order irrelevant.
export function accountOperationTermsDigest(terms: AccountOperationTerms) {
  const entries = Object.entries(terms).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (
    entries.length > 32 ||
    entries.some(
      ([key, value]) =>
        !/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(key) ||
        typeof value !== "string" ||
        value.length > 2048 ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127;
        }),
    )
  )
    throw new AccountOperationError(400, "invalid operation terms");
  const canonical = JSON.stringify(entries);
  if (canonical.length > 16_384)
    throw new AccountOperationError(400, "invalid operation terms");
  return createHash("sha256").update(canonical).digest("hex");
}

function unavailable(): never {
  throw new AccountOperationError(
    410,
    "approval expired or invalid; start again",
  );
}

// This is retained-credential authorization, not a general recent-auth flag.
// No access-token issuance time or browser/provider MFA callback is accepted.
export function createAccountOperationRepository(database: Pool) {
  const repository = {
    async create(input: {
      userId: string;
      sessionTokenHash: string;
      purpose: string;
      terms: AccountOperationTerms;
      credential: AccountOperationCredential;
      origin: string;
    }): Promise<AccountOperation> {
      if (!/^[a-z][a-z0-9_.]{0,79}$/.test(input.purpose))
        throw new AccountOperationError(400, "invalid operation purpose");
      const termsDigest = accountOperationTermsDigest(input.terms);
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const account = await lockAccount(client, input.userId);
        if (!account)
          throw new AccountOperationError(401, "authentication required");
        await assertActiveSession(client, input.userId, input.sessionTokenHash);
        let wallet: { address: string; chainId: string } | undefined;
        let passkey: { credentialId: string } | undefined;
        if (input.credential.type === "wallet") {
          wallet = (
            await client.query<{ address: string; chainId: string }>(
              `SELECT address,chain_id AS "chainId" FROM wallet_identities
               WHERE id=$1 AND user_id=$2`,
              [input.credential.walletId, input.userId],
            )
          ).rows[0];
          if (!wallet)
            throw new AccountOperationError(403, "linked wallet required");
        } else if (input.credential.type === "passkey") {
          passkey = (
            await client.query<{ credentialId: string }>(
              `SELECT credential_id AS "credentialId" FROM account_security_keys
               WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
              [input.credential.keyId, input.userId],
            )
          ).rows[0];
          if (!passkey)
            throw new AccountOperationError(403, "security passkey required");
          if (
            input.purpose === "security.passkey.remove" &&
            input.terms.keyId === input.credential.keyId
          )
            throw new AccountOperationError(403, "use a retained credential");
        } else if (!account.passwordHash) {
          throw new AccountOperationError(403, "retained credential required");
        }
        const id = randomUUID();
        const nonce = randomBytes(32).toString("hex");
        const issuedAt = (
          await client.query<{ issuedAt: Date }>(
            `SELECT date_trunc('milliseconds',clock_timestamp()) AS "issuedAt"`,
          )
        ).rows[0]!.issuedAt;
        const expiresAt = new Date(issuedAt.getTime() + 300_000);
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
              issuedAt,
              expirationTime: expiresAt,
              requestId: id,
              statement: `Authorize ${input.purpose} for YAP Arena account ${input.userId}. Terms: ${JSON.stringify(input.terms)}. This approves this account operation and does not sign a blockchain transaction.`,
              resources: [`urn:yaparena:operation-terms:${termsDigest}`],
            })
          : null;
        const result = await client.query<AccountOperation>(
          `INSERT INTO account_operations(id,user_id,session_token_hash,auth_generation,
            purpose,terms,terms_digest,nonce,credential_type,authorizing_wallet_id,
            authorizing_address,authorizing_chain_id,authorization_message,expires_at,created_at,authorizing_passkey_id)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING ${columns}`,
          [
            id,
            input.userId,
            input.sessionTokenHash,
            account.authGeneration,
            input.purpose,
            JSON.stringify(input.terms),
            termsDigest,
            nonce,
            input.credential.type,
            input.credential.type === "wallet"
              ? input.credential.walletId
              : null,
            wallet?.address ?? null,
            wallet?.chainId ?? null,
            message,
            expiresAt,
            issuedAt,
            input.credential.type === "passkey" ? input.credential.keyId : null,
          ],
        );
        await client.query("COMMIT");
        const operation = result.rows[0]!;
        if (passkey)
          operation.authenticationOptions = await generateAuthenticationOptions(
            {
              rpID: site.hostname,
              challenge: Buffer.from(nonce, "hex"),
              allowCredentials: [{ id: passkey.credentialId }],
              userVerification: "required",
              timeout: 300_000,
            },
          );
        return operation;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async prepare(input: {
      id: string;
      userId: string;
      sessionTokenHash: string;
      purpose: string;
      terms: AccountOperationTerms;
      password?: string;
      signature?: string;
      authentication?: AuthenticationResponseJSON;
      origin: string;
      rpcUrls: Readonly<Record<string, string>>;
      requestId?: string;
    }) {
      const digest = accountOperationTermsDigest(input.terms);
      const operation = (
        await database.query<AccountOperation>(
          `SELECT ${columns} FROM account_operations WHERE id=$1 AND user_id=$2
             AND session_token_hash=$3 AND purpose=$4 AND terms_digest=$5
             AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [
            input.id,
            input.userId,
            input.sessionTokenHash,
            input.purpose,
            digest,
          ],
        )
      ).rows[0];
      if (!operation) unavailable();
      // Verify potentially slow wallet RPC outside the mutation transaction.
      if (
        operation.credentialType === "wallet" &&
        (!input.signature ||
          !(await verifyChallengeSignature({
            challenge: {
              address: operation.authorizingAddress!,
              chainId: operation.authorizingChainId!,
              message: operation.authorizationMessage!,
              expiresAt: operation.expiresAt,
            },
            signature: input.signature,
            origin: input.origin,
            rpcUrls: input.rpcUrls,
          })))
      )
        throw new AccountOperationError(401, "wallet approval is invalid");

      return Object.freeze({
        purpose: operation.purpose,
        termsDigest: operation.termsDigest,
        assertContext(userId: string, sessionTokenHash: string) {
          if (
            userId !== input.userId ||
            sessionTokenHash !== input.sessionTokenHash
          )
            throw new AccountOperationError(
              403,
              "approval belongs to another session",
            );
        },
        // The caller owns BEGIN/COMMIT. Invoke this before taking feature locks;
        // callback writes and one-use consumption must share that transaction.
        async consume<T>(client: PoolClient, mutation: () => Promise<T>) {
          const account = await lockAccount(client, input.userId);
          if (!account || account.authGeneration !== operation.authGeneration)
            unavailable();
          const session = await assertActiveSession(
            client,
            input.userId,
            input.sessionTokenHash,
          );
          const locked = await client.query(
            `SELECT id FROM account_operations WHERE id=$1 AND user_id=$2
             AND session_token_hash=$3 AND auth_generation=$4 AND purpose=$5
             AND terms_digest=$6 AND nonce=$7 AND consumed_at IS NULL
             AND expires_at>clock_timestamp() FOR UPDATE`,
            [
              operation.id,
              input.userId,
              input.sessionTokenHash,
              account.authGeneration,
              input.purpose,
              digest,
              operation.nonce,
            ],
          );
          if (!locked.rows[0]) unavailable();
          if (operation.credentialType === "password") {
            if (
              !account.passwordHash ||
              !input.password ||
              !(await verifyPassword(account.passwordHash, input.password))
            )
              throw new AccountOperationError(
                401,
                "current password is incorrect",
              );
          } else if (operation.credentialType === "wallet") {
            const credential = await client.query(
              `SELECT id FROM wallet_identities WHERE id=$1 AND user_id=$2
               AND address=$3 AND chain_id=$4`,
              [
                operation.authorizingWalletId,
                input.userId,
                operation.authorizingAddress,
                operation.authorizingChainId,
              ],
            );
            if (!credential.rows[0]) unavailable();
          } else {
            const key = (
              await client.query<{
                credentialId: string;
                publicKey: Buffer;
                counter: string;
                deviceType: "singleDevice" | "multiDevice";
                userHandle: string;
              }>(
                `SELECT k.credential_id AS "credentialId",k.public_key AS "publicKey",
                   k.counter,k.device_type AS "deviceType",u.user_handle AS "userHandle"
                 FROM account_security_keys k JOIN account_security_users u ON u.user_id=k.user_id
                 WHERE k.id=$1 AND k.user_id=$2 AND k.revoked_at IS NULL FOR UPDATE OF k`,
                [operation.authorizingPasskeyId, input.userId],
              )
            ).rows[0];
            if (!key || !input.authentication) unavailable();
            try {
              if (
                input.authentication.response.userHandle &&
                input.authentication.response.userHandle !== key.userHandle
              )
                throw new Error("incorrect user handle");
              const verification = await verifyAuthenticationResponse({
                response: input.authentication,
                expectedChallenge: Buffer.from(operation.nonce, "hex").toString(
                  "base64url",
                ),
                expectedOrigin: new URL(input.origin).origin,
                expectedRPID: new URL(input.origin).hostname,
                requireUserVerification: true,
                credential: {
                  id: key.credentialId,
                  publicKey: new Uint8Array(key.publicKey),
                  counter: Number(key.counter),
                },
              });
              if (
                !verification.verified ||
                verification.authenticationInfo.credentialDeviceType !==
                  key.deviceType
              )
                throw new Error("security passkey verification failed");
              await client.query(
                "UPDATE account_security_keys SET counter=$2,backed_up=$3 WHERE id=$1",
                [
                  operation.authorizingPasskeyId,
                  verification.authenticationInfo.newCounter,
                  verification.authenticationInfo.credentialBackedUp,
                ],
              );
            } catch {
              throw new AccountOperationError(
                401,
                "security passkey approval is invalid",
              );
            }
          }
          const result = await mutation();
          const consumed = await client.query(
            `UPDATE account_operations SET consumed_at=clock_timestamp()
             WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()
             AND $2::timestamptz>clock_timestamp() RETURNING id`,
            [operation.id, session.expiresAt],
          );
          if (!consumed.rows[0]) unavailable();
          await client.query(
            `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata)
             VALUES($1,'account.operation_authorized',$2,$3::jsonb)`,
            [
              input.userId,
              operation.id,
              JSON.stringify({
                purpose: operation.purpose,
                termsDigest: digest,
                actorSessionId: session.id,
                credentialType: operation.credentialType,
                requestId: input.requestId,
                outcome: "success",
              }),
            ],
          );
          return result;
        },
      });
    },

    async deleteExpired() {
      const result = await database.query(
        "DELETE FROM account_operations WHERE expires_at<clock_timestamp()-interval '1 day'",
      );
      return result.rowCount ?? 0;
    },
  };
  return Object.freeze({
    ...repository,
    async authorize(input: Parameters<typeof repository.prepare>[0]) {
      const approval = await repository.prepare(input),
        client = await database.connect();
      try {
        await client.query("BEGIN");
        await approval.consume(client, async () => {});
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
