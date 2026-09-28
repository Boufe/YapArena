import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSessionToken,
  hashSessionToken,
} from "../src/platform/auth/session-tokens.js";

describe("session tokens", () => {
  it("creates unique 256-bit URL-safe tokens", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.token, second.token);
    assert.equal(first.tokenHash, hashSessionToken(first.token));
  });

  it("creates a deterministic SHA-256 digest for storage", () => {
    const tokenHash = hashSessionToken("session-token");

    assert.match(tokenHash, /^[a-f0-9]{64}$/);
    assert.equal(tokenHash, hashSessionToken("session-token"));
    assert.notEqual(tokenHash, "session-token");
  });
});
