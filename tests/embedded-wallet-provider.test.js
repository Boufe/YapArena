import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPrivyEmbeddedWalletProvider,
  EmbeddedWalletProviderError,
} from "../dist/platform/auth/embedded-wallet-provider.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";

const subject = "did:privy:synthetic-wallet-owner";
const address = "0x1234567890123456789012345678901234567890";
const input = {
  subject,
  externalId: "opaque-wallet-reference",
  signal: new AbortController().signal,
};
function fixture(overrides = {}) {
  const calls = [];
  const linked = {
    type: "wallet",
    id: "wallet-fixture",
    chain_type: "ethereum",
    address,
    wallet_client_type: "privy",
    connector_type: "embedded",
    user_can_sign: true,
  };
  const wallet = {
    id: "wallet-fixture",
    address,
    chain_type: "ethereum",
    archived_at: null,
    external_id: input.externalId,
    additional_signers: [],
    policy_ids: [],
    owner_id: "user-only-quorum",
  };
  const state = {
    settings: { email_auth: true, merge_accounts_by_email: false },
    user: {
      id: subject,
      is_guest: false,
      frozen_at: null,
      linked_accounts: [
        { type: "email", address: "wallet-fixture@example.invalid" },
        linked,
      ],
    },
    external: wallet,
    wallet,
    quorum: {
      id: "user-only-quorum",
      authorization_threshold: 1,
      authorization_keys: [],
      user_ids: [subject],
      key_quorum_ids: [],
    },
    ...overrides,
  };
  const provider = createPrivyEmbeddedWalletProvider({
    appId: "synthetic-wallet-app",
    appSecret: "synthetic-only-secret",
    fetch: async (url, options) => {
      const request = new Request(url, options);
      const path = decodeURIComponent(new URL(request.url).pathname);
      calls.push({
        path,
        method: request.method,
        body: await request.text(),
        idempotencyKey: request.headers.get("privy-idempotency-key"),
      });
      let value;
      if (path === "/v1/apps/synthetic-wallet-app") value = state.settings;
      else if (path === `/v1/users/${subject}`) value = state.user;
      else if (path === `/v1/wallets/ext_wal_${input.externalId}`)
        value = state.external;
      else if (path === "/v1/wallets/wallet-fixture") value = state.wallet;
      else if (path === "/v1/key_quorums/user-only-quorum")
        value = state.quorum;
      else if (path === "/v1/wallets" && request.method === "POST")
        value = state.wallet;
      else throw new Error("Unexpected synthetic provider route");
      return new Response(JSON.stringify(value ?? { error: "not found" }), {
        status: value === null ? 404 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { provider, calls, state, linked, wallet };
}
describe("user-owned Privy embedded wallet adapter", () => {
  it("uses the installed public SDK's idempotency header and exact user-only create body", async () => {
    const { provider, calls } = fixture();
    await provider.create({ ...input, idempotencyKey: "stored-attempt-uuid" });
    assert.deepEqual(calls, [
      {
        path: "/v1/wallets",
        method: "POST",
        body: JSON.stringify({
          chain_type: "ethereum",
          owner: { user_id: subject },
          external_id: input.externalId,
        }),
        idempotencyKey: "stored-attempt-uuid",
      },
    ]);
  });
  it("reconciles immutable external reference and exact user-only owner without mutating", async () => {
    const { provider, calls } = fixture();
    assert.deepEqual(await provider.inspect(input), {
      credentialsDigest: providerCredentialsDigest([
        { type: "email", id: "wallet-fixture@example.invalid" },
      ]),
      wallet: { id: "wallet-fixture", address },
    });
    assert.ok(calls.every((call) => call.method === "GET" && call.body === ""));
    assert.ok(
      calls.some(
        (call) => call.path === `/v1/wallets/ext_wal_${input.externalId}`,
      ),
    );
    assert.ok(
      calls.some((call) => call.path === "/v1/key_quorums/user-only-quorum"),
    );
  });
  it("reuses a pre-existing verified user wallet instead of issuing an extra wallet", async () => {
    const { provider, calls } = fixture({ external: null });
    assert.deepEqual((await provider.inspect(input)).wallet, {
      id: "wallet-fixture",
      address,
    });
    assert.ok(calls.some((call) => call.path === "/v1/wallets/wallet-fixture"));
    assert.ok(calls.every((call) => call.method === "GET"));
  });
  it("returns absence only after authoritative user and unique-reference reads agree", async () => {
    const { provider, state } = fixture({ external: null });
    state.user.linked_accounts = [state.user.linked_accounts[0]];
    assert.equal((await provider.inspect(input)).wallet, null);
  });
  it("waits for provider linkage after an uncertain create instead of creating a replacement", async () => {
    const { provider, state, calls } = fixture();
    state.user.linked_accounts = [state.user.linked_accounts[0]];
    await assert.rejects(
      provider.inspect(input),
      (error) =>
        error instanceof EmbeddedWalletProviderError &&
        error.code === "unavailable",
    );
    assert.ok(calls.every((call) => call.method === "GET"));
  });
  it("rejects app/server/other-user ownership, signers, policies and archived wallets", async () => {
    for (const change of [
      { authorization_threshold: null },
      { authorization_threshold: 2 },
      { authorization_keys: [{ public_key: "unapproved-server-key" }] },
      { user_ids: ["did:privy:other"] },
      { user_ids: [subject, "did:privy:other"] },
      { key_quorum_ids: ["nested-server-quorum"] },
    ]) {
      const { provider, state } = fixture();
      Object.assign(state.quorum, change);
      await assert.rejects(
        provider.inspect(input),
        (error) =>
          error instanceof EmbeddedWalletProviderError &&
          error.code === "review_required",
      );
    }
    for (const change of [
      { additional_signers: [{ signer_id: "app" }] },
      { policy_ids: ["unapproved-policy"] },
      { archived_at: 123 },
      { owner_id: null },
      { external_id: "other-reference" },
      { address: "invalid" },
      { chain_type: "solana" },
    ]) {
      const { provider, state } = fixture();
      Object.assign(state.external, change);
      await assert.rejects(
        provider.inspect(input),
        (error) =>
          error instanceof EmbeddedWalletProviderError &&
          error.code === "review_required",
      );
    }
  });
  it("rejects unsupported credentials, external wallets, duplicate wallets and wrong provider identities", async () => {
    for (const replace of [
      (state) => {
        state.settings.merge_accounts_by_email = true;
      },
      (state) => {
        state.user.id = "did:privy:other";
      },
      (state) => {
        state.user.is_guest = true;
      },
      (state) => {
        state.user.linked_accounts.push({ type: "phone", number: "synthetic" });
      },
      (state) => {
        state.user.linked_accounts[1].wallet_client_type = "metamask";
      },
      (state) => {
        state.user.linked_accounts[1].user_can_sign = false;
      },
      (state) => {
        state.user.linked_accounts.push({
          ...state.user.linked_accounts[1],
          id: "another-wallet",
        });
      },
      (state) => {
        state.user.linked_accounts = [state.user.linked_accounts[1]];
      },
    ]) {
      const { provider, state } = fixture();
      replace(state);
      await assert.rejects(
        provider.inspect(input),
        (error) =>
          error instanceof EmbeddedWalletProviderError &&
          error.code === "review_required",
      );
    }
    const { provider, state } = fixture();
    state.user.frozen_at = 123;
    await assert.rejects(
      provider.inspect(input),
      (error) =>
        error instanceof EmbeddedWalletProviderError &&
        error.code === "unavailable",
    );
  });
  it("does not leak private provider error text through classified failures", async () => {
    const provider = createPrivyEmbeddedWalletProvider({
      appId: "synthetic",
      appSecret: "synthetic",
      fetch: async () => {
        throw new Error("private provider details");
      },
    });
    for (const action of [
      () => provider.inspect(input),
      () => provider.create({ ...input, idempotencyKey: "uuid" }),
    ])
      await assert.rejects(
        action(),
        (error) =>
          error instanceof EmbeddedWalletProviderError &&
          error.code === "unavailable" &&
          !error.message.includes("private provider"),
      );
  });
});
