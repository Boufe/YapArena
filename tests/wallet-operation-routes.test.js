import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  WalletOperationError,
  WalletAlreadyLinkedError,
} from "../dist/platform/auth/wallet-operations.js";
import { WalletVerificationUnavailableError } from "../dist/platform/auth/siwe.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";

const id = "11111111-1111-4111-8111-111111111111";
const address = `0x${"ab".repeat(20)}`;
const user = { id: "7", email: "synthetic@example.test" };
const target = { purpose: "link", address, chainId: 1 };
function fixture({
  error,
  signedIn = true,
  environment = "development",
  authRateLimit = 100,
} = {}) {
  const operations = {
    create: mock.fn(async (input) => {
      if (error) throw error;
      return {
        ...input,
        id,
        proposedMessage: "new proof",
        authorizationMessage: null,
      };
    }),
    complete: mock.fn(async () => {
      if (error) throw error;
      return {
        wallet: { id, address, chainId: "1" },
        token: "synthetic-replacement",
      };
    }),
  };
  const app = createApp({
    users: {},
    messages: {},
    logger: createLogger({ enabled: false }),
    sessions: { findUserByTokenHash: async () => (signedIn ? user : null) },
    wallets: { operations, listWallets: async () => [] },
    environment,
    applicationOrigin: "https://arena.example.test",
    authRateLimit,
  });
  const call = (path, body, method = "post") =>
    request(app)
      [method](path)
      .set(
        "Cookie",
        environment === "production"
          ? "__Host-session=synthetic"
          : "session=synthetic",
      )
      .set("Origin", "https://arena.example.test")
      .send(body);
  return { app, operations, call };
}

describe("wallet credential-management HTTP gate", () => {
  it("removes the cookie-only legacy mutation API", async () => {
    const { call, operations } = fixture();
    for (const path of [
      "/api/auth/wallet/link/challenge",
      "/api/auth/wallet/link/verify",
    ])
      assert.equal((await call(path, target)).status, 404);
    assert.equal(
      (await call(`/api/auth/wallets/${id}`, undefined, "delete")).status,
      404,
    );
    assert.equal(operations.complete.mock.callCount(), 0);
  });
  it("requires authentication and validates exact operation input", async () => {
    assert.equal(
      (
        await fixture({ signedIn: false }).call(
          "/api/auth/wallet/operations",
          target,
        )
      ).status,
      401,
    );
    const { call, operations } = fixture();
    for (const body of [
      null,
      [],
      {},
      target,
      { ...target, credential: { type: "new-wallet" } },
      { ...target, credential: { type: "wallet", walletId: "bad" } },
      { ...target, purpose: "unlink", credential: { type: "password" } },
    ])
      assert.equal(
        (await call("/api/auth/wallet/operations", body)).status,
        400,
      );
    assert.equal(operations.create.mock.callCount(), 0);
    assert.equal(
      (
        await call("/api/auth/wallet/operations", {
          ...target,
          credential: { type: "password" },
        })
      ).status,
      201,
    );
    const input = operations.create.mock.calls[0].arguments[0];
    assert.equal(input.userId, user.id);
    assert.match(input.sessionTokenHash, /^[a-f0-9]{64}$/);
  });
  it("rotates a host-only cookie only on successful completion and never returns the token in JSON", async () => {
    const { call } = fixture({ environment: "production" });
    const result = await call(`/api/auth/wallet/operations/${id}/complete`, {
      ...target,
      password: "synthetic password",
      proposedSignature: "0xaa",
    });
    assert.equal(result.status, 200);
    assert.match(
      result.headers["set-cookie"][0],
      /^__Host-session=synthetic-replacement;/,
    );
    assert.match(result.headers["set-cookie"][0], /Secure/);
    assert.match(result.headers["set-cookie"][0], /HttpOnly/);
    assert.equal(result.body.token, undefined);
  });
  it("rejects malformed proofs and retains origin protection", async () => {
    const { call, app, operations } = fixture({ environment: "production" });
    for (const body of [
      {},
      { ...target, password: 12 },
      { ...target, password: "x".repeat(513) },
      { ...target, proposedSignature: false },
      { ...target, authorizationSignature: "x".repeat(8195) },
    ])
      assert.equal(
        (await call(`/api/auth/wallet/operations/${id}/complete`, body)).status,
        400,
      );
    assert.equal(
      (await call("/api/auth/wallet/operations/bad/complete", target)).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/auth/wallet/operations")
          .set("Cookie", "__Host-session=synthetic")
          .set("Origin", "https://attacker.example.test")
          .send(target)
      ).status,
      403,
    );
    assert.equal(operations.complete.mock.callCount(), 0);
  });
  it("maps rejected approvals and provider failures without issuing cookies", async () => {
    for (const [error, status] of [
      [new WalletOperationError(410, "expired"), 410],
      [new SessionUnavailableError(), 401],
      [new WalletAlreadyLinkedError(), 409],
      [new WalletVerificationUnavailableError(), 503],
      [new Error("synthetic database outage"), 500],
    ]) {
      const { call } = fixture({ error });
      for (const [path, body] of [
        [
          "/api/auth/wallet/operations",
          { ...target, credential: { type: "password" } },
        ],
        [`/api/auth/wallet/operations/${id}/complete`, target],
      ]) {
        const result = await call(path, body);
        assert.equal(result.status, status);
        assert.equal(result.headers["set-cookie"], undefined);
      }
    }
  });
  it("throttles reauthentication attempts and account-scopes wallet inventory", async () => {
    const { call, app } = fixture({ authRateLimit: 1 });
    assert.equal(
      (await call(`/api/auth/wallet/operations/${id}/complete`, target)).status,
      200,
    );
    assert.equal(
      (await call(`/api/auth/wallet/operations/${id}/complete`, target)).status,
      429,
    );
    assert.equal(
      (
        await request(app)
          .get("/api/auth/wallets")
          .set("Cookie", "session=synthetic")
      ).status,
      200,
    );
  });
});
