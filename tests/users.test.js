import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createUserRepository } from "../src/platform/auth/users.js";

describe("user repository", () => {
  it("creates and returns safe user fields", async () => {
    const savedUser = {
      id: "1",
      email: "user@example.com",
      createdAt: new Date("2026-08-04T17:00:00.000Z"),
    };
    const query = mock.fn(async () => ({ rows: [savedUser] }));
    const repository = createUserRepository({ query });

    const result = await repository.create(
      "user@example.com",
      "argon2-password-hash",
    );

    assert.deepEqual(result, savedUser);
    assert.deepEqual(query.mock.calls[0].arguments[1], [
      "user@example.com",
      "argon2-password-hash",
    ]);
    assert.doesNotMatch(
      query.mock.calls[0].arguments[0],
      /RETURNING.*password_hash/s,
    );
  });

  it("finds a user by email for login", async () => {
    const savedUser = {
      id: "1",
      email: "user@example.com",
      passwordHash: "argon2-password-hash",
    };
    const query = mock.fn(async () => ({ rows: [savedUser] }));
    const repository = createUserRepository({ query });

    const result = await repository.findByEmail("user@example.com");

    assert.deepEqual(result, savedUser);
    assert.deepEqual(query.mock.calls[0].arguments[1], ["user@example.com"]);
  });

  it("returns null when an email does not exist", async () => {
    const query = mock.fn(async () => ({ rows: [] }));
    const repository = createUserRepository({ query });

    assert.equal(await repository.findByEmail("missing@example.com"), null);
  });
});
