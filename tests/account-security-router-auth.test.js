import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import request from "../scripts/test-http-request.ts";
import { createAccountSecurityRouter } from "../dist/platform/auth/security-router.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import { AccountOperationError } from "../dist/platform/auth/account-operations.js";
const origin = "https://yaparena.example.test",
  userId = "823",
  id = randomUUID(),
  keyId = randomUUID();
const registration = {
  id: "AQID",
  rawId: "AQID",
  type: "public-key",
  response: { clientDataJSON: "AQID", attestationObject: "AQID" },
  clientExtensionResults: {},
};
function fixture(overrides = {}) {
  const seen = [],
    options = {
      sessions: {
        async findUserByTokenHash(token) {
          return token === hashSessionToken("synthetic-cookie")
            ? { id: userId, email: null, createdAt: new Date() }
            : null;
        },
      },
      operations: {
        async create(input) {
          seen.push({ kind: "create", input });
          return {
            id,
            expiresAt: new Date(),
            authorizationMessage: null,
            sessionTokenHash: input.sessionTokenHash,
          };
        },
        async prepare(input) {
          seen.push({ kind: "prepare", input });
          return {
            purpose: input.purpose,
            termsDigest: "a".repeat(64),
            assertContext() {},
            async consume() {},
          };
        },
      },
      passkeys: {
        async list(value) {
          seen.push({ kind: "list", value });
          return [];
        },
        async enrollmentOptions(input) {
          seen.push({ kind: "options", input });
          return { id, options: { challenge: "AQID" }, bootstrapAllowed: true };
        },
        async completeEnrollment(input) {
          seen.push({ kind: "complete", input });
          return { keyId, token: "synthetic-rotated-cookie" };
        },
        async remove(input) {
          seen.push({ kind: "remove", input });
          return { token: "synthetic-rotated-cookie" };
        },
      },
      environment: "production",
      applicationOrigin: origin,
      ...overrides,
    };
  const app = express()
    .use(express.json())
    .use(cookieParser())
    .use("/api/auth", createAccountSecurityRouter(options));
  const call = (method, path) =>
    request(app)
      [method](`/api/auth/security${path}`)
      .set("Cookie", "__Host-session=synthetic-cookie")
      .set("Origin", origin);
  return { app, seen, call };
}
describe("security passkey HTTP boundaries", () => {
  it("disables new external-wallet links before proof consumption and keeps retained removal", async () => {
    const calls = [];
    const { call } = fixture({
      allowExternalWalletLinks: false,
      walletOperations: {
        async create(input) {
          calls.push(input);
          return { id };
        },
        async complete(input) {
          calls.push(input);
          return { token: "synthetic", wallet: { id } };
        },
      },
    });
    const target = {
      purpose: "link",
      address: `0x${"11".repeat(20)}`,
      chainId: 1,
    };
    const created = await call("post", "/wallet/operations").send({
      ...target,
      credential: { type: "passkey", keyId },
    });
    const completed = await call(
      "post",
      `/wallet/operations/${id}/complete`,
    ).send({
      ...target,
      approval: { id, password: "synthetic" },
      proposedSignature: "0x1234",
    });
    for (const response of [created, completed]) {
      assert.equal(response.status, 410);
      assert.equal(response.headers["set-cookie"], undefined);
    }
    assert.deepEqual(calls, []);
    const removed = await call("post", "/wallet/operations").send({
      ...target,
      purpose: "unlink",
      targetWalletId: keyId,
      credential: { type: "passkey", keyId },
    });
    assert.equal(removed.status, 200);
    assert.equal(calls[0].purpose, "unlink");
  });
  it("restarts a first provider passkey only through server-verified bearer context and a native proof", async () => {
    const calls = [];
    const { app } = fixture({
      sessions: {
        async findUserByTokenHash() {
          throw new Error("restart is sessionless");
        },
      },
      providerPasskeyBootstrap: {
        async candidate(input) {
          calls.push(input);
          return { code: "first_passkey_restart_available" };
        },
        async restart(input) {
          calls.push(input);
          return { id, authenticationOptions: { challenge: "AQID" } };
        },
        async complete(input) {
          calls.push(input);
          return { keyId, token: "synthetic-first-key-cookie" };
        },
      },
    });
    const invoke = (path) =>
      request(app)
        .post(`/api/auth/security/provider/passkeys/bootstrap${path}`)
        .set("Origin", origin)
        .set("Authorization", "Bearer synthetic-provider-evidence");
    assert.equal((await invoke("/candidate").send({ userId })).status, 400);
    assert.equal(
      (await invoke("/restart").send({ credentialsVerified: true })).status,
      400,
    );
    assert.equal(
      (await invoke("/candidate").set("Authorization", "").send({})).status,
      401,
    );
    assert.equal(
      (
        await invoke("/restart")
          .set("Origin", "https://attacker.example")
          .send({})
      ).status,
      403,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (await invoke("/candidate").send({})).body.code,
      "first_passkey_restart_available",
    );
    assert.equal((await invoke("/restart").send({})).body.id, id);
    const authentication = {
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: "AQID",
        authenticatorData: "AQID",
        signature: "AQID",
      },
    };
    assert.equal(
      (
        await invoke(`/${id}/complete`).send({
          authentication,
          mfaCompleted: true,
        })
      ).status,
      400,
    );
    const completed = await invoke(`/${id}/complete`).send({ authentication });
    assert.equal(completed.status, 200);
    assert.match(
      completed.headers["set-cookie"][0],
      /^__Host-session=synthetic-first-key-cookie;/,
    );
    for (const input of calls) {
      assert.equal(input.userId, undefined);
      assert.equal(input.token, "synthetic-provider-evidence");
      assert.equal(input.origin, origin);
    }
    assert.deepEqual(calls.at(-1).authentication, authentication);
  });

  it("scopes interrupted Privy setup to its original cookie and provider evidence without reopening ordinary protected actions", async () => {
    const terms = {
      intentId: id,
      subject: "did:privy:synthetic",
      beforeDigest: "a".repeat(64),
    };
    const calls = [];
    const { app, seen, call } = fixture({
      async authorizeProviderPasskeyAttempt(value) {
        assert.equal(value, "917");
        calls.push({ kind: "accountAttempt" });
      },
      sessions: {
        async findUserByTokenHash() {
          throw new Error(
            "ordinary protected access is unavailable during pending setup",
          );
        },
      },
      providerPasskeys: {
        async activationOptions(input) {
          assert.equal(input.id, id);
          assert.equal(
            input.sessionTokenHash,
            hashSessionToken("synthetic-cookie"),
          );
          assert.equal(input.token, "synthetic-provider-evidence");
          assert.equal(input.origin, origin);
          calls.push({ kind: "activation", input });
          return {
            id,
            userId: "917",
            terms,
            bootstrapAllowed: false,
            expiresAt: new Date(),
            before: [],
            after: [],
            authenticationOptions: { challenge: "AQID" },
          };
        },
        async complete(input) {
          calls.push({ kind: "complete", input });
          assert.equal(input.approval.purpose, "provider.passkey.link");
          return { keyId, token: "synthetic-privy-key-cookie" };
        },
      },
    });
    const scoped = (suffix) =>
      call("post", `/provider/passkeys/${id}/${suffix}`).set(
        "Authorization",
        "Bearer synthetic-provider-evidence",
      );
    const activation = await scoped("activation").send({});
    assert.equal(activation.status, 200);
    assert.equal(
      activation.body.userId,
      undefined,
      "internal validated owner is not exposed",
    );
    assert.deepEqual(activation.body.terms, terms);
    assert.equal(
      (await scoped("activation").send({ userId: "917" })).status,
      400,
    );
    assert.equal(
      (
        await scoped("operations").send({
          credential: { type: "password" },
          purpose: "withdrawal",
        })
      ).status,
      400,
    );
    const issued = await scoped("operations").send({
      credential: { type: "password" },
    });
    assert.equal(issued.status, 200);
    assert.deepEqual(issued.body.terms, terms);
    assert.equal(seen.at(-1).input.userId, "917");
    assert.equal(seen.at(-1).input.purpose, "provider.passkey.link");
    assert.deepEqual(seen.at(-1).input.terms, terms);
    const authentication = {
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: "AQID",
        authenticatorData: "AQID",
        signature: "AQID",
      },
    };
    const completed = await scoped("complete").send({
      authentication,
      approval: { id, password: "synthetic-retained-proof" },
    });
    assert.equal(completed.status, 200);
    assert.match(
      completed.headers["set-cookie"][0],
      /^__Host-session=synthetic-privy-key-cookie;/,
    );
    assert.equal(seen.at(-1).input.userId, "917");
    assert.deepEqual(seen.at(-1).input.terms, terms);
    assert.equal(calls.filter((entry) => entry.kind === "complete").length, 1);
    assert.equal(
      calls.filter((entry) => entry.kind === "accountAttempt").length,
      2,
    );
    const before = calls.length;
    assert.equal(
      (
        await request(app)
          .post(`/api/auth/security/provider/passkeys/${id}/activation`)
          .set("Origin", origin)
          .set("Authorization", "Bearer synthetic-provider-evidence")
          .send({})
      ).status,
      401,
    );
    assert.equal(
      (await call("post", `/provider/passkeys/${id}/activation`).send({}))
        .status,
      401,
    );
    assert.equal(
      (
        await scoped("activation")
          .set("Origin", "https://attacker.example")
          .send({})
      ).status,
      403,
    );
    assert.equal(
      calls.length,
      before,
      "invalid context is rejected before trusted intent inspection",
    );
  });

  it("uses authenticated Privy enrollment intents and disables the second registration API when the provider owns enrollment", async () => {
    const calls = [];
    const { call } = fixture({
      providerPasskeys: {
        async begin(input) {
          calls.push(input);
          return { id, bootstrapAllowed: true, terms: { intentId: id } };
        },
      },
    });
    assert.equal(
      (await call("post", "/provider/passkeys").send({ userId })).status,
      400,
    );
    assert.equal(
      (
        await call("post", "/provider/passkeys").send({
          credentialId: "invalid value",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("post", "/provider/passkeys").send({})).status,
      200,
    );
    assert.equal(calls[0].userId, userId);
    assert.equal(
      calls[0].sessionTokenHash,
      hashSessionToken("synthetic-cookie"),
    );
    assert.equal(
      (await call("post", "/provider/passkeys").send({ credentialId: "AQID" }))
        .status,
      200,
    );
    assert.equal(calls[1].credentialId, "AQID");
    assert.equal(
      (await call("post", "/passkeys/enrollment").send({})).status,
      409,
    );
    assert.equal(
      (
        await call("post", `/passkeys/enrollment/${id}/complete`).send({
          response: registration,
        })
      ).status,
      409,
    );
  });

  it("fails closed on a missing or exhausted server-derived account budget before checking resumed proofs", async () => {
    for (const status of [503, 429]) {
      const { seen, call } = fixture({
        ...(status === 429
          ? {
              async authorizeProviderPasskeyAttempt(value) {
                assert.equal(value, userId);
                throw new AccountOperationError(429, "too many attempts");
              },
            }
          : {}),
        providerPasskeys: {
          async activationOptions() {
            return { userId, terms: { intentId: id } };
          },
          async complete() {
            throw new Error("must not complete without the account budget");
          },
        },
      });
      for (const [suffix, body] of [
        ["operations", { credential: { type: "password" } }],
        [
          "complete",
          { approval: { id, password: "synthetic" }, authentication: {} },
        ],
      ]) {
        const response = await call(
          "post",
          `/provider/passkeys/${id}/${suffix}`,
        )
          .set("Authorization", "Bearer synthetic-provider-evidence")
          .send(body);
        assert.equal(response.status, status);
        assert.equal(response.headers["set-cookie"], undefined);
      }
      assert.equal(
        seen.length,
        0,
        "no credential check or operation creation before the shared budget",
      );
    }
  });

  it("provides sessionless key login without trusting an app cookie, account selector or browser credential flags", async () => {
    const seen = [];
    const { app } = fixture({
      sessions: {
        async findUserByTokenHash() {
          throw new Error("public key login must not use a stale app cookie");
        },
      },
      access: {
        async loginOptions(input) {
          seen.push(input);
          return { id, authenticationOptions: { challenge: "AQID" } };
        },
        async login(input) {
          seen.push(input);
          return { token: "synthetic-key-cookie" };
        },
      },
    });
    const call = (path) =>
      request(app)
        .post(`/api/auth/security/access${path}`)
        .set("Origin", origin);
    assert.equal((await call("/login").send({ userId })).status, 400);
    assert.equal(
      (await call("/login").set("Origin", "https://attacker.example").send({}))
        .status,
      403,
    );
    assert.equal((await call("/login").send({})).status, 200);
    const authentication = {
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: {
        clientDataJSON: "AQID",
        authenticatorData: "AQID",
        signature: "AQID",
        userHandle: "AQID",
      },
      clientExtensionResults: {},
    };
    assert.equal(
      (
        await call(`/login/${id}/complete`).send({
          authentication,
          mfaCompleted: true,
        })
      ).status,
      400,
    );
    const response = await call(`/login/${id}/complete`).send({
      authentication,
    });
    assert.equal(response.status, 204);
    assert.match(
      response.headers["set-cookie"][0],
      /^__Host-session=synthetic-key-cookie;/,
    );
    assert.equal(seen.at(-1).userId, undefined);
    assert.equal(seen.at(-1).authentication.response.userHandle, "AQID");
  });
  it("binds sessionless reconciliation to bearer identity and one exact proof ID without browser ownership fields", async () => {
    const seen = [],
      { app } = fixture({
        access: {
          async reconciliationCandidate(token) {
            seen.push(token);
            return { before: [], after: [] };
          },
          async reconciliationOptions(input) {
            seen.push(input);
            return { id };
          },
          async reconcile(input) {
            seen.push(input);
            return { token: "synthetic-recovered-cookie" };
          },
        },
      });
    const call = (path) =>
      request(app)
        .post(`/api/auth/security/access/reconciliation${path}`)
        .set("Origin", origin)
        .set("Authorization", "Bearer synthetic-provider-token");
    assert.equal(
      (
        await request(app)
          .post("/api/auth/security/access/reconciliation/candidate")
          .set("Origin", origin)
          .send({})
      ).status,
      401,
    );
    assert.equal((await call("/candidate").send({})).status, 200);
    assert.equal(
      (await call("").send({ credential: { type: "password" }, userId }))
        .status,
      400,
    );
    assert.equal(
      (await call("").send({ credential: { type: "password" } })).status,
      200,
    );
    assert.equal(
      (
        await call(`/${id}/complete`).send({
          approval: { id: randomUUID(), password: "synthetic" },
        })
      ).status,
      400,
    );
    const response = await call(`/${id}/complete`).send({
      approval: { id, password: "synthetic" },
    });
    assert.equal(response.status, 204);
    assert.equal(seen.at(-1).token, "synthetic-provider-token");
    assert.equal(seen.at(-1).userId, undefined);
    assert.match(
      response.headers["set-cookie"][0],
      /^__Host-session=synthetic-recovered-cookie;/,
    );
  });
  it("consumes an operation-specific prior approval before allowing the provider-change UI", async () => {
    const seen = [],
      { call } = fixture({
        operations: {
          async authorize(input) {
            seen.push(input);
          },
        },
      }),
      terms = { action: "update", method: "email", target: "new@example.test" };
    assert.equal(
      (
        await call("post", "/provider/change").send({
          terms,
          approval: { id, password: "synthetic" },
        })
      ).status,
      204,
    );
    assert.equal(seen[0].purpose, "provider.credentials.change");
    assert.deepEqual(seen[0].terms, terms);
    assert.equal(seen[0].userId, userId);
    assert.equal(
      (
        await call("post", "/provider/change").send({
          terms: { ...terms, amount: "1" },
          approval: { id },
        })
      ).status,
      400,
    );
  });
  it("requires an application cookie and exact origin and rejects account selectors or arbitrary operations", async () => {
    const { app, call } = fixture();
    assert.equal(
      (await request(app).get("/api/auth/security/passkeys")).status,
      401,
    );
    assert.equal(
      (
        await call("post", "/passkeys/enrollment")
          .set("Origin", "https://attacker.example")
          .send({})
      ).status,
      403,
    );
    assert.equal(
      (await call("post", "/passkeys/enrollment").send({ userId: "another" }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("post", "/operations").send({
          purpose: "withdrawal.request",
          terms: { keyId },
          credential: { type: "password" },
        })
      ).status,
      400,
    );
    for (const credential of [
      { type: "passkey", keyId: "invalid" },
      { type: "wallet", walletId: "invalid" },
      { type: "password", accountId: "another" },
      { type: "unknown" },
    ])
      assert.equal(
        (
          await call("post", "/operations").send({
            purpose: "security.passkey.enroll",
            terms: { challengeId: id },
            credential,
          })
        ).status,
        400,
      );
  });
  it("binds operation issuance to the verified account/cookie and omits private stored fields", async () => {
    const { call, seen } = fixture();
    for (const credential of [
      { type: "password" },
      { type: "wallet", walletId: randomUUID() },
      { type: "passkey", keyId },
    ]) {
      const response = await call("post", "/operations").send({
        purpose: "security.passkey.enroll",
        terms: { challengeId: id },
        credential,
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.id, id);
      assert.equal(seen.at(-1).input.userId, userId);
      assert.equal(
        seen.at(-1).input.sessionTokenHash,
        hashSessionToken("synthetic-cookie"),
      );
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /sessionTokenHash|authGeneration|authorizing/,
      );
    }
  });
  it("returns bootstrap eligibility from the server and publishes a secure cookie only after completion", async () => {
    const { call, seen } = fixture();
    assert.equal((await call("get", "/passkeys")).status, 200);
    const options = await call("post", "/passkeys/enrollment").send({});
    assert.equal(options.body.bootstrapAllowed, true);
    const result = await call(
      "post",
      `/passkeys/enrollment/${id}/complete`,
    ).send({ response: registration });
    assert.equal(result.status, 200);
    assert.equal(result.body.keyId, keyId);
    assert.match(
      result.headers["set-cookie"][0],
      /^__Host-session=synthetic-rotated-cookie;/,
    );
    for (const attribute of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"])
      assert.ok(result.headers["set-cookie"][0].includes(attribute));
    assert.equal(seen.at(-1).input.approval, undefined);
  });
  it("fixes sensitive purpose/target on the server and validates WebAuthn and proof payloads", async () => {
    const { call, seen } = fixture();
    const result = await call(
      "post",
      `/passkeys/enrollment/${id}/complete`,
    ).send({ response: registration, approval: { id, password: "synthetic" } });
    assert.equal(result.status, 200);
    const prepared = seen.find((event) => event.kind === "prepare").input;
    assert.equal(prepared.purpose, "security.passkey.enroll");
    assert.deepEqual(prepared.terms, { challengeId: id });
    assert.equal(
      (
        await call("post", `/passkeys/enrollment/${id}/complete`).send({
          response: { ...registration, response: {} },
          approval: { id },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("post", `/passkeys/enrollment/${id}/complete`).send({
          response: registration,
          approval: { id, userId: "another" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("delete", `/passkeys/${keyId}`).send({
          approval: { id, signature: "0x1234" },
        })
      ).status,
      204,
    );
    const removed = seen
      .filter((event) => event.kind === "prepare")
      .at(-1).input;
    assert.equal(removed.purpose, "security.passkey.remove");
    assert.deepEqual(removed.terms, { keyId });
  });
  it("does not publish replacement cookies for rejected or expired approvals", async () => {
    const { call } = fixture({
      passkeys: {
        async completeEnrollment() {
          throw new AccountOperationError(
            410,
            "approval expired or invalid; start again",
          );
        },
      },
    });
    const response = await call(
      "post",
      `/passkeys/enrollment/${id}/complete`,
    ).send({ response: registration });
    assert.equal(response.status, 410);
    assert.equal(response.headers["set-cookie"], undefined);
  });
  it("binds the security-key wallet path to the authenticated account and exact stored operation", async () => {
    const seen = [];
    const { call } = fixture({
      walletOperations: {
        async create(input) {
          seen.push(input);
          return { id, proposedMessage: "synthetic target proof" };
        },
        async complete(input) {
          seen.push(input);
          return {
            wallet: {
              id: keyId,
              address: input.address,
              chainId: String(input.chainId),
            },
            token: "synthetic-rotated-cookie",
          };
        },
      },
    });
    const target = {
      purpose: "link",
      address: `0x${"11".repeat(20)}`,
      chainId: 1,
    };
    const created = await call("post", "/wallet/operations").send({
      ...target,
      credential: { type: "passkey", keyId },
    });
    assert.equal(created.status, 200);
    assert.equal(seen[0].userId, userId);
    assert.equal(
      seen[0].sessionTokenHash,
      hashSessionToken("synthetic-cookie"),
    );
    const completed = await call(
      "post",
      `/wallet/operations/${id}/complete`,
    ).send({
      ...target,
      approval: { id, password: "synthetic" },
      proposedSignature: "0x1234",
    });
    assert.equal(completed.status, 200);
    assert.equal(seen.at(-1).purpose, "link");
    assert.equal(completed.body.wallet.address, target.address);
    assert.match(
      completed.headers["set-cookie"][0],
      /^__Host-session=synthetic-rotated-cookie/,
    );
    for (const body of [
      { ...target, chainId: "1", credential: { type: "password" } },
      { ...target, purpose: "other", credential: { type: "password" } },
      { ...target, accountId: "another", credential: { type: "password" } },
    ])
      assert.equal(
        (await call("post", "/wallet/operations").send(body)).status,
        400,
      );
    assert.equal(
      (
        await call("post", `/wallet/operations/${id}/complete`).send({
          ...target,
          approval: { id: randomUUID(), password: "synthetic" },
          proposedSignature: "0x1234",
        })
      ).status,
      400,
    );
  });
  it("requires provider evidence in a redacted authorization header and binds legacy linking to the live account", async () => {
    const seen = [];
    const { call } = fixture({
      legacyProviderLink: {
        async candidate(userId, token) {
          seen.push({ userId, token });
          return { email: "verified@example.test", methods: ["email"] };
        },
        async create(input) {
          seen.push(input);
          return { id, email: "verified@example.test", methods: ["email"] };
        },
        async complete(input) {
          seen.push(input);
          return { token: "synthetic-rotated-cookie" };
        },
      },
    });
    assert.equal(
      (await call("post", "/provider/candidate").send({})).status,
      401,
    );
    const candidate = await call("post", "/provider/candidate")
      .set("Authorization", "Bearer synthetic-provider-token")
      .send({});
    assert.equal(candidate.status, 200);
    assert.equal(seen[0].userId, userId);
    assert.equal(seen[0].token, "synthetic-provider-token");
    assert.doesNotMatch(
      JSON.stringify(candidate.body),
      /token|subject|credentialsDigest/,
    );
    assert.equal(
      (
        await call("post", "/provider/link")
          .set("Authorization", "Bearer synthetic-provider-token")
          .send({ credential: { type: "password" }, userId: "other" })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("post", "/provider/link")
          .set("Authorization", "Bearer synthetic-provider-token")
          .send({ credential: { type: "password" } })
      ).status,
      200,
    );
    const done = await call("post", `/provider/link/${id}/complete`)
      .set("Authorization", "Bearer synthetic-provider-token")
      .send({ approval: { id, password: "synthetic" } });
    assert.equal(done.status, 204);
    assert.equal(seen.at(-1).userId, userId);
    assert.match(
      done.headers["set-cookie"][0],
      /^__Host-session=synthetic-rotated-cookie/,
    );
  });
});
