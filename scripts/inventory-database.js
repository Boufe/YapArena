import { readFile } from "node:fs/promises";
import pg from "pg";

// Supply an inspection URL to this operator process only. Output contains catalog
// identifiers and privilege evidence, never application rows or connection strings.
const client = new pg.Client({
  connectionString: process.env.DATABASE_INSPECTION_URL,
});
try {
  if (!process.env.DATABASE_INSPECTION_URL)
    throw new Error("Missing inspection connection");
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const sql = await readFile(
    new URL("./database-privilege-inventory.sql", import.meta.url),
    "utf8",
  );
  const result = await client.query(sql);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        result.rows.map(({ section, evidence }) => [section, evidence]),
      ),
      null,
      2,
    ),
  );
  await client.query("COMMIT");
} catch (error) {
  console.error(
    `Database inventory failed (${error.code ?? "inspection connection required"}).`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
