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
});
