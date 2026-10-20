import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import {
  accountOperationTermsDigest,
  createAccountOperationRepository,
} from "../dist/platform/auth/account-operations.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";

const terms = {
  environment: "sandbox",
  asset: "USDC",
  amount: "5000000",
  network: "base-sepolia",
  destination: "0x1111111111111111111111111111111111111111",
  fee: "1000",
};
it("binds every exact term independent of object insertion order and rejects unsafe representations", () => {
  assert.equal(
    accountOperationTermsDigest(terms),
    accountOperationTermsDigest(
      Object.fromEntries(Object.entries(terms).reverse()),
    ),
  );
  for (const key of Object.keys(terms))
    assert.notEqual(
      accountOperationTermsDigest(terms),
      accountOperationTermsDigest({ ...terms, [key]: `${terms[key]}0` }),
    );
  for (const invalid of [
    { amount: 0.1 },
    { amount: "5\nUSDC" },
    { "bad-key": "500" },
    { destination: "x".repeat(2049) },
    Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`term${n}`, "x"])),
    Object.fromEntries(
      Array.from({ length: 9 }, (_, n) => [`term${n}`, "x".repeat(2048)]),
    ),
  ])
    assert.throws(
      () => accountOperationTermsDigest(invalid),
      /invalid operation terms/,
    );
});

const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL;
const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const password = "synthetic account approval passphrase";
const signer = privateKeyToAccount(`0x${"41".repeat(32)}`);
const origin = "http://localhost:53024";
describe(
  "purpose-bound account approvals in disposable PostgreSQL",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let a, b, owner, passwordHash;
    const accounts = [];
    let chain = 810000;
    before(async () => {
      for (const value of [runtimeUrl, ownerUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
        );
      }
      a = new pg.Pool({ connectionString: runtimeUrl });
      b = new pg.Pool({ connectionString: runtimeUrl });
      owner = new pg.Pool({ connectionString: ownerUrl });
      passwordHash = await hashPassword(password);
    });
    after(async () => {
      if (accounts.length)
        await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [
          accounts,
        ]);
      await Promise.all([a?.end(), b?.end(), owner?.end()]);
    });
    async function fixture({ wallet = false, noCredential = false } = {}) {
      const user = (
        await owner.query(
          `INSERT INTO users(email,password_hash) VALUES($1,$2)
       RETURNING id,auth_generation AS "authGeneration"`,
          [
            noCredential ? null : `${randomUUID()}@example.test`,
            noCredential ? null : passwordHash,
          ],
        )
      ).rows[0];
      accounts.push(user.id);
      const token = createSessionToken();
      await createSessionRepository(a).create(
        user.id,
        token.tokenHash,
        new Date(Date.now() + 600000),
        user,
      );
      const walletId = wallet
        ? (
            await owner.query(
              "INSERT INTO wallet_identities(user_id,address,chain_id) VALUES($1,$2,$3) RETURNING id",
              [user.id, signer.address.toLowerCase(), chain++],
            )
          ).rows[0].id
        : null;
      const input = {
        userId: user.id,
        sessionTokenHash: token.tokenHash,
        purpose: "withdrawal.request",
        terms,
        origin,
      };
      return { user, token, walletId, input };
    }
    async function issue(f, credential = { type: "password" }) {
      return createAccountOperationRepository(a).create({
        ...f.input,
        credential,
      });
    }
    async function prepare(f, operation, overrides = {}, database = a) {
      return createAccountOperationRepository(database).prepare({
        ...f.input,
        id: operation.id,
        password,
        rpcUrls: {},
        ...overrides,
      });
    }
    async function consume(
      prepared,
      database = a,
      work = async () => "success",
    ) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const result = await prepared.consume(client, () => work(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    it("consumes exactly once with the authorized mutation across application pools", async () => {
      const f = await fixture(),
        operation = await issue(f);
      assert.match(operation.nonce, /^[0-9a-f]{64}$/);
      assert.equal(operation.termsDigest, accountOperationTermsDigest(terms));
      const first = await prepare(f, operation),
        second = await prepare(f, operation, {}, b);
      const mutation = async (c) =>
        c.query(
          "INSERT INTO account_notifications(user_id,event_type,message) VALUES($1,'approval.test','synthetic')",
          [f.user.id],
        );
      const results = await Promise.allSettled([
        consume(first, a, mutation),
        consume(second, b, mutation),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM account_notifications WHERE user_id=$1",
            [f.user.id],
          )
        ).rows[0].n,
        1,
      );
      const audit = (
        await owner.query(
          "SELECT metadata FROM identity_audit_events WHERE user_id=$1 AND event_type='account.operation_authorized'",
          [f.user.id],
        )
      ).rows[0].metadata;
      assert.equal(audit.termsDigest, operation.termsDigest);
      assert.doesNotMatch(
        JSON.stringify(audit),
        /synthetic account approval|signature|destination|token|nonce/,
      );
      await assert.rejects(prepare(f, operation), /expired or invalid/);
    });
    it("rejects cross-account/session, changed purpose/terms, and wrong or absent password", async () => {
      const f = await fixture(),
        stranger = await fixture(),
        operation = await issue(f);
      for (const overrides of [
        { userId: stranger.user.id },
        { sessionTokenHash: stranger.token.tokenHash },
        { purpose: "account.email.change" },
        { terms: { ...terms, amount: "5000001" } },
      ])
        await assert.rejects(
          prepare(f, operation, overrides),
          /expired or invalid/,
        );
      for (const password of ["incorrect", undefined])
        await assert.rejects(
          consume(await prepare(f, operation, { password })),
          /password is incorrect/,
        );
      await consume(await prepare(f, operation));
    });
    it("rolls back mutation and proof consumption together and rejects stale generations/sessions", async () => {
      const f = await fixture(),
        operation = await issue(f);
      await assert.rejects(
        consume(await prepare(f, operation), a, async (c) => {
          await c.query(
            "INSERT INTO account_notifications(user_id,event_type,message) VALUES($1,'approval.test','must roll back')",
            [f.user.id],
          );
          throw Error("synthetic mutation failure");
        }),
        /synthetic mutation failure/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM account_notifications WHERE user_id=$1",
            [f.user.id],
          )
        ).rows[0].n,
        0,
      );
      const prepared = await prepare(f, operation);
      await createSessionRepository(b).revoke(
        f.user.id,
        f.token.tokenHash,
        true,
      );
      await assert.rejects(consume(prepared), /expired or invalid/);
      const current = await issue(f);
      const pending = await prepare(f, current);
      await createSessionRepository(b).deleteByTokenHash(f.token.tokenHash);
      await assert.rejects(consume(pending), /session is unavailable/);
    });
    it("validates exact operation SIWE and rechecks the retained wallet at commit", async () => {
      const f = await fixture({ wallet: true });
      const operation = await issue(f, {
        type: "wallet",
        walletId: f.walletId,
      });
      const parsed = parseSiweMessage(operation.authorizationMessage);
      assert.equal(parsed.requestId, operation.id);
      assert.equal(parsed.nonce, operation.nonce);
      assert.match(parsed.statement, /withdrawal.request/);
      assert.match(parsed.statement, /5000000/);
      await assert.rejects(
        prepare(f, operation, { signature: undefined }),
        /wallet approval is invalid/,
      );
      const signature = await signer.signMessage({
        message: operation.authorizationMessage,
      });
      await assert.rejects(
        prepare(f, operation, { signature, origin: "http://another.example" }),
        /wallet approval is invalid/,
      );
      await consume(await prepare(f, operation, { signature }));
      const second = await issue(f, { type: "wallet", walletId: f.walletId });
      const approved = await prepare(f, second, {
        signature: await signer.signMessage({
          message: second.authorizationMessage,
        }),
      });
      await owner.query("DELETE FROM wallet_identities WHERE id=$1", [
        f.walletId,
      ]);
      await assert.rejects(consume(approved), /expired or invalid/);
    });
    it("rolls back a mutation when its approval or current session expires during the mutation", async () => {
      for (const expiring of ["approval", "session"]) {
        const f = await fixture();
        if (expiring === "session") {
          await createSessionRepository(a).deleteByTokenHash(f.token.tokenHash);
          await createSessionRepository(a).create(
            f.user.id,
            f.token.tokenHash,
            new Date(Date.now() + 250),
            f.user,
          );
        }
        let operation = await issue(f);
        if (expiring === "approval") {
          const id = randomUUID();
          await owner.query(
            `INSERT INTO account_operations(id,user_id,session_token_hash,auth_generation,purpose,terms,terms_digest,nonce,credential_type,created_at,expires_at)
            SELECT $2,user_id,session_token_hash,auth_generation,purpose,terms,terms_digest,nonce,credential_type,statement_timestamp(),statement_timestamp()+interval '250 milliseconds'
            FROM account_operations WHERE id=$1`,
            [operation.id, id],
          );
          operation = { ...operation, id };
        }
        const proof = await prepare(f, operation);
        await assert.rejects(
          consume(proof, a, async (c) => {
            await c.query(
              "INSERT INTO account_notifications(user_id,event_type,message) VALUES($1,'approval.test','must roll back on expiry')",
              [f.user.id],
            );
            await c.query("SELECT pg_sleep(0.3)");
          }),
          /expired or invalid/,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM account_notifications WHERE user_id=$1",
              [f.user.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await owner.query(
              "SELECT consumed_at FROM account_operations WHERE id=$1",
              [operation.id],
            )
          ).rows[0].consumed_at,
          null,
        );
      }
    });
    it("fails closed for absent credentials, unsupported purpose and expiry", async () => {
      const f = await fixture({ noCredential: true });
      await assert.rejects(issue(f), /retained credential required/);
      await assert.rejects(
        issue(f, { type: "wallet", walletId: randomUUID() }),
        /linked wallet required/,
      );
      await assert.rejects(
        createAccountOperationRepository(a).create({
          ...f.input,
          purpose: "arbitrary\ntext",
          credential: { type: "password" },
        }),
        /invalid operation purpose/,
      );
      const withPassword = await fixture(),
        operation = await issue(withPassword);
      const expiredId = randomUUID();
      await owner.query(
        `INSERT INTO account_operations(id,user_id,session_token_hash,auth_generation,purpose,
         terms,terms_digest,nonce,credential_type,created_at,expires_at)
         SELECT $2,user_id,session_token_hash,auth_generation,purpose,terms,terms_digest,nonce,
           credential_type,statement_timestamp()-interval '6 minutes',statement_timestamp()-interval '1 minute'
         FROM account_operations WHERE id=$1`,
        [operation.id, expiredId],
      );
      await assert.rejects(
        prepare(withPassword, { ...operation, id: expiredId }),
        /expired or invalid/,
      );
    });
  },
);
