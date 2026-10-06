import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ChallengeUnavailableError,
  createWalletRepository,
} from "../dist/platform/auth/wallets.js";

const user = {
  id: "7",
  email: null,
  authGeneration: "0",
  createdAt: new Date("2026-09-01"),
};
const address = `0x${"a".repeat(40)}`;
const wallet = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "7",
  address,
  chainId: "1",
  createdAt: new Date("2026-09-01"),
};

function fakePool(options = {}) {
  const calls = [];
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes("INSERT INTO wallet_challenges"))
      return {
        rows: [{ id: "challenge", address, chainId: "1", purpose: "login" }],
      };
    if (sql.includes("FROM users WHERE id"))
      return { rows: [{ ...user, email: options.email ?? null }] };
    if (sql.includes("INSERT INTO sessions") || sql.includes("FROM sessions s"))
      return { rows: [{ id: "1", userId: "7" }] };
    if (sql.includes("FROM wallet_challenges") && sql.includes("SELECT id"))
      return {
        rows: options.challengeMissing
          ? []
          : [
              {
                id: "challenge",
                address,
                chainId: "1",
                purpose: "login",
                accountId: options.existingLogin ? "7" : null,
                walletId: options.existingLogin ? wallet.id : null,
                authGeneration: "0",
              },
            ],
      };
    if (sql.includes("UPDATE wallet_challenges"))
      return {
        rows: options.challengeMissing ? [] : [{ address, chainId: "1" }],
      };
    if (sql.includes("FROM wallet_identities w JOIN users"))
      return { rows: options.existingLogin ? [user] : [] };
    if (sql.includes("INSERT INTO users")) return { rows: [user] };
    if (sql.includes('SELECT id, user_id AS "userId" FROM wallet_identities'))
      return { rows: options.existingLogin ? [wallet] : [] };
    if (sql.includes("FROM wallet_identities WHERE chain_id"))
      return {
        rows:
          options.linkedTo === undefined
            ? []
            : [{ ...wallet, userId: options.linkedTo }],
      };
    if (
      sql.includes("INSERT INTO wallet_identities") &&
      sql.includes("RETURNING")
    )
      return { rows: [wallet] };
    if (sql.includes("SELECT email FROM users"))
      return { rows: [{ email: options.email ?? null }] };
    if (sql.includes("SELECT id FROM wallet_identities WHERE id"))
      return { rows: options.walletMissing ? [] : [wallet] };
    if (sql.includes("count(*)::text"))
      return { rows: [{ count: String(options.walletCount ?? 1) }] };
    if (sql.includes("FROM wallet_identities WHERE user_id"))
      return { rows: [wallet] };
    if (sql.includes("DELETE FROM wallet_challenges"))
      return { rowCount: 2, rows: [] };
    return { rows: [], rowCount: 1 };
  };
  return {
    pool: {
      query,
      connect: async () => ({
        query,
        release() {
          calls.push({ sql: "RELEASE" });
        },
      }),
    },
    calls,
  };
}

describe("wallet repository atomic identity changes", () => {
  it("stores and loads short-lived challenges", async () => {
    const { pool, calls } = fakePool();
    const repository = createWalletRepository(pool);
    const issued = await repository.createChallenge({
      address,
      chainId: 1,
      purpose: "login",
      message: "signed message",
      expiresAt: new Date("2026-10-01"),
    });
    assert.equal(issued.id, "challenge");
    assert.deepEqual(calls[0].values.slice(0, 4), [
      address,
      1,
      "login",
      "signed message",
    ]);
    assert.equal((await repository.getChallenge("challenge")).id, "challenge");
    assert.equal(await repository.deleteExpiredChallenges(), 2);
  });

  it("creates a wallet-only account or reuses the linked account under a transaction lock", async () => {
    const first = fakePool();
    const created = await createWalletRepository(first.pool).completeLogin(
      "challenge",
      { tokenHash: "hash", expiresAt: new Date("2026-10-01") },
    );
    assert.equal(created.id, "7");
    assert.ok(first.calls.some(({ sql }) => sql.includes("INSERT INTO users")));
    assert.ok(
      first.calls.some(({ sql }) =>
        sql.includes("INSERT INTO wallet_identities"),
      ),
    );
    assert.ok(
      first.calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")),
    );
    assert.ok(first.calls.some(({ sql }) => sql === "COMMIT"));
    const existing = fakePool({ existingLogin: true });
    assert.equal(
      (
        await createWalletRepository(existing.pool).completeLogin("challenge", {
          tokenHash: "hash",
          expiresAt: new Date("2026-10-01"),
        })
      ).id,
      "7",
    );
    assert.ok(
      !existing.calls.some(({ sql }) => sql.includes("INSERT INTO users")),
    );
  });

  it("rolls back a replayed challenge", async () => {
    const { pool, calls } = fakePool({ challengeMissing: true });
    await assert.rejects(
      () =>
        createWalletRepository(pool).completeLogin("challenge", {
          tokenHash: "hash",
          expiresAt: new Date("2026-10-01"),
        }),
      ChallengeUnavailableError,
    );
    assert.ok(calls.some(({ sql }) => sql === "ROLLBACK"));
  });

  it("keeps wallet inventory scoped and exposes only gated mutations", async () => {
    const repository = createWalletRepository(fakePool().pool);
    assert.equal((await repository.listWallets("7"))[0].id, wallet.id);
    assert.equal(repository.completeLink, undefined);
    assert.equal(repository.unlinkWallet, undefined);
    assert.equal(typeof repository.operations.complete, "function");
  });
});
