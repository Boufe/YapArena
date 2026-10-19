import { createHmac } from "node:crypto";
import { createClient } from "redis";
import { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";

// One atomic fixed window with a TTL installed in the same operation. Redis time
// is authoritative; application clocks cannot split a shared window.
export const abuseScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}`;

export type AbuseStore = {
  increment(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; ttl: number }>;
};

export function createRedisAbuseStore({
  url,
  observe = () => {},
}: {
  url: string;
  observe?: (outcome: "ok" | "error", seconds: number) => void;
}) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
  });
  // Never log Redis errors: URLs or authentication details may be included.
  client.on("error", () => {});
  let connecting: Promise<void> | undefined;
  let retryAfter = 0;
  async function connect() {
    if (client.isReady) return;
    if (Date.now() < retryAfter) throw new Error("abuse store unavailable");
    connecting ??= client
      .connect()
      .then(() => {})
      .catch(() => {
        retryAfter = Date.now() + 5_000;
        throw new Error("abuse store unavailable");
      })
      .finally(() => {
        connecting = undefined;
      });
    await connecting;
  }
  return {
    async increment(key: string, windowMs: number) {
      const start = performance.now();
      try {
        await connect();
        const result = await client
          .withCommandOptions({ abortSignal: AbortSignal.timeout(1_000) })
          .eval(abuseScript, {
            keys: [key],
            arguments: [String(windowMs)],
          });
        if (
          !Array.isArray(result) ||
          typeof result[0] !== "number" ||
          typeof result[1] !== "number"
        )
          throw new Error("invalid abuse store result");
        observe("ok", (performance.now() - start) / 1_000);
        return { count: result[0], ttl: result[1] };
      } catch {
        observe("error", (performance.now() - start) / 1_000);
        throw new Error("abuse store unavailable");
      }
    },
    close() {
      if (client.isOpen) client.destroy();
    },
  };
}

export function createSharedAbuseLimiter({
  store,
  namespace,
  secret,
  scope,
  limit,
  windowMs,
  account = false,
  observe = () => {},
}: {
  store: AbuseStore;
  namespace: string;
  secret: string;
  scope: "auth" | "exchange" | "account";
  limit: number;
  windowMs: number;
  account?: boolean;
  observe?: (outcome: "allowed" | "throttled" | "unavailable") => void;
}): RequestHandler {
  if (
    !/^[a-z0-9_-]{1,48}$/.test(namespace) ||
    secret.length < 32 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    windowMs < 1_000
  )
    throw new Error("invalid shared abuse configuration");
  return async (request, response, next) => {
    const subject = account
      ? request.user?.id
      : ipKeyGenerator(request.ip ?? "unknown");
    if (!subject)
      return response.status(401).json({ error: "authentication required" });
    const digest = createHmac("sha256", secret)
      .update(`${scope}:${subject}`)
      .digest("hex");
    try {
      const result = await store.increment(
        `${namespace}:security:limit:${scope}:${digest}`,
        windowMs,
      );
      if (result.count > limit) {
        observe("throttled");
        return response
          .set(
            "Retry-After",
            String(Math.max(1, Math.ceil(result.ttl / 1_000))),
          )
          .status(429)
          .json({ error: "too many attempts; try again shortly" });
      }
      observe("allowed");
      return next();
    } catch {
      observe("unavailable");
      return response.set("Retry-After", "5").status(503).json({
        error:
          "sign-in protection is temporarily unavailable; try again shortly",
      });
    }
  };
}
