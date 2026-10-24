import { createHmac } from "node:crypto";
import { createClient } from "redis";
import { ipKeyGenerator } from "express-rate-limit";
import type {
  Logger as RateLimitLogger,
  Options as RateLimitOptions,
  Store,
} from "express-rate-limit";
import type { RequestHandler } from "express";
import type { Logger } from "pino";

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

async function withinDeadline<T>(operation: Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("abuse store unavailable")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

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
    commandsQueueMaxLength: 256,
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
  });
  // Never log Redis errors: URLs or authentication details may be included.
  client.on("error", () => {});
  let connecting: Promise<void> | undefined;
  let retryAfter = 0;
  async function connect() {
    if (connecting) return connecting;
    if (client.isReady) return;
    if (Date.now() < retryAfter) throw new Error("abuse store unavailable");
    connecting = withinDeadline(
      client.connect().then(async () => {
        const memory = await client.info("memory");
        if (!/^maxmemory_policy:noeviction\r?$/m.test(memory))
          throw new Error("unsafe abuse store policy");
      }),
    )
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
        const result = await withinDeadline(
          client.eval(abuseScript, {
            keys: [key],
            arguments: [String(windowMs)],
          }),
        );
        if (
          !Array.isArray(result) ||
          typeof result[0] !== "number" ||
          typeof result[1] !== "number" ||
          !Number.isSafeInteger(result[0]) ||
          !Number.isSafeInteger(result[1]) ||
          result[0] < 1 ||
          result[1] < 1 ||
          result[1] > windowMs
        )
          throw new Error("invalid abuse store result");
        observe("ok", (performance.now() - start) / 1_000);
        return { count: result[0], ttl: result[1] };
      } catch {
        // A timed-out command may have executed. Never queue or replay it; close
        // the connection and make later attempts wait before reconnecting.
        if (client.isOpen || retryAfter <= Date.now())
          retryAfter = Date.now() + 5_000;
        if (client.isOpen) client.destroy();
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
  scope: "auth" | "account";
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
    !Number.isSafeInteger(windowMs) ||
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

export class RateLimitStoreUnavailableError extends Error {
  constructor() {
    super("rate limit store unavailable");
  }
}

export type SharedRateLimit = {
  store: Store;
  passOnStoreError: boolean;
  logger: RateLimitLogger;
};

// Backs express-rate-limit limiters with the shared abuse store so limits hold
// across instances. Keys are HMAC digests: Redis never holds client IPs or
// account IDs. Each call returns a fresh store for one named limiter.
export function createSharedRateLimits({
  store,
  namespace,
  secret,
  logger,
  observe = () => {},
}: {
  store: AbuseStore;
  namespace: string;
  secret: string;
  logger: Pick<Logger, "warn" | "error">;
  observe?: (outcome: "fail_open" | "unavailable") => void;
}) {
  if (!/^[a-z0-9_-]{1,48}$/.test(namespace) || secret.length < 32)
    throw new Error("invalid shared abuse configuration");
  return (name: string, failure: "open" | "closed"): SharedRateLimit => {
    if (!/^[a-z0-9-]{1,32}$/.test(name))
      throw new Error("invalid shared rate limit name");
    let windowMs = 60_000;
    let lastWarning = 0;
    return {
      passOnStoreError: failure === "open",
      // Store failures are logged below with the limiter name, at most once
      // every 10 seconds per limiter so an outage cannot flood the logs.
      logger: {
        error: (error, message) => {
          if (!(error instanceof RateLimitStoreUnavailableError))
            logger.error({ error, limiter: name }, message);
        },
        warn: (error, message) =>
          logger.warn({ error, limiter: name }, message),
      },
      store: {
        localKeys: false,
        prefix: name,
        init(options: RateLimitOptions) {
          windowMs = options.windowMs;
        },
        async increment(key: string) {
          const digest = createHmac("sha256", secret)
            .update(`${name}:${key}`)
            .digest("hex");
          try {
            const result = await store.increment(
              `${namespace}:security:limit:api:${name}:${digest}`,
              windowMs,
            );
            return {
              totalHits: result.count,
              resetTime: new Date(Date.now() + result.ttl),
            };
          } catch {
            observe(failure === "open" ? "fail_open" : "unavailable");
            if (Date.now() - lastWarning >= 10_000) {
              lastWarning = Date.now();
              logger.warn(
                { limiter: name, failure },
                failure === "open"
                  ? "shared rate limit unavailable; allowing requests"
                  : "shared rate limit unavailable; refusing requests",
              );
            }
            throw new RateLimitStoreUnavailableError();
          }
        },
        // The fixed-window script only counts up. These limiters never refund
        // requests (no skipSuccessfulRequests/skipFailedRequests) or reset keys.
        async decrement() {},
        async resetKey() {},
      },
    };
  };
}

export type SharedRateLimits = ReturnType<typeof createSharedRateLimits>;
