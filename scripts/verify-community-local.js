import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { chromium } from "playwright-core";
import { verifyChatClient } from "./verify-chat-client.js";
import { createCommunityRepository } from "../dist/features/community/repository.js";
import { provisionDatabase } from "./provision-database.js";

// Disposable, volume-free local cluster; never loads .env or accepts a hosted URL.
const exec = promisify(execFile);
const container = `yaparena-chat-${randomUUID().slice(0, 8)}`;
const passwords = Object.fromEntries(
  ["postgres", "yaparena_owner", "yaparena_runtime"].map((role) => [
    role,
    randomBytes(24).toString("hex"),
  ]),
);
const quiet = { info() {}, warn() {}, error() {} };
let started = false;
let hostDirectory;
let app;
let admin;
let owner;
let port;
const url = (role) =>
  `postgresql://${role}:${passwords[role]}@127.0.0.1:${port}/postgres`;
const connect = async (role) => {
  const client = new pg.Client({
    connectionString: url(role),
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
  });
  await client.connect();
  return client;
};
const migrate = (options = {}) =>
  runner({
    dbClient: owner,
    dir: "migrations",
    direction: "up",
    schema: "yaparena",
    migrationsSchema: "yaparena_migrations",
    migrationsTable: "pgmigrations",
    logger: quiet,
    log() {},
    ...options,
  });

try {
  assert.match(process.version, /^v24\./, "Use Node.js 24 for this trial");
  if (process.env.COMMUNITY_POSTGRES_MODE === "host") {
    const version = (await exec("initdb", ["--version"])).stdout;
    assert.match(version, /PostgreSQL\) (17|18)\./);
    hostDirectory = await mkdtemp("/tmp/yaparena-chat-pg-");
    const passwordFile = `${hostDirectory}/password`;
    await writeFile(passwordFile, passwords.postgres, { mode: 0o600 });
    await exec("initdb", [
      "--pgdata",
      `${hostDirectory}/data`,
      "--username",
      "postgres",
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
    await exec(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        container,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_PASSWORD",
        "postgres:18.4-bookworm",
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: passwords.postgres } },
    );
    started = true;
    port = (await exec("docker", ["port", container, "5432/tcp"])).stdout
      .trim()
      .split(":")
      .at(-1);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      admin = await connect("postgres");
      break;
    } catch {
      await delay(250);
    }
  }
  if (!admin) throw new Error("Local PostgreSQL did not become ready");
  await admin.query(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN",
  );
  await provisionDatabase(admin, passwords);
  owner = await connect("yaparena_owner");
  const migrations = (await readdir("migrations")).filter((name) =>
    name.endsWith(".js"),
  );
  await migrate({ count: migrations.length - 1 });
  // Verify an actual older-server row survives the new migration unchanged.
  const legacyUser = (
    await owner.query(
      "INSERT INTO users(email, password_hash) VALUES ('chat-upgrade@example.test', 'synthetic') RETURNING id",
    )
  ).rows[0].id;
  const legacyTopic = (
    await owner.query(
      "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES ('chat-upgrade-topic','Upgrade','Synthetic','For','Against','published') RETURNING id",
    )
  ).rows[0].id;
  const legacyEvent = (
    await owner.query(
      "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT 'chat-upgrade-event',$1,'Synthetic upgrade','live','published',version,rules FROM event_rule_versions WHERE version='preview-1' RETURNING id",
      [legacyTopic],
    )
  ).rows[0].id;
  const legacyMessage = (
    await owner.query(
      "INSERT INTO event_chat_messages(debate_id,author_user_id,body) VALUES ($1,$2,'Legacy synthetic text') RETURNING id",
      [legacyEvent, legacyUser],
    )
  ).rows[0].id;
  await migrate();
  const upgraded = (
    await owner.query(
      "SELECT client_message_id, revision::text, body FROM event_chat_messages WHERE id=$1",
      [legacyMessage],
    )
  ).rows[0];
  assert.deepEqual(upgraded, {
    client_message_id: null,
    revision: "0",
    body: "Legacy synthetic text",
  });
  const grants = await admin.query(
    "SELECT has_function_privilege('anon','yaparena.advance_chat_revision()','EXECUTE') AS anon, has_function_privilege('authenticated','yaparena.advance_chat_revision()','EXECUTE') AS authenticated, has_function_privilege('yaparena_runtime','yaparena.advance_chat_revision()','EXECUTE') AS runtime",
  );
  assert.deepEqual(grants.rows[0], {
    anon: false,
    authenticated: false,
    runtime: false,
  });
  console.log(
    "Chat migration: existing-row compatibility and private trigger privileges PASS",
  );

  await exec(process.execPath, ["scripts/verify-community.js"], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: url("yaparena_owner"),
      COMMUNITY_RUNTIME_URL: url("yaparena_runtime"),
    },
  }).then((result) => process.stdout.write(result.stdout));

  const runtimePool = new pg.Pool({
    connectionString: url("yaparena_runtime"),
    options: "-c search_path=pg_catalog,yaparena,pg_temp",
  });
  try {
    const repository = createCommunityRepository(runtimePool);
    await owner.query(
      "INSERT INTO public_profiles(user_id,handle,display_name,publication_state) VALUES($1,'chat-upgrade-author','Synthetic upgrade author','published')",
      [legacyUser],
    );
    await owner.query(
      "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '20 seconds' WHERE id=$1",
      [legacyMessage],
    );
    const expiryKey = randomUUID();
    const accepted = await repository.postChat(
      legacyEvent,
      legacyUser,
      "Synthetic retained acceptance",
      expiryKey,
    );
    await owner.query(
      "UPDATE event_chat_messages SET created_at=clock_timestamp()-INTERVAL '366 days' WHERE id=$1",
      [accepted.id],
    );
    const pruned = await repository.pruneExpired();
    assert.equal(pruned.chat, 1);
    const afterExpiry = await repository.postChat(
      legacyEvent,
      legacyUser,
      "New binding after retention expiry",
      expiryKey,
    );
    assert.notEqual(afterExpiry.id, accepted.id);
    console.log(
      "Chat idempotency retention: existing runtime purge expires keys; subsequent eligible reuse is a new write PASS",
    );
  } finally {
    await runtimePool.end();
  }

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const httpPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${httpPort}`;
  app = spawn(process.execPath, ["dist/server.js"], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(httpPort),
      APP_ORIGIN: base,
      LOG_LEVEL: "silent",
      DATABASE_URL: url("yaparena_runtime"),
    },
    stdio: "ignore",
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/ready`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Startup is still in progress. */
    }
    await delay(100);
  }
  if (!ready) throw new Error("Runtime application failed readiness");
  if (process.env.COMMUNITY_CLIENT_ONLY === "1") {
    const artifactDir =
      process.env.BROWSER_ARTIFACT_DIR ?? `/tmp/${container}-evidence`;
    await mkdir(artifactDir, { recursive: true });
    const browser = await chromium.launch({
      executablePath:
        process.env.BROWSER_CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      await verifyChatClient({
        browser,
        base,
        eventSlug: "chat-upgrade-event",
        eventId: legacyEvent,
        artifactDir,
      });
    } finally {
      await browser.close();
    }
  } else {
    await exec(process.execPath, ["scripts/verify-community-browser.js"], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: url("yaparena_owner"),
        BROWSER_BASE_URL: base,
        BROWSER_ARTIFACT_DIR:
          process.env.BROWSER_ARTIFACT_DIR ?? `/tmp/${container}-evidence`,
        ...(process.env.BROWSER_CHROME_PATH
          ? { BROWSER_CHROME_PATH: process.env.BROWSER_CHROME_PATH }
          : {}),
      },
      maxBuffer: 1024 * 1024,
    }).then((result) => process.stdout.write(result.stdout));
  }
  console.log("Disposable community PostgreSQL/runtime/browser trial PASS");
} finally {
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    await exited;
  }
  if (owner) await owner.end();
  if (admin) await admin.end();
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
    else await exec("docker", ["rm", "--force", container]);
  }
  if (hostDirectory) await rm(hostDirectory, { recursive: true, force: true });
}
