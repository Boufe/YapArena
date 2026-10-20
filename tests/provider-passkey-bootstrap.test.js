import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { it } from "node:test";
import { createProviderPasskeyBootstrap } from "../dist/platform/auth/provider-passkey-bootstrap.js";
import { createProviderPasskeys } from "../dist/platform/auth/provider-passkeys.js";
import { AccountOperationError } from "../dist/platform/auth/account-operations.js";
import {
  createPrivyVerifier,
  ProviderUnavailableError,
} from "../dist/platform/auth/privy.js";

for (const flow of ["restart", "activation"]) {
  it(`turns an actual installed-SDK malformed token into fixed401 before ${flow} authorization`, async () => {
    const { publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    let providerReads = 0,
      databaseReads = 0,
      connections = 0;
    const verifier = createPrivyVerifier({
      appId: "synthetic-app",
      appSecret: "synthetic-secret",
      verificationKey: publicKey.export({ type: "spki", format: "pem" }),
      fetch: async () => {
        providerReads++;
        throw Error("must not contact provider for malformed JWT");
      },
    });
    const database = {
      async query() {
        databaseReads++;
        return {
          rows: [
            {
              id: randomUUID(),
              userId: "1",
              subject: "did:privy:synthetic",
              mode: "addition",
              expiresAt: new Date(Date.now() + 60000),
            },
          ],
        };
      },
      async connect() {
        connections++;
        throw Error("must not obtain mutation connection");
      },
    };
    const promise =
      flow === "restart"
        ? createProviderPasskeyBootstrap(database, verifier, {
            authorizeAttempt: async () =>
              assert.fail("no account authority from malformed token"),
          }).candidate({ token: "not.a.jwt", origin: "https://example.test" })
        : createProviderPasskeys(database, verifier).activationOptions({
            id: randomUUID(),
            token: "not.a.jwt",
            origin: "https://example.test",
            sessionTokenHash: "a".repeat(64),
          });
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof AccountOperationError);
      assert.equal(error.status, 401);
      assert.match(error.message, /Verify your Privy sign-in/);
      assert.doesNotMatch(error.message, /JWT|not\.a\.jwt/);
      return true;
    });
    assert.equal(providerReads, 0);
    assert.equal(connections, 0);
    assert.equal(databaseReads, flow === "restart" ? 0 : 1);
  });
  it(`preserves a bounded provider outage instead of describing it as bad ${flow} credentials`, async () => {
    const outage = new ProviderUnavailableError(
        "provider identity unavailable",
      ),
      database = {
        query: async () => ({
          rows: [
            {
              id: randomUUID(),
              subject: "did:privy:synthetic",
              mode: "addition",
            },
          ],
        }),
        connect: async () =>
          assert.fail("no mutation connection during outage"),
      },
      verifier = {
        verify: async () => {
          throw outage;
        },
      };
    const promise =
      flow === "restart"
        ? createProviderPasskeyBootstrap(database, verifier, {
            authorizeAttempt: async () =>
              assert.fail("no authority during outage"),
          }).candidate({
            token: "synthetic-token",
            origin: "https://example.test",
          })
        : createProviderPasskeys(database, verifier).activationOptions({
            id: randomUUID(),
            token: "synthetic-token",
            origin: "https://example.test",
            sessionTokenHash: "a".repeat(64),
          });
    await assert.rejects(promise, (error) => error === outage);
  });
}
