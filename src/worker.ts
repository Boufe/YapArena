import { createIdentityRepository } from "./features/identity/repository.ts";
import { createMatchingRepository } from "./features/matching/repository.ts";
import { createMediaRepository } from "./features/media/repository.ts";
import { createMediaProvider } from "./features/media/provider.ts";
import { createMediaOperations } from "./features/media/operations.ts";
import { createSessionRepository } from "./platform/auth/sessions.ts";
import { createWalletRepository } from "./platform/auth/wallets.ts";
import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { verifyDatabaseState } from "./platform/migrations.ts";
import { createRuntime } from "./platform/runtime.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const database = createDatabase(config.databaseUrl, logger);
const media = config.media ? createMediaRepository(database) : undefined;
const baseMediaProvider = config.media
  ? createMediaProvider(config.media)
  : undefined;
const mediaOperations =
  media && baseMediaProvider
    ? createMediaOperations({
        database,
        media,
        provider: baseMediaProvider,
        logger,
      })
    : undefined;
const runtime = createRuntime({
  database,
  sessions: createSessionRepository(database),
  identity: createIdentityRepository(database),
  matching: createMatchingRepository(database),
  media,
  mediaProvider: mediaOperations?.provider,
  mediaOperations,
  wallets: createWalletRepository(database),
  logger,
  config,
  verifyDatabase: () =>
    verifyDatabaseState(database, new URL("../migrations", import.meta.url)),
});

await runtime.start();
logger.info("background worker started");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutdown requested");
  const forcedExit = setTimeout(() => {
    logger.fatal("forced worker shutdown");
    process.exit(1);
  }, 10_000);
  forcedExit.unref();
  try {
    await runtime.stop();
    clearTimeout(forcedExit);
  } catch (error) {
    logger.error({ error }, "worker shutdown failed");
    process.exitCode = 1;
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
