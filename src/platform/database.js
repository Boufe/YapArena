import pg from "pg";

const { Pool } = pg;

export function createDatabase(connectionString, logger) {
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
