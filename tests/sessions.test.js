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
    const query = mock.fn(async () => ({ rows: [savedSession] }));
    const repository = createSessionRepository({ query });
    const expiresAt = new Date("2026-08-11T17:00:00.000Z");

    const result = await repository.create("2", "token-hash", expiresAt);

    assert.deepEqual(result, savedSession);
    assert.deepEqual(query.mock.calls[0].arguments[1], [
      "2",
      "token-hash",
      expiresAt,
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
      /expires_at > CURRENT_TIMESTAMP/,
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
