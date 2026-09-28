import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from "../src/platform/auth/passwords.js";

describe("passwords", () => {
  it("accepts passwords within the supported length", () => {
    assert.equal(validatePassword("a secure passphrase"), null);
    assert.equal(validatePassword("🔐".repeat(15)), null);
  });

  it("rejects invalid password values", () => {
    assert.equal(validatePassword(null), "password must be a string");
    assert.match(validatePassword("too short"), /between 15 and 128/);
    assert.match(validatePassword("x".repeat(129)), /between 15 and 128/);
  });

  it("hashes and verifies a password", async () => {
    const password = "a secure passphrase";
    const passwordHash = await hashPassword(password);

    assert.notEqual(passwordHash, password);
    assert.match(passwordHash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(passwordHash, password), true);
    assert.equal(
      await verifyPassword(passwordHash, "a different password"),
      false,
    );
  });
});
