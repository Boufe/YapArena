import { readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { verifyRuntimeIdentity } from "./database.ts";

export async function verifyDatabaseState(
  database: Pool,
  migrationsDirectory: URL,
) {
  await verifyRuntimeIdentity(database);

  const files = await readdir(migrationsDirectory);
  const expected = files
    .filter((file) => /^\d+_.+\.js$/u.test(file))
    .map((file) => file.replace(/\.js$/u, ""))
    .sort();
  const result = await database.query<{ name: string }>(
    "SELECT name FROM yaparena_migrations.pgmigrations ORDER BY name",
  );
  const applied = result.rows.map(({ name }) => name).sort();
  const missing = expected.filter((name) => !applied.includes(name));

  if (missing.length > 0) {
    throw new Error(`database migrations are pending: ${missing.join(", ")}`);
  }
}
