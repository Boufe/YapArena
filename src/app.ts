import cookieParser from "cookie-parser";
import express from "express";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import type { createMessageRepository } from "./features/messages/repository.ts";
import type { createDiscoveryRepository } from "./features/discovery/repository.ts";
import type { createIdentityRepository } from "./features/identity/repository.ts";
import type { createMatchingRepository } from "./features/matching/repository.ts";
import type { createMediaRepository } from "./features/media/repository.ts";
import type { createMediaProvider } from "./features/media/provider.ts";
import type { createUserRepository } from "./platform/auth/users.ts";
import type { createSessionRepository } from "./platform/auth/sessions.ts";
import type { createWalletRepository } from "./platform/auth/wallets.ts";

import { createMessageRouter } from "./features/messages/router.ts";
import { createDiscoveryRouter } from "./features/discovery/router.ts";
import { createIdentityRouter } from "./features/identity/router.ts";
import { createMatchingRouter } from "./features/matching/router.ts";
import {
  createMediaRouter,
  createMediaWebhookRouter,
} from "./features/media/router.ts";
import { renderUnavailable } from "./features/discovery/web.ts";
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

  if (
    request.headers?.accept?.includes("text/html") &&
    !request.path.startsWith("/api/")
  ) {
    return response.status(500).type("html").send(renderUnavailable());
  }

  return response.status(500).json({
    error: "internal server error",
  });
};

export function createApp({
  messages,
  discovery,
  identity,
  matching,
  media,
  mediaProvider,
  users,
  sessions,
  wallets,
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
  siweRpcUrls = {},
}: {
  messages: ReturnType<typeof createMessageRepository>;
  discovery?: ReturnType<typeof createDiscoveryRepository>;
  identity?: ReturnType<typeof createIdentityRepository>;
  matching?: ReturnType<typeof createMatchingRepository>;
  media?: ReturnType<typeof createMediaRepository>;
  mediaProvider?: ReturnType<typeof createMediaProvider>;
  users: ReturnType<typeof createUserRepository>;
  sessions: ReturnType<typeof createSessionRepository>;
  wallets?: ReturnType<typeof createWalletRepository>;
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
  siweRpcUrls?: Readonly<Record<string, string>>;
}) {
  const app = express();
  const mediaUrl = mediaProvider ? new URL(mediaProvider.publicUrl) : undefined;
  const mediaHttpOrigin = mediaUrl
    ? `${mediaUrl.protocol === "wss:" ? "https:" : "http:"}//${mediaUrl.host}`
    : undefined;

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use(createHttpLogger(logger));
  app.use(metrics.middleware);
  app.use(
    mediaProvider
      ? helmet({
          contentSecurityPolicy: {
            directives: {
              "connect-src": ["'self'", mediaUrl!.origin, mediaHttpOrigin!],
              "media-src": ["'self'", mediaProvider.playbackOrigin],
              "upgrade-insecure-requests":
                environment === "production" ? [] : null,
            },
          },
        })
      : helmet(),
  );
  app.use(
    createApiRateLimiter({ windowMs: rateLimitWindowMs, limit: apiRateLimit }),
  );
  if (media && mediaProvider) {
    app.use(
      "/api/media/webhook",
      express.raw({ type: "application/webhook+json", limit: "256kb" }),
      createMediaWebhookRouter({ media, provider: mediaProvider }),
    );
  }
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

  if (discovery) {
    app.get("/sw.js", (_request, response) => {
      response
        .set("Cache-Control", "no-cache")
        .sendFile(fileURLToPath(new URL("../public/sw.js", import.meta.url)));
    });
    app.use(
      "/assets",
      express.static(fileURLToPath(new URL("../public", import.meta.url)), {
        maxAge: 0,
      }),
    );
    app.use(
      createDiscoveryRouter({
        discovery,
        applicationOrigin: applicationOrigin ?? "http://localhost:3000",
      }),
    );
  }

  app.use(
    "/api/auth",
    createAuthRouter({
      users,
      sessions,
      wallets,
      environment,
      applicationOrigin,
      siweRpcUrls,
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
  if (identity) {
    app.use(
      "/api/me",
      createRequireAuthentication({ sessions, environment }),
      createIdentityRouter({ identity }),
    );
  }
  if (matching && identity) {
    app.use(
      "/api/matching",
      createRequireAuthentication({ sessions, environment }),
      createMatchingRouter({ matching, identity, media }),
    );
  }
  if (media && mediaProvider && matching && identity) {
    app.use(
      "/api/media",
      createMediaRouter({
        media,
        provider: mediaProvider,
        matching,
        identity,
        requireAuth: createRequireAuthentication({ sessions, environment }),
      }),
    );
  }

  app.use((_request, response) => {
    response.status(404).json({
      error: "resource not found",
    });
  });

  app.use(handleError);

  return app;
}
