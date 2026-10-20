import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { runner } from "node-pg-migrate";

// Explicit deployment operator only. Never imported into runtime or migrations.
// prepare: encrypted private backup + isolated restore/migration rehearsal.
// migrate: exact reviewed migrations, only after prepare and lead release gates.
// Neither mode deletes users, changes provider settings or enables money movement.
const mode = process.argv[2];
assert.ok(mode === "prepare" || mode === "migrate");
assert.equal(process.argv.length, 3);
// These are operator assertions, not proof that Render actually stopped web,
// worker and callback writers. The lead verifies those states independently.
assert.equal(process.env.ACCOUNT_STAGING_WRITERS_STOPPED, "true");
assert.equal(process.env.ACCOUNT_STAGING_RELEASE_GATES_PASSED, "true");
const projectRef = "ypteqfmjietdqjzyvgtk";
const privateRoot = "/private/tmp/yaparena-auth-operator";
const credentialPath = resolve(privateRoot, "role-recovery.json");
const keyPath = resolve(privateRoot, "selected-1-4-3/backup-key");
const reviewedPending = [
  "1792426004000_add-account-operation-proofs",
  "1792426005000_add-account-security-passkeys",
  "1792426006000_add-isolated-coin-sandbox",
  "1792426006100_add-coin-debate-rounds",
  "1792426006200_add-sandbox-webhook-inbox",
  "1792426006300_allow-guarded-sandbox-void",
  "1792426006400_add-account-media-revocation",
  "1792426006500_add-sandbox-treasury-funding",
  "1792426007000_add-account-access-reconciliation",
  "1792426008000_bind-media-replacement-intent",
  "1792426009000_add-sandbox-error-reports",
  "1792426010000_enforce-sandbox-withdrawal-operator-boundary",
];
const exec = promisify(execFile),
  sha = (value: Buffer | string) =>
    createHash("sha256").update(value).digest("hex"),
  quote = (value: string) => `"${value.replaceAll('"', '""')}"`,
  quiet = { info() {}, warn() {}, error() {} };
type Login = { user: string; password: string };
type Configuration = {
  projectRef: string;
  host: string;
  port: number;
  database: string;
  owner: Login;
  runtime: Login;
  caPath: string;
};
type Table = { schema: string; name: string };
type Fingerprint = { table: string; count: number; sha256: string };
type Sequence = { name: string; lastValue: string; called: boolean };
type Metadata = {
  format: 1;
  projectRef: string;
  id: string;
  at: string;
  revision: string;
  ciphertextSha256: string;
  migrationHashes: Record<string, string>;
  applied: string[];
  pending: string[];
  tables: Table[];
  fingerprints: Fingerprint[];
  sequences: Sequence[];
  restoreVerified: boolean;
  migrationRehearsalVerified: boolean;
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function login(value: unknown): value is Login {
  return (
    object(value) &&
    typeof value.user === "string" &&
    typeof value.password === "string" &&
    value.password.length > 0
  );
}
function configuration(value: unknown): value is Configuration {
  return (
    object(value) &&
    value.projectRef === projectRef &&
    typeof value.host === "string" &&
    typeof value.port === "number" &&
    Number.isSafeInteger(value.port) &&
    value.port > 0 &&
    value.port < 65536 &&
    value.database === "postgres" &&
    login(value.owner) &&
    login(value.runtime) &&
    typeof value.caPath === "string"
  );
}
async function privateRead(path: string) {
  assert.equal(await realpath(path), path);
  const file = await lstat(path);
  assert.ok(file.isFile());
  assert.equal(file.mode & 0o077, 0);
  assert.equal((await lstat(dirname(path))).mode & 0o077, 0);
  return readFile(path);
}
async function fingerprints(client: pg.Client, tables: Table[]) {
  await client.query("SET TIME ZONE 'UTC'");
  const result: Fingerprint[] = [];
  for (const table of tables) {
    const rows = (
      await client.query<{ value: string }>(
        `SELECT row_to_json(t)::text AS value FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY row_to_json(t)::text COLLATE "C"`,
      )
    ).rows;
    result.push({
      table: `${table.schema}.${table.name}`,
      count: rows.length,
      sha256: sha(rows.map((row) => row.value).join("\n")),
    });
  }
  return result;
}
async function sequences(client: pg.Client) {
  const names = (
      await client.query<Table>(
        "SELECT schemaname AS schema,sequencename AS name FROM pg_sequences WHERE schemaname IN('yaparena','yaparena_migrations') ORDER BY schemaname,sequencename",
      )
    ).rows,
    result: Sequence[] = [];
  for (const name of names)
    result.push({
      name: `${name.schema}.${name.name}`,
      ...(
        await client.query<{ lastValue: string; called: boolean }>(
          `SELECT last_value::text AS "lastValue",is_called AS called FROM ${quote(name.schema)}.${quote(name.name)}`,
        )
      ).rows[0]!,
    });
  return result;
}
async function migrations(client: pg.Client) {
  return (
    await client.query<{ name: string }>(
      "SELECT name FROM yaparena_migrations.pgmigrations ORDER BY name",
    )
  ).rows.map((row) => row.name);
}
async function sourceMigrations() {
  const files = (await readdir("migrations"))
    .filter((name) => /^\d+_.*\.js$/.test(name))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name.slice(0, -3),
        sha(await readFile(resolve("migrations", name))),
      ]),
    ),
  );
}
async function verifyAccounts(client: pg.Client) {
  const state = (
    await client.query<{
      total: number;
      retained: number;
      deleted: number;
      live: number;
    }>(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE id IN(72,73,134))::int AS retained,count(*) FILTER(WHERE id IN(1,2,3,4))::int AS deleted,(SELECT count(*)::int FROM yaparena.coin_journals WHERE environment='live') AS live FROM yaparena.users",
    )
  ).rows[0]!;
  assert.deepEqual(state, { total: 4, retained: 3, deleted: 0, live: 0 });
  return state;
}
async function runMigrations(client: pg.Client) {
  assert.equal(
    (
      await client.query<{ owner: boolean }>(
        "SELECT current_user='yaparena_owner' AND session_user='yaparena_owner' AS owner",
      )
    ).rows[0]!.owner,
    true,
  );
  await client.query("SET lock_timeout='5s'");
  await client.query("SET statement_timeout='60s'");
  await runner({
    dbClient: client,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    checkOrder: true,
    singleTransaction: true,
    logger: quiet,
    log() {},
  });
}
async function availablePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done, fail) =>
    socket.close((error) => (error ? fail(error) : done())),
  );
  return port;
}
const ownerClients: pg.Client[] = [];
let step = "validate private configuration and lead release gates",
  cluster: string | undefined,
  started = false;
const operatorLockPath = resolve(privateRoot, "account-release.lock");
let operatorLock: Awaited<ReturnType<typeof open>> | undefined;
try {
  assert.equal(await realpath(privateRoot), privateRoot);
  assert.equal((await lstat(privateRoot)).mode & 0o077, 0);
  operatorLock = await open(operatorLockPath, "wx", 0o600);
  const parsed: unknown = JSON.parse(
    (await privateRead(credentialPath)).toString("utf8"),
  );
  assert.ok(configuration(parsed));
  const settings = parsed,
    pooler = settings.host.endsWith(".pooler.supabase.com");
  assert.ok(pooler || settings.host === `db.${projectRef}.supabase.co`);
  assert.equal(
    settings.owner.user,
    `yaparena_owner${pooler ? `.${projectRef}` : ""}`,
  );
  assert.equal(
    settings.runtime.user,
    `yaparena_runtime${pooler ? `.${projectRef}` : ""}`,
  );
  assert.notEqual(settings.owner.password, settings.runtime.password);
  const caPath = process.env.ACCOUNT_STAGING_CA_PATH ?? settings.caPath,
    ca = await readFile(caPath, "utf8"),
    key = Buffer.from(
      (await privateRead(keyPath)).toString("utf8").trim(),
      "base64",
    );
  assert.equal(key.length, 32);
  const client = new pg.Client({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.owner.user,
    password: settings.owner.password,
    ssl: { ca, rejectUnauthorized: true, servername: settings.host },
    connectionTimeoutMillis: 10000,
    query_timeout: 65000,
    statement_timeout: 60000,
    application_name: "yaparena-account-release-operator",
  });
  ownerClients.push(client);
  await client.connect();
  assert.equal(
    (
      await client.query<{ safe: boolean }>(
        "SELECT current_user='yaparena_owner' AND session_user='yaparena_owner' AND current_database()='postgres' AS safe",
      )
    ).rows[0]!.safe,
    true,
  );
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    migrationHashes = await sourceMigrations(),
    applied = await migrations(client),
    pending = Object.keys(migrationHashes).filter(
      (name) => !applied.includes(name),
    );
  assert.deepEqual(pending, reviewedPending);
  assert.deepEqual(
    applied.filter((name) => !(name in migrationHashes)),
    [],
  );
  await verifyAccounts(client);
  assert.equal(
    (
      await client.query<{ active: number }>(
        "SELECT count(*)::int AS active FROM pg_stat_activity WHERE usename='yaparena_runtime' AND pid<>pg_backend_pid() AND (state='active' OR xact_start IS NOT NULL)",
      )
    ).rows[0]!.active,
    0,
  );
  const pgEnvironment = {
    ...process.env,
    PGHOST: settings.host,
    PGPORT: String(settings.port),
    PGDATABASE: settings.database,
    PGUSER: settings.owner.user,
    PGPASSWORD: settings.owner.password,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: caPath,
    PGOPTIONS:
      "-c search_path=pg_catalog,yaparena,pg_temp -c statement_timeout=60000 -c lock_timeout=5000",
    PGCONNECT_TIMEOUT: "10",
  };
  if (mode === "prepare") {
    const directory = await mkdtemp(resolve(privateRoot, "account-release-")),
      id = randomUUID(),
      aad = Buffer.from(JSON.stringify({ projectRef, id }));
    assert.equal((await lstat(directory)).mode & 0o077, 0);
    step =
      "capture consistent application snapshot and encrypted private backup";
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL lock_timeout='5s'");
    const tables = (
      await client.query<Table>(
        "SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname IN('yaparena','yaparena_migrations') ORDER BY schemaname,tablename",
      )
    ).rows;
    await client.query(
      `LOCK TABLE ${tables.map((table) => `${quote(table.schema)}.${quote(table.name)}`).join(",")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const snapshot = (
        await client.query<{ snapshot: string }>(
          "SELECT pg_export_snapshot() AS snapshot",
        )
      ).rows[0]!.snapshot,
      dump = await exec(
        "pg_dump",
        [
          "--format=custom",
          "--schema=yaparena",
          "--schema=yaparena_migrations",
          `--snapshot=${snapshot}`,
        ],
        {
          env: pgEnvironment,
          encoding: "buffer",
          maxBuffer: 128 * 1024 * 1024,
          timeout: 60000,
          killSignal: "SIGTERM",
        },
      ),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
        iv,
        cipher.update(dump.stdout),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
      metadata: Metadata = {
        format: 1,
        projectRef,
        id,
        at: new Date().toISOString(),
        revision,
        ciphertextSha256: sha(ciphertext),
        migrationHashes,
        applied,
        pending,
        tables,
        fingerprints: await fingerprints(client, tables),
        sequences: await sequences(client),
        restoreVerified: false,
        migrationRehearsalVerified: false,
      };
    await writeFile(resolve(directory, "application.dump.enc"), ciphertext, {
      mode: 0o600,
      flag: "wx",
    });
    await client.query("COMMIT");
    step =
      "restore encrypted application snapshot into new private native PostgreSQL";
    cluster = await mkdtemp("/private/tmp/yaparena-account-release-rehearsal-");
    const postgresPassword = randomBytes(24).toString("hex"),
      ownerPassword = randomBytes(24).toString("hex"),
      runtimePassword = randomBytes(24).toString("hex"),
      passwordFile = resolve(cluster, "password"),
      port = await availablePort(),
      database = "yaparena_account_release_rehearsal";
    assert.match(
      (await exec("initdb", ["--version"], { timeout: 5000 })).stdout,
      /PostgreSQL\) (17|18)\./,
    );
    await writeFile(passwordFile, postgresPassword, { mode: 0o600 });
    await exec(
      "initdb",
      [
        "--encoding=UTF8",
        "--pgdata",
        resolve(cluster, "data"),
        "--username",
        "postgres",
        "--auth",
        "scram-sha-256",
        "--pwfile",
        passwordFile,
      ],
      { timeout: 30000, killSignal: "SIGTERM" },
    );
    await rm(passwordFile);
    // Startup may create the background server before pg_ctl itself times out.
    // Cleanup therefore treats even an interrupted start as potentially active.
    started = true;
    await exec(
      "pg_ctl",
      [
        "--pgdata",
        resolve(cluster, "data"),
        "--log",
        resolve(cluster, "postgres.log"),
        "--options",
        `-p ${port} -h 127.0.0.1 -k ${cluster}`,
        "--wait",
        "start",
      ],
      { timeout: 30000, killSignal: "SIGTERM" },
    );
    const admin = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: postgresPassword,
      database: "postgres",
    });
    ownerClients.push(admin);
    await admin.connect();
    for (const [name, password] of [
      ["yaparena_owner", ownerPassword],
      ["yaparena_runtime", runtimePassword],
    ] as const) {
      const command = (
        await admin.query<{ sql: string }>(
          "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',$1::text,$2::text) AS sql",
          [name, password],
        )
      ).rows[0]!.sql;
      await admin.query(command);
    }
    await admin.query(`CREATE DATABASE ${database} OWNER yaparena_owner`);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      ciphertext.subarray(0, 12),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    const restorePath = resolve(cluster, "restore.dump");
    await writeFile(
      restorePath,
      Buffer.concat([
        decipher.update(ciphertext.subarray(12, -16)),
        decipher.final(),
      ]),
      { mode: 0o600, flag: "wx" },
    );
    await exec(
      "pg_restore",
      [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        `--dbname=${database}`,
        restorePath,
      ],
      {
        env: {
          ...process.env,
          PGHOST: "127.0.0.1",
          PGPORT: String(port),
          PGDATABASE: database,
          PGUSER: "yaparena_owner",
          PGPASSWORD: ownerPassword,
          PGSSLMODE: "disable",
        },
        maxBuffer: 1024 * 1024,
        timeout: 60000,
        killSignal: "SIGTERM",
      },
    );
    await rm(restorePath);
    const local = new pg.Client({
      host: "127.0.0.1",
      port,
      user: "yaparena_owner",
      password: ownerPassword,
      database,
    });
    ownerClients.push(local);
    await local.connect();
    assert.deepEqual(await fingerprints(local, tables), metadata.fingerprints);
    assert.deepEqual(await sequences(local), metadata.sequences);
    metadata.restoreVerified = true;
    step = "rehearse exact additive migration set as local owner";
    // The restored schema has no hosted/provider objects or data. The local
    // owner role is deliberately not a superuser and owns only this new DB.
    await runMigrations(local);
    assert.deepEqual(await migrations(local), Object.keys(migrationHashes));
    await verifyAccounts(local);
    metadata.migrationRehearsalVerified = true;
    assert.deepEqual(await sourceMigrations(), migrationHashes);
    await writeFile(
      resolve(directory, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await mkdir(resolve("docs/evidence/account-completion-baseline"), {
      recursive: true,
    });
    await writeFile(
      resolve(
        "docs/evidence/account-completion-baseline/staging-release-prepare.json",
      ),
      `${JSON.stringify({ at: new Date().toISOString(), revision, projectRef, encryptedBackup: true, ciphertextSha256: metadata.ciphertextSha256, tableCount: tables.length, sequenceCount: metadata.sequences.length, exactRestoredFingerprints: true, restoredMigrationRehearsal: true, rehearsedMigrations: pending, hostedMigrationsApplied: 0, hostedAccountMutations: 0, retainedAccounts: 3, totalAccounts: 4, liveJournals: 0, limits: ["Private application schemas only; not a full Supabase/provider/global-role disaster recovery backup.", "Local restore intentionally omits original ACLs; hosted role/catalog boundary is verified separately.", "No deletion rehearsal, provider mutation, live funds, service-state change or deployment."] }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        result: "PASS",
        mode,
        encryptedBackup: true,
        restoreVerified: true,
        migrationRehearsalVerified: true,
        privateReleaseDirectory: directory,
        hostedMigrationsApplied: 0,
      }),
    );
  } else {
    step =
      "verify successful matching private backup/rehearsal before hosted migration";
    assert.equal(process.env.ACCOUNT_STAGING_APPLY_MIGRATIONS, "approved");
    const directory = process.env.ACCOUNT_STAGING_RELEASE_DIRECTORY;
    assert.ok(
      directory && directory.startsWith(`${privateRoot}/account-release-`),
    );
    assert.equal(await realpath(directory), directory);
    const value: unknown = JSON.parse(
      (await privateRead(resolve(directory, "metadata.json"))).toString("utf8"),
    );
    assert.ok(
      object(value) &&
        value.format === 1 &&
        value.projectRef === projectRef &&
        value.restoreVerified === true &&
        value.migrationRehearsalVerified === true &&
        value.revision === revision &&
        typeof value.ciphertextSha256 === "string" &&
        Array.isArray(value.tables) &&
        Array.isArray(value.fingerprints) &&
        Array.isArray(value.sequences),
    );
    assert.deepEqual(value.migrationHashes, migrationHashes);
    assert.deepEqual(value.applied, applied);
    assert.deepEqual(value.pending, pending);
    assert.equal(
      sha(await privateRead(resolve(directory, "application.dump.enc"))),
      value.ciphertextSha256,
    );
    const tables = (
      await client.query<Table>(
        "SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname IN('yaparena','yaparena_migrations') ORDER BY schemaname,tablename",
      )
    ).rows;
    assert.deepEqual(tables, value.tables);
    assert.deepEqual(await fingerprints(client, tables), value.fingerprints);
    assert.deepEqual(await sequences(client), value.sequences);
    step =
      "apply exact additive migration set with owner-only repository runner";
    await runMigrations(client);
    assert.deepEqual(await migrations(client), Object.keys(migrationHashes));
    await verifyAccounts(client);
    await writeFile(
      resolve(
        "docs/evidence/account-completion-baseline/staging-release-migrate.json",
      ),
      `${JSON.stringify({ at: new Date().toISOString(), revision, projectRef, appliedMigrations: pending, ownerOnly: true, retainedAccounts: 3, totalAccounts: 4, liveJournals: 0, encryptedBackupSha256: value.ciphertextSha256, rollback: "Forward-only schema changes. Retained encrypted backup is emergency recovery evidence; do not run down migrations or reset accounts. Reassess application compatibility before code rollback." }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        result: "PASS",
        mode,
        appliedMigrations: pending.length,
        retainedAccounts: 3,
        totalAccounts: 4,
        liveJournals: 0,
      }),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      result: "FAIL",
      mode,
      step,
      category: error instanceof Error ? error.name : "unclassified",
      detail:
        "Private credentials, endpoints, rows, SQL values and utility output are omitted; do not retry a failed hosted migration without inspecting current history.",
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled(ownerClients.map((client) => client.end()));
  let stopped = !started;
  if (started && cluster) {
    try {
      await exec(
        "pg_ctl",
        [
          "--pgdata",
          resolve(cluster, "data"),
          "--mode",
          "immediate",
          "--wait",
          "stop",
        ],
        { timeout: 15000, killSignal: "SIGTERM" },
      );
      stopped = true;
    } catch {
      try {
        await lstat(resolve(cluster, "data/postmaster.pid"));
      } catch (error) {
        stopped = object(error) && error.code === "ENOENT";
      }
      if (!stopped) {
        console.error(
          JSON.stringify({
            cleanup: "private local rehearsal server requires operator stop",
            privateCluster: cluster,
          }),
        );
        process.exitCode = 1;
      }
    }
  }
  try {
    if (cluster && stopped) await rm(cluster, { recursive: true, force: true });
  } finally {
    await operatorLock?.close();
    if (operatorLock) await rm(operatorLockPath);
  }
}
