import { readdir } from "node:fs/promises";

export async function verifyDatabaseState(database, migrationsDirectory) {
  await database.query("SELECT 1");

  const files = await readdir(migrationsDirectory);
  const expected = files
    .filter((file) => /^\d+_.+\.js$/u.test(file))
    .map((file) => file.replace(/\.js$/u, ""))
    .sort();
  const result = await database.query(
    "SELECT name FROM pgmigrations ORDER BY name",
  );
  const applied = result.rows.map(({ name }) => name).sort();
  const missing = expected.filter((name) => !applied.includes(name));

  if (missing.length > 0) {
    throw new Error(`database migrations are pending: ${missing.join(", ")}`);
  }
}
