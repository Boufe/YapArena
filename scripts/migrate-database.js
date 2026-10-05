import { runner } from "node-pg-migrate";
import pg from "pg";

// Runs only in a one-off job/operator process. The URL is supplied as DATABASE_URL to
// this process alone; web/worker receive a different, runtime-only DATABASE_URL.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  if (!process.env.DATABASE_URL)
    throw new Error("Missing migration connection");
  await client.connect();
  const identity = await client.query(
    "SELECT current_user = 'yaparena_owner' AS safe",
  );
  if (!identity.rows[0].safe) throw new Error("Wrong migration identity");
  await runner({
    dbClient: client,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    log: () => {},
    logger: { info() {}, warn() {}, error() {} },
  });
  console.log("Database migrations completed with the migration identity.");
} catch (error) {
  console.error(
    `Database migration failed (${error.code ?? "check provisioning and migration review"}).`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
