import type { Pool, PoolClient } from "pg";

export type IsolationLevel =
  "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  /** Adds ISOLATION LEVEL to BEGIN. Omitted, the server default applies. */
  isolation?: IsolationLevel;
  /** Adds READ ONLY to BEGIN. */
  readOnly?: boolean;
  /** Runs SET LOCAL statement_timeout after BEGIN. */
  statementTimeoutMs?: number;
  /** Runs SET LOCAL lock_timeout after BEGIN (and after statement_timeout). */
  lockTimeoutMs?: number;
  /**
   * Treats the connection as possibly broken. withTransaction records socket
   * errors while the client is checked out and fails the transaction before
   * COMMIT; a failed ROLLBACK is ignored so the original error surfaces; and a
   * connection that errored or failed to roll back is discarded instead of
   * returned to the pool. Without it, a failed ROLLBACK error is thrown.
   */
  guardConnection?: boolean;
  /** Replaces the error thrown by a failed transaction, after ROLLBACK. */
  mapError?: (error: unknown) => unknown;
}

export interface Transaction<T> {
  /** Rolls back instead of committing; the transaction resolves to value. */
  rollback(value: T): never;
}

export type TransactionWork<T> = (
  client: PoolClient,
  transaction: Transaction<T>,
) => Promise<T>;

export type DatabaseFailure = "unique_violation" | "check_violation" | "busy";

// The one SQLSTATE classification shared by repositories. Features turn a
// class into their own error type (see the A4 repository).
const databaseFailures = new Map<string, DatabaseFailure>([
  ["23505", "unique_violation"],
  ["23514", "check_violation"],
  ["55P03", "busy"], // lock_not_available: lock_timeout expired
  ["57014", "busy"], // query_canceled: statement_timeout expired
  ["40P01", "busy"], // deadlock_detected
]);

export function sqlState(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export function databaseFailure(error: unknown) {
  const code = sqlState(error);
  return code === undefined ? undefined : databaseFailures.get(code);
}

class RollbackRequest<T> {
  constructor(
    readonly owner: Transaction<T>,
    readonly value: T,
  ) {}
}

interface Plan {
  setup: string[];
  guard: boolean;
  mapError: ((error: unknown) => unknown) | undefined;
}

function duration(name: string, milliseconds: number) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
    throw new RangeError(`invalid ${name}`);
  return milliseconds % 1000 === 0
    ? `${milliseconds / 1000}s`
    : `${milliseconds}ms`;
}

function plan(options: TransactionOptions): Plan {
  const modes: string[] = [];
  if (options.isolation !== undefined) {
    if (
      !["read committed", "repeatable read", "serializable"].includes(
        options.isolation,
      )
    )
      throw new RangeError("invalid isolation level");
    modes.push(`ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
  }
  if (options.readOnly) modes.push("READ ONLY");
  const setup = [modes.length ? `BEGIN ${modes.join(" ")}` : "BEGIN"];
  if (options.statementTimeoutMs !== undefined)
    setup.push(
      `SET LOCAL statement_timeout = '${duration("statement timeout", options.statementTimeoutMs)}'`,
    );
  if (options.lockTimeoutMs !== undefined)
    setup.push(
      `SET LOCAL lock_timeout = '${duration("lock timeout", options.lockTimeoutMs)}'`,
    );
  return {
    setup,
    guard: options.guardConnection === true,
    mapError: options.mapError,
  };
}

async function execute<T>(
  client: PoolClient,
  work: TransactionWork<T>,
  { setup, guard, mapError }: Plan,
  beforeCommit?: () => void,
  rollbackFailed?: () => void,
): Promise<T> {
  const transaction: Transaction<T> = {
    rollback(value) {
      throw new RollbackRequest(transaction, value);
    },
  };
  try {
    for (const statement of setup) await client.query(statement);
    const value = await work(client, transaction);
    beforeCommit?.();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    if (error instanceof RollbackRequest && error.owner === transaction) {
      try {
        await client.query("ROLLBACK");
      } catch (failure) {
        rollbackFailed?.();
        throw failure;
      }
      return (error as RollbackRequest<T>).value;
    }
    if (guard) {
      try {
        await client.query("ROLLBACK");
      } catch {
        rollbackFailed?.();
      }
    } else await client.query("ROLLBACK");
    throw mapError ? mapError(error) : error;
  }
}

/**
 * Runs work in one transaction on a pooled connection: BEGIN with the
 * requested modes and timeouts, then COMMIT, or ROLLBACK and rethrow.
 */
export async function withTransaction<T>(
  pool: Pick<Pool, "connect">,
  work: TransactionWork<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const steps = plan(options);
  const client = await pool.connect();
  if (!steps.guard) {
    try {
      return await execute(client, work, steps);
    } finally {
      client.release();
    }
  }
  let connectionError: Error | undefined;
  let discard = false;
  const lost = (error: Error) => {
    connectionError = error;
  };
  client.on("error", lost);
  try {
    return await execute(
      client,
      work,
      steps,
      () => {
        if (connectionError) throw connectionError;
      },
      () => {
        discard = true;
      },
    );
  } finally {
    client.removeListener("error", lost);
    client.release(connectionError ?? (discard || undefined));
  }
}

/**
 * Runs work in one transaction on a client the caller already checked out
 * and will release itself. guardConnection only ignores a failed ROLLBACK
 * here; the caller listens for socket errors.
 */
export async function runTransaction<T>(
  client: PoolClient,
  work: TransactionWork<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return execute(client, work, plan(options));
}
