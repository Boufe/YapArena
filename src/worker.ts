import { loadConfig } from "./platform/config.ts";
import { createDatabase } from "./platform/database.ts";
import { createLogger } from "./platform/logger.ts";
import { createMetrics } from "./platform/metrics.ts";
import { createBackgroundWorker } from "./services.ts";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const metrics = createMetrics();
const database = createDatabase(config.databaseUrl, logger, (seconds) =>
  metrics.poolWait.observe(seconds),
);
const worker = createBackgroundWorker({
  config,
  database,
  logger,
  metrics,
});

await worker.start();
logger.info(
  {
    environment: config.environment,
    media: Boolean(config.media),
  },
  "background worker started",
);

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
    await worker.stop();
    clearTimeout(forcedExit);
  } catch (error) {
    logger.error({ error }, "worker shutdown failed");
    process.exitCode = 1;
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
