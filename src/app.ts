import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import type { createMessageRepository } from "./features/messages/repository.ts";
import type { createUserRepository } from "./platform/auth/users.ts";
import type { createSessionRepository } from "./platform/auth/sessions.ts";

import { createMessageRouter } from "./features/messages/router.ts";
import {
  createAuthRouter,
  createRequireAuthentication,
} from "./platform/auth/router.ts";
import { createHttpLogger } from "./platform/logger.ts";
import { createMetrics } from "./platform/metrics.ts";
import {
  createApiRateLimiter,
  createCsrfOriginProtection,
} from "./platform/security.ts";

export const handleError: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  void _next;

  if (error instanceof SyntaxError) {
    return response.status(400).json({
      error: "request body contains invalid JSON",
    });
  }

  request.log.error({ error }, "unhandled request error");

  return response.status(500).json({
    error: "internal server error",
  });
};

export function createApp({
  messages,
  users,
  sessions,
  logger,
  environment = "development",
  metrics = createMetrics(),
  applicationOrigin,
  trustProxy = false,
  requestBodyLimit = "10kb",
  apiRateLimit = 300,
  authRateLimit = 10,
  rateLimitWindowMs = 15 * 60 * 1_000,
  sessionDurationMs = 7 * 24 * 60 * 60 * 1_000,
}: {
  messages: ReturnType<typeof createMessageRepository>;
  users: ReturnType<typeof createUserRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
  logger: Logger;
  environment?: string;
  metrics?: ReturnType<typeof createMetrics>;
  applicationOrigin?: string;
  trustProxy?: number | false;
  requestBodyLimit?: string;
  apiRateLimit?: number;
  authRateLimit?: number;
  rateLimitWindowMs?: number;
  sessionDurationMs?: number;
}) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use(createHttpLogger(logger));
  app.use(metrics.middleware);
  app.use(helmet());
  app.use(
    createApiRateLimiter({ windowMs: rateLimitWindowMs, limit: apiRateLimit }),
  );
  app.use(express.json({ limit: requestBodyLimit }));
  app.use(cookieParser());
  app.use(createCsrfOriginProtection({ environment, applicationOrigin }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/ready", async (_request, response) => {
    try {
      await messages.isReady();
      return response.json({ status: "ready" });
    } catch (error) {
      _request.log.error({ error }, "readiness check failed");

      return response.status(503).json({ status: "not ready" });
    }
  });

  app.get("/metrics", metrics.handler);

  app.use(
    "/api/auth",
    createAuthRouter({
      users,
      sessions,
      environment,
      sessionDurationMs,
      authRateLimit,
      rateLimitWindowMs,
    }),
  );
  app.use(
    "/api/messages",
    createRequireAuthentication({ sessions, environment }),
    createMessageRouter({ messages }),
  );

  app.use((_request, response) => {
    response.status(404).json({
      error: "resource not found",
    });
  });

  app.use(handleError);

  return app;
}
