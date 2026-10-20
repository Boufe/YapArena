import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import {
  createRedisAbuseStore,
  createSharedAbuseLimiter,
  createSharedAccountAttemptLimiter,
} from "../dist/platform/shared-abuse.js";

it("scopes resolved-account recovery attempts independently, without storing account identifiers or caching authorization", async () => {
  const counters = new Map(),
    outcomes = [];
  const options = {
    store: {
      async increment(key) {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return { count, ttl: 3000 };
      },
    },
    namespace: "isolated",
    secret: "s".repeat(32),
    limit: 1,
    windowMs: 3000,
    observe: (outcome) => outcomes.push(outcome),
  };
  const first = createSharedAccountAttemptLimiter(options),
    second = createSharedAccountAttemptLimiter(options);
  assert.equal(await first("12345678901234", "security.login"), "allowed");
  assert.equal(await second("12345678901234", "security.login"), "throttled");
  assert.equal(
    await second("12345678901234", "provider.credentials.reconcile"),
    "allowed",
  );
  assert.equal(await second("12345678901235", "security.login"), "allowed");
  assert.equal(
    [...counters.keys()].some((key) => key.includes("12345678901234")),
    false,
  );
  const unavailable = createSharedAccountAttemptLimiter({
    ...options,
    store: {
      async increment() {
        throw new Error("private cause");
      },
    },
  });
  assert.equal(
    await unavailable("12345678901234", "security.login"),
    "unavailable",
  );
  await assert.rejects(
    first("browser-choice", "security.login"),
    /verified recovery/,
  );
  await assert.rejects(first("1", "arbitrary-operation"), /verified recovery/);
  assert.throws(
    () => createSharedAccountAttemptLimiter({ ...options, limit: 0 }),
    /invalid shared abuse/,
  );
  assert.throws(
    () =>
      createSharedAccountAttemptLimiter({
        ...options,
        namespace: "PII:unsafe",
      }),
    /invalid shared abuse/,
  );
  assert.throws(
    () => createSharedAccountAttemptLimiter({ ...options, secret: "short" }),
    /invalid shared abuse/,
  );
  assert.throws(
    () => createSharedAccountAttemptLimiter({ ...options, windowMs: 999 }),
    /invalid shared abuse/,
  );
  assert.deepEqual(outcomes, [
    "allowed",
    "throttled",
    "allowed",
    "allowed",
    "unavailable",
  ]);
});

// Protocol fixtures exercise the actual locked Redis client. Operational
// acceptance separately uses a real, verifier-owned Redis container.
async function redisFixture({
  policy = "noeviction",
  silent = false,
  reply,
} = {}) {
  const sockets = new Set();
  const state = { policy, connections: 0, evaluations: 0 };
  const server = createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        const headerEnd = pending.indexOf("\r\n");
        if (headerEnd < 0) return;
        const count = Number(pending.subarray(1, headerEnd).toString());
        const command = [];
        let offset = headerEnd + 2;
        for (let i = 0; i < count; i++) {
          const end = pending.indexOf("\r\n", offset);
          if (end < 0) return;
          const length = Number(pending.subarray(offset + 1, end).toString());
          if (pending.length < end + 2 + length + 2) return;
          command.push(pending.subarray(end + 2, end + 2 + length).toString());
          offset = end + 2 + length + 2;
        }
        pending = pending.subarray(offset);
        if (silent) continue;
        switch (command[0]?.toUpperCase()) {
          case "HELLO":
            socket.write("%1\r\n+proto\r\n:3\r\n");
            break;
          case "INFO": {
            const memory = `# Memory\r\nmaxmemory_policy:${state.policy}\r\n`;
            socket.write(`$${Buffer.byteLength(memory)}\r\n${memory}\r\n`);
            break;
          }
          case "EVAL":
            state.evaluations++;
            if (reply !== null) socket.write(reply ?? "*2\r\n:1\r\n:1500\r\n");
            break;
          default:
            socket.write("+OK\r\n");
        }
      }
    });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    state,
    url: `redis://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const options = {
  store: { increment: async () => ({ count: 1, ttl: 1500 }) },
  namespace: "security-test",
  secret: "synthetic-key-material".repeat(2),
  scope: "auth",
  limit: 2,
  windowMs: 1500,
};

describe("shared abuse operational boundaries", () => {
  it("rejects invalid fixed windows and budgets", () => {
    for (const windowMs of [NaN, Infinity, 1000.5, 999])
      assert.throws(() => createSharedAbuseLimiter({ ...options, windowMs }));
    for (const limit of [0, NaN, Infinity, 1.5])
      assert.throws(() => createSharedAbuseLimiter({ ...options, limit }));
    assert.throws(() =>
      createSharedAbuseLimiter({ ...options, secret: "short" }),
    );
  });

  it("groups IPv6 subnets while separating operations, accounts, environments and secrets", async () => {
    const keys = [];
    function app(overrides = {}) {
      const application = express();
      application.set("trust proxy", "loopback");
      application.use((req, _res, next) => {
        if (overrides.account)
          req.user = {
            id: req.get("X-Synthetic-Account"),
            email: null,
            createdAt: new Date(0),
          };
        next();
      });
      application.use(
        createSharedAbuseLimiter({
          ...options,
          ...overrides,
          store: {
            increment: async (key) => {
              keys.push(key);
              return { count: 1, ttl: 1500 };
            },
          },
        }),
      );
      application.get("/", (_req, res) => res.sendStatus(204));
      return application;
    }
    const first = app();
    for (const ip of ["2001:db8:1234:5600::1", "2001:db8:1234:56ff::2"])
      assert.equal(
        (await request(first).get("/").set("X-Forwarded-For", ip)).status,
        204,
      );
    assert.equal(keys[0], keys[1]);
    await request(app({ scope: "exchange" })).get("/");
    await request(app({ namespace: "other-environment" })).get("/");
    await request(
      app({ secret: "different-synthetic-material".repeat(2) }),
    ).get("/");
    const account = app({ scope: "account", account: true });
    await request(account).get("/").set("X-Synthetic-Account", "account-one");
    await request(account).get("/").set("X-Synthetic-Account", "account-two");
    assert.equal(new Set(keys).size, 6);
    assert.ok(
      keys.every((key) =>
        /:security:limit:(auth|exchange|account):[a-f0-9]{64}$/.test(key),
      ),
    );
    assert.ok(keys.every((key) => !/2001:|account-one|account-two/.test(key)));
  });

  it("rejects evictable configuration before any concurrent mutation and does not extend cooldown on rejected requests", async (context) => {
    const fixture = await redisFixture({ policy: "allkeys-lru" });
    const store = createRedisAbuseStore({ url: fixture.url });
    let now = 10_000;
    context.mock.method(Date, "now", () => now);
    try {
      await Promise.all(
        Array.from({ length: 16 }, () =>
          assert.rejects(store.increment("fixture", 1500), {
            message: "abuse store unavailable",
          }),
        ),
      );
      assert.equal(fixture.state.evaluations, 0);
      fixture.state.policy = "noeviction";
      now += 4000;
      await assert.rejects(store.increment("fixture", 1500));
      assert.equal(fixture.state.connections, 1);
      now += 1001;
      assert.deepEqual(await store.increment("fixture", 1500), {
        count: 1,
        ttl: 1500,
      });
      assert.equal(fixture.state.connections, 2);
    } finally {
      store.close();
      await fixture.close();
    }
  });

  for (const scenario of [
    {
      name: "accepted TCP connections with a stalled initialization handshake",
      silent: true,
    },
    { name: "sent commands whose replies never arrive", reply: null },
  ])
    it(`bounds ${scenario.name} and emits only aggregate errors`, async () => {
      const fixture = await redisFixture(scenario);
      const observed = [];
      const store = createRedisAbuseStore({
        url: fixture.url,
        observe: (...event) => observed.push(event),
      });
      const start = performance.now();
      try {
        await assert.rejects(
          store.increment("synthetic-private-subject", 1500),
          { message: "abuse store unavailable" },
        );
        assert.ok(performance.now() - start < 2000);
        await assert.rejects(
          store.increment("synthetic-private-subject", 1500),
        );
        assert.equal(observed.length, 2);
        assert.ok(
          observed.every(
            ([outcome, seconds]) =>
              outcome === "error" && Number.isFinite(seconds),
          ),
        );
        assert.equal(
          JSON.stringify(observed).includes("synthetic-private-subject"),
          false,
        );
      } finally {
        store.close();
        await fixture.close();
      }
    });

  it("fails closed on invalid store counters and TTLs", async () => {
    for (const reply of [
      "+unexpected\r\n",
      "*2\r\n:-1\r\n:1500\r\n",
      "*2\r\n:1\r\n:0\r\n",
      "*2\r\n:1\r\n:1501\r\n",
    ]) {
      const fixture = await redisFixture({ reply });
      const store = createRedisAbuseStore({ url: fixture.url });
      try {
        await assert.rejects(store.increment("fixture", 1500), {
          message: "abuse store unavailable",
        });
      } finally {
        store.close();
        await fixture.close();
      }
    }
  });

  it("bounds the connected pending command queue and destroys stalled commands on overflow", async () => {
    const fixture = await redisFixture({ reply: null });
    const store = createRedisAbuseStore({ url: fixture.url });
    try {
      await Promise.all(
        Array.from({ length: 300 }, () =>
          assert.rejects(store.increment("fixture", 1500), {
            message: "abuse store unavailable",
          }),
        ),
      );
      assert.ok(fixture.state.evaluations <= 256);
    } finally {
      store.close();
      await fixture.close();
    }
  });
});
