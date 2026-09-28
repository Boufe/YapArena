import pg from "pg";
import type { Logger } from "pino";

const { Pool } = pg;

export function createDatabase(connectionString: string, logger: Logger) {
  const database = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  database.on("error", (error) => {
    logger.error({ error }, "idle database connection failed");
  });

  return database;
}
