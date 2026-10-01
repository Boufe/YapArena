import { createApp } from "./app.ts";
import { createMessageRepository } from "./features/messages/repository.ts";
import { createDiscoveryRepository } from "./features/discovery/repository.ts";
import { createIdentityRepository } from "./features/identity/repository.ts";
import { createMatchingRepository } from "./features/matching/repository.ts";
import { createMediaRepository } from "./features/media/repository.ts";
import { createMediaProvider } from "./features/media/provider.ts";
import { createCommunityRepository } from "./features/community/repository.ts";
import { createSessionRepository } from "./platform/auth/sessions.ts";
import { createWalletRepository } from "./platform/auth/wallets.ts";
import { createUserRepository } from "./platform/auth/users.ts";
import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { createRuntime } from "./platform/runtime.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const database = createDatabase(config.databaseUrl, logger);
const messages = createMessageRepository(database);
const discovery = createDiscoveryRepository(database);
const identity = createIdentityRepository(database);
const matching = createMatchingRepository(database);
const community = createCommunityRepository(database);
const media = config.media ? createMediaRepository(database) : undefined;
const mediaProvider = config.media
  ? createMediaProvider(config.media)
  : undefined;
const users = createUserRepository(database);
const sessions = createSessionRepository(database);
const wallets = createWalletRepository(database);
const app = createApp({
  messages,
  discovery,
  identity,
  matching,
  media,
  mediaProvider,
  community,
  users,
  sessions,
  wallets,
  logger,
  environment: config.environment,
  applicationOrigin: config.applicationOrigin,
  trustProxy: config.trustProxy,
  requestBodyLimit: config.requestBodyLimit,
  apiRateLimit: config.apiRateLimit,
  authRateLimit: config.authRateLimit,
  rateLimitWindowMs: config.rateLimitWindowMs,
  sessionDurationMs: config.sessionDurationMs,
  siweRpcUrls: config.siweRpcUrls,
});

const runtime = createRuntime({
  app,
  database,
  sessions,
  identity,
  matching,
  community,
  media,
  mediaProvider,
  wallets,
  logger,
  config,
  verifyDatabase: () =>
    verifyDatabaseState(database, new URL("../migrations", import.meta.url)),
  backgroundJobs: config.backgroundJobs,
});

await runtime.start();

logger.info(
  {
    environment: config.environment,
    host: config.host,
    port: config.port,
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
    await runtime.stop();
    clearTimeout(forcedExit);
  } catch (error) {
    logger.error({ error }, "server shutdown failed");
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
