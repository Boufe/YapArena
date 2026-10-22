import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createRuntime } from "../dist/platform/runtime.js";

describe("service runtime", () => {
  for (const failing of ["play", "sandbox"])
    it(`awaits both market jobs when ${failing} recovery fails`, async () => {
      let callback,
        finish,
        closed = false;
      const calls = [],
        errors = [];
      const run = (kind) => async () => {
        calls.push(kind);
        if (kind === failing) throw new Error(`${kind} failed`);
        await new Promise((resolve) => {
          finish = resolve;
        });
      };
      const runtime = createRuntime({
        a4: { tick: run("play") },
        coinDebates: { advance: run("sandbox") },
        database: {
          end: async () => {
            closed = true;
          },
        },
        sessions: { deleteExpired: async () => {} },
        logger: {
          info() {},
          error: ({ error }) => errors.push(error.message),
        },
        config: { port: 3000, host: "127.0.0.1" },
        verifyDatabase: async () => {},
        setIntervalFn: (fn, ms) => {
          if (ms === 1000) callback = fn;
          return { unref() {} };
        },
        clearIntervalFn() {},
      });
      await runtime.start();
      const first = callback();
      await Promise.resolve();
      await Promise.resolve();
      callback();
      assert.deepEqual(calls, ["play", "sandbox"]);
      const stopped = runtime.stop();
      await Promise.resolve();
      assert.equal(closed, false);
      finish();
      await first;
      await stopped;
      assert.equal(closed, true);
      assert.deepEqual(errors, [`${failing} failed`]);
    });

  it("recovers media revocations without overlapping claims and awaits in-flight recovery on shutdown", async () => {
    let callback,
      finish,
      calls = 0,
      cleared = 0,
      closed = false;
    const runtime = createRuntime({
      database: {
        end: async () => {
          closed = true;
        },
      },
      sessions: { deleteExpired: async () => {} },
      mediaAccountRevocation: {
        flush: async () => {
          calls++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (fn, ms) => {
        if (ms === 1000) callback = fn;
        return { unref() {} };
      },
      clearIntervalFn: () => {
        cleared++;
      },
    });
    await runtime.start();
    const first = callback();
    callback();
    assert.equal(calls, 1);
    const stop = runtime.stop();
    await Promise.resolve();
    assert.equal(closed, false);
    finish();
    await first;
    await stop;
    assert.equal(closed, true);
    assert.equal(cleared, 2);
  });
  it("runs only maintenance when no web app is supplied", async () => {
    const callbacks = new Map();
    const events = [];
    const runtime = createRuntime({
      database: { end: async () => events.push("closed") },
      sessions: { deleteExpired: async () => events.push("cleanup") },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(3600000)();
    await runtime.stop();
    assert.deepEqual(events, ["cleanup", "closed"]);
  });

  it("starts a web server without duplicate background jobs when disabled", async () => {
    const events = [];
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => events.push("closed") },
      sessions: { deleteExpired: async () => 0 },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      backgroundJobs: false,
      setIntervalFn: () => {
        throw new Error("web service must not start a clock");
      },
    });
    await runtime.start();
    await runtime.stop();
    assert.deepEqual(events, ["closed"]);
  });

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
      communityStreams: {
        start: async () => events.push("listener registered"),
        stop: async () => events.push("streams drained"),
      },
      sessions: { deleteExpired: async () => 0 },
      logger: { info: () => {}, error: () => {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => events.push("verified"),
    });

    await runtime.start();
    await runtime.stop();

    assert.deepEqual(events, [
      "verified",
      "listener registered",
      "listen",
      "streams drained",
      "database closed",
    ]);
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

  it("expires wallet challenges and audit records independently", async () => {
    const events = [];
    let cleanup;
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      wallets: {
        deleteExpiredChallenges: async () => {
          events.push("wallets");
          throw new Error("wallet cleanup failed");
        },
      },
      identity: {
        deleteExpiredAudit: async () => {
          events.push("audit");
          return 3;
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await cleanup();
    await runtime.stop();
    assert.deepEqual(events, ["wallets", "wallet cleanup failed", "audit"]);
  });

  it("expires debate requests without affecting other maintenance", async () => {
    const events = [];
    let cleanup;
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      matching: {
        expireRequests: async () => {
          events.push("matching");
          throw new Error("matching cleanup failed");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback) => {
        cleanup = callback;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await cleanup();
    await runtime.stop();
    assert.deepEqual(events, ["matching", "matching cleanup failed"]);
  });

  it("prunes community records and logs a failed retention run without stopping cleanup", async () => {
    const events = [];
    let cleanup;
    let runs = 0;
    const runtime = createRuntime({
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      community: {
        pruneExpired: async () => {
          runs += 1;
          if (runs === 1) events.push("pruned");
          else throw new Error("retention unavailable");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
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
    assert.deepEqual(events, ["pruned", "retention unavailable"]);
  });

  it("prunes consented measurement and logs a failed retention run", async () => {
    const events = [];
    let cleanup;
    let runs = 0;
    const runtime = createRuntime({
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      measurement: {
        pruneExpired: async () => {
          runs += 1;
          if (runs === 1) events.push("pruned");
          else throw new Error("measurement retention unavailable");
        },
      },
      logger: {
        info: () => {},
        error: ({ error }) => events.push(error.message),
      },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
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
    assert.deepEqual(events, ["pruned", "measurement retention unavailable"]);
  });

  it("advances media turns and stops recordings independently of session cleanup", async () => {
    const events = [];
    const callbacks = new Map();
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => events.push("database closed") },
      sessions: { deleteExpired: async () => 0 },
      media: {
        tick: async () => ({
          turns: [{ debateId: "event-1", side: "B" }],
          ended: ["event-2"],
        }),
        claimRecordingStops: async () => [
          { debateId: "event-1", egressId: "egress-1" },
        ],
        recordingStopFailed: async () => {},
      },
      mediaProvider: {
        setTurn: async (_id, side) => events.push(`turn:${side}`),
        stopRecording: async (id) => events.push(`stop:${id}`),
      },
      logger: { info() {}, error() {} },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(1000)();
    await runtime.stop();
    assert.deepEqual(events, [
      "turn:B",
      "turn:null",
      "stop:egress-1",
      "database closed",
    ]);
  });

  it("logs a media clock failure and keeps the service alive", async () => {
    const events = [];
    const callbacks = new Map();
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      media: {
        tick: async () => {
          throw new Error("database unavailable");
        },
        claimRecordingStops: async () => [],
        recordingStopFailed: async () => {},
      },
      logger: { info() {}, error: ({ error }) => events.push(error.message) },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(1000)();
    await runtime.stop();
    assert.deepEqual(events, ["database unavailable"]);
  });

  it("retries an unsuccessful recording stop without losing the durable request", async () => {
    const events = [];
    const callbacks = new Map();
    const runtime = createRuntime({
      app: {
        listen: (_port, _host, callback) => {
          queueMicrotask(callback);
          return { close: (done) => done(), once: () => {} };
        },
      },
      database: { end: async () => {} },
      sessions: { deleteExpired: async () => 0 },
      media: {
        tick: async () => ({ turns: [], ended: [] }),
        claimRecordingStops: async () => [
          { debateId: "event-1", egressId: "egress-1" },
        ],
        recordingStopFailed: async (id) => events.push(`retry:${id}`),
      },
      mediaProvider: {
        setTurn: async () => {},
        stopRecording: async () => {
          throw new Error("egress unavailable");
        },
      },
      logger: { info() {}, error: ({ error }) => events.push(error.message) },
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: async () => {},
      setIntervalFn: (callback, interval) => {
        callbacks.set(interval, callback);
        return { unref() {} };
      },
      clearIntervalFn: () => {},
    });
    await runtime.start();
    await callbacks.get(1000)();
    await runtime.stop();
    assert.deepEqual(events, ["egress unavailable", "retry:event-1"]);
  });

  describe("Privy provider timers", () => {
    function deferred() {
      let resolve, reject;
      const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    }
    function providerJobs() {
      const calls = { synchronize: [], process: [] };
      return {
        calls,
        providerRevocation: {
          synchronize: (...args) => {
            const work = deferred();
            calls.synchronize.push({ args, work });
            return work.promise;
          },
        },
        embeddedWallet: {
          process: (...args) => {
            const work = deferred();
            calls.process.push({ args, work });
            return work.promise;
          },
        },
      };
    }
    const counter = () => {
      const counts = [];
      return {
        counts,
        metrics: {
          authJourney: {
            inc: (labels, value) =>
              counts.push(
                value === undefined ? labels.event : [labels.event, value],
              ),
          },
        },
      };
    };
    const webApp = () => ({
      listen: (_port, _host, callback) => {
        queueMicrotask(callback);
        return { close: (done) => done(), once: () => {} };
      },
    });

    it("does not start provider revocation or wallet provisioning when background jobs are disabled", async () => {
      const jobs = providerJobs();
      const runtime = createRuntime({
        app: webApp(),
        ...jobs,
        ...counter(),
        database: { end: async () => {} },
        sessions: { deleteExpired: async () => 0 },
        logger: { info() {}, error() {} },
        config: { port: 3000, host: "127.0.0.1" },
        verifyDatabase: async () => {},
        backgroundJobs: false,
        setIntervalFn: () => {
          throw new Error("web service must not start provider timers");
        },
        clearIntervalFn: () => {
          throw new Error("no provider timer to clear");
        },
      });
      await runtime.start();
      await runtime.stop();
      assert.deepEqual(jobs.calls, { synchronize: [], process: [] });
    });

    it("starts both provider timers when enabled, avoids overlap, counts outcomes and drains on stop", async () => {
      const jobs = providerJobs();
      const { counts, metrics } = counter();
      const timers = new Map();
      const unrefs = [];
      const cleared = [];
      const events = [];
      const ran = [];
      const runtime = createRuntime({
        app: webApp(),
        ...jobs,
        metrics,
        database: { end: async () => events.push("database closed") },
        sessions: { deleteExpired: async () => 0 },
        logger: {
          info: (details, message) => ran.push([message, details.job]),
          error() {},
        },
        config: { port: 3000, host: "127.0.0.1" },
        verifyDatabase: async () => {},
        setIntervalFn: (callback, interval) => {
          const timer = {
            interval,
            unref: () => unrefs.push(interval),
          };
          if (interval === 10000) timers.set(timers.size, callback);
          return timer;
        },
        clearIntervalFn: (timer) => cleared.push(timer.interval),
      });
      await runtime.start();
      assert.equal(timers.size, 2);
      assert.deepEqual(
        unrefs.filter((interval) => interval === 10000),
        [10000, 10000],
      );
      // Each job runs once at start and does not overlap its in-flight run.
      assert.equal(jobs.calls.synchronize.length, 1);
      assert.deepEqual(jobs.calls.synchronize[0].args, []);
      assert.deepEqual(jobs.calls.process[0].args, [1]);
      timers.get(0)();
      timers.get(1)();
      assert.equal(jobs.calls.synchronize.length, 1);
      assert.equal(jobs.calls.process.length, 1);

      jobs.calls.synchronize[0].work.reject(new Error("Privy unavailable"));
      jobs.calls.process[0].work.resolve({ ready: 1, retry: 2, review: 3 });
      await new Promise(setImmediate);
      timers.get(0)();
      timers.get(1)();
      jobs.calls.synchronize[1].work.resolve();
      jobs.calls.process[1].work.reject(new Error("database unavailable"));
      await new Promise(setImmediate);
      timers.get(1)();
      jobs.calls.process[2].work.resolve({ ready: 0, retry: 0, review: 0 });
      await new Promise(setImmediate);
      assert.deepEqual(counts, [
        "provider_revocation_retry",
        ["embedded_wallet_ready", 1],
        ["embedded_wallet_retry", 2],
        ["embedded_wallet_review", 3],
        "embedded_wallet_worker_error",
      ]);

      timers.get(0)();
      timers.get(1)();
      const stopped = runtime.stop();
      // A tick during shutdown starts no new provider work.
      timers.get(0)();
      timers.get(1)();
      assert.equal(jobs.calls.synchronize.length, 3);
      assert.equal(jobs.calls.process.length, 4);
      await new Promise(setImmediate);
      assert.deepEqual(events, []);
      jobs.calls.synchronize[2].work.resolve();
      jobs.calls.process[3].work.resolve({ ready: 0, retry: 0, review: 0 });
      await stopped;
      assert.deepEqual(events, ["database closed"]);
      assert.deepEqual(
        cleared.filter((interval) => interval === 10000),
        [10000, 10000],
      );
      // Each job logs its first completed run once, whatever the outcome.
      assert.deepEqual(ran, [
        ["background job ran", "provider-revocation"],
        ["background job ran", "embedded-wallet"],
      ]);
    });

    it("keeps provider timers referenced in the worker and tolerates missing metrics", async () => {
      const jobs = providerJobs();
      const unrefs = [];
      const timers = [];
      const runtime = createRuntime({
        ...jobs,
        database: { end: async () => {} },
        sessions: { deleteExpired: async () => 0 },
        logger: { info() {}, error() {} },
        config: { port: 3000, host: "127.0.0.1" },
        verifyDatabase: async () => {},
        setIntervalFn: (callback, interval) => {
          if (interval === 10000) timers.push(callback);
          return { unref: () => unrefs.push(interval) };
        },
        clearIntervalFn: () => {},
      });
      await runtime.start();
      jobs.calls.synchronize[0].work.reject(new Error("Privy unavailable"));
      jobs.calls.process[0].work.resolve({ ready: 1, retry: 1, review: 1 });
      await new Promise(setImmediate);
      timers[1]();
      jobs.calls.process[1].work.reject(new Error("database unavailable"));
      await new Promise(setImmediate);
      await runtime.stop();
      assert.equal(timers.length, 2);
      assert.deepEqual(unrefs, []);
    });

    it("starts revocation without wallet provisioning when only one job exists", async () => {
      const jobs = providerJobs();
      const intervals = [];
      const runtime = createRuntime({
        providerRevocation: jobs.providerRevocation,
        database: { end: async () => {} },
        sessions: { deleteExpired: async () => 0 },
        logger: { info() {}, error() {} },
        config: { port: 3000, host: "127.0.0.1" },
        verifyDatabase: async () => {},
        setIntervalFn: (_callback, interval) => {
          intervals.push(interval);
          return { unref() {} };
        },
        clearIntervalFn: () => {},
      });
      await runtime.start();
      jobs.calls.synchronize[0].work.resolve();
      await runtime.stop();
      assert.deepEqual(intervals.sort(), [10000, 3600000]);
      assert.equal(jobs.calls.process.length, 0);
    });
  });
});
