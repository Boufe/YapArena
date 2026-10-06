import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

import { verifyDatabaseState } from "../dist/platform/migrations.js";

describe("database migration verification", () => {
  async function migrationDirectory() {
    const directory = await mkdtemp(join(tmpdir(), "service-migrations-"));
    await writeFile(join(directory, "100_create-users.js"), "");
    return directory;
  }

  it("accepts a connected, current database", async () => {
    const database = {
      query: mock.fn(async (sql) =>
        sql.includes("AS safe FROM pg_roles")
          ? { rows: [{ safe: true }] }
          : { rows: [{ name: "100_create-users" }] },
      ),
    };

    await verifyDatabaseState(database, await migrationDirectory());
    assert.equal(database.query.mock.callCount(), 2);
  });

  it("rejects a database with pending migrations", async () => {
    const database = {
      query: async (sql) =>
        sql.includes("AS safe FROM pg_roles")
          ? { rows: [{ safe: true }] }
          : { rows: [] },
    };

    await assert.rejects(
      verifyDatabaseState(database, await migrationDirectory()),
      /database migrations are pending: 100_create-users/,
    );
  });
  it("rejects an unsafe or unrecognized runtime identity before serving traffic", async () => {
    for (const rows of [[{ safe: false }], []]) {
      await assert.rejects(
        verifyDatabaseState(
          { query: async () => ({ rows }) },
          await migrationDirectory(),
        ),
        /runtime identity violates/,
      );
    }
  });
});
