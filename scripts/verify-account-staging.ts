import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

// This is a fixed-target, read-only operator inspection. It never loads .env,
// changes roles/data/schema/service state, prints identities or supplies owner
// credentials to an application/worker. The existing private file stays private.
const projectRef = "ypteqfmjietdqjzyvgtk";
const credentialPath = "/private/tmp/yaparena-auth-operator/role-recovery.json";
const evidenceDirectory = resolve(
  "docs/evidence/account-completion-baseline/embedded-wallet-release",
);
const phase = process.argv[2];
assert.ok(phase === "preflight" || phase === "postflight");
assert.equal(process.argv.length, 3);
type Credentials = {
  projectRef: string;
  host: string;
  port: number;
  database: string;
  owner: { user: string; password: string };
  runtime: { user: string; password: string };
  caPath: string;
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function login(value: unknown): value is Credentials["owner"] {
  return (
    object(value) &&
    typeof value.user === "string" &&
    typeof value.password === "string" &&
    value.password.length > 0
  );
}
function credentials(value: unknown): value is Credentials {
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
async function privateFile(path: string) {
  assert.equal(await realpath(path), path);
  const file = await lstat(path);
  assert.ok(file.isFile());
  assert.equal(file.mode & 0o077, 0);
  assert.equal((await lstat(dirname(path))).mode & 0o077, 0);
  return readFile(path, "utf8");
}
const clients: pg.Client[] = [];
let step = "read private staging operator configuration";
try {
  const parsed: unknown = JSON.parse(await privateFile(credentialPath));
  assert.ok(credentials(parsed));
  const configuration = parsed;
  assert.notEqual(configuration.owner.password, configuration.runtime.password);
  const directHost = configuration.host === `db.${projectRef}.supabase.co`,
    poolerHost = configuration.host.endsWith(".pooler.supabase.com");
  assert.ok(directHost || poolerHost);
  for (const role of ["owner", "runtime"] as const)
    assert.equal(
      configuration[role].user,
      `yaparena_${role}${poolerHost ? `.${projectRef}` : ""}`,
    );
  const ca = await readFile(
    process.env.ACCOUNT_STAGING_CA_PATH ?? configuration.caPath,
    "utf8",
  );
  assert.match(ca, /-----BEGIN CERTIFICATE-----/);
  async function connect(role: "owner" | "runtime") {
    const client = new pg.Client({
      host: configuration.host,
      port: configuration.port,
      database: configuration.database,
      user: configuration[role].user,
      password: configuration[role].password,
      ssl: { ca, rejectUnauthorized: true, servername: configuration.host },
      connectionTimeoutMillis: 8000,
      query_timeout: 8000,
      statement_timeout: 5000,
      application_name: "yaparena-account-readonly-acceptance",
    });
    clients.push(client);
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identity = (
      await client.query<{
        correctRole: boolean;
        correctDatabase: boolean;
        readOnly: boolean;
        privileged: boolean;
        version: string;
      }>(
        `SELECT current_user=$1 AND session_user=$1 AS "correctRole",current_database()=$2 AS "correctDatabase",current_setting('transaction_read_only')='on' AS "readOnly",r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS privileged,current_setting('server_version') AS version FROM pg_roles r WHERE r.rolname=current_user`,
        [`yaparena_${role}`, configuration.database],
      )
    ).rows[0]!;
    assert.equal(identity.correctRole, true);
    assert.equal(identity.correctDatabase, true);
    assert.equal(identity.readOnly, true);
    assert.equal(identity.privileged, false);
    return { client, identity };
  }
  step =
    "connect with TLS CA and exact owner identity in a read-only transaction";
  const owner = await connect("owner");
  const applied = (
      await owner.client.query<{ name: string }>(
        "SELECT name FROM yaparena_migrations.pgmigrations ORDER BY name",
      )
    ).rows.map((row) => row.name),
    local = (await readdir(resolve("migrations")))
      .filter((name) => /^\d+_.*\.js$/.test(name))
      .map((name) => name.slice(0, -3))
      .sort();
  assert.equal(new Set(applied).size, applied.length);
  const unknownApplied = applied.filter((name) => !local.includes(name));
  assert.deepEqual(unknownApplied, []);
  step = "inspect retained account aggregates without exporting identities";
  const accounts = (
    await owner.client.query<{
      total: number;
      retained: number;
      selectedResetAbsent: boolean;
      otherAccounts: number;
      otherProviderMappedAccounts: number;
    }>(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE id IN(72,73,134))::int AS retained,count(*) FILTER(WHERE id IN(1,2,3,4))=0 AS "selectedResetAbsent",count(*) FILTER(WHERE id NOT IN(72,73,134))::int AS "otherAccounts",count(*) FILTER(WHERE id NOT IN(72,73,134) AND EXISTS(SELECT 1 FROM yaparena.provider_identities p WHERE p.user_id=u.id AND p.provider='privy'))::int AS "otherProviderMappedAccounts" FROM yaparena.users u`,
    )
  ).rows[0]!;
  assert.equal(accounts.retained, 3);
  assert.equal(accounts.selectedResetAbsent, true);
  assert.equal(accounts.otherAccounts, 1);
  assert.equal(accounts.otherProviderMappedAccounts, 1);
  step = "inspect provider session fences without exporting identities";
  const providerSessionFences = (
    await owner.client.query<{
      activeMappings: number;
      generationMismatch: number;
      complete: number;
      pending: number;
      running: number;
      manualUncertain: number;
      manualInherited: number;
      manualIndependentFreeze: number;
      manualOther: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM yaparena.provider_identities p JOIN yaparena.users u ON u.id=p.user_id WHERE u.account_status='active') AS "activeMappings",
        (SELECT count(*)::int FROM yaparena.provider_identities p JOIN yaparena.users u ON u.id=p.user_id WHERE u.account_status='active' AND p.auth_generation<>u.auth_generation) AS "generationMismatch",
        count(*) FILTER(WHERE j.state='complete')::int AS complete,
        count(*) FILTER(WHERE j.state='pending')::int AS pending,
        count(*) FILTER(WHERE j.state='running')::int AS running,
        count(*) FILTER(WHERE j.state='manual' AND j.failure_reason='uncertain_provider_outcome')::int AS "manualUncertain",
        count(*) FILTER(WHERE j.state='manual' AND j.failure_reason='inherited_manual')::int AS "manualInherited",
        count(*) FILTER(WHERE j.state='manual' AND j.failure_reason='independent_provider_freeze')::int AS "manualIndependentFreeze",
        count(*) FILTER(WHERE j.state='manual' AND (j.failure_reason IS NULL OR j.failure_reason NOT IN('uncertain_provider_outcome','inherited_manual','independent_provider_freeze')))::int AS "manualOther"
       FROM yaparena.provider_revocation_jobs j`,
    )
  ).rows[0]!;
  for (const count of Object.values(providerSessionFences))
    assert.ok(Number.isSafeInteger(count) && count >= 0);
  async function liveCount(table: "coin_journals" | "coin_grant_lots") {
    const present = (
      await owner.client.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`yaparena.${table}`],
      )
    ).rows[0]!.present;
    return present
      ? (
          await owner.client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM yaparena.${table} WHERE environment='live'`,
          )
        ).rows[0]!.n
      : null;
  }
  const liveJournals = await liveCount("coin_journals"),
    liveGrantLots = await liveCount("coin_grant_lots");
  assert.equal(liveJournals, 0);
  assert.ok(liveGrantLots === null || liveGrantLots === 0);
  step =
    "inspect legacy speaker eligibility aggregates without exporting seats";
  // Mirror f942dc6 media.getPublicEvent/sideFor/assertDeviceReady: the old
  // speaker route filters topic publication, not debate publication or the
  // participant row's active flag. Do not undercount by adding those filters.
  const legacySpeakerInventory = (
    await owner.client.query<{
      activeStatusEventsWithPublishedTopic: number;
      assignedSeats: number;
      activeParticipantRoleSeats: number;
      assignedSeatsWithFreshDeviceChecks: number;
      deviceReadyActiveParticipantSeats: number;
      eventsWithDeviceReadyActiveParticipants: number;
      liveViewerEligibleEvents: number;
    }>(
      `WITH events AS (
        SELECT d.id,d.status,d.publication_state
        FROM yaparena.debates d JOIN yaparena.topics t ON t.id=d.topic_id
        WHERE t.publication_state='published' AND d.status IN('scheduled','ready','live')
      ),seats AS (
        SELECT e.id, u.account_status='active' AND EXISTS(
          SELECT 1 FROM yaparena.account_roles r WHERE r.user_id=p.user_id AND r.role='participant'
        ) AS active_participant,
        EXISTS(SELECT 1 FROM yaparena.media_device_checks c WHERE c.debate_id=p.debate_id
          AND c.user_id=p.user_id AND c.camera_ok AND c.microphone_ok
          AND c.checked_at>CURRENT_TIMESTAMP-INTERVAL '30 minutes') AS device_ready
        FROM events e JOIN yaparena.event_participants p ON p.debate_id=e.id
        JOIN yaparena.users u ON u.id=p.user_id
      ) SELECT (SELECT count(*)::int FROM events) AS "activeStatusEventsWithPublishedTopic",
        count(*)::int AS "assignedSeats",
        count(*) FILTER(WHERE active_participant)::int AS "activeParticipantRoleSeats",
        count(*) FILTER(WHERE device_ready)::int AS "assignedSeatsWithFreshDeviceChecks",
        count(*) FILTER(WHERE active_participant AND device_ready)::int AS "deviceReadyActiveParticipantSeats",
        count(DISTINCT id) FILTER(WHERE active_participant AND device_ready)::int AS "eventsWithDeviceReadyActiveParticipants",
        (SELECT count(*)::int FROM events WHERE status='live' AND publication_state='published') AS "liveViewerEligibleEvents"
        FROM seats`,
    )
  ).rows[0]!;
  for (const count of Object.values(legacySpeakerInventory))
    assert.ok(Number.isSafeInteger(count) && count >= 0);
  step = "inspect effective private-schema browser privileges";
  const browserBoundary = (
    await owner.client.query<{
      schemaAccess: number;
      relationAccess: number;
      sequenceAccess: number;
      routineAccess: number;
      publicSchemaGrants: number;
    }>(
      `WITH browsers AS(SELECT oid FROM pg_roles WHERE rolname IN('anon','authenticated','authenticator','service_role')),private AS(SELECT oid,nspacl,nspowner FROM pg_namespace WHERE nspname IN('yaparena','yaparena_migrations')) SELECT (SELECT count(*)::int FROM browsers b CROSS JOIN private n WHERE has_schema_privilege(b.oid,n.oid,'USAGE,CREATE')) AS "schemaAccess",(SELECT count(*)::int FROM browsers b CROSS JOIN pg_class c WHERE c.relnamespace IN(SELECT oid FROM private) AND c.relkind IN('r','p','v','m','f') AND (has_table_privilege(b.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(b.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS "relationAccess",(SELECT count(*)::int FROM browsers b CROSS JOIN pg_class c WHERE c.relnamespace IN(SELECT oid FROM private) AND c.relkind='S' AND has_sequence_privilege(b.oid,c.oid,'USAGE,SELECT,UPDATE')) AS "sequenceAccess",(SELECT count(*)::int FROM browsers b CROSS JOIN pg_proc p WHERE p.pronamespace IN(SELECT oid FROM private) AND has_function_privilege(b.oid,p.oid,'EXECUTE')) AS "routineAccess",(SELECT count(*)::int FROM private n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee=0) AS "publicSchemaGrants"`,
    )
  ).rows[0]!;
  assert.deepEqual(browserBoundary, {
    schemaAccess: 0,
    relationAccess: 0,
    sequenceAccess: 0,
    routineAccess: 0,
    publicSchemaGrants: 0,
  });
  step = "connect with separate runtime identity and inspect its authority";
  const runtime = await connect("runtime"),
    runtimeBoundary = (
      await runtime.client.query<{
        ownedObjects: number;
        memberships: number;
        canAssumeOwner: boolean;
        schemaCreate: boolean;
        migrationRead: boolean;
        migrationWrite: boolean;
      }>(
        `SELECT (SELECT count(*)::int FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND relnamespace IN(SELECT oid FROM pg_namespace WHERE nspname IN('yaparena','yaparena_migrations'))) AS "ownedObjects",(SELECT count(*)::int FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships,pg_has_role(current_user,'yaparena_owner','SET') AS "canAssumeOwner",has_schema_privilege(current_user,'yaparena','CREATE') OR has_schema_privilege(current_user,'yaparena_migrations','CREATE') AS "schemaCreate",has_table_privilege(current_user,'yaparena_migrations.pgmigrations','SELECT') AS "migrationRead",has_table_privilege(current_user,'yaparena_migrations.pgmigrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS "migrationWrite"`,
      )
    ).rows[0]!;
  assert.deepEqual(runtimeBoundary, {
    ownedObjects: 0,
    memberships: 0,
    canAssumeOwner: false,
    schemaCreate: false,
    migrationRead: true,
    migrationWrite: false,
  });
  for (const client of clients) await client.query("ROLLBACK");
  const report = {
    at: new Date().toISOString(),
    phase,
    passed: true,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    helperSha256: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
    projectRef,
    targetVerified: true,
    tls: {
      certificateAuthorityProvided: true,
      rejectUnauthorized: true,
      hostnameVerification: true,
      certificateAuthoritySha256: createHash("sha256").update(ca).digest("hex"),
    },
    readOnly: true,
    ownerRoleVerified: true,
    runtimeRoleVerified: true,
    serverVersion: owner.identity.version,
    migrations: {
      applied,
      pending: local.filter((name) => !applied.includes(name)),
      unknownApplied,
    },
    accounts,
    providerSessionFences,
    liveJournals,
    liveGrantLots,
    legacySpeakerInventory,
    browserBoundary,
    runtimeBoundary,
    mutations: 0,
    limitations: [
      "Read-only SQL connection and catalog evidence; not hosted REST/browser identity or returning-user authentication acceptance.",
      "One non-retained Privy-mapped account and all three retained accounts exist; no email, DID, wallet, cookie or individual row is exported.",
      "TLS configuration verifies this client connection; no database URL, endpoint, credential or CA file path is exported.",
      "No migration, backup, reset, provider mutation, financial operation, service suspension or deployment is performed.",
      "Legacy speaker counts mirror old event/seat/role/device predicates before cookie authentication; no valid session, provider state or active Cloud connection is inferred. Eligibility can change after this read-only snapshot.",
    ],
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    resolve(evidenceDirectory, `staging-database-${phase}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      result: "PASS",
      phase,
      appliedMigrations: applied.length,
      pendingMigrations: report.migrations.pending.length,
      retainedAccounts: accounts.retained,
      totalAccounts: accounts.total,
      providerSessionFences,
      liveJournals,
      legacySpeakerInventory,
      evidence: `staging-database-${phase}.json`,
    }),
  );
} catch (error) {
  const code =
    object(error) &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,30}$/.test(error.code)
      ? error.code
      : undefined;
  console.error(
    JSON.stringify({
      result: "FAIL",
      phase,
      step,
      category: error instanceof Error ? error.name : "unclassified",
      ...(code ? { code } : {}),
      detail:
        "Credentials, database endpoint and application rows are omitted.",
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
}
