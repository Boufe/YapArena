import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRedisAbuseStore } from "../src/platform/shared-abuse.ts";

const url = new URL(process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:56379");
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname),
  "Redis verifier accepts disposable local targets only",
);
const namespace = `auth-verifier-${randomUUID()}`;
const a = createRedisAbuseStore({ url: url.href }),
  b = createRedisAbuseStore({ url: url.href });
try {
  const key = `${namespace}:security:limit:auth:synthetic`;
  const result = await Promise.all(
    Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).increment(key, 1500)),
  );
  assert.equal(new Set(result.map((entry) => entry.count)).size, 100);
  assert.equal(Math.max(...result.map((entry) => entry.count)), 100);
  assert.ok(result.every((entry) => entry.ttl > 0 && entry.ttl <= 1500));
  await delay(1600);
  assert.equal((await a.increment(key, 1500)).count, 1);
  const unavailable = createRedisAbuseStore({ url: "redis://127.0.0.1:1" });
  try {
    await assert.rejects(unavailable.increment(`${namespace}:outage`, 1500));
    await assert.rejects(unavailable.increment(`${namespace}:outage`, 1500));
  } finally {
    unavailable.close();
  }
  console.log(
    "PASS: real Redis, two clients, 100 atomic concurrent increments, TTL expiry and bounded outage failure. Only unique expiring test keys used.",
  );
} finally {
  a.close();
  b.close();
}
