import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createRuntime } from "../dist/platform/runtime.js";

describe("service runtime", () => {
  it("verifies the database before listening and closes resources", async () => {
    const events = [];
    const server = { close: (callback) => callback() };
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          events.push("listen");
          queueMicrotask(callback);
          return { ...server, once: () => {} };
        },
      },
      database: { end: mock.fn(async () => events.push("database closed")) },
      sessions: { deleteExpired: async () => 0 },
      logger: { info: () => {}, error: () => {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => events.push("verified"),
    });

    await runtime.start();
    await runtime.stop();

    assert.deepEqual(events, ["verified", "listen", "database closed"]);
  });

  it("does not listen when database verification fails", async () => {
    const listen = mock.fn();
    const runtime = createRuntime({
      app: { listen },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      logger: { info: () => {}, error: () => {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {
        throw new Error("pending migration");
      },
    });

    await assert.rejects(runtime.start(), /pending migration/);
    assert.equal(listen.mock.callCount(), 0);
  });

  it("runs bounded session cleanup without stopping the service on errors", async () => {
    let cleanupCalls = 0;
    const errors = [];
    let cleanup;
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          const server = { close: (done) => done(), once: () => {} };
          queueMicrotask(callback);
          return server;
        },
      },
      database: { end: async () => {} },
      sessions: {
        deleteExpired: async () => {
          cleanupCalls += 1;
          if (cleanupCalls === 1) return 2;
          throw new Error("temporary cleanup failure");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => errors.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      cleanupIntervalMs: 2,
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });

    await runtime.start();
    await cleanup();
    await cleanup();
    await runtime.stop();

    assert.equal(cleanupCalls, 2);
    assert.deepEqual(errors, ["temporary cleanup failure"]);
  });
});
