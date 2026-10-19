import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

// Explicit operator workflow only. Never imported by the web process or a migration.
const exec = promisify(execFile);
const mode = process.argv[2] ?? "--dry-run";
assert.ok(["--dry-run", "--prepare", "--rehearse", "--execute"].includes(mode));
const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};
function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    throw new Error("invalid operator URL; raw value withheld");
  }
}
const source = safeUrl(required("RESET_DATABASE_URL"));
assert.equal(
  source.hostname,
  required("RESET_EXPECTED_HOST"),
  "database host mismatch",
);
assert.equal(
  source.pathname.slice(1),
  required("RESET_EXPECTED_DATABASE"),
  "database name mismatch",
);
assert.equal(
  source.username.split(".").slice(1).join("."),
  required("RESET_EXPECTED_PROJECT"),
  "provider project mismatch",
);
assert.equal(
  required("RESET_ENVIRONMENT"),
  "staging",
  "only explicitly identified test staging is supported",
);
const origin = safeUrl(required("RESET_ORIGIN"));
assert.equal(origin.protocol, "https:");
const directory = path.resolve(required("RESET_BACKUP_DIRECTORY"));
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
type Table = { schema: string; name: string };
type Fingerprint = { table: string; count: number; sha256: string };
type Sequence = { name: string; lastValue: string; called: boolean };
type Backup = {
  formatVersion: 2;
  target: { host: string; database: string; project: string; origin: string };
  at: string;
  sha256: string;
  fingerprints: Fingerprint[];
  sequences: Sequence[];
};
const target = {
  host: source.hostname,
  database: source.pathname.slice(1),
  project: required("RESET_EXPECTED_PROJECT"),
  origin: origin.origin,
};
const db = new pg.Client({
  connectionString: source.href,
  options: "-c search_path=pg_catalog,yaparena,pg_temp",
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
  application_name: "yaparena-account-reset-operator",
});
async function tables(): Promise<Table[]> {
  return (
    await db.query<Table>(
      "SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname IN ('yaparena','yaparena_migrations') ORDER BY schemaname,tablename",
    )
  ).rows;
}
async function fingerprints(
  client: pg.Client,
  items: Table[],
): Promise<Fingerprint[]> {
  const results: Fingerprint[] = [];
  await client.query("SET TIME ZONE 'UTC'");
  for (const table of items) {
    const rows = (
      await client.query(
        `SELECT row_to_json(t)::text AS value FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY row_to_json(t)::text COLLATE "C"`,
      )
    ).rows as { value: string }[];
    results.push({
      table: `${table.schema}.${table.name}`,
      count: rows.length,
      sha256: sha(rows.map((row) => row.value).join("\n")),
    });
  }
  return results;
}
async function sequences(client: pg.Client): Promise<Sequence[]> {
  const names = (
    await client.query<{ schema: string; name: string }>(
      "SELECT schemaname AS schema,sequencename AS name FROM pg_sequences WHERE schemaname IN ('yaparena','yaparena_migrations') ORDER BY schemaname,sequencename",
    )
  ).rows;
  const result: Sequence[] = [];
  for (const entry of names) {
    const value = (
      await client.query<{ lastValue: string; called: boolean }>(
        `SELECT last_value::text AS "lastValue",is_called AS called FROM ${quote(entry.schema)}.${quote(entry.name)}`,
      )
    ).rows[0]!;
    result.push({ name: `${entry.schema}.${entry.name}`, ...value });
  }
  return result;
}
function pgEnv(url: URL) {
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "verify-full",
    PGSSLROOTCERT: url.searchParams.get("sslrootcert") ?? "",
  };
}
async function key() {
  const value = Buffer.from(required("RESET_BACKUP_KEY"), "base64");
  assert.equal(
    value.length,
    32,
    "backup key must be 32 random bytes encoded as base64",
  );
  return value;
}
async function backupMetadata(): Promise<Backup> {
  const metadata: Backup = JSON.parse(
    await readFile(path.join(directory, "backup.json"), "utf8"),
  );
  assert.equal(metadata.formatVersion, 2, "capture a fresh canonical backup");
  return metadata;
}
async function decrypt() {
  const bytes = await readFile(path.join(directory, "application.dump.enc"));
  const metadata = await backupMetadata();
  assert.deepEqual(metadata.target, target);
  assert.equal(sha(bytes), metadata.sha256);
  const cipher = createDecipheriv(
    "aes-256-gcm",
    await key(),
    bytes.subarray(0, 12),
  );
  cipher.setAAD(Buffer.from(JSON.stringify(target)));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]);
}
async function inspect() {
  assert.equal(
    (await db.query("SELECT current_user AS role")).rows[0].role,
    "yaparena_owner",
    "use a separate owner process, never a runtime credential",
  );
  const items = await tables();
  const migrationReady = items.some((item) => item.name === "account_subjects");
  const ledgerReady = items.some((item) => item.name === "coin_accounts");
  const grantsReady = items.some((item) => item.name === "coin_grant_lots");
  const counts = (
    await db.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM sessions) AS sessions,(SELECT count(*)::int FROM wallet_identities) AS wallets,
    (SELECT count(*)::int FROM public_profiles WHERE user_id IS NOT NULL) AS owned_profiles,
    (SELECT count(*)::int FROM a4_sessions) AS retained_play_runs,
    (SELECT count(*)::int FROM a4_journals) AS retained_play_journals,
    (SELECT count(*)::int FROM debate_media) AS retained_media`)
  ).rows[0];
  const conflicts = (
    await db.query(`SELECT
    ${ledgerReady ? "EXISTS(SELECT 1 FROM coin_journals WHERE environment='live') OR EXISTS(SELECT 1 FROM coin_accounts WHERE environment='live') OR" : ""}
    ${grantsReady ? "EXISTS(SELECT 1 FROM coin_grant_lots WHERE environment='live') OR" : ""}
    EXISTS(SELECT 1 FROM a4_assets WHERE mode<>'play') AS financial,
    EXISTS(SELECT 1 FROM a4_rounds WHERE state NOT IN ('settled','void')) AS rounds,
    EXISTS(SELECT 1 FROM debates WHERE status IN ('ready','live')) AS live`)
  ).rows[0];
  console.log(
    JSON.stringify({
      mode,
      target,
      counts,
      migrationReady,
      conflicts,
      preservation:
        "Public content, detached profile snapshots, media objects, historical subject IDs and all play journals remain. User credentials, application sessions and cascading private account records are removed.",
    }),
  );
  if (mode === "--execute")
    assert.ok(migrationReady, "apply the reviewed retirement migration first");
  assert.equal(
    conflicts.financial,
    false,
    "financial records or obligations exist; destructive reset refused",
  );
  assert.equal(
    conflicts.rounds,
    false,
    "unsettled rounds require separate resolution before reset",
  );
  assert.equal(
    conflicts.live,
    false,
    "active events require separate media/provider shutdown",
  );
  return { items, counts };
}
let phase = "source connection";
try {
  await db.connect();
  phase = "source inspection";
  const { items, counts } = await inspect();
  if (mode !== "--dry-run") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assert.equal(
      (await stat(directory)).mode & 0o077,
      0,
      "backup directory must be private",
    );
    // Rehearsal restores only the guarded disposable local database. Snapshot
    // export additionally locks source tables; execution also requires no
    // runtime backends, including any retained by a managed pooler.
    if (mode !== "--rehearse") {
      assert.equal(
        required("RESET_WRITERS_STOPPED"),
        "true",
        "stop all web/worker writers and relevant callbacks first",
      );
      if (mode === "--execute") {
        const writers = (
          await db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='yaparena_runtime' AND pid<>pg_backend_pid()",
          )
        ).rows[0].n;
        assert.equal(
          writers,
          0,
          "runtime connections remain; drain the actual deployment first",
        );
      }
      phase = "source snapshot locks";
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query(
        `LOCK TABLE ${items.map((item) => `${quote(item.schema)}.${quote(item.name)}`).join(",")} IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    if (mode === "--prepare") {
      const snapshot = (
        await db.query("SELECT pg_export_snapshot() AS snapshot")
      ).rows[0].snapshot as string;
      const temporary = path.join(directory, "application.dump");
      try {
        await writeFile(temporary, "", { mode: 0o600, flag: "wx" });
        phase = "snapshot export";
        await exec(
          "pg_dump",
          [
            "--format=custom",
            "--schema=yaparena",
            "--schema=yaparena_migrations",
            `--snapshot=${snapshot}`,
            `--file=${temporary}`,
          ],
          { env: pgEnv(source) },
        );
        phase = "snapshot encryption and fingerprints";
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", await key(), iv);
        cipher.setAAD(Buffer.from(JSON.stringify(target)));
        const encrypted = Buffer.concat([
          iv,
          cipher.update(await readFile(temporary)),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
        await writeFile(
          path.join(directory, "application.dump.enc"),
          encrypted,
          { mode: 0o600, flag: "wx" },
        );
        const metadata: Backup = {
          formatVersion: 2,
          target,
          at: new Date().toISOString(),
          sha256: sha(encrypted),
          fingerprints: await fingerprints(db, items),
          sequences: await sequences(db),
        };
        await writeFile(
          path.join(directory, "backup.json"),
          JSON.stringify(metadata, null, 2),
          { mode: 0o600, flag: "wx" },
        );
        console.log(
          "Encrypted application backup captured. Restore rehearsal is required before execution.",
        );
      } finally {
        await unlink(temporary).catch(() => {});
      }
    } else if (mode === "--rehearse") {
      phase = "restore target validation";
      const restore = safeUrl(required("RESET_RESTORE_DATABASE_URL"));
      assert.ok(["127.0.0.1", "localhost"].includes(restore.hostname));
      assert.match(
        restore.pathname,
        /^\/yaparena_auth_reset_rehearsal_[a-z0-9_]+$/,
      );
      const local = new pg.Client({ connectionString: restore.href });
      phase = "restore connection";
      await local.connect();
      const temporary = path.join(directory, "restore.dump");
      try {
        phase = "restore empty-database check";
        assert.equal(
          (
            await local.query(
              "SELECT count(*)::int n FROM pg_namespace WHERE nspname IN ('yaparena','yaparena_migrations')",
            )
          ).rows[0].n,
          0,
          "restore database must be empty and disposable",
        );
        phase = "backup decryption";
        await writeFile(temporary, await decrypt(), {
          mode: 0o600,
          flag: "wx",
        });
        phase = "archive restore";
        await exec(
          "pg_restore",
          [
            "--single-transaction",
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            `--dbname=${restore.pathname.slice(1)}`,
            temporary,
          ],
          { env: pgEnv(restore) },
        );
        phase = "restored table fingerprints";
        const metadata = await backupMetadata();
        assert.deepEqual(
          await fingerprints(local, items),
          metadata.fingerprints,
        );
        phase = "restored sequence fingerprints";
        assert.deepEqual(await sequences(local), metadata.sequences);
        // A pre-migration backup can be restored and checked first. Execution
        // also requires a fresh post-migration backup with a deletion rehearsal.
        const ready = items.some((item) => item.name === "account_subjects");
        if (ready) {
          phase = "restored deletion rehearsal";
          await local.query("BEGIN");
          await local.query("SET search_path=pg_catalog,yaparena,pg_temp");
          await local.query("DELETE FROM users");
          assert.equal(
            (await local.query("SELECT count(*)::int n FROM users")).rows[0].n,
            0,
          );
          await local.query("ROLLBACK");
        }
        phase = "restore proof write";
        await writeFile(
          path.join(directory, "restore-verified.json"),
          JSON.stringify({
            sha256: metadata.sha256,
            at: new Date().toISOString(),
            tableFingerprintsMatch: true,
            deletionRehearsal: ready,
          }),
          { mode: 0o600, flag: "wx" },
        );
        console.log(
          ready
            ? "Restore fingerprints and deletion rehearsal passed in the disposable local database."
            : "Pre-migration restore fingerprints passed. A fresh post-migration backup and deletion rehearsal are still required.",
        );
      } finally {
        await unlink(temporary).catch(() => {});
        await local.end();
      }
    } else {
      phase = "execution backup/proof checks";
      const metadata = await backupMetadata();
      const proof = JSON.parse(
        await readFile(path.join(directory, "restore-verified.json"), "utf8"),
      );
      assert.deepEqual(metadata.target, target);
      assert.equal(proof.sha256, metadata.sha256);
      assert.equal(proof.deletionRehearsal, true);
      await decrypt();
      assert.deepEqual(
        await fingerprints(db, items),
        metadata.fingerprints,
        "source changed since the backup; capture and rehearse a fresh backup",
      );
      assert.deepEqual(
        await sequences(db),
        metadata.sequences,
        "source sequences changed since backup",
      );
      phase = "account deletion";
      await db.query("DELETE FROM users");
      const after = (
        await db.query(
          "SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM sessions) AS sessions,(SELECT count(*)::int FROM wallet_identities) AS wallets,(SELECT count(*)::int FROM wallet_challenges) AS challenges",
        )
      ).rows[0];
      assert.deepEqual(after, {
        users: 0,
        sessions: 0,
        wallets: 0,
        challenges: 0,
      });
      phase = "account deletion commit";
      await db.query("COMMIT");
      const report = {
        target,
        before: counts,
        after,
        at: new Date().toISOString(),
        backupSha256: metadata.sha256,
        status:
          "Database reset committed; hosted fresh-signup acceptance and final test-identity cleanup still required",
      };
      await writeFile(
        path.join(directory, "execution-report.json"),
        JSON.stringify(report, null, 2),
        { mode: 0o600, flag: "wx" },
      );
      console.log(JSON.stringify(report));
    }
    if (mode === "--prepare") await db.query("COMMIT");
  }
} catch {
  await db.query("ROLLBACK").catch(() => {});
  console.error(
    `Reset stopped during ${phase}. No success is claimed; inspect target checks, private operator files, writer drain, financial conflicts and restore evidence. Credentials and raw database errors are withheld.`,
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
