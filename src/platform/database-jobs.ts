import type { Pool, PoolClient } from "pg";

// Transaction-scoped locks work on the configured direct/session path and cannot
// escape into a reused pool connection. No session or table lock is held by viewers.
export async function runExclusiveDatabaseJob<T>(
  database: Pool,
  key: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await database.connect();
  let connectionError: Error | undefined;
  const lost = (error: Error) => {
    connectionError = error;
  };
  client.on("error", lost);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
      [`yaparena-job-v1:${key}`],
    );
    if (!result.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return { acquired: false };
    }
    const value = await work(client);
    if (connectionError) throw connectionError;
    await client.query("COMMIT");
    return { acquired: true, value };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.removeListener("error", lost);
    client.release(connectionError);
  }
}
