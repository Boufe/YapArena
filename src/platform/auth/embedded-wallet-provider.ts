import { NotFoundError, PrivyClient } from "@privy-io/node";
import {
  providerCredentialsDigest,
  type ProviderCredential,
} from "./provider-credentials.ts";

export type EmbeddedWallet = { id: string; address: string };
export type EmbeddedWalletProvider = {
  inspect(input: {
    subject: string;
    externalId: string;
    signal: AbortSignal;
  }): Promise<{ credentialsDigest: string; wallet: EmbeddedWallet | null }>;
  create(input: {
    subject: string;
    externalId: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<void>;
};
export class EmbeddedWalletProviderError extends Error {
  constructor(readonly code: "unavailable" | "review_required") {
    super(
      code === "unavailable"
        ? "Wallet provider unavailable"
        : "Wallet ownership requires review",
    );
  }
}
function review(condition: unknown): asserts condition {
  if (!condition) throw new EmbeddedWalletProviderError("review_required");
}

export function createPrivyEmbeddedWalletProvider(config: {
  appId: string;
  appSecret: string;
  fetch?: typeof globalThis.fetch;
}): EmbeddedWalletProvider {
  function scopedClient(signal: AbortSignal) {
    return new PrivyClient({
      ...config,
      apiUrl: "https://api.privy.io",
      logLevel: "off",
      timeout: 5000,
      maxRetries: 0,
      fetch: (input, init) =>
        (config.fetch ?? globalThis.fetch)(input, {
          ...init,
          redirect: "error",
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        }),
    });
  }
  return {
    async inspect({ subject, externalId, signal }) {
      try {
        const client = scopedClient(signal);
        const settings = await client.apps().getSettings();
        review(
          settings.email_auth && settings.merge_accounts_by_email === false,
        );
        const user = await client.users()._get(subject, { signal });
        review(user.id === subject && !user.is_guest);
        if (user.frozen_at !== undefined && user.frozen_at !== null)
          throw new EmbeddedWalletProviderError("unavailable");
        const credentials: ProviderCredential[] = [];
        const linkedWallets: EmbeddedWallet[] = [];
        for (const account of user.linked_accounts) {
          if (account.type === "email")
            credentials.push({ type: "email", id: account.address });
          else if (account.type === "google_oauth")
            credentials.push({ type: "google_oauth", id: account.subject });
          else if (account.type === "passkey")
            credentials.push({ type: "passkey", id: account.credential_id });
          else if (account.type === "wallet") {
            review(
              account.wallet_client_type === "privy" &&
                account.connector_type === "embedded" &&
                "user_can_sign" in account &&
                account.user_can_sign === true,
            );
            if (account.chain_type === "ethereum") {
              review(
                "id" in account &&
                  typeof account.id === "string" &&
                  account.id.length > 0 &&
                  /^0x[0-9a-fA-F]{40}$/.test(account.address),
              );
              linkedWallets.push({ id: account.id, address: account.address });
            } else
              review(
                account.chain_type === "solana" &&
                  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account.address),
              );
          } else throw new EmbeddedWalletProviderError("review_required");
        }
        review(credentials.length > 0 && linkedWallets.length <= 1);
        const external = await client
          .wallets()
          .get(`ext_wal_${externalId}`, undefined, { signal })
          .catch((error: unknown) => {
            if (error instanceof NotFoundError) return null;
            throw error;
          });
        let wallet = external;
        if (external) {
          review(
            external.external_id === externalId &&
              external.chain_type === "ethereum" &&
              /^0x[0-9a-fA-F]{40}$/.test(external.address),
          );
          const linked = linkedWallets.find(
            (entry) =>
              entry.id === external.id &&
              entry.address.toLowerCase() === external.address.toLowerCase(),
          );
          // Provider user linkage can lag wallet creation. Do not create a
          // replacement or claim ownership until both reads agree.
          if (!linked) throw new EmbeddedWalletProviderError("unavailable");
        } else if (linkedWallets[0])
          wallet = await client
            .wallets()
            .get(linkedWallets[0].id, undefined, { signal });
        if (wallet) {
          review(
            wallet.chain_type === "ethereum" &&
              /^0x[0-9a-fA-F]{40}$/.test(wallet.address) &&
              wallet.archived_at === null &&
              wallet.additional_signers.length === 0 &&
              wallet.policy_ids.length === 0 &&
              typeof wallet.owner_id === "string" &&
              wallet.owner_id.length > 0,
          );
          const linked = linkedWallets.find(
            (entry) =>
              entry.id === wallet.id &&
              entry.address.toLowerCase() === wallet.address.toLowerCase(),
          );
          review(linked);
          const quorum = await client.keyQuorums().get(wallet.owner_id);
          review(
            quorum.id === wallet.owner_id &&
              quorum.authorization_threshold === 1 &&
              quorum.authorization_keys.length === 0 &&
              quorum.user_ids?.length === 1 &&
              quorum.user_ids[0] === subject &&
              (quorum.key_quorum_ids === undefined ||
                quorum.key_quorum_ids.length === 0),
          );
        }
        return {
          credentialsDigest: providerCredentialsDigest(credentials),
          wallet: wallet ? { id: wallet.id, address: wallet.address } : null,
        };
      } catch (error) {
        if (error instanceof EmbeddedWalletProviderError) throw error;
        throw new EmbeddedWalletProviderError("unavailable");
      }
    },
    async create({ subject, externalId, idempotencyKey, signal }) {
      try {
        const client = scopedClient(signal);
        // This creates an empty wallet owned only by the verified provider
        // user. No app key, policy, extra signer, smart wallet or funds.
        await client.wallets().create({
          chain_type: "ethereum",
          owner: { user_id: subject },
          external_id: externalId,
          idempotency_key: idempotencyKey,
        });
      } catch {
        // Every outcome is reconciled via the immutable unique external ID
        // before another attempt. Never expose raw provider responses.
        throw new EmbeddedWalletProviderError("unavailable");
      }
    },
  };
}
