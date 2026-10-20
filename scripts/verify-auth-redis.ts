import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express from "express";
import { createClient } from "redis";
import { createMetrics } from "../src/platform/metrics.ts";
import {
  createRedisAbuseStore,
  createSharedAbuseLimiter,
  createSharedAccountAttemptLimiter,
  type AbuseStore,
} from "../src/platform/shared-abuse.ts";

const execute = promisify(execFile);
const disposable = process.argv.includes("--disposable");
const worker = process.argv.includes("--http-worker");
const evidencePath = process.argv
  .find((argument) => argument.startsWith("--evidence="))
  ?.slice("--evidence=".length);
assert.ok(
  process.argv
    .slice(2)
    .every(
      (argument) =>
        argument === "--disposable" ||
        argument === "--http-worker" ||
        argument.startsWith("--evidence="),
    ),
  "only --disposable and --evidence=PATH are supported",
);
assert.ok(
  !disposable || !process.env.REDIS_TEST_URL,
  "disposable mode must not use an existing Redis target",
);
const runId = randomUUID();
const container = `yaparena-redis-acceptance-${runId}`;
assert.ok(
  !worker || process.send,
  "HTTP workers require a verifier IPC parent",
);
const namespace = worker
  ? workerValue("REDIS_VERIFIER_NAMESPACE")
  : `rv-${randomBytes(12).toString("hex")}`;
const secret = worker
  ? workerValue("REDIS_VERIFIER_SECRET")
  : randomBytes(32).toString("hex");
function workerValue(name: string) {
  const value = process.env[name];
  assert.ok(value, "verifier worker configuration is required");
  return value;
}
const metrics = createMetrics();
const durations: number[] = [];
const keys = new Set<string>();
const stores: ReturnType<typeof createRedisAbuseStore>[] = [];
const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
const workers: ChildProcess[] = [];
const checks: string[] = [];
let owned = false;
let paused = false;
let admin: Awaited<ReturnType<typeof connectAdmin>> | undefined;
let endpoint = new URL(process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:56379");

async function docker(...arguments_: string[]) {
  const result = await execute("docker", arguments_, { timeout: 30_000 });
  return result.stdout.trim();
}

async function ownedDocker(action: "restart" | "pause" | "unpause" | "stop") {
  assert.ok(owned, "container lifecycle requires verifier ownership");
  assert.equal(
    await docker(
      "inspect",
      "--format",
      '{{index .Config.Labels "com.yaparena.acceptance"}}',
      container,
    ),
    runId,
    "refusing to alter an unowned container",
  );
  return docker(action, container);
}

function store(url = endpoint.href) {
  const result = createRedisAbuseStore({
    url,
    observe(outcome, seconds) {
      metrics.redisOutcome.inc({ outcome });
      metrics.redisLatency.observe(seconds);
      durations.push(seconds);
    },
  });
  stores.push(result);
  return result;
}

async function connectAdmin() {
  for (let attempt = 0; attempt < (disposable ? 20 : 1); attempt++) {
    const client = createClient({
      url: endpoint.href,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return client;
    } catch {
      if (client.isOpen) client.destroy();
      if (!disposable) throw new Error("local Redis unavailable");
      await delay(100);
    }
  }
  throw new Error("disposable Redis did not become ready");
}

async function fixture(backing: AbuseStore, environment = namespace) {
  const app = express();
  const traced: AbuseStore = {
    increment(key, windowMs) {
      keys.add(key);
      return backing.increment(key, windowMs);
    },
  };
  const limiter = (scope: "auth" | "exchange" | "account", account = false) =>
    createSharedAbuseLimiter({
      store: traced,
      namespace: environment,
      secret,
      scope,
      account,
      limit: scope === "auth" ? 12 : 2,
      windowMs: 60_000,
      observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
    });
  const accountAttempt = createSharedAccountAttemptLimiter({
    store: traced,
    namespace: environment,
    secret,
    limit: 2,
    windowMs: 60_000,
    observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
  });
  app.post("/passkey/:purpose/:subject", async (request, response) => {
    const purpose = request.params.purpose;
    if (
      (purpose !== "link" && purpose !== "restart") ||
      !/^[1-9][0-9]*$/.test(request.params.subject)
    ) {
      response.sendStatus(400);
      return;
    }
    // Synthetic numeric fixture identities only. Actual callers derive the
    // account from server-verified provider evidence before this attempt limit.
    const outcome = await accountAttempt(
      request.params.subject,
      purpose === "link" ? "provider.passkey.link" : "provider.passkey.restart",
    );
    response.sendStatus(
      outcome === "allowed" ? 204 : outcome === "throttled" ? 429 : 503,
    );
  });
  app.post("/auth", limiter("auth"), (_request, response) =>
    response.sendStatus(204),
  );
  app.post("/exchange", limiter("exchange"), (_request, response) =>
    response.sendStatus(204),
  );
  app.post(
    "/account/:subject",
    (request, _response, next) => {
      // Synthetic fixture identities only. The real application verifies sessions
      // in PostgreSQL before applying account-scoped limits.
      Object.assign(request, {
        user: {
          id: `synthetic-${request.params.subject}`,
          email: null,
          createdAt: new Date(0),
        },
      });
      next();
    },
    limiter("account", true),
    (_request, response) => response.sendStatus(204),
  );
  app.get("/watch", (_request, response) => response.sendStatus(204));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return (path: string, method = "POST") =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      signal: AbortSignal.timeout(3_000),
    });
}

async function processFixture(environment: string) {
  const child = fork(fileURLToPath(import.meta.url), ["--http-worker"], {
    env: {
      REDIS_TEST_URL: endpoint.href,
      REDIS_VERIFIER_NAMESPACE: environment,
      REDIS_VERIFIER_SECRET: secret,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  workers.push(child);
  const origin = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("HTTP worker initialization timed out")),
      5_000,
    );
    child.once("error", () => {
      clearTimeout(deadline);
      reject(new Error("HTTP worker failed"));
    });
    child.once("exit", () => {
      clearTimeout(deadline);
      reject(new Error("HTTP worker exited before acceptance"));
    });
    child.once("message", (message) => {
      clearTimeout(deadline);
      if (
        typeof message === "string" &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(message)
      )
        resolve(message);
      else reject(new Error("invalid HTTP worker readiness"));
    });
  });
  return (path: string) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
}

async function rejectsPromptly(
  target: ReturnType<typeof createRedisAbuseStore>,
  key: string,
) {
  const start = performance.now();
  await assert.rejects(target.increment(key, 60_000), {
    message: "abuse store unavailable",
  });
  const milliseconds = performance.now() - start;
  assert.ok(
    milliseconds < 2_000,
    `outage exceeded deadline: ${milliseconds.toFixed(0)}ms`,
  );
  return milliseconds;
}

if (worker) {
  assert.ok(["localhost", "127.0.0.1"].includes(endpoint.hostname));
  await fixture(store());
  const address = servers[0]?.address();
  assert.ok(address && typeof address !== "string" && process.send);
  process.send(`http://127.0.0.1:${address.port}`);
  await once(process, "disconnect");
  for (const instance of stores) instance.close();
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  process.exit(0);
}

try {
  if (disposable) {
    await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--label",
      `com.yaparena.acceptance=${runId}`,
      "--publish",
      "127.0.0.1::6379",
      "redis:7.4-alpine",
      "redis-server",
      "--maxmemory",
      "16mb",
      "--maxmemory-policy",
      "noeviction",
      "--save",
      "",
      "--appendonly",
      "no",
    );
    owned = true;
    const address = await docker("port", container, "6379/tcp");
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    endpoint = new URL(`redis://${address}`);
  }
  assert.ok(
    ["localhost", "127.0.0.1"].includes(endpoint.hostname),
    "Redis verifier accepts disposable loopback targets only",
  );
  admin = await connectAdmin();
  const memory = await admin.info("memory");
  assert.match(memory, /^maxmemory_policy:noeviction\r?$/m);
  const a = store(),
    b = store();
  const atomicKey = `${namespace}:security:limit:auth:synthetic`;
  const result = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      (i % 2 ? a : b).increment(atomicKey, 1_500),
    ),
  );
  assert.equal(new Set(result.map((entry) => entry.count)).size, 100);
  assert.equal(Math.max(...result.map((entry) => entry.count)), 100);
  assert.ok(result.every((entry) => entry.ttl > 0 && entry.ttl <= 1_500));
  await delay(1_600);
  assert.equal((await a.increment(atomicKey, 1_500)).count, 1);
  checks.push(
    "100 atomic concurrent increments through two clients; TTL expiry",
  );

  const first = await fixture(a),
    second = await fixture(b);
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 ? first : second)("/auth")),
  );
  assert.equal(
    responses.filter((response) => response.status === 204).length,
    12,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    28,
  );
  assert.ok(
    responses
      .filter((response) => response.status === 429)
      .every((response) => Number(response.headers.get("Retry-After")) > 0),
  );
  assert.equal((await first("/exchange")).status, 204);
  assert.equal((await first("/account/one")).status, 204);
  assert.equal((await second("/account/one")).status, 204);
  assert.equal((await first("/account/one")).status, 429);
  assert.equal((await second("/account/two")).status, 204);
  const separate = await fixture(store(), `${namespace}-other`);
  assert.equal((await separate("/auth")).status, 204);
  for (const key of keys) {
    assert.match(
      key,
      /^rv-[a-f0-9]{24}(?:-other)?:security:limit:(auth|exchange|account|recovery):[a-f0-9]{64}$/,
    );
    assert.ok(
      !key.includes("synthetic-") &&
        !key.includes("127.0.0.1") &&
        !key.includes(secret),
    );
  }
  checks.push(
    "two independent HTTP middleware instances: shared IP budget, account/operation/environment separation, opaque HMAC keys",
  );

  const [processA, processB] = await Promise.all([
    processFixture(`${namespace}-process`),
    processFixture(`${namespace}-process`),
  ]);
  const processResponses = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      (i % 2 ? processA : processB)("/auth"),
    ),
  );
  assert.equal(
    processResponses.filter((response) => response.status === 204).length,
    12,
  );
  assert.equal(
    processResponses.filter((response) => response.status === 429).length,
    28,
  );
  assert.equal((await processA("/account/one")).status, 204);
  assert.equal((await processB("/account/one")).status, 204);
  assert.equal((await processA("/account/one")).status, 429);
  checks.push(
    "two separate Node HTTP worker processes enforce one Redis IP/account budget under concurrent requests",
  );
  for (const purpose of ["link", "restart"]) {
    const attemptResponses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? processA : processB)(`/passkey/${purpose}/910001`),
      ),
    );
    assert.equal(
      attemptResponses.filter((response) => response.status === 204).length,
      2,
    );
    assert.equal(
      attemptResponses.filter((response) => response.status === 429).length,
      18,
    );
    assert.equal((await processA(`/passkey/${purpose}/910002`)).status, 204);
    assert.equal((await processB(`/passkey/${purpose}/910002`)).status, 204);
    assert.equal((await processA(`/passkey/${purpose}/910002`)).status, 429);
    assert.equal((await separate(`/passkey/${purpose}/910001`)).status, 204);
  }
  const attemptKeys = await admin.keys(
    `${namespace}-process:security:limit:recovery:*`,
  );
  assert.equal(attemptKeys.length, 4);
  for (const key of attemptKeys) {
    assert.match(
      key,
      /^rv-[a-f0-9]{24}-process:security:limit:recovery:[a-f0-9]{64}$/,
    );
    assert.ok(
      !["910001", "910002", "provider.passkey", secret].some((value) =>
        key.includes(value),
      ),
    );
    const ttl = await admin.pTTL(key);
    assert.ok(ttl > 0 && ttl <= 60_000);
  }
  checks.push(
    "two separate Node HTTP workers atomically share provider.passkey.link and provider.passkey.restart attempt budgets; purpose, account and environment stay separate; stored keys are opaque HMACs with bounded TTL",
  );

  const unavailable = store("redis://127.0.0.1:1");
  await rejectsPromptly(unavailable, `${namespace}:closed-port`);
  assert.ok(
    (await rejectsPromptly(unavailable, `${namespace}:closed-port`)) < 100,
    "backoff must fail immediately",
  );
  const sockets = new Set<Socket>();
  const blackhole = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  }).listen(0, "127.0.0.1");
  await once(blackhole, "listening");
  const address = blackhole.address();
  assert.ok(address && typeof address !== "string");
  try {
    await rejectsPromptly(
      store(`redis://127.0.0.1:${address.port}`),
      `${namespace}:handshake`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  }
  const outage = await fixture(unavailable);
  assert.equal((await outage("/auth")).status, 503);
  assert.equal((await outage("/passkey/link/910001")).status, 503);
  assert.equal((await outage("/passkey/restart/910001")).status, 503);
  assert.equal((await outage("/watch", "GET")).status, 204);
  checks.push(
    "closed-port and accepted-but-stalled handshake bounded; backoff fails immediately; protected mutation fails closed while public read works",
  );

  if (disposable) {
    await admin.configSet("maxmemory-policy", "allkeys-lru");
    const wrongPolicy = store();
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        rejectsPromptly(wrongPolicy, `${namespace}:policy:${i}`),
      ),
    );
    assert.equal((await admin.keys(`${namespace}:policy:*`)).length, 0);
    await admin.configSet("maxmemory-policy", "noeviction");
    checks.push(
      "evictable policy rejected before concurrent commands can execute",
    );

    const retained = `${namespace}:retained`;
    await admin.set(retained, "1", { PX: 60_000 });
    await admin.configSet("maxmemory", "1");
    try {
      await rejectsPromptly(store(), `${namespace}:oom`);
      assert.equal(await admin.get(retained), "1");
      assert.match(await admin.info("stats"), /^evicted_keys:0\r?$/m);
    } finally {
      await admin.configSet("maxmemory", "16777216");
    }
    checks.push(
      "noeviction memory exhaustion fails closed and retains existing counters",
    );

    const stalled = store();
    const stalledKey = `${namespace}:stalled`;
    await stalled.increment(stalledKey, 60_000);
    await ownedDocker("pause");
    paused = true;
    await rejectsPromptly(stalled, stalledKey);
    await ownedDocker("unpause");
    paused = false;
    assert.ok((await rejectsPromptly(stalled, stalledKey)) < 100);
    await delay(5_100);
    const resumed = await stalled.increment(stalledKey, 60_000);
    assert.ok(
      resumed.count === 2 || resumed.count === 3,
      "timed-out counter may execute once, but must never be replayed",
    );
    checks.push(
      "paused Redis command deadline, connection destruction, retry cooldown and bounded uncertain counter execution",
    );

    admin.destroy();
    await ownedDocker("restart");
    // Docker may allocate a different ephemeral host port after restarting.
    const restartedAddress = await docker("port", container, "6379/tcp");
    assert.match(restartedAddress, /^127\.0\.0\.1:\d+$/);
    endpoint = new URL(`redis://${restartedAddress}`);
    admin = await connectAdmin();
    assert.equal(await admin.get(retained), null);
    assert.equal((await store().increment(stalledKey, 60_000)).count, 1);
    checks.push(
      "nonpersistent restart loses counters and permits a new window; this store cannot be financial security state",
    );
  }
  const exposition = await metrics.registry.metrics();
  assert.match(
    exposition,
    /yaparena_redis_security_total\{outcome="throttled"\}/,
  );
  assert.match(exposition, /yaparena_redis_security_total\{outcome="error"\}/);
  assert.match(exposition, /yaparena_redis_security_seconds_count/);
  assert.ok(
    !exposition.includes(secret) &&
      !exposition.includes(namespace) &&
      !exposition.includes("synthetic-"),
  );
  checks.push(
    "aggregate latency/error/throttle metrics contain no fixture identities, key namespace or key secret",
  );
  durations.sort((left, right) => left - right);
  const sourcePaths = [
    "src/platform/shared-abuse.ts",
    "scripts/verify-auth-redis.ts",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  const report = {
    testedAt: new Date().toISOString(),
    revision: (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
    sourceHashes,
    environment: "isolated local loopback Redis and synthetic HTTP principals",
    runtime: process.version,
    redisVersion: (await admin.info("server"))
      .match(/^redis_version:(.+)\r?$/m)?.[1]
      ?.trim(),
    mode: disposable
      ? "verifier-owned disposable Docker instance"
      : "existing loopback instance; unique expiring keys only",
    checks,
    observedStoreSeconds: {
      samples: durations.length,
      p50: durations[Math.floor(durations.length * 0.5)],
      p95: durations[Math.floor(durations.length * 0.95)],
      max: durations.at(-1),
    },
    limitations: [
      "HTTP fixtures include separate Node processes, but synthetic principals are not PostgreSQL session acceptance.",
      "Logout and revocation routing during outages is independently covered by the actual application unit suite.",
      "No hosted Redis changes, provider acceptance, live financial authorization, physical-device or screen-reader claims.",
      "Nonpersistent restarts reset abuse budgets. PostgreSQL must own financial and revocation state.",
      ...(!disposable
        ? [
            "Restart, paused-command, memory-exhaustion and policy-change checks require --disposable.",
          ]
        : []),
    ],
  };
  if (evidencePath)
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all(
    workers.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          const deadline = setTimeout(() => child.kill(), 3_000);
          child.once("exit", () => {
            clearTimeout(deadline);
            resolve();
          });
          if (child.connected) child.disconnect();
          else child.kill();
        }),
    ),
  );
  for (const instance of stores) instance.close();
  if (admin?.isOpen) admin.destroy();
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  if (paused) await ownedDocker("unpause");
  if (owned) await ownedDocker("stop");
}
