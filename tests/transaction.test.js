import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  databaseFailure,
  runTransaction,
  sqlState,
  withTransaction,
} from "../dist/platform/transaction.js";

function fakePool({ fail = {} } = {}) {
  const statements = [];
  const releases = [];
  const client = new EventEmitter();
  client.query = async (sql) => {
    statements.push(sql);
    if (fail[sql]) throw fail[sql];
    return { rows: [], rowCount: 0 };
  };
  client.release = (...args) => {
    releases.push(args);
  };
  let connects = 0;
  return {
    client,
    statements,
    releases,
    get connects() {
      return connects;
    },
    async connect() {
      connects++;
      return client;
    },
  };
}

function sqlError(code) {
  return Object.assign(new Error(`sqlstate ${code}`), { code });
}

describe("withTransaction", () => {
  it("commits the work's result and releases the client", async () => {
    const pool = fakePool();
    const value = await withTransaction(pool, async (client) => {
      await client.query("SELECT 1");
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(pool.statements, ["BEGIN", "SELECT 1", "COMMIT"]);
    assert.deepEqual(pool.releases, [[]]);
  });

  it("rolls back and rethrows the work's error", async () => {
    const pool = fakePool();
    const failure = new Error("work failed");
    await assert.rejects(
      withTransaction(pool, async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(pool.statements, ["BEGIN", "ROLLBACK"]);
    assert.deepEqual(pool.releases, [[]]);
  });

  it("rolls back when COMMIT fails", async () => {
    const commit = new Error("commit failed");
    const pool = fakePool({ fail: { COMMIT: commit } });
    await assert.rejects(
      withTransaction(pool, async () => 1),
      (error) => error === commit,
    );
    assert.deepEqual(pool.statements, ["BEGIN", "COMMIT", "ROLLBACK"]);
  });

  it("throws a failed ROLLBACK unless the connection is guarded", async () => {
    const rollback = new Error("rollback failed");
    const pool = fakePool({ fail: { ROLLBACK: rollback } });
    await assert.rejects(
      withTransaction(pool, async () => {
        throw new Error("work failed");
      }),
      (error) => error === rollback,
    );
    assert.deepEqual(pool.releases, [[]]);
  });

  it("adds isolation and read-only modes to BEGIN", async () => {
    for (const [options, begin] of [
      [{ readOnly: true }, "BEGIN READ ONLY"],
      [{ isolation: "serializable" }, "BEGIN ISOLATION LEVEL SERIALIZABLE"],
      [{ isolation: "read committed" }, "BEGIN ISOLATION LEVEL READ COMMITTED"],
      [
        { isolation: "repeatable read", readOnly: true },
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      ],
    ]) {
      const pool = fakePool();
      await withTransaction(pool, async () => null, options);
      assert.equal(pool.statements[0], begin);
    }
  });

  it("sets statement and lock timeouts after BEGIN", async () => {
    const pool = fakePool();
    await withTransaction(pool, async () => null, {
      statementTimeoutMs: 30000,
      lockTimeoutMs: 1500,
    });
    assert.deepEqual(pool.statements, [
      "BEGIN",
      "SET LOCAL statement_timeout = '30s'",
      "SET LOCAL lock_timeout = '1500ms'",
      "COMMIT",
    ]);
    const lockOnly = fakePool();
    await withTransaction(lockOnly, async () => null, { lockTimeoutMs: 5000 });
    assert.deepEqual(lockOnly.statements, [
      "BEGIN",
      "SET LOCAL lock_timeout = '5s'",
      "COMMIT",
    ]);
  });

  it("rejects invalid options before connecting", async () => {
    for (const options of [
      { statementTimeoutMs: 0 },
      { statementTimeoutMs: 1.5 },
      { lockTimeoutMs: -1 },
      { lockTimeoutMs: Number.NaN },
      { isolation: "read uncommitted; DROP TABLE users" },
    ]) {
      const pool = fakePool();
      await assert.rejects(
        withTransaction(pool, async () => null, options),
        RangeError,
      );
      assert.equal(pool.connects, 0);
    }
  });

  it("maps the error after ROLLBACK", async () => {
    const pool = fakePool();
    const mapped = new Error("mapped");
    await assert.rejects(
      withTransaction(
        pool,
        async () => {
          throw sqlError("23505");
        },
        {
          mapError: (error) =>
            databaseFailure(error) === "unique_violation" ? mapped : error,
        },
      ),
      (error) => error === mapped,
    );
    assert.deepEqual(pool.statements, ["BEGIN", "ROLLBACK"]);
  });

  it("rolls back on request and resolves to the given value", async () => {
    const pool = fakePool();
    const value = await withTransaction(pool, async (client, transaction) => {
      await client.query("INSERT");
      transaction.rollback("skipped");
    });
    assert.equal(value, "skipped");
    assert.deepEqual(pool.statements, ["BEGIN", "INSERT", "ROLLBACK"]);
  });

  it("does not map a requested rollback, and throws its failure", async () => {
    const rollback = new Error("rollback failed");
    const pool = fakePool({ fail: { ROLLBACK: rollback } });
    await assert.rejects(
      withTransaction(
        pool,
        async (_client, transaction) => transaction.rollback(0),
        { guardConnection: true, mapError: () => new Error("mapped") },
      ),
      (error) => error === rollback,
    );
    assert.equal(pool.releases[0][0], true);
  });

  it("treats another transaction's rollback request as an error", async () => {
    const outer = fakePool();
    const inner = fakePool();
    let request;
    await withTransaction(inner, async (_client, transaction) => {
      try {
        transaction.rollback(1);
      } catch (error) {
        request = error;
      }
      return 0;
    });
    await assert.rejects(
      withTransaction(outer, async () => {
        throw request;
      }),
      (error) => error === request,
    );
    assert.deepEqual(outer.statements, ["BEGIN", "ROLLBACK"]);
  });

  describe("guardConnection", () => {
    it("listens for socket errors only while checked out", async () => {
      const pool = fakePool();
      const value = await withTransaction(
        pool,
        async (client) => {
          assert.equal(client.listenerCount("error"), 1);
          return "ok";
        },
        { guardConnection: true },
      );
      assert.equal(value, "ok");
      assert.equal(pool.client.listenerCount("error"), 0);
      assert.deepEqual(pool.releases, [[undefined]]);
    });

    it("fails before COMMIT and discards the client after a socket error", async () => {
      const pool = fakePool();
      const lost = new Error("connection lost");
      await assert.rejects(
        withTransaction(
          pool,
          async (client) => {
            client.emit("error", lost);
            return 1;
          },
          {
            guardConnection: true,
            mapError: (error) => Object.assign(new Error("mapped"), { error }),
          },
        ),
        (error) => error.message === "mapped" && error.error === lost,
      );
      assert.deepEqual(pool.statements, ["BEGIN", "ROLLBACK"]);
      assert.deepEqual(pool.releases, [[lost]]);
      assert.equal(pool.client.listenerCount("error"), 0);
    });

    it("ignores a failed ROLLBACK and discards the client", async () => {
      const pool = fakePool({ fail: { ROLLBACK: new Error("rollback") } });
      const failure = new Error("work failed");
      await assert.rejects(
        withTransaction(
          pool,
          async () => {
            throw failure;
          },
          { guardConnection: true },
        ),
        (error) => error === failure,
      );
      assert.deepEqual(pool.releases, [[true]]);
    });

    it("returns a healthy client after an ordinary failure", async () => {
      const pool = fakePool();
      await assert.rejects(
        withTransaction(
          pool,
          async () => {
            throw new Error("work failed");
          },
          { guardConnection: true },
        ),
        /work failed/,
      );
      assert.deepEqual(pool.releases, [[undefined]]);
    });
  });
});

describe("runTransaction", () => {
  it("uses the caller's client without releasing it", async () => {
    const pool = fakePool();
    const value = await runTransaction(pool.client, async () => "done", {
      isolation: "repeatable read",
      readOnly: true,
      statementTimeoutMs: 3000,
    });
    assert.equal(value, "done");
    assert.deepEqual(pool.statements, [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout = '3s'",
      "COMMIT",
    ]);
    assert.deepEqual(pool.releases, []);
  });

  it("ignores a failed ROLLBACK when guarded", async () => {
    const pool = fakePool({ fail: { ROLLBACK: new Error("rollback") } });
    const failure = new Error("work failed");
    await assert.rejects(
      runTransaction(
        pool.client,
        async () => {
          throw failure;
        },
        { guardConnection: true },
      ),
      (error) => error === failure,
    );
    assert.deepEqual(pool.releases, []);
  });
});

describe("SQLSTATE mapping", () => {
  it("reads the code of database errors only", () => {
    assert.equal(sqlState(sqlError("23505")), "23505");
    assert.equal(sqlState(new Error("plain")), undefined);
    assert.equal(sqlState(null), undefined);
    assert.equal(sqlState("23505"), undefined);
  });

  it("classifies constraint and busy failures", () => {
    assert.equal(databaseFailure(sqlError("23505")), "unique_violation");
    assert.equal(databaseFailure(sqlError("23514")), "check_violation");
    for (const code of ["55P03", "57014", "40P01"])
      assert.equal(databaseFailure(sqlError(code)), "busy");
    for (const error of [
      sqlError("23503"),
      sqlError("constructor"),
      new Error("plain"),
      undefined,
    ])
      assert.equal(databaseFailure(error), undefined);
  });
});
