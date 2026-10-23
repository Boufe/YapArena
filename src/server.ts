import { createCoinSandboxRepository } from "./features/account-wallet/sandbox-repository.ts";
import { createSandboxWebhookRouter } from "./features/account-wallet/sandbox-webhooks.ts";
import { createSandboxErrorReports } from "./features/account-wallet/sandbox-reports.ts";
import { createAccountWallet } from "./features/account-wallet/repository.ts";
import { createPublicBotRepository } from "./features/a4/public-bots.ts";
import { createApp } from "./app.ts";
import { createMessageRepository } from "./features/messages/repository.ts";
import { createDiscoveryRepository } from "./features/discovery/repository.ts";
import { loadProviderConfig } from "./platform/auth/provider-config.ts";
import {
  createSharedAbuseLimiter,
  createSharedRateLimits,
} from "./platform/shared-abuse.ts";
import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { createRuntime } from "./platform/runtime.ts";
import { createMetrics } from "./platform/metrics.ts";
import { createCommunityStreams } from "./features/community/streams.ts";
import { createServices } from "./services.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const metrics = createMetrics();
const database = createDatabase(config.databaseUrl, logger, (seconds) =>
  metrics.poolWait.observe(seconds),
);
const communityStreams = config.communityStream.enabled
  ? createCommunityStreams(
      database,
      config.databaseUrl,
      logger,
      metrics.community,
      config.communityStream,
    )
  : undefined;
const providerConfig = loadProviderConfig(process.env);
const services = createServices({
  config,
  providerConfig,
  database,
  logger,
  metrics,
});
const {
  identity,
  matching,
  community,
  measurement,
  a4,
  media,
  mediaProvider,
  mediaAccountRevocation,
  users,
  wallets,
  abuseStore,
  authProvider,
  sessions,
  providerRecheck,
  accountSecurity,
  coinDebates,
} = services;
const messages = createMessageRepository(database);
const discovery = createDiscoveryRepository(database);
const app = createApp({
  coinWebhook: config.coinSandboxWebhookSecret
    ? createSandboxWebhookRouter({
        database,
        rail: "simulation",
        secret: config.coinSandboxWebhookSecret,
      })
    : undefined,
  coinSandbox: coinDebates
    ? {
        sandbox: createCoinSandboxRepository(database, { rail: "simulation" }),
        debates: coinDebates,
        operations: accountSecurity.operations,
        reports: createSandboxErrorReports(database, "simulation"),
      }
    : undefined,
  messages,
  database,
  a4,
  publicBots: createPublicBotRepository(database),
  discovery,
  identity,
  matching,
  media,
  mediaProvider,
  mediaAccountRevocation,
  mediaAdmissionSecret: config.media?.livekitSecret,
  community,
  communityStreams,
  metrics,
  metricsToken: config.metricsToken,
  measurement,
  users,
  sessions,
  wallets,
  logger,
  environment: config.environment,
  homepageReferenceEnabled: config.homepageReferenceEnabled,
  applicationOrigin: config.applicationOrigin,
  trustProxy: config.trustProxy,
  requestBodyLimit: config.requestBodyLimit,
  apiRateLimit: config.apiRateLimit,
  authRateLimit: config.authRateLimit,
  rateLimitWindowMs: config.rateLimitWindowMs,
  sessionDurationMs: config.sessionDurationMs,
  siweRpcUrls: config.siweRpcUrls,
  authProvider,
  accountSecurity,
  accountWallet: createAccountWallet(database),
  sharedAccountLimiter:
    providerConfig && abuseStore
      ? createSharedAbuseLimiter({
          store: abuseStore,
          namespace: providerConfig.namespace,
          secret: providerConfig.keySecret,
          scope: "account",
          account: true,
          limit: 30,
          windowMs: 15 * 60 * 1000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
  sharedRateLimits:
    providerConfig && abuseStore
      ? createSharedRateLimits({
          store: abuseStore,
          namespace: providerConfig.namespace,
          secret: providerConfig.keySecret,
          logger,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
  sharedAuthLimiter:
    providerConfig && abuseStore
      ? createSharedAbuseLimiter({
          store: abuseStore,
          namespace: providerConfig.namespace,
          secret: providerConfig.keySecret,
          scope: "auth",
          limit: 120,
          windowMs: 15 * 60 * 1_000,
          observe: (outcome) => metrics.redisOutcome.inc({ outcome }),
        })
      : undefined,
});

const runtime = createRuntime({
  ...services.background,
  app,
  communityStreams,
  backgroundJobs: config.backgroundJobs,
});

await runtime.start();

logger.info(
  {
    environment: config.environment,
    host: config.host,
    port: config.port,
    backgroundJobs: config.backgroundJobs,
  },
  "server started",
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "shutdown requested");
  const forcedExit = setTimeout(() => {
    logger.fatal("forced shutdown");
    process.exit(1);
  }, 10_000);
  forcedExit.unref();

  try {
    // Start no new Privy re-checks, and let running ones finish, before the
    // runtime closes the database pool.
    await providerRecheck?.close();
    await runtime.stop();
    services.close();
    clearTimeout(forcedExit);
  } catch (error) {
    logger.error({ error }, "server shutdown failed");
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
