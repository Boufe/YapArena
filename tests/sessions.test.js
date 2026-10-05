import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createSessionRepository } from "../dist/platform/auth/sessions.js";

describe("session repository", () => {
  it("creates a session using only the token hash", async () => {
    const savedSession = {
      id: "1",
      userId: "2",
      expiresAt: new Date("2026-08-11T17:00:00.000Z"),
    };
    const query = mock.fn(async (sql) => ({
      rows: sql.includes("FROM users")
        ? [{ id: "2", authGeneration: "0" }]
        : [savedSession],
    }));
    const repository = createSessionRepository({
      connect: async () => ({ query, release() {} }),
    });
    const expiresAt = new Date("2026-08-11T17:00:00.000Z");

    const result = await repository.create("2", "token-hash", expiresAt, {
      authGeneration: "0",
    });

    assert.deepEqual(result, savedSession);
    assert.deepEqual(query.mock.calls[2].arguments[1], [
      "2",
      "token-hash",
      expiresAt,
      "0",
    ]);
  });

  it("finds the user for an unexpired session", async () => {
    const savedUser = { id: "2", email: "user@example.com" };
    const query = mock.fn(async () => ({ rows: [savedUser] }));
    const repository = createSessionRepository({ query });

    const result = await repository.findUserByTokenHash("token-hash");

    assert.deepEqual(result, savedUser);
    assert.deepEqual(query.mock.calls[0].arguments[1], ["token-hash"]);
    assert.match(
      query.mock.calls[0].arguments[0],
      /expires_at > clock_timestamp/,
    );
  });

  it("returns null when a session is missing or expired", async () => {
    const query = mock.fn(async () => ({ rows: [] }));
    const repository = createSessionRepository({ query });

    assert.equal(await repository.findUserByTokenHash("missing-hash"), null);
  });

  it("deletes a session for logout", async () => {
    const query = mock.fn(async () => ({ rows: [{ id: "1" }], rowCount: 1 }));
    const repository = createSessionRepository({ query });

    assert.equal(await repository.deleteByTokenHash("token-hash"), true);
    assert.deepEqual(query.mock.calls[0].arguments[1], ["token-hash"]);
  });

  it("reports when there was no session to delete", async () => {
    const query = mock.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = createSessionRepository({ query });

    assert.equal(await repository.deleteByTokenHash("missing-hash"), false);
  });

  it("deletes expired sessions for scheduled maintenance", async () => {
    const database = {
      query: mock.fn(async () => ({ rowCount: 4 })),
    };
    const sessions = createSessionRepository(database);

    assert.equal(await sessions.deleteExpired(), 4);
    assert.match(database.query.mock.calls[0].arguments[0], /expires_at <=/);
  });
});

describe("session issuance authoritative checks and failure atomicity", () => {
  function clientPool({
    account = {
      id: "2",
      email: "user@example.com",
      passwordHash: "current-hash",
      authGeneration: "1",
    },
    wallet = true,
    saved = true,
    commitError = false,
  } = {}) {
    const calls = [];
    return {
      calls,
      pool: {
        connect: async () => ({
          query: async (sql) => {
            calls.push(sql);
            if (sql === "COMMIT" && commitError)
              throw new Error("commit failed");
            if (sql.includes("FROM users"))
              return { rows: account ? [account] : [] };
            if (sql.includes("FROM wallet_identities"))
              return { rows: wallet ? [{ id: "wallet" }] : [] };
            if (sql.includes("INSERT INTO sessions"))
              return { rows: saved ? [{ id: "session" }] : [] };
            return { rows: [] };
          },
          release() {
            calls.push("RELEASE");
          },
        }),
      },
    };
  }
  it("rejects missing accounts, obsolete generations, and changed credential snapshots", async () => {
    for (const [options, snapshot] of [
      [{ account: null }, { authGeneration: "1" }],
      [{}, { authGeneration: "0" }],
      [
        {},
        {
          authGeneration: "1",
          passwordHash: "obsolete-hash",
          email: "user@example.com",
        },
      ],
      [
        {},
        {
          authGeneration: "1",
          passwordHash: "current-hash",
          email: "different@example.com",
        },
      ],
      [{ wallet: false }, { authGeneration: "1", walletId: "removed-wallet" }],
    ]) {
      const { pool, calls } = clientPool(options);
      await assert.rejects(
        createSessionRepository(pool).create("2", "hash", new Date(), snapshot),
      );
      assert.ok(calls.includes("ROLLBACK"));
      assert.equal(calls.includes("COMMIT"), false);
    }
  });
  it("checks wallet ownership again and releases a committed session", async () => {
    const { pool, calls } = clientPool();
    assert.equal(
      (
        await createSessionRepository(pool).create("2", "hash", new Date(), {
          authGeneration: "1",
          walletId: "wallet",
        })
      ).id,
      "session",
    );
    assert.ok(calls.some((sql) => sql.includes("FROM wallet_identities")));
    assert.deepEqual(calls.slice(-2), ["COMMIT", "RELEASE"]);
  });
  it("does not return a session when insertion or commit fails", async () => {
    for (const options of [{ saved: false }, { commitError: true }]) {
      const { pool, calls } = clientPool(options);
      await assert.rejects(
        createSessionRepository(pool).create("2", "hash", new Date(), {
          authGeneration: "1",
        }),
      );
      assert.deepEqual(calls.slice(-2), ["ROLLBACK", "RELEASE"]);
    }
  });
});
