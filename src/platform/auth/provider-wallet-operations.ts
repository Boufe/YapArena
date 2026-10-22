import type { Pool } from "pg";
import { createSiweMessage } from "viem/siwe";
import { getAddress } from "viem";
import {
  AccountOperationError,
  accountOperationTermsDigest,
  createAccountOperationRepository,
  type AccountOperationCredential,
  type AccountOperation,
} from "./account-operations.ts";
import {
  normalizeWalletAddress,
  validChainId,
  verifyChallengeSignature,
} from "./siwe.ts";
import { insertSession, lockAccount } from "./sessions.ts";
import { createSessionToken } from "./session-tokens.ts";
import type { LinkedWallet } from "./wallets.ts";
import type { IdentityVerifier } from "./privy.ts";

export type ProviderWalletTarget = {
  purpose: "link" | "unlink";
  address: string;
  chainId: number;
  targetWalletId?: string;
};
function targetTerms(target: ProviderWalletTarget) {
  if (
    !["link", "unlink"].includes(target.purpose) ||
    normalizeWalletAddress(target.address) !== target.address ||
    !validChainId(target.chainId) ||
    (target.purpose === "unlink" &&
      (!target.targetWalletId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          target.targetWalletId,
        ))) ||
    (target.purpose === "link" && target.targetWalletId !== undefined)
  )
    throw new AccountOperationError(400, "invalid wallet target");
  return {
    address: target.address,
    chainId: String(target.chainId),
    ...(target.targetWalletId ? { targetWalletId: target.targetWalletId } : {}),
  };
}
function proposedMessage(
  operation: Pick<AccountOperation, "id" | "nonce" | "expiresAt">,
  target: ProviderWalletTarget,
  origin: string,
) {
  const site = new URL(origin);
  return createSiweMessage({
    address: getAddress(target.address),
    chainId: target.chainId,
    domain: site.host,
    uri: site.origin,
    scheme: site.protocol.slice(0, -1),
    version: "1",
    nonce: operation.nonce,
    requestId: operation.id,
    issuedAt: new Date(operation.expiresAt.getTime() - 300000),
    expirationTime: operation.expiresAt,
    statement:
      "Prove control of this new wallet for linking to your YAP Arena account. This does not authorize a transaction.",
  });
}

// The existing F02 endpoints remain compatible. This path adds server-verified
// security-passkey approval without making the proposed wallet its own authorizer.
export function createProviderWalletOperations(
  database: Pool,
  inspector?: Pick<IdentityVerifier, "inspect">,
) {
  const operations = createAccountOperationRepository(database, inspector);
  return Object.freeze({
    async create(
      input: ProviderWalletTarget & {
        userId: string;
        sessionTokenHash: string;
        origin: string;
        credential: AccountOperationCredential;
      },
    ) {
      const terms = targetTerms(input);
      if (input.purpose === "unlink") {
        if (
          input.credential.type === "wallet" &&
          input.credential.walletId === input.targetWalletId
        )
          throw new AccountOperationError(
            403,
            "use an existing credential that will remain linked",
          );
        const target = await database.query(
          "SELECT id FROM wallet_identities WHERE id=$1 AND user_id=$2 AND address=$3 AND chain_id=$4",
          [input.targetWalletId, input.userId, input.address, input.chainId],
        );
        if (!target.rowCount)
          throw new AccountOperationError(404, "wallet not found");
      } else {
        const existing = await database.query(
          "SELECT id FROM wallet_identities WHERE address=$1 AND chain_id=$2",
          [input.address, input.chainId],
        );
        if (existing.rowCount)
          throw new AccountOperationError(409, "wallet is already linked");
      }
      const operation = await operations.create({
        ...input,
        purpose: `wallet.${input.purpose}`,
        terms,
      });
      return {
        id: operation.id,
        expiresAt: operation.expiresAt,
        authorizationMessage: operation.authorizationMessage,
        authenticationOptions: operation.authenticationOptions,
        proposedMessage:
          input.purpose === "link"
            ? proposedMessage(operation, input, input.origin)
            : null,
      };
    },
    async complete(
      input: ProviderWalletTarget &
        Omit<Parameters<typeof operations.prepare>[0], "purpose" | "terms"> & {
          proposedSignature?: string;
          sessionDurationMs: number;
        },
    ) {
      const terms = targetTerms(input),
        purpose = `wallet.${input.purpose}`;
      const operation = (
        await database.query<{
          id: string;
          nonce: string;
          expiresAt: Date;
          credentialType: string;
          authorizingWalletId: string | null;
        }>(
          `SELECT id,nonce,expires_at AS "expiresAt",credential_type AS "credentialType",authorizing_wallet_id AS "authorizingWalletId"
         FROM account_operations WHERE id=$1 AND user_id=$2 AND session_token_hash=$3
           AND purpose=$4 AND terms_digest=$5 AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
          [
            input.id,
            input.userId,
            input.sessionTokenHash,
            purpose,
            accountOperationTermsDigest(terms),
          ],
        )
      ).rows[0];
      if (!operation)
        throw new AccountOperationError(
          410,
          "wallet operation expired or invalid; start again",
        );
      if (
        input.purpose === "unlink" &&
        operation.credentialType === "wallet" &&
        operation.authorizingWalletId === input.targetWalletId
      )
        throw new AccountOperationError(
          403,
          "use an existing credential that will remain linked",
        );
      const approval = await operations.prepare({ ...input, purpose, terms });
      if (
        input.purpose === "link" &&
        (!input.proposedSignature ||
          !(await verifyChallengeSignature({
            challenge: {
              address: input.address,
              chainId: String(input.chainId),
              message: proposedMessage(operation, input, input.origin),
              expiresAt: operation.expiresAt,
            },
            signature: input.proposedSignature,
            origin: input.origin,
            rpcUrls: input.rpcUrls,
          })))
      )
        throw new AccountOperationError(401, "new wallet signature is invalid");
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const result = await approval.consume(client, async () => {
          const account = await lockAccount(client, input.userId);
          if (!account)
            throw new AccountOperationError(401, "authentication required");
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `${input.chainId}:${input.address}`,
          ]);
          let wallet: LinkedWallet;
          if (input.purpose === "link") {
            const existing = await client.query(
              "SELECT id FROM wallet_identities WHERE address=$1 AND chain_id=$2",
              [input.address, input.chainId],
            );
            if (existing.rowCount)
              throw new AccountOperationError(409, "wallet is already linked");
            wallet = (
              await client.query<LinkedWallet>(
                `INSERT INTO wallet_identities(user_id,address,chain_id) VALUES($1,$2,$3)
              RETURNING id,address,chain_id AS "chainId",created_at AS "createdAt"`,
                [input.userId, input.address, input.chainId],
              )
            ).rows[0]!;
            await client.query(
              "DELETE FROM sessions WHERE user_id=$1 AND token_hash=$2",
              [input.userId, input.sessionTokenHash],
            );
          } else {
            const retained = (
              await client.query<{ available: boolean }>(
                `SELECT $2::boolean OR EXISTS(SELECT 1 FROM provider_identities WHERE user_id=$1)
                OR EXISTS(SELECT 1 FROM wallet_identities WHERE user_id=$1 AND id<>$3) AS available`,
                [
                  input.userId,
                  Boolean(account.passwordHash),
                  input.targetWalletId,
                ],
              )
            ).rows[0]?.available;
            if (!retained)
              throw new AccountOperationError(
                409,
                "cannot remove the last sign-in method",
              );
            const deleted = await client.query<LinkedWallet>(
              `DELETE FROM wallet_identities WHERE id=$1 AND user_id=$2 AND address=$3 AND chain_id=$4
              RETURNING id,address,chain_id AS "chainId",created_at AS "createdAt"`,
              [
                input.targetWalletId,
                input.userId,
                input.address,
                input.chainId,
              ],
            );
            if (!deleted.rows[0])
              throw new AccountOperationError(404, "wallet not found");
            wallet = deleted.rows[0];
          }
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
            "INSERT INTO account_notifications(user_id,event_type,message) VALUES($1,$2,$3)",
            [
              input.userId,
              `wallet.${input.purpose}`,
              `Wallet ${input.address} on chain ${input.chainId} was ${input.purpose === "link" ? "linked" : "unlinked"}. Review your account security if you did not request this change.`,
            ],
          );
          return { wallet, token: token.token };
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
