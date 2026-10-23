import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  AccountOperationError,
  accountOperationTermsDigest,
  ConfirmationError,
  createAccountOperationRepository,
  parseConfirmation,
} from "../dist/platform/auth/account-operations.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import request from "../scripts/test-http-request.ts";
import { endAllAccountSessions } from "./helpers/account-sessions.js";
import {
  createAuth0TestApp,
  me,
  origin,
  sessionCookie,
  signIn,
} from "./helpers/auth0-app.js";

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

it("accepts only an exact confirmation reference", () => {
  const id = randomUUID();
  assert.deepEqual(parseConfirmation({ id }), { id });
  for (const invalid of [
    null,
    [],
    "x",
    {},
    { id: "not-a-uuid" },
    { id, password: "legacy" },
    { id, authentication: {} },
    { id: id.toUpperCase() },
  ])
    assert.throws(
      () => parseConfirmation(invalid),
      (error) => error instanceof AccountOperationError && error.status === 400,
    );
});

const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const ownerUrl = process.env.A4_TEST_OWNER_URL;
describe(
  "sensitive operations confirmed by a fresh sign-in in PostgreSQL",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let owner, runtime, operations, context;
    before(async () => {
      for (const input of [ownerUrl, runtimeUrl]) {
        const url = new URL(input);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
      operations = createAccountOperationRepository(runtime);
      context = await createAuth0TestApp(runtime);
    });
    after(async () => {
      await context?.issuer.close();
      await Promise.all([owner?.end(), runtime?.end()]);
    });

    // A signed-in account with one email-code subject and one device session.
    async function account() {
      const subject = `email|${randomUUID()}`;
      const email = `${randomUUID()}@example.test`;
      const { token, tokenHash } = createSessionToken();
      const signedIn = await context.accounts.signIn(
        { subject, email, method: "email", authTime: null },
        { purpose: "sign_in" },
        { tokenHash, expiresAt: new Date(Date.now() + 600_000) },
      );
      return { userId: signedIn.user.id, subject, email, token, tokenHash };
    }
    const issue = (fixture, purpose = "withdrawal.request") =>
      operations.create({
        userId: fixture.userId,
        sessionTokenHash: fixture.tokenHash,
        purpose,
        terms,
      });
    const prepare = (fixture, id, overrides = {}) =>
      operations.prepare({
        id,
        userId: fixture.userId,
        sessionTokenHash: fixture.tokenHash,
        purpose: "withdrawal.request",
        terms,
        ...overrides,
      });
    const now = () => Math.ceil(Date.now() / 1000);
    async function consume(approval) {
      const client = await runtime.connect();
      try {
        await client.query("BEGIN");
        await approval.consume(client, async () => {});
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const refused = (code) => (error) =>
      error instanceof ConfirmationError && error.code === code;
    const expiredApproval = (error) =>
      error instanceof AccountOperationError && error.status === 410;

    it("requires a confirmation before an operation can be prepared, then consumes it once", async () => {
      const fixture = await account();
      const issued = await issue(fixture);
      assert.match(
        issued.confirmPath,
        new RegExp(`^/api/auth/confirm\\?operation=${issued.id}$`),
      );
      assert.ok(issued.expiresAt.getTime() - Date.now() <= 300_000);
      assert.equal(
        await operations.pending({
          id: issued.id,
          userId: fixture.userId,
          sessionTokenHash: fixture.tokenHash,
        }),
        true,
      );
      await assert.rejects(prepare(fixture, issued.id), expiredApproval);
      await operations.confirm({
        id: issued.id,
        userId: fixture.userId,
        identity: { subject: fixture.subject, authTime: now() },
      });
      assert.equal(
        await operations.pending({
          id: issued.id,
          userId: fixture.userId,
          sessionTokenHash: fixture.tokenHash,
        }),
        false,
        "a confirmed operation no longer awaits confirmation",
      );
      await assert.rejects(
        operations.confirm({
          id: issued.id,
          userId: fixture.userId,
          identity: { subject: fixture.subject, authTime: now() },
        }),
        refused("expired"),
        "a confirmation is recorded once",
      );
      const approval = await prepare(fixture, issued.id);
      assert.equal(approval.purpose, "withdrawal.request");
      assert.equal(approval.termsDigest, accountOperationTermsDigest(terms));
      assert.throws(
        () => approval.assertContext(fixture.userId, "0".repeat(64)),
        /another session/,
      );
      await consume(approval);
      await assert.rejects(consume(approval), expiredApproval, "used once");
      await assert.rejects(prepare(fixture, issued.id), expiredApproval);
      const audit = await owner.query(
        `SELECT metadata FROM identity_audit_events
         WHERE user_id=$1 AND event_type='account.operation_authorized' AND subject_id=$2`,
        [fixture.userId, issued.id],
      );
      assert.equal(audit.rows[0].metadata.credentialType, "sign_in");
      assert.equal(audit.rows[0].metadata.confirmedSubject, fixture.subject);
    });

    it("refuses a sign-in older than the challenge", async () => {
      const fixture = await account();
      const issued = await issue(fixture);
      const created = (
        await owner.query(
          "SELECT floor(extract(epoch FROM created_at))::bigint AS seconds FROM account_operations WHERE id=$1",
          [issued.id],
        )
      ).rows[0].seconds;
      await assert.rejects(
        operations.confirm({
          id: issued.id,
          userId: fixture.userId,
          identity: { subject: fixture.subject, authTime: Number(created) - 1 },
        }),
        refused("stale_sign_in"),
      );
      await assert.rejects(
        operations.confirm({
          id: issued.id,
          userId: fixture.userId,
          identity: { subject: fixture.subject, authTime: null },
        }),
        refused("stale_sign_in"),
      );
      await assert.rejects(prepare(fixture, issued.id), expiredApproval);
      // The database refuses a confirmation older than the challenge too.
      await assert.rejects(
        owner.query(
          `UPDATE account_operations SET confirmed_at=clock_timestamp(),confirmed_subject=$2,
             confirmed_auth_time=created_at-interval '2 seconds' WHERE id=$1`,
          [issued.id, fixture.subject],
        ),
        /account_operation_confirmation/,
      );
    });

    it("refuses another account's subject or an unknown subject", async () => {
      const fixture = await account();
      const other = await account();
      const issued = await issue(fixture);
      for (const subject of [other.subject, `email|${randomUUID()}`])
        await assert.rejects(
          operations.confirm({
            id: issued.id,
            userId: fixture.userId,
            identity: { subject, authTime: now() },
          }),
          refused("other_account"),
        );
      // A confirmation cannot be recorded against another owner's operation.
      await assert.rejects(
        operations.confirm({
          id: issued.id,
          userId: other.userId,
          identity: { subject: other.subject, authTime: now() },
        }),
        refused("expired"),
      );
      await assert.rejects(prepare(fixture, issued.id), expiredApproval);
    });

    it("refuses an expired challenge, other terms, another session and a changed account", async () => {
      const fixture = await account();
      const expired = await issue(fixture);
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE account_operations DISABLE TRIGGER account_operation_guard",
        );
        await client.query(
          `UPDATE account_operations SET created_at=clock_timestamp()-interval '10 minutes',
             expires_at=clock_timestamp()-interval '6 minutes' WHERE id=$1`,
          [expired.id],
        );
        await client.query(
          "ALTER TABLE account_operations ENABLE TRIGGER account_operation_guard",
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await assert.rejects(
        operations.confirm({
          id: expired.id,
          userId: fixture.userId,
          identity: { subject: fixture.subject, authTime: now() },
        }),
        refused("expired"),
      );
      const issued = await issue(fixture);
      await operations.confirm({
        id: issued.id,
        userId: fixture.userId,
        identity: { subject: fixture.subject, authTime: now() },
      });
      await assert.rejects(
        prepare(fixture, issued.id, { terms: { ...terms, amount: "6000000" } }),
        expiredApproval,
      );
      await assert.rejects(
        prepare(fixture, issued.id, { purpose: "recovery.cost.consent" }),
        expiredApproval,
      );
      await assert.rejects(
        prepare(fixture, issued.id, { sessionTokenHash: "f".repeat(64) }),
        expiredApproval,
      );
      // An incident revocation ends the session and the approval with it.
      const approval = await prepare(fixture, issued.id);
      await endAllAccountSessions(runtime, fixture.userId);
      await assert.rejects(consume(approval), (error) => error.name !== "");
    });

    it("guards the confirmation state in the database", async () => {
      const fixture = await account();
      const issued = await issue(fixture);
      await assert.rejects(
        runtime.query(
          "UPDATE account_operations SET consumed_at=clock_timestamp() WHERE id=$1",
          [issued.id],
        ),
        /unconfirmed/,
        "an unconfirmed sign-in operation cannot be consumed",
      );
      await assert.rejects(
        runtime.query(
          "UPDATE account_operations SET terms_digest=$2 WHERE id=$1",
          [issued.id, "0".repeat(64)],
        ),
        /permission denied|immutable/,
      );
      await assert.rejects(
        runtime.query(
          `INSERT INTO account_operations(id,user_id,session_token_hash,auth_generation,purpose,terms,
             terms_digest,nonce,credential_type,expires_at,confirmed_at,confirmed_subject,confirmed_auth_time)
           VALUES($1,$2,$3,0,'withdrawal.request','{}'::jsonb,$4,$4,'sign_in',
             clock_timestamp()+interval '1 minute',clock_timestamp(),$5,clock_timestamp())`,
          [
            randomUUID(),
            fixture.userId,
            fixture.tokenHash,
            "a".repeat(64),
            fixture.subject,
          ],
        ),
        /starts unconfirmed/,
      );
    });

    describe("through the Auth0 callback", () => {
      // Signs in through the provider and returns the browser and account.
      async function signedIn() {
        const subject = `email|${randomUUID()}`;
        const email = `${randomUUID()}@example.test`;
        const { agent } = await signIn(context, { subject, email });
        const user = await me(agent);
        const tokenHash = (
          await owner.query(
            "SELECT token_hash FROM sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
            [user.id],
          )
        ).rows[0].token_hash;
        return { agent, subject, email, userId: user.id, tokenHash };
      }
      async function startConfirmation(fixture, id) {
        const response = await fixture.agent.get(
          `/api/auth/confirm?operation=${id}&return=%2Faccount%23coin-sandbox`,
        );
        assert.equal(response.status, 303, response.text);
        return response.headers.location;
      }

      it("confirms by a fresh sign-in of the same account without a new session", async () => {
        const fixture = await signedIn();
        const issued = await issue(fixture);
        const location = await startConfirmation(fixture, issued.id);
        const authorization = new URL(location);
        assert.equal(authorization.searchParams.get("prompt"), "login");
        assert.equal(authorization.searchParams.get("max_age"), "0");
        assert.equal(
          authorization.searchParams.get("login_hint"),
          fixture.email,
        );
        assert.equal(authorization.searchParams.has("connection"), false);
        const callback = await fixture.agent.get(
          context.issuer.authorize(location, {
            subject: fixture.subject,
            email: fixture.email,
          }),
        );
        assert.equal(callback.status, 200);
        assert.equal(sessionCookie(callback), undefined, "no new session");
        assert.match(
          callback.text,
          new RegExp(
            `content="0;url=/account\\?confirmed=${issued.id}#coin-sandbox"`,
          ),
        );
        await consume(await prepare(fixture, issued.id));
        // The confirmation was spent: a replayed callback is refused.
        const replay = await fixture.agent.get(
          context.issuer.authorize(location, {
            subject: fixture.subject,
            email: fixture.email,
          }),
        );
        assert.equal(replay.status, 400);
      });

      it("refuses an old sign-in, another account and a cancelled confirmation", async () => {
        const fixture = await signedIn();
        const other = await signedIn();
        const createdSecond = async (id) =>
          Number(
            (
              await owner.query(
                "SELECT floor(extract(epoch FROM created_at))::bigint AS seconds FROM account_operations WHERE id=$1",
                [id],
              )
            ).rows[0].seconds,
          );
        for (const [identity, status, message] of [
          // Signed in just before the challenge: within the provider's
          // max_age clock tolerance, so the challenge check refuses it.
          [
            async (id) => ({
              subject: fixture.subject,
              email: fixture.email,
              authTime: (await createdSecond(id)) - 1,
            }),
            403,
            /needs a new sign-in/,
          ],
          // Long ago: the max_age=0 freshness check refuses it first.
          [
            async () => ({
              subject: fixture.subject,
              email: fixture.email,
              authTime: Math.floor(Date.now() / 1000) - 120,
            }),
            401,
            /couldn't verify/,
          ],
          [
            async () => ({ subject: other.subject, email: other.email }),
            403,
            /different account/,
          ],
        ]) {
          const issued = await issue(fixture);
          const location = await startConfirmation(fixture, issued.id);
          const response = await fixture.agent.get(
            context.issuer.authorize(location, await identity(issued.id)),
          );
          assert.equal(response.status, status);
          assert.match(response.text.replaceAll("&#39;", "'"), message);
          await assert.rejects(prepare(fixture, issued.id), expiredApproval);
        }
        const issued = await issue(fixture);
        const cancelled = await fixture.agent.get(
          context.issuer.deny(await startConfirmation(fixture, issued.id)),
        );
        assert.equal(cancelled.status, 400);
        assert.doesNotMatch(cancelled.text, /Try again/);
        await assert.rejects(prepare(fixture, issued.id), expiredApproval);
        assert.ok(await me(fixture.agent), "the session continues");
      });

      it("starts confirmation only for this device's pending operation", async () => {
        const fixture = await signedIn();
        const issued = await issue(fixture);
        // Signed out: sign in first.
        const signedOut = await request(context.app).get(
          `/api/auth/confirm?operation=${issued.id}`,
        );
        assert.equal(signedOut.status, 401);
        // Another device of the same account cannot drive this device's
        // confirmation.
        const device = await signIn(context, {
          subject: fixture.subject,
          email: fixture.email,
        });
        const elsewhere = await device.agent.get(
          `/api/auth/confirm?operation=${issued.id}`,
        );
        assert.equal(elsewhere.status, 410);
        for (const operation of ["not-a-uuid", randomUUID()])
          assert.equal(
            (
              await fixture.agent.get(
                `/api/auth/confirm?operation=${operation}`,
              )
            ).status,
            410,
          );
        const unsafe = await fixture.agent.get(
          `/api/auth/confirm?operation=${issued.id}&return=${encodeURIComponent("//evil.example")}`,
        );
        assert.equal(unsafe.status, 303);
        const callback = await fixture.agent.get(
          context.issuer.authorize(unsafe.headers.location, {
            subject: fixture.subject,
            email: fixture.email,
          }),
        );
        assert.match(
          callback.text,
          new RegExp(`content="0;url=/account\\?confirmed=${issued.id}"`),
          "an unsafe return falls back to the account page",
        );
        assert.equal(
          new URL(`/account?confirmed=${issued.id}`, origin).origin,
          origin,
        );
      });
    });
  },
);
