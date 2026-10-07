import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import pg from "pg";
import pino from "pino";
import supertest from "./test-http-request.js";
import { runner, MigrationBuilder } from "node-pg-migrate";
import { privateKeyToAccount } from "viem/accounts";
import { deliveryTables } from "../migrations/1791335211412_durable-community-delivery.js";
import { receiptTables } from "../migrations/1791345540042_preserve-chat-idempotency.js";
import { replayJobTables } from "../migrations/1791385198189_automatic-replay-packaging.js";
import { provisionDatabase } from "./provision-database.js";
import {
  runtimeGrants,
  up as isolationMigrationUp,
} from "../migrations/1791158400000_isolate_server_database.js";
import { createApp } from "../dist/app.js";
import {
  createDatabase,
  verifyRuntimeIdentity,
} from "../dist/platform/database.js";
import { verifyDatabaseState } from "../dist/platform/migrations.js";
import { createRuntime } from "../dist/platform/runtime.js";
import { createUserRepository } from "../dist/platform/auth/users.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createWalletRepository } from "../dist/platform/auth/wallets.js";
import { createMessageRepository } from "../dist/features/messages/repository.js";
import { createDiscoveryRepository } from "../dist/features/discovery/repository.js";
import { createIdentityRepository } from "../dist/features/identity/repository.js";
import { createMatchingRepository } from "../dist/features/matching/repository.js";
import { createMediaRepository } from "../dist/features/media/repository.js";
import { createCommunityRepository } from "../dist/features/community/repository.js";
import { createMeasurementRepository } from "../dist/features/measurement/repository.js";

// This harness creates its own isolated Docker cluster. It accepts no external URL,
// never reads .env, mounts no data volume, and uses only synthetic random credentials.
const exec = promisify(execFile);
const applicationTables = [
  ...Object.keys(runtimeGrants),
  "wallet_operations",
  ...deliveryTables,
  ...receiptTables,
  ...replayJobTables,
];
const container = `yaparena-isolation-${randomUUID().slice(0, 8)}`;
const evidenceDirectory = `/tmp/${container}-evidence`;
const postgresImage =
  process.env.DATABASE_TEST_IMAGE ?? "postgres:18.4-bookworm";
if (!/^postgres:(17|18)(\.\d+)?-bookworm$/.test(postgresImage))
  throw new Error(
    "Database harness accepts official PostgreSQL 17/18 bookworm images only",
  );
const secret = () => randomBytes(24).toString("hex");
const adminPassword = secret();
const bootstrapPassword = secret();
const passwords = { yaparena_owner: secret(), yaparena_runtime: secret() };
const logger = pino({ level: "silent" });
const inventorySql = await readFile(
  new URL("./database-privilege-inventory.sql", import.meta.url),
  "utf8",
);
let port;
let hostDirectory;
let started = false;
const url = (database, role = "postgres") => {
  const connection = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  connection.username = role;
  connection.password =
    role === "fixture_admin"
      ? bootstrapPassword
      : role === "postgres"
        ? adminPassword
        : passwords[role];
  return connection.href;
};
async function connect(database, role = "postgres") {
  const client = new pg.Client({ connectionString: url(database, role) });
  await client.connect();
  return client;
}
const quiet = { info() {}, warn() {}, error() {} };
async function migrate(client, options = {}) {
  return runner({
    dbClient: client,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    logger: quiet,
    log() {},
    ...options,
  });
}
async function denied(client, sql, values) {
  await assert.rejects(
    client.query(sql, values),
    (error) => error.code === "42501",
    `must deny: ${sql}`,
  );
}

async function browserChecks(admin) {
  // Both roles are genuine PostgreSQL API identities; SET ROLE supplements the
  // separate runtime login tests below. It does not establish hosted HTTP isolation.
  for (const role of ["anon", "authenticated"]) {
    await admin.query(`SET ROLE ${role}`);
    try {
      for (const table of applicationTables) {
        await denied(admin, `SELECT * FROM yaparena.${table}`);
        await denied(admin, `INSERT INTO yaparena.${table} DEFAULT VALUES`);
        await denied(admin, `DELETE FROM yaparena.${table}`);
      }
      await denied(admin, "SELECT * FROM yaparena_migrations.pgmigrations");
    } finally {
      await admin.query("RESET ROLE");
    }
    // Even if a future operator exposes the schema, object ACLs must still deny access.
    await admin.query("BEGIN");
    try {
      await admin.query(`GRANT USAGE ON SCHEMA yaparena TO ${role}`);
      const objects = await admin.query(`SELECT c.relname, c.relkind,
        (SELECT attname FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped ORDER BY attnum LIMIT 1) AS column FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='yaparena'
        AND c.relkind IN ('r','p','v','m','S')`);
      // Use savepoints because expected permission errors abort a transaction.
      await admin.query(`SET LOCAL ROLE ${role}`);
      for (const object of objects.rows) {
        const sql =
          object.relkind === "S"
            ? `SELECT nextval('yaparena.${object.relname}')`
            : `SELECT * FROM yaparena.${object.relname}`;
        await admin.query("SAVEPOINT probe");
        await denied(admin, sql);
        await admin.query("ROLLBACK TO SAVEPOINT probe");
        if (object.relkind === "r") {
          for (const mutation of [
            `UPDATE yaparena.${object.relname} SET ${object.column} = ${object.column}`,
            `INSERT INTO yaparena.${object.relname} DEFAULT VALUES`,
            `DELETE FROM yaparena.${object.relname}`,
          ]) {
            await admin.query("SAVEPOINT probe");
            await denied(admin, mutation);
            await admin.query("ROLLBACK TO SAVEPOINT probe");
          }
        }
        if (object.relkind === "S") {
          for (const mutation of [
            `SELECT last_value FROM yaparena.${object.relname}`,
            `SELECT setval('yaparena.${object.relname}',1)`,
          ]) {
            await admin.query("SAVEPOINT probe");
            await denied(admin, mutation);
            await admin.query("ROLLBACK TO SAVEPOINT probe");
          }
        }
      }
      for (const routine of [
        "identity_audit_row",
        "assign_participant_role",
        "product_measurement_record_completion",
        "isolation_definer_probe",
        "capture_community_change",
        "capture_submission_receipt",
      ]) {
        await admin.query("SAVEPOINT probe");
        await denied(admin, `SELECT yaparena.${routine}()`);
        await admin.query("ROLLBACK TO SAVEPOINT probe");
      }
      await admin.query("SAVEPOINT probe");
      await denied(admin, "SELECT email FROM yaparena.users");
      await admin.query("ROLLBACK TO SAVEPOINT probe");
    } finally {
      await admin.query("ROLLBACK");
    }
  }
}

async function membershipChecks(database, admin, owner) {
  const bootstrap = await connect(database, "fixture_admin");
  const login = await connect(database, "yaparena_runtime");
  let phase;
  const results = [];
  try {
    const creator = await admin.query(
      "SELECT pg_get_userbyid(member) AS member, admin_option, inherit_option, set_option FROM pg_auth_members WHERE roleid='yaparena_runtime'::regrole",
    );
    assert.deepEqual(creator.rows, [
      {
        member: "postgres",
        admin_option: true,
        inherit_option: false,
        set_option: false,
      },
    ]);
    const identity = (
      await admin.query(
        "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(identity, { rolsuper: false, rolcreaterole: true });
    const builder = new MigrationBuilder(
      {
        query() {
          throw new Error("Offline guard compilation");
        },
      },
      {},
      false,
      quiet,
    );
    isolationMigrationUp(builder);
    const guard = builder.getSqlSteps()[0];
    await owner.query(guard);
    await verifyRuntimeIdentity(login);
    const negative = async (name, install, undo) => {
      phase = name;
      await bootstrap.query(install);
      try {
        await assert.rejects(
          provisionDatabase(admin),
          /Unsafe pre-existing database identities/,
        );
        await assert.rejects(verifyRuntimeIdentity(login), /violates/);
        await assert.rejects(
          owner.query(guard),
          (error) => error.code === "P0001",
        );
        results.push({
          case: name,
          pass: true,
          guards: ["provision", "migration", "runtime"],
        });
      } finally {
        await bootstrap.query(undo);
      }
      await verifyRuntimeIdentity(login);
    };
    await negative(
      "deny outbound runtime membership regardless of flags",
      "GRANT yaparena_owner TO yaparena_runtime WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_owner FROM yaparena_runtime",
    );
    await negative(
      "deny browser inbound delegation even with no inherit or set",
      "GRANT yaparena_runtime TO anon WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM anon",
    );
    await negative(
      "deny unrelated inbound member",
      "GRANT yaparena_runtime TO outside_reader WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM outside_reader",
    );
    await negative(
      "deny postgres inbound SET grant",
      "GRANT yaparena_runtime TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET TRUE",
      "REVOKE SET OPTION FOR yaparena_runtime FROM postgres",
    );
    await negative(
      "deny postgres inbound INHERIT grant",
      "GRANT yaparena_runtime TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET FALSE",
      "REVOKE INHERIT OPTION FOR yaparena_runtime FROM postgres",
    );
    await negative(
      "deny inbound grant lacking administrative status",
      "GRANT yaparena_runtime TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "GRANT yaparena_runtime TO postgres WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
    );
    await negative(
      "deny other privileged administrator inbound grant",
      "GRANT yaparena_runtime TO outside_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM outside_admin",
    );
    const mediatorNegative = async (name, install, undo) => {
      phase = name;
      await bootstrap.query(install);
      try {
        await assert.rejects(
          provisionDatabase(admin),
          /Browser\/API role has an unsafe administrative membership|Unsafe pre-existing database identities/,
        );
        results.push({
          case: name,
          pass: true,
          guard: "provision",
          surface: "mediator",
        });
      } finally {
        await bootstrap.query(undo);
      }
      await provisionDatabase(admin);
      await verifyRuntimeIdentity(login);
    };
    results.push({
      case: "standard authenticator direct provider grants accepted",
      pass: true,
    });
    await mediatorNegative(
      "deny anon service-role escalation",
      "GRANT service_role TO anon WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE service_role FROM anon",
    );
    await mediatorNegative(
      "deny authenticated service-role escalation",
      "GRANT service_role TO authenticated WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE service_role FROM authenticated",
    );
    await mediatorNegative(
      "deny mediator ADMIN delegation",
      "GRANT service_role TO authenticator WITH ADMIN TRUE, INHERIT FALSE, SET TRUE",
      "REVOKE ADMIN OPTION FOR service_role FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator service-role inheritance",
      "GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT TRUE, SET TRUE",
      "REVOKE INHERIT OPTION FOR service_role FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator service-role grant without SET",
      "GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    );
    await mediatorNegative(
      "deny mediator role-level inheritance",
      "ALTER ROLE authenticator INHERIT",
      "ALTER ROLE authenticator NOINHERIT",
    );
    await mediatorNegative(
      "deny mediator owner membership",
      "GRANT yaparena_owner TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_owner FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator runtime membership",
      "GRANT yaparena_runtime TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE yaparena_runtime FROM authenticator",
    );
    await mediatorNegative(
      "deny mediator postgres membership",
      "GRANT postgres TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET FALSE",
      "REVOKE postgres FROM authenticator",
    );
    await mediatorNegative(
      "deny malformed privileged service target",
      "ALTER ROLE service_role CREATEROLE",
      "ALTER ROLE service_role NOCREATEROLE",
    );
    await mediatorNegative(
      "deny alternate indirect service-role route",
      "GRANT service_role TO mediator_proxy WITH ADMIN FALSE, INHERIT FALSE, SET FALSE; GRANT mediator_proxy TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
      "REVOKE mediator_proxy FROM authenticator; REVOKE service_role FROM mediator_proxy",
    );

    console.log(
      "Creator and API mediator membership guards: " +
        results.length +
        " denial/acceptance cases PASS.",
    );
  } catch (error) {
    throw new Error(
      "Role membership fixture failed at " + (phase ?? "initialization"),
      { cause: error },
    );
  } finally {
    await login.end();
    await bootstrap.end();
  }
}

async function runtimeChecks(database, owner, admin) {
  const pool = createDatabase(url(database, "yaparena_runtime"), logger);
  const login = await connect(database, "yaparena_runtime");
  try {
    assert.equal(
      (await login.query("SELECT session_user AS name")).rows[0].name,
      "yaparena_runtime",
    );
    await verifyDatabaseState(pool, new URL("../migrations", import.meta.url));
    await assert.rejects(verifyRuntimeIdentity(owner), /violates/);
    for (const sql of [
      "CREATE TABLE yaparena.forbidden (id int)",
      "ALTER TABLE yaparena.users ADD COLUMN forbidden int",
      "DROP TABLE yaparena.messages",
      "CREATE FUNCTION yaparena.forbidden() RETURNS int LANGUAGE SQL AS 'SELECT 1'",
      "CREATE VIEW yaparena.forbidden AS SELECT * FROM yaparena.users",
      "GRANT yaparena_owner TO yaparena_runtime",
      "SET ROLE yaparena_owner",
      "SET ROLE postgres",
      "CREATE ROLE isolation_escalation",
      "UPDATE yaparena_migrations.pgmigrations SET name = name",
      "INSERT INTO yaparena_migrations.pgmigrations(name, run_on) VALUES ('forbidden',now())",
      "DELETE FROM yaparena_migrations.pgmigrations",
      "TRUNCATE yaparena_migrations.pgmigrations",
      "SELECT nextval('yaparena_migrations.pgmigrations_id_seq')",
      "SELECT setval('yaparena.users_id_seq',1)",
      "SELECT yaparena.isolation_definer_probe()",
      "SELECT yaparena.capture_community_change()",
      "SELECT yaparena.capture_submission_receipt()",
      "DELETE FROM yaparena.community_submission_receipts",
      "UPDATE yaparena.community_submission_receipts SET body_hash=body_hash",
      "UPDATE yaparena.users SET email = email",
    ])
      await denied(login, sql);
    // PostgreSQL can emit a warning and grant nothing instead of throwing here.
    await login.query("GRANT SELECT ON yaparena.users TO anon");
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege('anon','yaparena.users','SELECT') AS access",
        )
      ).rows[0].access,
      false,
    );

    const users = createUserRepository(pool);
    const sessions = createSessionRepository(pool);
    const wallets = createWalletRepository(pool);
    const messages = createMessageRepository(pool);
    const discovery = createDiscoveryRepository(pool);
    const identity = createIdentityRepository(pool);
    const matching = createMatchingRepository(pool);
    const media = createMediaRepository(pool);
    const community = createCommunityRepository(pool);
    const measurement = createMeasurementRepository(pool);
    const app = createApp({
      users,
      sessions,
      wallets,
      messages,
      discovery,
      identity,
      matching,
      community,
      measurement,
      logger,
      applicationOrigin: "http://localhost:3000",
      authRateLimit: 100,
    });
    const agents = [];
    const people = [];
    for (const name of ["alice", "bob", "moderator", "reviewer"]) {
      const agent = supertest.agent(app);
      agents.push(agent);
      const credentials = {
        email: `${name}@isolation.test`,
        password: "Synthetic local verification passphrase",
      };
      const response = await agent
        .post("/api/auth/register")
        .send(credentials)
        .expect(201);
      const user = response.body.user;
      people.push(user);
      assert.deepEqual(await identity.getRoles(user.id), ["participant"]);
      await agent.get("/api/auth/me").expect(200);
      await agent.post("/api/auth/logout").expect(204);
      await agent.post("/api/auth/login").send(credentials).expect(200);
      await identity.createProfile(user.id, name, name, null);
      await identity.updateProfile(user.id, { publicationState: "published" });
    }
    const [alice, bob, moderator, reviewer] = people;
    await owner.query(
      "INSERT INTO account_roles(user_id,role) VALUES ($1,'moderator'),($2,'moderator'),($1,'operator')",
      [moderator.id, reviewer.id],
    );
    await agents[0].get("/api/me/roles").expect(200);
    await agents[0].get("/moderation").expect(403);
    await agents[2].get("/moderation").expect(200);
    await denied(
      login,
      "INSERT INTO yaparena.account_roles(user_id,role) VALUES ($1,'operator')",
      [alice.id],
    );
    await agents[0]
      .post("/api/messages")
      .send({ name: "Boundary" })
      .expect(201);
    await agents[0].get("/api/messages").expect(200);

    // Actual SIWE endpoints: signature verification, wallet-only registration, second
    // login, session lookup, linking, and row-lock-protected unlink through runtime.
    const account = privateKeyToAccount(`0x${"31".repeat(32)}`);
    const walletAgent = supertest.agent(app);
    const challenge = await walletAgent
      .post("/api/auth/wallet/login/challenge")
      .send({ address: account.address, chainId: 1 })
      .expect(201);
    const signature = await account.signMessage({
      message: challenge.body.message,
    });
    const walletLogin = await walletAgent
      .post("/api/auth/wallet/login/verify")
      .send({ challengeId: challenge.body.id, signature })
      .expect(200);
    await walletAgent.get("/api/auth/me").expect(200);
    assert.equal(walletLogin.body.user.email, null);
    const linkAccount = privateKeyToAccount(`0x${"32".repeat(32)}`);
    const linkTarget = {
      purpose: "link",
      address: linkAccount.address,
      chainId: 1,
    };
    const link = await agents[0]
      .post("/api/auth/wallet/operations")
      .send({ ...linkTarget, credential: { type: "password" } })
      .expect(201);
    await agents[0]
      .post(`/api/auth/wallet/operations/${link.body.id}/complete`)
      .send({
        ...linkTarget,
        password: "Synthetic local verification passphrase",
        proposedSignature: await linkAccount.signMessage({
          message: link.body.proposedMessage,
        }),
      })
      .expect(200);
    const linked = (await wallets.listWallets(alice.id))[0];
    const unlinkTarget = {
      purpose: "unlink",
      address: linked.address,
      chainId: Number(linked.chainId),
      targetWalletId: linked.id,
    };
    const unlink = await agents[0]
      .post("/api/auth/wallet/operations")
      .send({ ...unlinkTarget, credential: { type: "password" } })
      .expect(201);
    await agents[0]
      .post(`/api/auth/wallet/operations/${unlink.body.id}/complete`)
      .send({
        ...unlinkTarget,
        password: "Synthetic local verification passphrase",
      })
      .expect(200);

    assert.ok(
      (await identity.listActivity(alice.id, 100, 0)).items.some(
        (item) => item.eventType === "wallet_identities.insert",
      ),
    );

    const topic = await matching.createTopic(alice.id, {
      slug: "isolation-topic",
      title: "Boundary verification",
      summary: "Synthetic fixture",
      sideALabel: "For",
      sideBLabel: "Against",
    });
    await matching.publishTopic(alice.id, topic.slug);
    assert.equal(
      await identity.follow(alice.id, "topic", topic.slug),
      "created",
    );
    assert.equal(
      await identity.isFollowing(alice.id, "topic", topic.slug),
      true,
    );
    await identity.unfollow(alice.id, "topic", topic.slug);
    await discovery.listTopics({ limit: 10, offset: 0 });
    const request = await matching.createRequest(alice.id, {
      kind: "direct",
      topicSlug: topic.slug,
      targetHandle: "bob",
      proposition: "Does the database boundary work?",
      requestedSide: "A",
      scheduledAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    const event = await matching.acceptRequest(bob.id, request.id);
    const notification = (await matching.listNotifications(bob.id))[0];
    assert.ok(notification);
    assert.equal(
      await matching.markNotificationRead(bob.id, notification.id),
      true,
    );
    await media.checkDevice(event.id, alice.id, true, true);
    await media.checkDevice(event.id, bob.id, true, true);
    await matching.markReady(alice.id, event.id);
    await matching.markReady(bob.id, event.id);
    await media.start(event.id, "synthetic-egress", "synthetic-replay");
    await matching.operatorTransition(
      moderator.id,
      event.id,
      "start",
      "Synthetic start",
    );
    const chat = await community.postChat(event.id, alice.id, "Synthetic chat");
    await community.setLike(event.id, bob.id, true);
    const report = await community.report(
      bob.id,
      "chat",
      chat.id,
      "spam",
      "Synthetic report",
    );
    await community.decideCase(
      report.id,
      moderator.id,
      "remove_chat",
      "spam",
      "Synthetic moderation",
    );
    const appeal = await community.appeal(
      report.id,
      alice.id,
      "Synthetic appeal",
    );
    await community.decideAppeal(
      appeal.id,
      reviewer.id,
      "overturned",
      "Synthetic review",
    );
    assert.equal((await community.listChat(event.id)).items.length, 1);
    const token = "a".repeat(64);
    await measurement.grant(token);
    assert.equal(
      await measurement.recordDiscovery(token, alice.id, "debate", event.id),
      true,
    );
    assert.equal(
      await measurement.setAffiliation(
        "alice",
        "independent",
        "Synthetic classification",
        moderator.id,
      ),
      true,
    );
    const watchId = randomUUID();
    assert.equal(
      await measurement.startWatch(token, alice.id, watchId, event.id, "live"),
      true,
    );
    assert.equal(await measurement.progressWatch(token, watchId, true), true);
    await media.pause(event.id, moderator.id, "Synthetic pause");
    await media.resume(
      event.id,
      moderator.id,
      (await media.get(event.id)).revision,
    );
    await media.tick();
    await media.stop(event.id, "Synthetic end");
    await matching.operatorTransition(
      moderator.id,
      event.id,
      "end",
      "Synthetic completion",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM product_measurement_events WHERE event_type='debate_completed' AND debate_id=$1",
          [event.id],
        )
      ).rows[0].n,
      1,
    );
    await media.claimRecordingStops();
    await media.recordingStopFailed(event.id);
    await media.recordingEnded("synthetic-egress", true, "synthetic-replay");
    await media.setCaptions(
      event.id,
      "WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic",
    );
    await matching.operatorTransition(
      moderator.id,
      event.id,
      "replay",
      "Synthetic replay",
    );
    assert.ok((await measurement.summary()).events.length);
    await measurement.withdraw(token);
    await agents[0].get("/ready").expect(200);

    // Execute the runtime's real scheduled cleanup and clock callbacks; only the
    // timer scheduler is injected so tests need not wait one hour.
    const jobs = [];
    const workerPool = createDatabase(
      url(database, "yaparena_runtime"),
      logger,
    );
    const worker = createRuntime({
      database: workerPool,
      sessions: createSessionRepository(workerPool),
      identity: createIdentityRepository(workerPool),
      wallets: createWalletRepository(workerPool),
      matching: createMatchingRepository(workerPool),
      community: createCommunityRepository(workerPool),
      measurement: createMeasurementRepository(workerPool),
      media: createMediaRepository(workerPool),
      logger,
      config: { port: 3000, host: "127.0.0.1" },
      verifyDatabase: () =>
        verifyDatabaseState(
          workerPool,
          new URL("../migrations", import.meta.url),
        ),
      setIntervalFn: (callback) => {
        jobs.push(callback);
        return { unref() {} };
      },
      clearIntervalFn() {},
    });
    const failures = [];
    // Repository jobs also get called directly so runtime's logged-error recovery
    // cannot hide a permission failure behind a resolved callback.
    await sessions.create(
      alice.id,
      "b".repeat(64),
      new Date(Date.now() - 60_000),
      await users.findByEmail(alice.email),
    );
    assert.equal(await sessions.deleteExpired(), 1);
    const expiredWallet = await wallets.createChallenge({
      address: account.address.toLowerCase(),
      chainId: 1,
      purpose: "login",
      message: "Synthetic expired challenge",
      expiresAt: new Date(Date.now() - 2 * 86_400_000),
    });
    assert.equal(await wallets.deleteExpiredChallenges(), 1);
    assert.equal(await wallets.getChallenge(expiredWallet.id), null);
    await owner.query(
      "UPDATE yaparena.identity_audit_events SET occurred_at = now() - INTERVAL '100 days' WHERE user_id=$1",
      [alice.id],
    );
    assert.ok(await identity.deleteExpiredAudit());
    const expiring = await matching.createRequest(alice.id, {
      kind: "direct",
      topicSlug: topic.slug,
      targetHandle: "bob",
      proposition: "Will an expired request be cleaned up?",
      requestedSide: "A",
      scheduledAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    await owner.query(
      "UPDATE yaparena.match_requests SET created_at = now() - INTERVAL '2 days', expires_at = now() - INTERVAL '1 minute' WHERE id=$1",
      [expiring.id],
    );
    await matching.expireRequests();
    assert.equal(
      (
        await owner.query(
          "SELECT status FROM yaparena.match_requests WHERE id=$1",
          [expiring.id],
        )
      ).rows[0].status,
      "expired",
    );
    await owner.query(
      "UPDATE yaparena.event_likes SET created_at = now() - INTERVAL '400 days'",
    );
    assert.equal((await community.pruneExpired()).likes, 1);
    await owner.query(
      "UPDATE yaparena.product_measurement_affiliation_audit SET occurred_at = now() - INTERVAL '400 days'",
    );
    assert.equal((await measurement.pruneExpired()).audit, 1);
    await worker.start();
    try {
      for (const job of jobs) await job();
    } catch (error) {
      failures.push(error);
    }
    await worker.stop();
    assert.deepEqual(failures, []);
    assert.equal(jobs.length, 2);

    // A future migration explicitly chooses DML and RLS; safe defaults grant
    // nothing to browser roles and no surprise EXECUTE to runtime.
    await owner.query(
      "CREATE TABLE yaparena.future_probe(id bigserial PRIMARY KEY, value text)",
    );
    await owner.query(
      "CREATE FUNCTION yaparena.future_routine() RETURNS int LANGUAGE SQL AS 'SELECT 1'",
    );
    await denied(login, "SELECT * FROM yaparena.future_probe");
    await denied(login, "SELECT yaparena.future_routine()");
    await owner.query(
      "GRANT SELECT,INSERT ON yaparena.future_probe TO yaparena_runtime",
    );
    await owner.query(
      "GRANT USAGE ON SEQUENCE yaparena.future_probe_id_seq TO yaparena_runtime",
    );
    await owner.query(
      "ALTER TABLE yaparena.future_probe ENABLE ROW LEVEL SECURITY",
    );
    await owner.query(
      "CREATE POLICY backend_access ON yaparena.future_probe TO yaparena_runtime USING (true) WITH CHECK (true)",
    );
    assert.equal(
      (
        await login.query(
          "INSERT INTO yaparena.future_probe(value) VALUES ('synthetic') RETURNING id",
        )
      ).rowCount,
      1,
    );
    for (const role of ["anon", "authenticated"]) {
      const defaults = (
        await admin.query(
          "SELECT has_table_privilege($1,'yaparena.future_probe','SELECT,INSERT,UPDATE,DELETE') AS access, has_function_privilege($1,'yaparena.future_routine()','EXECUTE') AS execute, has_sequence_privilege($1,'yaparena.future_probe_id_seq','USAGE,SELECT,UPDATE') AS sequence",
          [role],
        )
      ).rows[0];
      assert.deepEqual(defaults, {
        access: false,
        execute: false,
        sequence: false,
      });
      await admin.query(`SET ROLE ${role}`);
      await denied(admin, "SELECT * FROM yaparena.future_probe");
      await denied(admin, "SELECT yaparena.future_routine()");
      await admin.query("RESET ROLE");
    }
  } finally {
    await login.end();
    await pool.end();
  }
}

async function scenario(database, upgrade) {
  const admin = await connect(database);
  let owner;
  try {
    const legacyCount = (
      await readdir(new URL("../migrations", import.meta.url))
    ).filter(
      (name) =>
        /^\d+_.+\.js$/.test(name) &&
        BigInt(name.split("_")[0]) < 1791158400000n,
    ).length;
    await assert.rejects(
      provisionDatabase(admin, {
        yaparena_owner: "same-synthetic-secret",
        yaparena_runtime: "same-synthetic-secret",
      }),
      /distinct/,
    );
    await admin.query("CREATE SCHEMA provider_fixture");
    await admin.query("CREATE TABLE provider_fixture.sentinel(id int)");
    await admin.query(
      "GRANT USAGE ON SCHEMA provider_fixture TO anon,authenticated",
    );
    await admin.query(
      "GRANT SELECT ON provider_fixture.sentinel TO anon,authenticated",
    );
    await admin.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA provider_fixture GRANT SELECT ON TABLES TO anon",
    );
    if (upgrade) {
      await migrate(admin, {
        schema: "public",
        migrationsSchema: "public",
        count: legacyCount,
      });
      await admin.query(
        "INSERT INTO users(email,password_hash) VALUES ('legacy@isolation.test','synthetic-legacy-hash')",
      );
      await admin.query(`INSERT INTO sessions(user_id,token_hash,expires_at)
        SELECT id,repeat('a',64),CURRENT_TIMESTAMP+INTERVAL '7 days' FROM users WHERE email='legacy@isolation.test'`);
      await admin.query(`INSERT INTO wallet_challenges(address,chain_id,purpose,message,expires_at)
        VALUES('0x' || repeat('a',40),1,'login','Synthetic legacy challenge',CURRENT_TIMESTAMP+INTERVAL '5 minutes')`);
      await admin.query(
        "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated,legacy_reader",
      );
      await admin.query(
        "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC",
      );
      await admin.query("GRANT SELECT(email) ON public.users TO anon");
      await admin.query(
        "CREATE VIEW public.external_leak AS SELECT email FROM public.users",
      );
      await admin.query("GRANT SELECT ON public.external_leak TO anon");
      await assert.rejects(
        provisionDatabase(admin, passwords),
        /External views/,
      );
      await admin.query("DROP VIEW public.external_leak");
      await admin.query(
        "CREATE FUNCTION public.external_routine_leak() RETURNS text LANGUAGE SQL BEGIN ATOMIC SELECT email::text FROM public.users LIMIT 1; END",
      );
      await assert.rejects(
        provisionDatabase(admin, passwords),
        /External routines/,
      );
      await admin.query("DROP FUNCTION public.external_routine_leak()");
    }
    await provisionDatabase(admin, passwords);
    await admin.query("GRANT yaparena_owner TO legacy_reader");
    await assert.rejects(
      provisionDatabase(admin),
      /unsafe administrative membership/,
    );
    await admin.query("REVOKE yaparena_owner FROM legacy_reader");
    owner = await connect(database, "yaparena_owner");
    // Seed dangerous creator defaults to prove hardening handles global and schema
    // additions, PUBLIC EXECUTE, direct/browser/inherited grants and column ACLs.
    await owner.query(
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO legacy_reader",
    );
    await owner.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA yaparena GRANT ALL ON TABLES TO anon,authenticated",
    );
    await owner.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA yaparena GRANT EXECUTE ON ROUTINES TO anon",
    );
    if (!upgrade) await migrate(owner, { count: legacyCount });
    await owner.query(
      "CREATE FUNCTION yaparena.isolation_definer_probe() RETURNS text LANGUAGE SQL SECURITY DEFINER SET search_path=yaparena,pg_catalog AS 'SELECT email::text FROM yaparena.users LIMIT 1'",
    );
    await owner.query(
      "CREATE VIEW yaparena.isolation_view_probe AS SELECT email FROM yaparena.users",
    );
    await owner.query(
      "CREATE MATERIALIZED VIEW yaparena.isolation_materialized_probe AS SELECT email FROM yaparena.users",
    );
    await owner.query(
      "CREATE POLICY unsafe_legacy_policy ON yaparena.account_roles TO PUBLIC USING (true) WITH CHECK (true)",
    );
    await migrate(owner);
    if (upgrade)
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM yaparena.users WHERE email='legacy@isolation.test'",
          )
        ).rows[0].n,
        1,
      );
    if (upgrade) {
      assert.equal(
        (await owner.query("SELECT count(*)::int AS n FROM sessions")).rows[0]
          .n,
        0,
        "legacy session cookies must be retired on upgrade",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM wallet_challenges WHERE consumed_at IS NULL",
          )
        ).rows[0].n,
        0,
        "legacy unbound challenges must be retired on upgrade",
      );
    }
    await membershipChecks(database, admin, owner);
    const inventory = Object.fromEntries(
      (await admin.query(inventorySql)).rows.map(({ section, evidence }) => [
        section,
        evidence,
      ]),
    );
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      `${evidenceDirectory}/${upgrade ? "upgrade" : "fresh"}-inventory.json`,
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    assert.equal(
      inventory.relations.filter(
        (r) => r.schema === "yaparena" && r.kind === "r",
      ).length,
      applicationTables.length,
    );
    assert.ok(
      inventory.policies
        .filter((p) => p.schema === "yaparena")
        .every((p) => p.roles.includes("yaparena_runtime")),
    );
    assert.equal(
      inventory.effectiveRelations
        .filter(
          (r) =>
            ["anon", "authenticated"].includes(r.identity) &&
            ["yaparena", "yaparena_migrations"].includes(r.schema),
        )
        .some((r) => Object.values(r.privileges).some(Boolean)),
      false,
    );
    assert.equal(
      inventory.effectiveSchemas.some(
        (s) =>
          s.identity === "yaparena_runtime" &&
          s.schema.startsWith("yaparena") &&
          s.create,
      ),
      false,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT has_table_privilege('anon','provider_fixture.sentinel','SELECT') AS safe",
        )
      ).rows[0].safe,
      true,
    );
    assert.ok(
      inventory.defaultPrivileges.some(
        (d) => d.creator === "postgres" && d.schema === "provider_fixture",
      ),
    );
    await browserChecks(admin);
    await runtimeChecks(database, owner, admin);
    await provisionDatabase(admin);
    await migrate(owner); // repeated operator steps preserve isolation and migration history
    console.log(
      `${upgrade ? "Upgrade" : "Fresh installation"}: inventory, browser denial, runtime login, backend journeys, worker, triggers and future defaults PASS.`,
    );
  } finally {
    if (owner) await owner.end();
    await admin.end();
  }
}

try {
  if (process.env.DATABASE_TEST_MODE === "host") {
    const version = (await exec("pg_config", ["--version"])).stdout;
    if (!/^PostgreSQL (17|18)\./.test(version))
      throw new Error("Host harness requires PostgreSQL 17/18");
    hostDirectory = await mkdtemp("/tmp/yaparena-isolation-pg-");
    const passwordFile = `${hostDirectory}/password`;
    await writeFile(passwordFile, bootstrapPassword, { mode: 0o600 });
    await exec("initdb", [
      "--pgdata",
      `${hostDirectory}/data`,
      "--username",
      "fixture_admin",
      "--auth",
      "scram-sha-256",
      "--pwfile",
      passwordFile,
    ]);
    await rm(passwordFile);
    const reserved = createServer();
    reserved.listen(0, "127.0.0.1");
    await once(reserved, "listening");
    port = String(reserved.address().port);
    await new Promise((resolve) => reserved.close(resolve));
    await exec("pg_ctl", [
      "--pgdata",
      `${hostDirectory}/data`,
      "--log",
      `${hostDirectory}/postgres.log`,
      "--options",
      `-p ${port} -h 127.0.0.1 -k ${hostDirectory}`,
      "--wait",
      "start",
    ]);
    started = true;
    console.log(version.trim());
  } else {
    await exec("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--env",
      "POSTGRES_USER=fixture_admin",
      "--env",
      `POSTGRES_PASSWORD=${bootstrapPassword}`,
      "--publish",
      "127.0.0.1::5432",
      postgresImage,
    ]);
    started = true;
    const mapping = await exec("docker", ["port", container, "5432/tcp"]);
    port = mapping.stdout.trim().split(":").at(-1);
  }
  let admin;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      admin = await connect("postgres", "fixture_admin");
      break;
    } catch {
      await delay(500);
    }
  }
  assert.ok(admin, "disposable PostgreSQL must become ready");
  try {
    const role = await admin.query(
      "SELECT format('CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS NOREPLICATION PASSWORD %L', $1::text) AS sql",
      [adminPassword],
    );
    await admin.query(role.rows[0].sql);
    await admin.query(
      "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE legacy_reader NOLOGIN; CREATE ROLE outside_reader NOLOGIN; CREATE ROLE outside_admin NOLOGIN CREATEROLE; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator LOGIN NOINHERIT; CREATE ROLE mediator_proxy NOLOGIN; GRANT legacy_reader TO anon,authenticated",
    );
    await admin.query(
      "GRANT anon,authenticated TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE",
    );
    await admin.query(
      "GRANT anon,authenticated,service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    );
    for (const database of ["isolation_fresh", "isolation_upgrade"])
      await admin.query(`CREATE DATABASE ${database} OWNER postgres`);
  } finally {
    await admin.end();
  }
  await scenario("isolation_fresh", false);
  await scenario("isolation_upgrade", true);
  console.log(
    "Local SQL isolation verified. Hosted Data API/GraphQL/Realtime isolation remains UNVERIFIED.",
  );
  console.log(`Sanitized catalog snapshots: ${evidenceDirectory}`);
} catch (error) {
  // Child-process errors may contain arguments; never print generated credentials.
  const message = error.cmd ? "local Docker command failed" : error.message;
  console.error(
    `Database isolation verification failed (${error.code ?? "assertion"}): ${message}`,
  );
  process.exitCode = 1;
} finally {
  if (started) {
    if (hostDirectory)
      await exec("pg_ctl", [
        "--pgdata",
        `${hostDirectory}/data`,
        "--mode",
        "fast",
        "--wait",
        "stop",
      ]);
    else await exec("docker", ["stop", container]);
  }
  if (hostDirectory) await rm(hostDirectory, { recursive: true, force: true });
}
