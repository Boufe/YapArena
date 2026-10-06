import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import request from "../scripts/test-http-request.js";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import { createUserRepository } from "../dist/platform/auth/users.js";
import { createWalletRepository } from "../dist/platform/auth/wallets.js";
import {
  createWalletOperationRepository,
  WalletAlreadyLinkedError,
} from "../dist/platform/auth/wallet-operations.js";
import {
  createSessionRepository,
  SessionUnavailableError,
  lockAccount,
  revokeAccountSessions,
} from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import {
  createChallengeMessage,
  verifyChallengeSignature,
  WalletVerificationUnavailableError,
} from "../dist/platform/auth/siwe.js";

// Explicit URLs must name a disposable database migrated with F04 -> F03 -> F02.
const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL;
const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const origin = "http://localhost:3000";
const password = "synthetic operation passphrase";
const ownerWallet = privateKeyToAccount(`0x${"11".repeat(32)}`);
const newWallet = privateKeyToAccount(`0x${"22".repeat(32)}`);
const thirdWallet = privateKeyToAccount(`0x${"33".repeat(32)}`);
let pool, ownerPool, operations, sessions, passwordHash;
let nextChain = 900000;
const userIds = [];
const extraPools = [];

async function fixture({ walletOnly = false, walletCount = 1 } = {}) {
  const {
    rows: [user],
  } = await ownerPool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1,$2)
     RETURNING id, auth_generation AS "authGeneration"`,
    [
      walletOnly ? null : `f02-${randomUUID()}@example.test`,
      walletOnly ? null : passwordHash,
    ],
  );
  userIds.push(user.id);
  const chainId = nextChain++;
  const wallets = [];
  for (const signer of [ownerWallet, thirdWallet].slice(0, walletCount)) {
    const {
      rows: [wallet],
    } = await ownerPool.query(
      `INSERT INTO wallet_identities (user_id, address, chain_id) VALUES ($1,$2,$3)
       RETURNING id, address, chain_id AS "chainId"`,
      [user.id, signer.address.toLowerCase(), chainId],
    );
    wallets.push(wallet);
  }
  const token = createSessionToken();
  await sessions.create(
    user.id,
    token.tokenHash,
    new Date(Date.now() + 60000),
    { authGeneration: user.authGeneration },
  );
  const target = {
    purpose: "link",
    address: newWallet.address.toLowerCase(),
    chainId,
  };
  return { userId: user.id, token, chainId, wallets, target };
}
async function issue(
  f,
  { target = f.target, credential = { type: "password" } } = {},
) {
  return operations.create({
    ...target,
    credential,
    userId: f.userId,
    sessionTokenHash: f.token.tokenHash,
    origin,
  });
}
async function proof(
  operation,
  { walletSigner = ownerWallet, proposedSigner = newWallet } = {},
) {
  return {
    ...(operation.credentialType === "password"
      ? { password }
      : {
          authorizationSignature: await walletSigner.signMessage({
            message: operation.authorizationMessage,
          }),
        }),
    ...(operation.purpose === "link"
      ? {
          proposedSignature: await proposedSigner.signMessage({
            message: operation.proposedMessage,
          }),
        }
      : {}),
  };
}
function completion(f, op, proofs) {
  return {
    id: op.id,
    userId: f.userId,
    sessionTokenHash: f.token.tokenHash,
    purpose: op.purpose,
    address: op.address,
    chainId: Number(op.chainId),
    ...proofs,
    origin,
    rpcUrls: {},
    sessionDurationMs: 60000,
  };
}
async function finish(f, op, overrides = {}, repository = operations) {
  return repository.complete({
    ...completion(f, op, await proof(op)),
    ...overrides,
  });
}
async function counts(f) {
  const {
    rows: [row],
  } = await ownerPool.query(
    `SELECT
    (SELECT count(*) FROM wallet_identities WHERE user_id = $1)::int AS wallets,
    (SELECT count(*) FROM account_notifications WHERE user_id = $1)::int AS notifications,
    (SELECT count(*) FROM sessions WHERE user_id = $1)::int AS sessions`,
    [f.userId],
  );
  return row;
}
async function newSession(f) {
  const {
    rows: [user],
  } = await ownerPool.query(
    'SELECT auth_generation AS "authGeneration" FROM users WHERE id = $1',
    [f.userId],
  );
  f.token = createSessionToken();
  await sessions.create(
    f.userId,
    f.token.tokenHash,
    new Date(Date.now() + 60000),
    user,
  );
}
function unlinkTarget(f, index = 0) {
  const w = f.wallets[index];
  return {
    purpose: "unlink",
    address: w.address,
    chainId: Number(w.chainId),
    targetWalletId: w.id,
  };
}
async function blockedPool(label) {
  const database = new pg.Pool({
    connectionString: runtimeUrl,
    max: 2,
    application_name: label,
  });
  extraPools.push(database);
  return database;
}
async function waitForLock(label, count = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE application_name = $1 AND wait_event_type = 'Lock'`,
      [label],
    );
    if (found.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`expected ${count} database lock waiters for ${label}`);
}
async function barrier(f) {
  const client = await ownerPool.connect();
  await client.query("BEGIN");
  await lockAccount(client, f.userId);
  return client;
}
function app() {
  return createApp({
    users: createUserRepository(pool),
    sessions,
    wallets: createWalletRepository(pool),
    messages: { isReady: async () => {} },
    logger: createLogger({ enabled: false }),
    authRateLimit: 1000,
    apiRateLimit: 10000,
    applicationOrigin: origin,
  });
}

describe(
  "wallet authorization with PostgreSQL runtime role",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    before(async () => {
      const runtime = new URL(runtimeUrl);
      const owner = new URL(ownerUrl);
      for (const url of [runtime, owner]) {
        assert.ok(
          ["localhost", "127.0.0.1"].includes(url.hostname),
          "only a loopback test database is allowed",
        );
        assert.match(
          url.pathname,
          /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
        );
      }
      assert.equal(
        runtime.host + runtime.pathname,
        owner.host + owner.pathname,
      );
      pool = new pg.Pool({
        connectionString: runtimeUrl,
        max: 10,
        application_name: "f02-main",
      });
      ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 5 });
      operations = createWalletOperationRepository(pool);
      sessions = createSessionRepository(pool);
      const role = await pool.query("SELECT current_user AS role");
      assert.equal(role.rows[0].role, "yaparena_runtime");
      passwordHash = await hashPassword(password);
    });
    after(async () => {
      for (const database of extraPools) await database.end();
      if (userIds.length) {
        await ownerPool.query(
          "DELETE FROM users WHERE id = ANY($1::bigint[])",
          [userIds],
        );
        await ownerPool.query(
          "DELETE FROM identity_audit_events WHERE user_id = ANY($1::bigint[])",
          [userIds],
        );
      }
      await pool.end();
      await ownerPool.end();
    });

    it("a stolen cookie and attacker-wallet signature cannot link or unlink", async () => {
      const f = await fixture();
      const http = app();
      for (const target of [f.target, unlinkTarget(f)]) {
        const issued = await request(http)
          .post("/api/auth/wallet/operations")
          .set("Cookie", `session=${f.token.token}`)
          .send({ ...target, credential: { type: "password" } });
        assert.equal(issued.status, 201);
        const result = await request(http)
          .post(`/api/auth/wallet/operations/${issued.body.id}/complete`)
          .set("Cookie", `session=${f.token.token}`)
          .send({
            ...target,
            proposedSignature: issued.body.proposedMessage
              ? await newWallet.signMessage({
                  message: issued.body.proposedMessage,
                })
              : undefined,
          });
        assert.equal(result.status, 401);
        assert.equal(result.headers["set-cookie"], undefined);
      }
      assert.deepEqual(await counts(f), {
        wallets: 1,
        notifications: 0,
        sessions: 1,
      });
    });
    it("current password authorizes each exact operation and rotates only its session", async () => {
      const f = await fixture();
      const other = createSessionToken();
      await sessions.create(
        f.userId,
        other.tokenHash,
        new Date(Date.now() + 60000),
        { authGeneration: "0" },
      );
      const op = await issue(f);
      const second = await issue(f, {
        target: { ...f.target, chainId: nextChain++ },
      });
      const result = await finish(f, op);
      assert.equal(result.wallet.address, f.target.address);
      assert.equal(await sessions.findUserByTokenHash(f.token.tokenHash), null);
      assert.equal(
        (await sessions.findUserByTokenHash(hashSessionToken(result.token))).id,
        f.userId,
      );
      assert.equal(
        (await sessions.findUserByTokenHash(other.tokenHash)).id,
        f.userId,
      );
      await assert.rejects(() => finish(f, second), SessionUnavailableError);
      await assert.rejects(
        () =>
          finish(f, second, {
            sessionTokenHash: hashSessionToken(result.token),
          }),
        (e) => e.status === 410,
      );
      const notification = await pool.query(
        "SELECT message FROM account_notifications WHERE user_id = $1",
        [f.userId],
      );
      assert.match(notification.rows[0].message, /was linked/);
      const audit = await pool.query(
        "SELECT event_type FROM identity_audit_events WHERE user_id = $1",
        [f.userId],
      );
      assert.ok(
        audit.rows.some((row) => row.event_type === "wallet_identities.insert"),
      );
    });
    it("linked-wallet authorization supports wallet-only and password accounts", async () => {
      for (const walletOnly of [true, false]) {
        const f = await fixture({ walletOnly });
        const op = await issue(f, {
          credential: { type: "wallet", walletId: f.wallets[0].id },
        });
        assert.match(op.authorizationMessage, /Authorize link of wallet/);
        assert.match(op.authorizationMessage, new RegExp(f.target.address));
        assert.match(op.authorizationMessage, new RegExp(`chain ${f.chainId}`));
        assert.notEqual(op.authorizationMessage, op.proposedMessage);
        assert.equal((await finish(f, op)).wallet.address, f.target.address);
      }
    });
    it("the proposed wallet cannot approve itself, and only retained credentials can approve unlink", async () => {
      const f = await fixture({ walletOnly: true });
      await assert.rejects(
        () =>
          issue(f, { credential: { type: "wallet", walletId: randomUUID() } }),
        (e) => e.status === 403,
      );
      await assert.rejects(
        () => issue(f, { credential: { type: "password" } }),
        (e) => e.status === 403,
      );
      await assert.rejects(
        () =>
          issue(f, {
            target: unlinkTarget(f),
            credential: { type: "wallet", walletId: f.wallets[0].id },
          }),
        (e) => e.status === 403,
      );
      await assert.rejects(
        () =>
          issue(f, {
            target: { ...f.target, address: f.wallets[0].address },
            credential: { type: "wallet", walletId: f.wallets[0].id },
          }),
        (e) => e.status === 403,
      );
      const two = await fixture({ walletOnly: true, walletCount: 2 });
      const op = await issue(two, {
        target: unlinkTarget(two, 1),
        credential: { type: "wallet", walletId: two.wallets[0].id },
      });
      const result = await finish(two, op);
      assert.equal((await counts(two)).wallets, 1);
      assert.equal(
        (await sessions.findUserByTokenHash(hashSessionToken(result.token))).id,
        two.userId,
      );
      await assert.rejects(
        () =>
          issue(two, {
            target: unlinkTarget(two),
            credential: { type: "wallet", walletId: two.wallets[0].id },
          }),
        SessionUnavailableError,
      );
    });
    it("missing, expired, reused, mismatched account/session/purpose/target proofs fail", async () => {
      const f = await fixture();
      const op = await issue(f);
      const valid = completion(f, op, await proof(op));
      for (const override of [
        { id: randomUUID() },
        { userId: "0" },
        { sessionTokenHash: "f".repeat(64) },
        { purpose: "unlink" },
        { address: thirdWallet.address.toLowerCase() },
        { chainId: f.chainId + 1 },
      ])
        await assert.rejects(
          () => operations.complete({ ...valid, ...override }),
          (e) => e.status === 410,
        );
      await assert.rejects(
        () => operations.complete({ ...valid, password: undefined }),
        (e) => e.status === 401,
      );
      await assert.rejects(
        () => operations.complete({ ...valid, password: "wrong password" }),
        (e) => e.status === 401,
      );
      await assert.rejects(
        () => operations.complete({ ...valid, proposedSignature: undefined }),
        (e) => e.status === 401,
      );
      await ownerPool.query(
        "UPDATE wallet_operations SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
        [op.id],
      );
      await assert.rejects(
        () => operations.complete(valid),
        (e) => e.status === 410,
      );
      const fresh = await issue(f);
      await finish(f, fresh);
      await assert.rejects(
        () => finish(f, fresh),
        (e) => e.status === 410,
      );
      assert.equal((await counts(f)).notifications, 1);
    });
    it("login and proposed-wallet signatures cannot be used as authorizing signatures", async () => {
      const f = await fixture({ walletOnly: true });
      const op = await issue(f, {
        credential: { type: "wallet", walletId: f.wallets[0].id },
      });
      const login = createChallengeMessage({
        address: ownerWallet.address,
        chainId: f.chainId,
        origin,
        purpose: "login",
      });
      for (const message of [login.message, op.proposedMessage]) {
        await assert.rejects(
          () => finish(f, op, { authorizationSignature: undefined }),
          (e) => e.status === 401,
        );
        const signature = await ownerWallet.signMessage({ message });
        await assert.rejects(
          () => finish(f, op, { authorizationSignature: signature }),
          (e) => e.status === 401,
        );
      }
    });
    it("wrong signing accounts fail and unavailable contract verification fails closed", async () => {
      const f = await fixture({ walletOnly: true });
      const op = await issue(f, {
        credential: { type: "wallet", walletId: f.wallets[0].id },
      });
      const wrong = await newWallet.signMessage({
        message: op.authorizationMessage,
      });
      await assert.rejects(
        () => finish(f, op, { authorizationSignature: wrong }),
        (e) => e.status === 401,
      );
      await assert.rejects(
        () =>
          finish(f, op, {
            authorizationSignature: wrong,
            rpcUrls: { [f.chainId]: "http://127.0.0.1:1" },
          }),
        WalletVerificationUnavailableError,
      );
      assert.deepEqual(await counts(f), {
        wallets: 1,
        notifications: 0,
        sessions: 1,
      });
    });
    it("removing then re-adding an authorizer or restoring a password cannot revive a proof", async () => {
      for (const method of ["wallet", "password"]) {
        const f = await fixture();
        const op = await issue(f, {
          credential:
            method === "wallet"
              ? { type: method, walletId: f.wallets[0].id }
              : { type: method },
        });
        if (method === "wallet") {
          await ownerPool.query("DELETE FROM wallet_identities WHERE id = $1", [
            f.wallets[0].id,
          ]);
          await ownerPool.query(
            "INSERT INTO wallet_identities (user_id,address,chain_id) VALUES ($1,$2,$3)",
            [f.userId, ownerWallet.address.toLowerCase(), f.chainId],
          );
        } else {
          await ownerPool.query(
            "UPDATE users SET password_hash = $2 WHERE id = $1",
            [f.userId, await hashPassword("another synthetic password")],
          );
          await ownerPool.query(
            "UPDATE users SET password_hash = $2 WHERE id = $1",
            [f.userId, passwordHash],
          );
        }
        await assert.rejects(() => finish(f, op), SessionUnavailableError);
        await newSession(f);
        // Owner-side simulation restores only the old binding to isolate generation/credential checks.
        await ownerPool.query(
          "UPDATE wallet_operations SET session_token_hash = $2 WHERE id = $1",
          [op.id, f.token.tokenHash],
        );
        await assert.rejects(
          () => finish(f, op),
          (e) => e.status === 410,
        );
        assert.equal((await counts(f)).notifications, 0);
      }
    });
    it("unlink proof is purpose-specific and password unlink retains password access", async () => {
      const f = await fixture();
      const op = await issue(f, { target: unlinkTarget(f) });
      const result = await finish(f, op);
      assert.equal((await counts(f)).wallets, 0);
      assert.equal(
        (await sessions.findUserByTokenHash(hashSessionToken(result.token))).id,
        f.userId,
      );
      const two = await fixture({ walletOnly: true, walletCount: 2 });
      const link = await issue(two, {
        credential: { type: "wallet", walletId: two.wallets[0].id },
      });
      const unlink = await issue(two, {
        target: unlinkTarget(two, 1),
        credential: { type: "wallet", walletId: two.wallets[0].id },
      });
      const wrongPurposeSignature = await ownerWallet.signMessage({
        message: link.authorizationMessage,
      });
      await assert.rejects(
        () =>
          finish(two, unlink, {
            authorizationSignature: wrongPurposeSignature,
          }),
        (e) => e.status === 401,
      );
    });
    it("logout wins during cryptographic verification and creates neither wallet nor replacement session", async () => {
      const f = await fixture();
      const op = await issue(f);
      const blockers = await barrier(f);
      const label = `f02-logout-${randomUUID()}`;
      const racing = await blockedPool(label);
      const pending = finish(
        f,
        op,
        {},
        createWalletOperationRepository(racing),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForLock(label);
      await sessions.deleteByTokenHash(f.token.tokenHash);
      await blockers.query("COMMIT");
      blockers.release();
      assert.ok((await outcome).error instanceof SessionUnavailableError);
      assert.deepEqual(await counts(f), {
        wallets: 1,
        notifications: 0,
        sessions: 0,
      });
    });
    it("account-wide revocation wins before a waiting link, and link-first ordering is explicit", async () => {
      const f = await fixture();
      const op = await issue(f);
      const blockers = await barrier(f);
      const label = `f02-revoke-${randomUUID()}`;
      const racing = await blockedPool(label);
      const outcome = finish(
        f,
        op,
        {},
        createWalletOperationRepository(racing),
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForLock(label);
      await revokeAccountSessions(blockers, f.userId, {
        action: "sessions.incident",
      });
      await blockers.query("COMMIT");
      blockers.release();
      assert.ok((await outcome).error instanceof SessionUnavailableError);
      assert.deepEqual(await counts(f), {
        wallets: 1,
        notifications: 0,
        sessions: 0,
      });
      const first = await fixture();
      const firstOp = await issue(first);
      const result = await finish(first, firstOp);
      assert.equal(
        await sessions.deleteByTokenHash(first.token.tokenHash),
        false,
      );
      assert.equal((await counts(first)).wallets, 2);
      assert.ok(
        await sessions.findUserByTokenHash(hashSessionToken(result.token)),
      );
    });
    it("concurrent proof consumption and concurrent links allow one committed operation", async () => {
      for (const distinct of [false, true]) {
        const f = await fixture();
        const first = await issue(f);
        const second = distinct ? await issue(f) : first;
        const blockers = await barrier(f);
        const label = `f02-consume-${randomUUID()}`;
        const racing = await blockedPool(label);
        const repository = createWalletOperationRepository(racing);
        const one = finish(f, first, {}, repository).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const two = finish(f, second, {}, repository).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitForLock(label, 2);
        await blockers.query("COMMIT");
        blockers.release();
        const results = await Promise.all([one, two]);
        assert.equal(results.filter((result) => result.value).length, 1);
        assert.equal(results.filter((result) => result.error).length, 1);
        assert.deepEqual(await counts(f), {
          wallets: 2,
          notifications: 1,
          sessions: 1,
        });
      }
    });
    it("cross-account simultaneous linking cannot assign a wallet twice", async () => {
      const f = await fixture();
      const other = await fixture();
      other.target = f.target;
      const one = await issue(f),
        two = await issue(other);
      const blockers = await ownerPool.connect();
      await blockers.query("BEGIN");
      await blockers.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${f.chainId}:${f.target.address}`,
      ]);
      const label = `f02-conflict-${randomUUID()}`;
      const racing = await blockedPool(label);
      const repository = createWalletOperationRepository(racing);
      const pending = Promise.allSettled([
        finish(f, one, {}, repository),
        finish(other, two, {}, repository),
      ]);
      await waitForLock(label, 2);
      await blockers.query("COMMIT");
      blockers.release();
      const result = await pending;
      assert.equal(result.filter((x) => x.status === "fulfilled").length, 1);
      assert.ok(
        result.find((x) => x.status === "rejected").reason instanceof
          WalletAlreadyLinkedError,
      );
      const assigned = await ownerPool.query(
        "SELECT count(*)::int AS count FROM wallet_identities WHERE address=$1 AND chain_id=$2",
        [f.target.address, f.chainId],
      );
      assert.equal(assigned.rows[0].count, 1);
    });
    it("concurrent final-method removals leave a retained usable credential", async () => {
      const f = await fixture({ walletOnly: true, walletCount: 2 });
      const first = await issue(f, {
        target: unlinkTarget(f, 1),
        credential: { type: "wallet", walletId: f.wallets[0].id },
      });
      const second = await issue(f, {
        target: unlinkTarget(f),
        credential: { type: "wallet", walletId: f.wallets[1].id },
      });
      const blockers = await barrier(f);
      const label = `f02-final-${randomUUID()}`;
      const racing = await blockedPool(label);
      const repository = createWalletOperationRepository(racing);
      const resultsPromise = Promise.allSettled([
        finish(f, first, {}, repository),
        finish(
          f,
          second,
          {
            authorizationSignature: await thirdWallet.signMessage({
              message: second.authorizationMessage,
            }),
          },
          repository,
        ),
      ]);
      await waitForLock(label, 2);
      await blockers.query("COMMIT");
      blockers.release();
      const results = await resultsPromise;
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal((await counts(f)).wallets, 1);
      assert.equal((await counts(f)).notifications, 1);
    });
    it("an approval expiring while verification waits cannot commit", async () => {
      const f = await fixture();
      const op = await issue(f);
      const blockers = await barrier(f);
      const label = `f02-approval-expiry-${randomUUID()}`;
      const racing = await blockedPool(label);
      const result = finish(
        f,
        op,
        {},
        createWalletOperationRepository(racing),
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForLock(label);
      await blockers.query(
        "UPDATE wallet_operations SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
        [op.id],
      );
      await blockers.query("COMMIT");
      blockers.release();
      assert.equal((await result).error.status, 410);
      assert.deepEqual(await counts(f), {
        wallets: 1,
        notifications: 0,
        sessions: 1,
      });
    });
    it("an expired session after lock waiting and a late failure roll back mutation/audit/notification", async () => {
      const f = await fixture();
      const op = await issue(f);
      const blockers = await barrier(f);
      const label = `f02-expiry-${randomUUID()}`;
      const racing = await blockedPool(label);
      const outcome = finish(
        f,
        op,
        {},
        createWalletOperationRepository(racing),
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForLock(label);
      await blockers.query(
        "UPDATE sessions SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE token_hash = $1",
        [f.token.tokenHash],
      );
      await blockers.query("COMMIT");
      blockers.release();
      assert.ok((await outcome).error);
      assert.equal((await counts(f)).wallets, 1);
      assert.equal((await counts(f)).notifications, 0);
      const rollback = await fixture();
      const rollbackOp = await issue(rollback);
      const beforeCount = await counts(rollback);
      const constraint = `f02_notification_${randomUUID().replaceAll("-", "")}`;
      await ownerPool.query(
        `ALTER TABLE account_notifications ADD CONSTRAINT ${constraint} CHECK (user_id <> ${rollback.userId})`,
      );
      try {
        await assert.rejects(
          () => finish(rollback, rollbackOp),
          (e) => e.code === "23514",
        );
        assert.deepEqual(await counts(rollback), beforeCount);
        const state = await ownerPool.query(
          "SELECT consumed_at FROM wallet_operations WHERE id=$1",
          [rollbackOp.id],
        );
        assert.equal(state.rows[0].consumed_at, null);
        const audit = await ownerPool.query(
          "SELECT count(*)::int AS count FROM identity_audit_events WHERE user_id=$1 AND event_type='wallet_identities.insert'",
          [rollback.userId],
        );
        assert.equal(audit.rows[0].count, 1);
      } finally {
        await ownerPool.query(
          `ALTER TABLE account_notifications DROP CONSTRAINT ${constraint}`,
        );
      }
    });
    it("runtime role cannot retarget an operation, and cleanup removes expired operations", async () => {
      const f = await fixture();
      const op = await issue(f);
      await assert.rejects(
        () =>
          pool.query(
            "UPDATE wallet_operations SET purpose = 'unlink' WHERE id=$1",
            [op.id],
          ),
        (e) => e.code === "42501",
      );
      await ownerPool.query(
        "UPDATE wallet_operations SET expires_at = clock_timestamp() - INTERVAL '2 days' WHERE id=$1",
        [op.id],
      );
      assert.ok((await operations.deleteExpired()) >= 1);
    });
    it("SIWE checks chain, URI, scheme, nonce and expiry before accepting an operation signature", async () => {
      const issued = createChallengeMessage({
        address: ownerWallet.address,
        chainId: 1,
        origin,
        purpose: "login",
      });
      const challenge = {
        address: ownerWallet.address.toLowerCase(),
        chainId: "1",
        ...issued,
      };
      const signature = await ownerWallet.signMessage({
        message: challenge.message,
      });
      for (const bad of [
        { ...challenge, chainId: "2" },
        {
          ...challenge,
          message: challenge.message.replace(
            "URI: http://localhost:3000",
            "URI: http://other.test",
          ),
        },
        {
          ...challenge,
          message: challenge.message.replace(
            "http://localhost",
            "https://localhost",
          ),
        },
        {
          ...challenge,
          message: challenge.message.replace(/Nonce: [a-f0-9]+/, "Nonce: "),
        },
      ])
        assert.equal(
          await verifyChallengeSignature({
            challenge: bad,
            signature,
            origin,
            rpcUrls: {},
          }),
          false,
        );
    });
  },
);
