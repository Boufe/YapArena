import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";

import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { createApiRateLimiter } from "../dist/platform/security.js";
import {
  createSharedRateLimits,
  RateLimitStoreUnavailableError,
} from "../dist/platform/shared-abuse.js";

const namespace = "test-ns";
const secret = "shared-rate-limit-secret-0123456789";

// Mirrors the Redis fixed-window script: one counter per key, TTL = window.
function memoryAbuseStore() {
  const counts = new Map();
  const calls = [];
  return {
    calls,
    async increment(key, windowMs) {
      calls.push({ key, windowMs });
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { count, ttl: windowMs };
    },
  };
}

const failingAbuseStore = {
  increment: mock.fn(async () => {
    throw new Error("abuse store unavailable");
  }),
};

function shared(store) {
  const logger = { warn: mock.fn(), error: mock.fn() };
  const observe = mock.fn();
  return {
    logger,
    observe,
    limits: createSharedRateLimits({
      store,
      namespace,
      secret,
      logger,
      observe,
    }),
  };
}

function instance(sharedRateLimits, overrides = {}) {
  return createApp({
    messages: {},
    database: { query: async () => ({ rows: [] }) },
    sessions: {
      findUserByTokenHash: async () => ({ id: "1" }),
      deleteByTokenHash: async () => false,
    },
    logger: createLogger({ enabled: false }),
    sharedRateLimits,
    ...overrides,
  });
}

describe("shared API rate limits", () => {
  it("counts general API requests across instances through the shared store", async () => {
    const store = memoryAbuseStore();
    const { limits } = shared(store);
    const first = instance(limits, { apiRateLimit: 2 });
    const second = instance(limits, { apiRateLimit: 2 });

    assert.equal((await request(first).get("/health")).status, 200);
    assert.equal((await request(second).get("/health")).status, 200);
    const limited = await request(first).get("/health");
    assert.equal(limited.status, 429);
    assert.match(limited.headers.ratelimit, /"2-in-15min"; r=0; t=(900|899)/);
    assert.match(
      limited.headers["ratelimit-policy"],
      /"2-in-15min"; q=2; w=900/,
    );

    // Keys are HMAC digests scoped by limiter; no client address is stored.
    assert.equal(new Set(store.calls.map(({ key }) => key)).size, 1);
    assert.match(
      store.calls[0].key,
      /^test-ns:security:limit:api:api:[0-9a-f]{64}$/,
    );
    assert.doesNotMatch(store.calls[0].key, /127\.0\.0\.1|::1|ffff/);
    assert.equal(store.calls[0].windowMs, 15 * 60 * 1_000);
  });

  it("separates limiters and keys account-scoped limits by user", async () => {
    const store = memoryAbuseStore();
    const { limits } = shared(store);
    const app = instance(limits, {
      environment: "test",
      a4: { mode: "yap-coins", wallet: async () => ({ balance: "1" }) },
    });
    const response = await request(app)
      .get("/api/a4/wallet")
      .set("Cookie", "session=synthetic-cookie");
    assert.equal(response.status, 200);
    const prefixes = store.calls.map(({ key }) =>
      key.split(":").slice(0, 5).join(":"),
    );
    assert.deepEqual(prefixes, [
      "test-ns:security:limit:api:api",
      "test-ns:security:limit:api:a4",
    ]);
    assert.equal(store.calls[1].windowMs, 60_000);
  });

  it("fails open for general API limits with a metric and a throttled log", async () => {
    const { limits, logger, observe } = shared(failingAbuseStore);
    const app = instance(limits, { apiRateLimit: 1 });
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(app).get("/health");
      assert.equal(response.status, 200);
      assert.equal(response.headers.ratelimit, undefined);
    }
    assert.equal(observe.mock.callCount(), 3);
    assert.deepEqual(observe.mock.calls[0].arguments, ["fail_open"]);
    assert.equal(logger.warn.mock.callCount(), 1);
    assert.deepEqual(logger.warn.mock.calls[0].arguments, [
      { limiter: "api", failure: "open" },
      "shared rate limit unavailable; allowing requests",
    ]);
    // express-rate-limit's own store-error message is replaced by the log above.
    assert.equal(logger.error.mock.callCount(), 0);
  });

  it("keeps sign-in limiters fail-closed and logout available", async () => {
    const { limits, logger, observe } = shared(failingAbuseStore);
    const app = instance(limits);
    const refused = await request(app).get("/api/auth/login?connection=email");
    assert.equal(refused.status, 503);
    assert.equal(refused.headers["retry-after"], "5");
    assert.deepEqual(refused.body, {
      error: "sign-in protection is temporarily unavailable; try again shortly",
    });
    assert.ok(
      observe.mock.calls.some(({ arguments: [outcome] }) => {
        return outcome === "unavailable";
      }),
    );
    assert.ok(
      logger.warn.mock.calls.some(
        ({ arguments: [fields] }) =>
          fields.limiter === "auth" && fields.failure === "closed",
      ),
    );
    const logout = await request(app).post("/api/auth/logout");
    assert.notEqual(logout.status, 503);
  });

  it("keeps the confirmation route on the fail-closed shared sign-in limit", async () => {
    const store = memoryAbuseStore();
    const { limits } = shared(store);
    await request(instance(limits))
      .get(`/api/auth/confirm?operation=${randomUUID()}`)
      .set("Cookie", "session=synthetic-cookie");
    assert.ok(
      store.calls.some(({ key }) =>
        key.startsWith("test-ns:security:limit:api:auth:"),
      ),
    );
    const { limits: failing, observe } = shared(failingAbuseStore);
    const refused = await request(instance(failing))
      .get(`/api/auth/confirm?operation=${randomUUID()}`)
      .set("Cookie", "session=synthetic-cookie");
    assert.equal(refused.status, 503);
    assert.equal(refused.headers["retry-after"], "5");
    assert.ok(
      observe.mock.calls.some(
        ({ arguments: [outcome] }) => outcome === "unavailable",
      ),
    );
  });

  it("keeps the in-memory limiter without a shared store", async () => {
    const app = instance(undefined, { apiRateLimit: 1 });
    assert.equal((await request(app).get("/health")).status, 200);
    assert.equal((await request(app).get("/health")).status, 429);
  });

  it("passes unrelated limiter errors to the error handler", async () => {
    const { limits } = shared(memoryAbuseStore());
    const app = express();
    app.use(
      createApiRateLimiter({
        windowMs: 60_000,
        limit: 5,
        keyGenerator: () => {
          throw new Error("key unavailable");
        },
        shared: limits("closed-test", "closed"),
      }),
    );
    app.use((error, _request, response, _next) => {
      void _next;
      response.status(500).json({ error: error.message });
    });
    const response = await request(app).get("/");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: "key unavailable" });
  });

  it("validates configuration and routes library diagnostics to the app logger", async () => {
    const { limits, logger } = shared(memoryAbuseStore());
    assert.throws(() => limits("Bad Name", "open"), /rate limit name/);
    for (const options of [
      { namespace: "Bad Namespace", secret },
      { namespace, secret: "short" },
    ])
      assert.throws(
        () =>
          createSharedRateLimits({
            store: memoryAbuseStore(),
            logger,
            ...options,
          }),
        /invalid shared abuse configuration/,
      );
    const limit = limits("diagnostics", "open");
    await limit.store.decrement("key");
    await limit.store.resetKey("key");
    limit.logger.error(new RateLimitStoreUnavailableError(), "suppressed");
    assert.equal(logger.error.mock.callCount(), 0);
    const failure = new Error("validation");
    limit.logger.error(failure, "reported");
    limit.logger.warn(failure, "warned");
    assert.deepEqual(logger.error.mock.calls[0].arguments, [
      { error: failure, limiter: "diagnostics" },
      "reported",
    ]);
    assert.deepEqual(logger.warn.mock.calls[0].arguments, [
      { error: failure, limiter: "diagnostics" },
      "warned",
    ]);
  });
});
