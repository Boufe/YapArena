import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadProviderConfig } from "../dist/platform/auth/provider-config.js";
import { loadConfig } from "../dist/platform/config.js";
import { createMetrics } from "../dist/platform/metrics.js";
import { createBackgroundWorker } from "../dist/services.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://yaparena_runtime@localhost:5432/yaparena",
};
const privy = {
  PRIVY_APP_ID: "test-app",
  PRIVY_APP_SECRET: "test-secret",
  REDIS_SECURITY_URL: "redis://127.0.0.1:6379",
  REDIS_NAMESPACE: "test",
  REDIS_KEY_SECRET: "k".repeat(32),
};
const media = {
  LIVEKIT_URL: "http://localhost:7880",
  LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "devkey",
  LIVEKIT_API_SECRET: "secret",
  MEDIA_S3_ENDPOINT: "http://localhost:8333",
  MEDIA_S3_PUBLIC_ENDPOINT: "http://localhost:8333",
  MEDIA_S3_REGION: "us-east-1",
  MEDIA_S3_BUCKET: "replays",
  MEDIA_S3_ACCESS_KEY: "local",
  MEDIA_S3_SECRET_KEY: "local-secret",
  MEDIA_REPLAY_EDGE_URL: "https://replay.example",
  MEDIA_REPLAY_SIGNING_SECRET: "s".repeat(32),
  MEDIA_REPLAY_PACKAGING_ENABLED: "true",
};

// Every query fails, so each job runs its real code and reports a failure
// without reaching PostgreSQL, Privy, Redis or LiveKit.
function startWorker(environment) {
  const events = [];
  const errors = [];
  const ran = [];
  const timers = [];
  const cleared = [];
  const unavailable = async () => {
    throw new Error("database unavailable");
  };
  const metrics = createMetrics();
  const worker = createBackgroundWorker({
    config: loadConfig(environment),
    providerConfig: loadProviderConfig(environment),
    database: {
      query: unavailable,
      connect: unavailable,
      end: async () => events.push("database closed"),
    },
    logger: {
      info: (details, message) => {
        if (message === "background job ran") ran.push(details.job);
      },
      warn() {},
      debug() {},
      error: (_details, message) => errors.push(message),
    },
    metrics,
    verifyDatabase: async () => events.push("verified"),
    setIntervalFn: (callback, interval) => {
      const timer = { interval, callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer.interval),
  });
  return { worker, events, errors, ran, timers, cleared, metrics };
}

async function authJourney(metrics) {
  return Object.fromEntries(
    (await metrics.authJourney.get()).values.map(({ labels, value }) => [
      labels.event,
      value,
    ]),
  );
}

describe("background worker", () => {
  it("starts every maintenance job without Privy or media configured", async () => {
    const { worker, events, errors, ran, timers, cleared, metrics } =
      startWorker(base);
    await worker.start();
    assert.deepEqual(
      timers.map(({ interval }) => interval),
      [1000, 3600000],
    );
    await timers.find(({ interval }) => interval === 3600000).callback();
    assert.ok(errors.includes("community retention cleanup failed"));
    assert.ok(errors.includes("product measurement retention cleanup failed"));
    assert.ok(errors.includes("expired account authorization cleanup failed"));
    await timers.find(({ interval }) => interval === 1000).callback();
    assert.deepEqual(ran, ["cleanup", "a4-recovery"]);
    await worker.stop();
    assert.deepEqual(events, ["verified", "database closed"]);
    assert.deepEqual(cleared.sort(), [1000, 3600000]);
    assert.deepEqual(await authJourney(metrics), {});
  });

  it("starts provider revocation and wallet provisioning with Privy and media configured", async () => {
    const { worker, events, errors, ran, timers, cleared, metrics } =
      startWorker({
        ...base,
        ...privy,
        ...media,
        COIN_SANDBOX_ENABLED: "true",
      });
    await worker.start();
    assert.deepEqual(
      timers.map(({ interval }) => interval).sort((a, b) => a - b),
      [1000, 1000, 1000, 10000, 10000, 3600000],
    );
    // Both provider jobs ran once at start and recorded their failures.
    await new Promise(setImmediate);
    assert.deepEqual(await authJourney(metrics), {
      provider_revocation_retry: 1,
      embedded_wallet_worker_error: 1,
    });
    for (const timer of timers.filter(({ interval }) => interval === 1000))
      await timer.callback();
    assert.ok(errors.includes("speaker access revocation failed"));
    assert.ok(errors.includes("A4 recovery tick failed"));
    assert.ok(errors.includes("media clock failed"));
    assert.deepEqual(ran.sort(), [
      "a4-recovery",
      "embedded-wallet",
      "media-clock",
      "provider-revocation",
      "speaker-revocation",
    ]);
    await worker.stop();
    assert.deepEqual(events, ["verified", "database closed"]);
    assert.equal(cleared.length, timers.length);
  });
});
