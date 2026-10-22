import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { AccountOperationError } from "../dist/platform/auth/account-operations.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";

const origin = "http://localhost:53024";
function fixture({ enabled = true, limiter = true, failure } = {}) {
  const calls = [];
  const projection = (accountId) => ({
    accountId,
    subject: `did:privy:synthetic-${accountId}`,
    chain: "ethereum",
    state: "ready",
    address: "0x1111111111111111111111111111111111111111",
    canRetry: false,
    retryAt: null,
  });
  const app = createApp({
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
    environment: "development",
    applicationOrigin: origin,
    users: {},
    sessions: {
      async findUserByTokenHash(hash) {
        const id =
          hash === hashSessionToken("synthetic-a")
            ? "401"
            : hash === hashSessionToken("synthetic-b")
              ? "402"
              : null;
        return id ? { id, email: null, createdAt: new Date() } : null;
      },
    },
    authProvider: {
      appId: "synthetic-embedded-wallet-app",
      verifier: {},
      accounts: {},
      embeddedWallet: enabled
        ? {
            repository: {
              async get(id) {
                calls.push(["get", id]);
                return projection(id);
              },
              async requestRetry(id) {
                calls.push(["retry", id]);
                return {
                  ...projection(id),
                  state: "pending",
                  address: null,
                };
              },
            },
            async authorizeAttempt(id) {
              calls.push(["authorize", id]);
              if (failure) throw failure;
            },
          }
        : undefined,
    },
    sharedAccountLimiter: limiter
      ? (_req, _res, next) => {
          calls.push(["shared-limit"]);
          next();
        }
      : undefined,
  });
  const call = (method, cookie = "synthetic-a") =>
    request(app)
      [method]("/api/auth/embedded-wallet")
      .set("Origin", origin)
      .set("Cookie", `session=${cookie}`);
  return { app, calls, call, projection };
}

describe("embedded wallet HTTP ownership and scheduling", () => {
  it("keeps guests and expired sessions private and never calls provisioning", async () => {
    const f = fixture();
    for (const method of ["get", "post"]) {
      const response = await f.call(method, "expired").send({});
      assert.equal(response.status, 401);
      assert.match(response.headers["cache-control"], /no-store/);
      assert.match(response.headers.vary, /Cookie/);
      assert.equal(response.headers["set-cookie"], undefined);
    }
    assert.deepEqual(f.calls, []);
  });

  it("returns status and address paired to the server-selected account", async () => {
    const f = fixture();
    const response = await f.call("get", "synthetic-b");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, f.projection("402"));
    assert.deepEqual(f.calls, [["get", "402"]]);
    assert.match(response.headers["cache-control"], /private, no-store/);
    assert.equal(response.headers["set-cookie"], undefined);
  });

  it("rejects body selectors and absent or stale account comparison before scheduling", async () => {
    const f = fixture();
    for (const body of [{ accountId: "402" }, { subject: "forged" }, []]) {
      const response = await f
        .call("post")
        .set("X-YapArena-Expected-Account", "401")
        .send(body);
      assert.equal(response.status, 400);
    }
    assert.equal((await f.call("post").send({})).status, 409);
    assert.equal(
      (
        await f
          .call("post", "synthetic-b")
          .set("X-YapArena-Expected-Account", "401")
          .send({})
      ).status,
      409,
    );
    assert.deepEqual(f.calls, []);
  });

  it("uses the verified cookie after the comparison fence and both abuse controls", async () => {
    const f = fixture();
    const response = await f
      .call("post", "synthetic-b")
      .set("X-YapArena-Expected-Account", "402")
      .send({});
    assert.equal(response.status, 202);
    assert.equal(response.body.accountId, "402");
    assert.equal(response.body.address, null);
    assert.deepEqual(f.calls, [
      ["shared-limit"],
      ["authorize", "402"],
      ["retry", "402"],
    ]);
    assert.equal(response.headers["set-cookie"], undefined);
  });

  it("fails closed when the provider integration or shared limiter is absent", async () => {
    for (const options of [{ enabled: false }, { limiter: false }]) {
      const f = fixture(options);
      const response = await f
        .call("post")
        .set("X-YapArena-Expected-Account", "401")
        .send({});
      assert.equal(response.status, 503);
      assert.deepEqual(f.calls, []);
    }
    const disabled = fixture({ enabled: false });
    assert.equal((await disabled.call("get")).status, 503);
  });

  it("does not schedule after throttling or a security-store outage", async () => {
    for (const status of [429, 503]) {
      const f = fixture({
        failure: new AccountOperationError(status, "retry unavailable"),
      });
      const response = await f
        .call("post")
        .set("X-YapArena-Expected-Account", "401")
        .send({});
      assert.equal(response.status, status);
      assert.deepEqual(f.calls, [["shared-limit"], ["authorize", "401"]]);
    }
  });

  it("rejects a foreign origin before any provisioning call", async () => {
    const f = fixture();
    const response = await f
      .call("post")
      .set("Origin", "https://foreign.example.test")
      .set("X-YapArena-Expected-Account", "401")
      .send({});
    assert.equal(response.status, 403);
    assert.deepEqual(f.calls, []);
  });
});
