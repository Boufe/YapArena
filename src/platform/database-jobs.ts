import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./transaction.ts";

// Transaction-scoped locks work on the configured direct/session path and cannot
// escape into a reused pool connection. No session or table lock is held by viewers.
export async function runExclusiveDatabaseJob<T>(
  database: Pool,
  key: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  return withTransaction(
    database,
    async (client, transaction) => {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [`yaparena-job-v1:${key}`],
      );
      if (!result.rows[0]?.acquired)
        return transaction.rollback({ acquired: false });
      return { acquired: true, value: await work(client) };
    },
    { statementTimeoutMs: 5000, guardConnection: true },
  );
}
