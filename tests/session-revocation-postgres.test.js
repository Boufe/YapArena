import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../dist/app.js";
import { verifyRuntimeIdentity } from "../dist/platform/database.js";
import { createLogger } from "../dist/platform/logger.js";
import { createUserRepository } from "../dist/platform/auth/users.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import {
  createSessionRepository,
  insertSession,
  lockAccount,
  revokeAccountSessions,
  SessionUnavailableError,
} from "../dist/platform/auth/sessions.js";
import {
  createWalletRepository,
  ChallengeUnavailableError,
} from "../dist/platform/auth/wallets.js";
import { createChallengeMessage } from "../dist/platform/auth/siwe.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";

const connectionString = process.env.REVOCATION_TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
const origin = "http://localhost:53023";
const logger = createLogger({ enabled: false });
const password = "synthetic strong passphrase";
const expiresAt = () => new Date(Date.now() + 600000);
const namespace = randomUUID();
let owner,
  firstPool,
  secondPool,
  users,
  sessions,
  wallets,
  appA,
  appB,
  passwordHash;
const accounts = [];
const challengeIds = [];
let counter = 0;
const signers = Array.from({ length: 5 }, (_, i) =>
  privateKeyToAccount(`0x${String(40 + i).repeat(32)}`),
);
function app(pool, overrides = {}) {
  return createApp({
    messages: { isReady: async () => {} },
    users: createUserRepository(pool),
    sessions: createSessionRepository(pool),
    wallets: createWalletRepository(pool),
    environment: "production",
    applicationOrigin: origin,
    authRateLimit: 1000,
    apiRateLimit: 10000,
    logger,
    ...overrides,
  });
}
function post(instance, path, cookie) {
  const call = request(instance)
    .post(`/api/auth/${path}`)
    .set("Origin", origin);
  return cookie ? call.set("Cookie", cookie) : call;
}
const me = (instance, cookie) =>
  request(instance).get("/api/auth/me").set("Cookie", cookie);
function cookieOf(response) {
  return response.headers["set-cookie"][0].split(";")[0];
}
async function account() {
  const email = `f03-${namespace}-${counter++}@example.test`;
  const user = await users.create(email, passwordHash);
  accounts.push(user.id);
  return user;
}
async function login(user, instance = appA) {
  const response = await post(instance, "login").send({
    email: user.email,
    password,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.authGeneration, undefined);
  return cookieOf(response);
}
async function linkFixture(user, signer = signers[0]) {
  const result = await owner.query(
    "INSERT INTO wallet_identities(user_id,chain_id,address) VALUES ($1,1,$2) RETURNING id",
    [user.id, signer.address.toLowerCase()],
  );
  return result.rows[0].id;
}
async function challenge(signer = signers[0]) {
  const fields = createChallengeMessage({
    address: signer.address,
    chainId: 1,
    origin,
    purpose: "login",
  });
  const issued = await wallets.createChallenge({
    address: signer.address.toLowerCase(),
    chainId: 1,
    purpose: "login",
    ...fields,
  });
  challengeIds.push(issued.id);
  return issued;
}
function barrier() {
  let release, arrived;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    arrived = resolve;
  });
  return { wait, entered, release, arrived };
}
async function waitForLock(applicationName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await firstPool.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected database lock wait for ${applicationName}`);
}

// These tests run against a disposable migrated database, never a staging/production URL.
// Two separate pools and Express instances exercise the shared PostgreSQL boundary.
describe(
  "PostgreSQL account revocation and controlled interleavings",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      const url = new URL(connectionString);
      assert.match(
        url.pathname,
        /^\/(?:yaparena_f03|revocation_test)[a-z0-9_]*$/,
      );
      owner = new pg.Pool({ connectionString });
      firstPool = new pg.Pool({
        connectionString:
          process.env.REVOCATION_TEST_RUNTIME_URL || connectionString,
        application_name: "f03-instance-a",
      });
      secondPool = new pg.Pool({
        connectionString:
          process.env.REVOCATION_TEST_RUNTIME_URL || connectionString,
        application_name: "f03-instance-b",
      });
      users = createUserRepository(firstPool);
      sessions = createSessionRepository(firstPool);
      wallets = createWalletRepository(firstPool);
      passwordHash = await hashPassword(password);
      appA = app(firstPool);
      appB = app(secondPool);
    });
    after(async () => {
      if (owner) {
        await owner.query("DELETE FROM users WHERE id = ANY($1::bigint[])", [
          accounts,
        ]);
        await owner.query(
          "DELETE FROM identity_audit_events WHERE user_id = ANY($1::bigint[])",
          [accounts],
        );
        await owner.query(
          "DELETE FROM wallet_challenges WHERE id = ANY($1::uuid[])",
          [challengeIds],
        );
      }
      await Promise.all([owner?.end(), firstPool?.end(), secondPool?.end()]);
    });

    it("logout-all denies both devices across instances and permits a fresh password login", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, appB);
      assert.equal((await me(appA, a)).status, 200);
      const result = await post(appA, "logout-all", a);
      assert.equal(result.status, 204);
      assert.match(result.headers["set-cookie"][0], /^__Host-session=;/);
      for (const instance of [appA, appB])
        for (const oldCookie of [a, b])
          assert.equal((await me(instance, oldCookie)).status, 401);
      const fresh = await login(user, appB);
      assert.equal((await me(appA, fresh)).status, 200);
      const audit = await owner.query(
        "SELECT metadata FROM identity_audit_events WHERE user_id = $1 AND event_type = 'sessions.logout_all'",
        [user.id],
      );
      assert.equal(audit.rows[0].metadata.actorUserId, user.id);
      assert.equal(audit.rows[0].metadata.outcome, "success");
      assert.ok(audit.rows[0].metadata.requestId);
      assert.doesNotMatch(
        JSON.stringify(audit.rows),
        /token|cookie|password|signature/i,
      );
    });

    it("logout-other-sessions retains the authorized current device, without replacing its cookie", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, appB);
      const result = await post(appA, "logout-other-sessions", a);
      assert.equal(result.status, 204);
      assert.equal(result.headers["set-cookie"], undefined);
      assert.equal((await me(appB, a)).status, 200);
      assert.equal((await me(appA, b)).status, 401);
    });

    it("single-session logout preserves the other session", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, appB);
      assert.equal((await post(appA, "logout", a)).status, 204);
      assert.equal((await me(appB, a)).status, 401);
      assert.equal((await me(appA, b)).status, 200);
    });

    it("rejects unauthenticated, cross-account selectors, and foreign sessions even after middleware", async () => {
      const user = await account(),
        other = await account();
      const a = await login(user),
        b = await login(other, appB);
      for (const path of ["logout-all", "logout-other-sessions"]) {
        assert.equal((await post(appA, path)).status, 401);
        assert.equal(
          (await post(appA, path, a).send({ userId: other.id })).status,
          400,
        );
        assert.equal(
          (await post(appA, path, a).set("Origin", "https://attacker.example"))
            .status,
          403,
        );
      }
      await assert.rejects(
        sessions.revoke(other.id, hashSessionToken(a.split("=")[1]), false),
        SessionUnavailableError,
      );
      assert.equal((await me(appB, b)).status, 200);
    });

    it("wallet removal revokes password and wallet sessions, preserves account ownership and final method", async () => {
      const user = await account();
      const walletId = await linkFixture(user);
      const passwordCookie = await login(user);
      const pending = await challenge();
      const response = await post(appB, "wallet/login/verify").send({
        challengeId: pending.id,
        signature: await signers[0].signMessage({ message: pending.message }),
      });
      assert.equal(response.status, 200);
      const walletCookie = cookieOf(response);
      const removed = await request(appA)
        .delete(`/api/auth/wallets/${walletId}`)
        .set("Origin", origin)
        .set("Cookie", passwordCookie);
      assert.equal(removed.status, 204);
      assert.match(removed.headers["set-cookie"][0], /^__Host-session=;/);
      assert.equal((await me(appB, passwordCookie)).status, 401);
      assert.equal((await me(appA, walletCookie)).status, 401);
      assert.equal((await me(appB, await login(user))).body.user.id, user.id);
      const fresh = await challenge();
      const newAccount = await wallets.completeLogin(fresh.id, {
        tokenHash: hashSessionToken("fresh-wallet-account"),
        expiresAt: expiresAt(),
      });
      accounts.push(newAccount.id);
      assert.notEqual(newAccount.id, user.id);
      const [newWallet] = await wallets.listWallets(newAccount.id);
      assert.equal(
        await wallets.unlinkWallet(user.id, newWallet.id),
        "missing",
      );
      assert.equal(
        await wallets.unlinkWallet(newAccount.id, newWallet.id),
        "last_credentials",
      );
    });

    it("supported owner password update atomically revokes sessions; rollback restores old credential and sessions", async () => {
      const user = await account();
      const a = await login(user),
        b = await login(user, appB);
      const replacementHash = await hashPassword(
        "changed synthetic passphrase",
      );
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        await client.query(
          "UPDATE users SET password_hash = $2 WHERE id = $1",
          [user.id, replacementHash],
        );
        await client.query("ROLLBACK");
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",
              [user.id],
            )
          ).rows[0].n,
          2,
          "credential rollback restores both session rows",
        );
        assert.equal(
          (
            await owner.query("SELECT auth_generation FROM users WHERE id=$1", [
              user.id,
            ])
          ).rows[0].auth_generation,
          "0",
          "credential rollback restores the generation",
        );
        assert.equal((await me(appB, a)).status, 200);
        assert.equal(
          (await users.findByEmail(user.email)).passwordHash,
          passwordHash,
        );
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        await client.query(
          "UPDATE users SET password_hash = $2 WHERE id = $1",
          [user.id, replacementHash],
        );
        await client.query("COMMIT");
        for (const oldCookie of [a, b])
          assert.equal((await me(appB, oldCookie)).status, 401);
        assert.equal(
          (await post(appA, "login").send({ email: user.email, password }))
            .status,
          401,
        );
        assert.equal(
          (
            await post(appB, "login").send({
              email: user.email,
              password: "changed synthetic passphrase",
            })
          ).status,
          200,
        );
      } finally {
        client.release();
      }
    });

    it("stale password authentication cannot cross logout-all or password-change ordering points", async () => {
      for (const mutate of ["logout", "password"]) {
        const user = await account();
        const cookie = await login(user);
        const gate = barrier();
        const staleUsers = {
          ...users,
          async findByEmail(email) {
            const snapshot = await users.findByEmail(email);
            gate.arrived();
            await gate.wait;
            return snapshot;
          },
        };
        const inFlight = post(app(firstPool, { users: staleUsers }), "login")
          .send({ email: user.email, password })
          .then((value) => value);
        await gate.entered;
        if (mutate === "logout")
          assert.equal((await post(appB, "logout-all", cookie)).status, 204);
        else
          await owner.query(
            "UPDATE users SET password_hash = $2 WHERE id = $1",
            [user.id, await hashPassword("new synthetic credential")],
          );
        gate.release();
        const result = await inFlight;
        assert.equal(result.status, 401);
        assert.equal(result.headers["set-cookie"], undefined);
      }
    });

    it("password issuance waiting behind a locked revocation fails with its obsolete snapshot", async () => {
      const user = await account();
      const client = await owner.connect();
      await client.query("BEGIN");
      await lockAccount(client, user.id);
      const issuance = createSessionRepository(secondPool).create(
        user.id,
        hashSessionToken("blocked-password"),
        expiresAt(),
        {
          authGeneration: user.authGeneration,
          passwordHash,
          email: user.email,
        },
      );
      const rejected = assert.rejects(issuance, SessionUnavailableError);
      try {
        await waitForLock("f03-instance-b");
        await revokeAccountSessions(client, user.id, {
          action: "sessions.incident",
        });
        await client.query("COMMIT");
        await rejected;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("wallet completion waiting behind unlink cannot resurrect the old account; remove/readd rejects its old UUID proof", async () => {
      const user = await account();
      const walletId = await linkFixture(user, signers[1]);
      const pending = await challenge(signers[1]);
      const client = await owner.connect();
      await client.query("BEGIN");
      await lockAccount(client, user.id);
      const completion = createWalletRepository(secondPool).completeLogin(
        pending.id,
        {
          tokenHash: hashSessionToken("blocked-wallet"),
          expiresAt: expiresAt(),
        },
      );
      const rejected = assert.rejects(completion, ChallengeUnavailableError);
      try {
        await waitForLock("f03-instance-b");
        await client.query("DELETE FROM wallet_identities WHERE id=$1", [
          walletId,
        ]);
        await client.query(
          "INSERT INTO wallet_identities(user_id,chain_id,address) VALUES($1,1,$2)",
          [user.id, signers[1].address.toLowerCase()],
        );
        await client.query("COMMIT");
        await rejected;
        assert.equal(
          await sessions.findUserByTokenHash(
            hashSessionToken("blocked-wallet"),
          ),
          null,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("wallet challenges issued before logout-all or logout-others are invalidated; fresh challenges succeed", async () => {
      const user = await account();
      await linkFixture(user, signers[2]);
      for (const action of ["logout-all", "logout-other-sessions"]) {
        const cookie = await login(user);
        const old = await challenge(signers[2]);
        assert.equal((await post(appB, action, cookie)).status, 204);
        await assert.rejects(
          wallets.completeLogin(old.id, {
            tokenHash: hashSessionToken(randomUUID()),
            expiresAt: expiresAt(),
          }),
          ChallengeUnavailableError,
        );
        const fresh = await challenge(signers[2]);
        assert.equal(
          (
            await wallets.completeLogin(fresh.id, {
              tokenHash: hashSessionToken(randomUUID()),
              expiresAt: expiresAt(),
            })
          ).id,
          user.id,
        );
      }
    });

    it("issuance ordered first is deleted by a waiting revocation, including across instances", async () => {
      const user = await account();
      const cookie = await login(user);
      const client = await owner.connect();
      const token = hashSessionToken("issued-before-revoke");
      await client.query("BEGIN");
      const locked = await lockAccount(client, user.id);
      await insertSession(
        client,
        user.id,
        token,
        expiresAt(),
        locked.authGeneration,
      );
      const revocation = createSessionRepository(secondPool).revoke(
        user.id,
        hashSessionToken(cookie.split("=")[1]),
        false,
      );
      try {
        await waitForLock("f03-instance-b");
        await client.query("COMMIT");
        await revocation;
        assert.equal(await sessions.findUserByTokenHash(token), null);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("credential deletion and session replacement roll back together; a transaction-local successor is unavailable before commit", async () => {
      const user = await account();
      const id = await linkFixture(user, signers[3]);
      const cookie = await login(user);
      const client = await owner.connect();
      const successor = hashSessionToken("rollback-successor");
      try {
        await client.query("BEGIN");
        await lockAccount(client, user.id);
        await client.query("DELETE FROM wallet_identities WHERE id=$1", [id]);
        const updated = await lockAccount(client, user.id);
        await insertSession(
          client,
          user.id,
          successor,
          expiresAt(),
          updated.authGeneration,
        );
        assert.equal(
          await createSessionRepository(secondPool).findUserByTokenHash(
            successor,
          ),
          null,
        );
        await client.query("ROLLBACK");
        assert.equal(await sessions.findUserByTokenHash(successor), null);
        assert.equal((await me(appB, cookie)).status, 200);
        assert.ok(
          (await wallets.listWallets(user.id)).some(
            (wallet) => wallet.id === id,
          ),
        );
      } finally {
        client.release();
      }
    });

    it("wallet session-insert failure rolls back account provisioning and challenge consumption", async () => {
      const pending = await challenge(signers[4]);
      const brokenPool = {
        async connect() {
          const client = await firstPool.connect();
          return {
            query: async (sql, values) => {
              if (sql.includes("INSERT INTO sessions"))
                throw new Error("synthetic issuance failure");
              return client.query(sql, values);
            },
            release: () => client.release(),
          };
        },
      };
      await assert.rejects(
        createWalletRepository(brokenPool).completeLogin(pending.id, {
          tokenHash: hashSessionToken("broken"),
          expiresAt: expiresAt(),
        }),
        /synthetic issuance failure/,
      );
      assert.ok(await wallets.getChallenge(pending.id));
      assert.equal(
        (
          await owner.query(
            "SELECT id FROM wallet_identities WHERE address=$1",
            [signers[4].address.toLowerCase()],
          )
        ).rowCount,
        0,
      );
      const completed = await wallets.completeLogin(pending.id, {
        tokenHash: hashSessionToken("recovered"),
        expiresAt: expiresAt(),
      });
      accounts.push(completed.id);
    });

    it("database rejects old-binary inserts and explicit obsolete generations; expiry stays authoritative", async () => {
      const user = await account();
      await assert.rejects(
        owner.query(
          "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
          [user.id, hashSessionToken("legacy"), expiresAt()],
        ),
        { code: "40001" },
      );
      await assert.rejects(
        owner.query(
          "INSERT INTO sessions(user_id,token_hash,expires_at,auth_generation) VALUES($1,$2,$3,-1)",
          [user.id, hashSessionToken("stale"), expiresAt()],
        ),
        { code: "40001" },
      );
      const token = hashSessionToken("expired");
      await sessions.create(user.id, token, new Date(Date.now() - 1000), user);
      assert.equal(await sessions.findUserByTokenHash(token), null);
      assert.ok(await sessions.deleteExpired());
      await assert.rejects(
        owner.query("UPDATE users SET auth_generation=-1 WHERE id=$1", [
          user.id,
        ]),
        /cannot decrease/,
      );
    });
    it("runtime role can revoke but cannot edit credentials or execute trigger functions directly", async () => {
      if (!process.env.REVOCATION_TEST_RUNTIME_URL) return;
      await verifyRuntimeIdentity(firstPool);
      const user = await account();
      await assert.rejects(
        firstPool.query(
          "UPDATE users SET password_hash='forbidden' WHERE id=$1",
          [user.id],
        ),
        { code: "42501" },
      );
      await assert.rejects(
        firstPool.query(
          "UPDATE users SET email='forbidden@example.test' WHERE id=$1",
          [user.id],
        ),
        { code: "42501" },
      );
      const result = await firstPool.query(
        "SELECT has_function_privilege(current_user, 'enforce_session_generation()', 'EXECUTE') AS executable",
      );
      assert.equal(result.rows[0].executable, false);
      const cookie = await login(user);
      assert.equal((await post(appB, "logout-all", cookie)).status, 204);
    });
  },
);
