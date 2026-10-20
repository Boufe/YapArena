import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createProviderPasskeys } from "../dist/platform/auth/provider-passkeys.js";
import {
  createProviderPasskeyBootstrap,
  FirstPasskeyRestartError,
} from "../dist/platform/auth/provider-passkey-bootstrap.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { providerPasskeyFixture } from "./provider-passkey-fixture.js";
const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL,
  ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL,
  origin = "http://localhost:53024";
describe(
  "first Privy passkey restart in disposable PostgreSQL",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let a, b, owner;
    const accounts = [];
    before(() => {
      for (const value of [runtimeUrl, ownerUrl]) {
        const url = new URL(value);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/(?:yaparena_f02|revocation_test)[a-z0-9_]*$/,
        );
      }
      owner = new pg.Pool({ connectionString: ownerUrl });
      a = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
      b = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    });
    after(async () => {
      if (accounts.length)
        await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [
          accounts,
        ]);
      await Promise.all([a?.end(), b?.end(), owner?.end()]);
    });
    async function fixture(method = "email", captured = false) {
      const baseCredentials = [
          {
            type: method,
            id:
              method === "email"
                ? `${randomUUID()}@example.invalid`
                : `google-${randomUUID()}`,
          },
        ],
        subject = `did:privy:${randomUUID()}`,
        base = {
          subject,
          sessionId: randomUUID(),
          email: method === "email" ? baseCredentials[0].id : null,
          methods: [method],
          credentials: baseCredentials,
          credentialsDigest: providerCredentialsDigest(baseCredentials),
          issuedAt: Math.floor(Date.now() / 1000),
        },
        token = createSessionToken(),
        key = providerPasskeyFixture(origin);
      const { user } = await createProviderAccounts(a).exchange(
        base,
        token.tokenHash,
        new Date(Date.now() + 600000),
      );
      accounts.push(user.id);
      const originalIntentId = randomUUID();
      // A guarded owner fixture models the immutable expired first intent. It
      // does not alter/extend an existing challenge or assert hosted SDK use.
      await owner.query(
        `WITH issued AS(SELECT clock_timestamp()-interval '6 minutes' AS at)
      INSERT INTO provider_passkey_intents(id,user_id,session_token_hash,auth_generation,provider_subject,origin,rp_id,intent_mode,
        before_digest,before_credentials,created_at,expires_at)
      SELECT $1,$2,$3,u.auth_generation,$4,$5,'localhost','addition',$6,$7::jsonb,at,at+interval '5 minutes' FROM users u CROSS JOIN issued WHERE u.id=$2`,
        [
          originalIntentId,
          user.id,
          token.tokenHash,
          subject,
          origin,
          base.credentialsDigest,
          JSON.stringify(baseCredentials),
        ],
      );
      const currentCredentials = [
        ...baseCredentials,
        { type: "passkey", id: key.credentialId },
      ];
      let identity = {
        ...base,
        sessionId: randomUUID(),
        credentials: currentCredentials,
        credentialsDigest: providerCredentialsDigest(currentCredentials),
        methods: [method, "passkey"].sort(),
        passkeys: [key.evidence],
      };
      if (captured)
        await owner.query(
          `UPDATE provider_passkey_intents SET candidate_digest=$2,candidate_credential_id=$3,
        candidate_public_key=$4,candidate_key_digest=$5,candidate_session_digest=$6,challenge=$7 WHERE id=$1`,
          [
            originalIntentId,
            identity.credentialsDigest,
            key.credentialId,
            key.publicKey,
            createHash("sha256").update(key.publicKey).digest("hex"),
            createHash("sha256").update(base.sessionId).digest("hex"),
            randomBytes(32).toString("base64url"),
          ],
        );
      const attempts = [];
      const verifier = {
        async verify(value) {
          assert.equal(value, "synthetic-token");
          return structuredClone(identity);
        },
        async inspect(value) {
          assert.equal(value, subject);
          return structuredClone(identity);
        },
      };
      const options = {
        async authorizeAttempt(userId, purpose) {
          attempts.push({ userId, purpose });
        },
      };
      const repo = createProviderPasskeyBootstrap(a, verifier, options),
        input = { token: "synthetic-token", origin };
      return {
        userId: user.id,
        key,
        base,
        token,
        originalIntentId,
        verifier,
        options,
        attempts,
        repo,
        input,
        get identity() {
          return identity;
        },
        replace(value) {
          identity = value;
        },
      };
    }
    const complete = (f, challenge, overrides = {}) => ({
      ...f.input,
      id: challenge.id,
      authentication: f.key.authentication(challenge.authenticationOptions),
      sessionDurationMs: 600000,
      ...overrides,
    });
    const state = async (f) =>
      (
        await owner.query(
          `SELECT u.auth_generation::text AS generation,p.auth_generation::text AS mapped,p.credentials_digest AS digest,
    (SELECT count(*)::int FROM account_security_keys k WHERE k.user_id=u.id) AS keys,
    (SELECT count(*)::int FROM provider_passkey_bootstraps c WHERE c.user_id=u.id AND c.consumed_at IS NOT NULL) AS consumed,
    (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id) AS sessions FROM users u JOIN provider_identities p ON p.user_id=u.id WHERE u.id=$1`,
          [f.userId],
        )
      ).rows[0];
    for (const method of ["email", "google_oauth"])
      it(`restarts expired ${method} first setup with the same provider key and a new nonce, preserving all ownership fences`, async () => {
        const f = await fixture(method),
          before = await state(f);
        assert.deepEqual(await f.repo.candidate(f.input), {
          code: "first_passkey_restart_available",
        });
        const challenge = await f.repo.restart(f.input);
        assert.equal(
          challenge.authenticationOptions.userVerification,
          "required",
        );
        assert.deepEqual(
          challenge.authenticationOptions.allowCredentials.map((v) => v.id),
          [f.key.credentialId],
        );
        assert.equal(challenge.terms.originalIntentId, f.originalIntentId);
        const result = await f.repo.complete(complete(f, challenge));
        assert.equal(
          (
            await createSessionRepository(b).findUserByTokenHash(
              hashSessionToken(result.token),
            )
          ).id,
          f.userId,
        );
        assert.equal(
          await createSessionRepository(b).findUserByTokenHash(
            f.token.tokenHash,
          ),
          null,
        );
        const after = await state(f);
        assert.equal(after.keys, 1);
        assert.equal(after.consumed, 1);
        assert.equal(after.sessions, 1);
        assert.notEqual(after.generation, before.generation);
        assert.equal(after.mapped, before.mapped);
        assert.equal(after.digest, f.identity.credentialsDigest);
        const original = (
          await owner.query(
            "SELECT consumed_at,expires_at<clock_timestamp() AS expired FROM provider_passkey_intents WHERE id=$1",
            [f.originalIntentId],
          )
        ).rows[0];
        assert.deepEqual(original, { consumed_at: null, expired: true });
        assert.ok(
          f.attempts.every(
            (v) =>
              v.userId === f.userId && v.purpose === "provider.passkey.restart",
          ),
        );
        await assert.rejects(
          f.repo.complete(complete(f, challenge)),
          FirstPasskeyRestartError,
        );
        await assert.rejects(
          createProviderAccounts(b).exchange(
            f.identity,
            createSessionToken().tokenHash,
            new Date(Date.now() + 600000),
          ),
          { code: "provider_reset_pending" },
        );
      });
    it("requires the same credential, origin, fresh challenge and user verification without consuming failed proofs", async () => {
      const f = await fixture(),
        challenge = await f.repo.restart(f.input),
        before = await state(f),
        other = providerPasskeyFixture(origin);
      for (const authentication of [
        other.authentication(challenge.authenticationOptions),
        f.key.authentication(challenge.authenticationOptions, { flags: 1 }),
        f.key.authentication(challenge.authenticationOptions, {
          challenge: "wrong",
        }),
        f.key.authentication(challenge.authenticationOptions, {
          origin: "https://another.example",
        }),
      ]) {
        await assert.rejects(
          f.repo.complete(complete(f, challenge, { authentication })),
        );
        assert.deepEqual(await state(f), before);
      }
      await f.repo.complete(complete(f, challenge));
    });
    it("keeps previously captured key identity exact and accepts only the approved sole-current-key fallback when no candidate was recorded", async () => {
      const captured = await fixture("email", true),
        challenge = await captured.repo.restart(captured.input),
        original = captured.identity,
        replacement = providerPasskeyFixture(origin),
        before = await state(captured);
      captured.replace({
        ...original,
        passkeys: [
          {
            credentialId: captured.key.credentialId,
            publicKey: replacement.evidence.publicKey,
          },
        ],
      });
      await assert.rejects(
        captured.repo.complete(complete(captured, challenge)),
        FirstPasskeyRestartError,
      );
      assert.deepEqual(await state(captured), before);
      const changed = [
        original.credentials[0],
        { type: "passkey", id: replacement.credentialId },
      ];
      captured.replace({
        ...original,
        credentials: changed,
        credentialsDigest: providerCredentialsDigest(changed),
        passkeys: [replacement.evidence],
      });
      await assert.rejects(
        captured.repo.restart(captured.input),
        FirstPasskeyRestartError,
      );
      captured.replace(original);
      await captured.repo.complete(complete(captured, challenge));
      const uncaptured = await fixture(),
        soleCurrent = providerPasskeyFixture(origin),
        credentials = [
          uncaptured.identity.credentials[0],
          { type: "passkey", id: soleCurrent.credentialId },
        ];
      uncaptured.replace({
        ...uncaptured.identity,
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        passkeys: [soleCurrent.evidence],
      });
      const newChallenge = await uncaptured.repo.restart(uncaptured.input);
      await uncaptured.repo.complete(
        complete(uncaptured, newChallenge, {
          authentication: soleCurrent.authentication(
            newChallenge.authenticationOptions,
          ),
        }),
      );
      assert.equal((await state(uncaptured)).keys, 1);
    });
    it("rejects an expired new restart challenge without extending it or consuming its still-live sibling", async () => {
      const f = await fixture(),
        challenge = await f.repo.restart(f.input),
        expiredId = randomUUID(),
        before = await state(f);
      await owner.query(
        `WITH issued AS(SELECT clock_timestamp()-interval '6 minutes' AS at)
        INSERT INTO provider_passkey_bootstraps(id,user_id,original_intent_id,auth_generation,provider_subject,provider_session_digest,
          before_digest,after_digest,credential_id,public_key,public_key_digest,origin,rp_id,challenge,created_at,expires_at)
        SELECT $1,user_id,original_intent_id,auth_generation,provider_subject,provider_session_digest,before_digest,after_digest,
          credential_id,public_key,public_key_digest,origin,rp_id,challenge,at,at+interval '5 minutes'
        FROM provider_passkey_bootstraps CROSS JOIN issued WHERE id=$2`,
        [expiredId, challenge.id],
      );
      await assert.rejects(
        f.repo.complete(complete(f, challenge, { id: expiredId })),
        FirstPasskeyRestartError,
      );
      assert.deepEqual(await state(f), before);
      await f.repo.complete(complete(f, challenge));
    });
    it("rejects prior wallet/password/key audit history, even when all current strong methods are absent", async () => {
      for (const event of [
        "wallet_identities.delete",
        "credentials.password_changed",
        "security.passkey.revoked",
        "provider.credentials.reconciled",
      ]) {
        const f = await fixture();
        await owner.query(
          "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,$2,$1::bigint::text,'{}')",
          [f.userId, event],
        );
        await assert.rejects(
          f.repo.candidate(f.input),
          FirstPasskeyRestartError,
        );
        // The same never-ever rule also guards ordinary first-key enrollment.
        f.replace(f.base);
        const begin = await createProviderPasskeys(a, f.verifier).begin({
          userId: f.userId,
          sessionTokenHash: f.token.tokenHash,
          origin,
        });
        assert.equal(begin.bootstrapAllowed, false);
      }
    });
    it("rejects funding history, unexplained deltas, retired or already consumed provider sessions and pending/manual resets", async () => {
      for (const scenario of [
        "grant",
        "other-delta",
        "consumed-sid",
        "minimum",
        "pending",
        "manual",
      ]) {
        const f = await fixture();
        if (scenario === "grant")
          await owner.query(
            "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'sandbox','USDC','welcome',$1::uuid::text,25000000)",
            [randomUUID(), f.userId],
          );
        if (scenario === "other-delta") {
          const credentials = [
            ...f.identity.credentials,
            { type: "google_oauth", id: "another-google" },
          ];
          f.replace({
            ...f.identity,
            credentials,
            credentialsDigest: providerCredentialsDigest(credentials),
          });
        }
        if (scenario === "consumed-sid")
          f.replace({ ...f.identity, sessionId: f.base.sessionId });
        if (scenario === "minimum")
          await owner.query(
            "UPDATE provider_identities SET minimum_issued_at=$2 WHERE user_id=$1",
            [f.userId, f.identity.issuedAt + 1],
          );
        if (scenario === "pending" || scenario === "manual")
          await owner.query(
            "INSERT INTO provider_revocation_jobs(user_id,subject,generation,state) SELECT u.id,$2,u.auth_generation,$3 FROM users u WHERE u.id=$1",
            [f.userId, f.identity.subject, scenario],
          );
        const before = await state(f);
        await assert.rejects(f.repo.restart(f.input));
        assert.deepEqual(await state(f), before);
      }
    });
    it("rechecks never-funded policy and generation at completion and never authorizes only an email token", async () => {
      for (const scenario of [
        "history",
        "generation",
        "changed-sid",
        "changed-key",
        "new-grant",
      ]) {
        const f = await fixture(),
          challenge = await f.repo.restart(f.input);
        if (scenario === "history")
          await owner.query(
            "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'wallet_identities.delete',$1::bigint::text,'{}')",
            [f.userId],
          );
        if (scenario === "generation")
          await owner.query(
            "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
            [f.userId],
          );
        if (scenario === "changed-sid")
          f.replace({ ...f.identity, sessionId: randomUUID() });
        if (scenario === "changed-key") {
          const key = providerPasskeyFixture(origin);
          f.replace({
            ...f.identity,
            passkeys: [
              {
                credentialId: f.key.credentialId,
                publicKey: key.evidence.publicKey,
              },
            ],
          });
        }
        if (scenario === "new-grant")
          await owner.query(
            "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'sandbox','USDC','welcome',$1::uuid::text,25000000)",
            [randomUUID(), f.userId],
          );
        const before = await state(f);
        await assert.rejects(f.repo.complete(complete(f, challenge)));
        assert.deepEqual(await state(f), before);
      }
    });
    it("allows only one concurrent completion and leaves immutable authorization and schema permissions enforced", async () => {
      const f = await fixture(),
        challenge = await f.repo.restart(f.input),
        second = createProviderPasskeyBootstrap(b, f.verifier, f.options),
        input = complete(f, challenge);
      const results = await Promise.allSettled([
        f.repo.complete(input),
        second.complete(input),
      ]);
      assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
      assert.equal((await state(f)).keys, 1);
      await assert.rejects(
        a.query(
          "UPDATE provider_passkey_bootstraps SET challenge=$2 WHERE id=$1",
          [challenge.id, "x".repeat(43)],
        ),
        { code: "42501" },
      );
      await assert.rejects(
        owner.query(
          "UPDATE provider_passkey_bootstraps SET public_key=$2 WHERE id=$1",
          [challenge.id, Buffer.alloc(32)],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        createProviderPasskeyBootstrap(a, f.verifier, undefined).candidate(
          f.input,
        ),
        { status: 503 },
      );
    });
    it("rolls back provisional key, generation, session and SID consumption if completion fails, allowing the exact unconsumed proof to retry", async () => {
      const f = await fixture(),
        challenge = await f.repo.restart(f.input),
        before = await state(f);
      const wrapped = {
        query: a.query.bind(a),
        async connect() {
          const client = await a.connect();
          return {
            release: () => client.release(),
            async query(text, values) {
              if (
                text.startsWith("INSERT INTO identity_audit_events") &&
                text.includes("'provider.passkey.bootstrap_completed'")
              )
                throw Error("synthetic completion write failure");
              return client.query(text, values);
            },
          };
        },
      };
      const input = complete(f, challenge);
      await assert.rejects(
        createProviderPasskeyBootstrap(wrapped, f.verifier, f.options).complete(
          input,
        ),
        /synthetic completion write failure/,
      );
      assert.deepEqual(await state(f), before);
      assert.deepEqual(await f.repo.candidate(f.input), {
        code: "first_passkey_restart_available",
      });
      await f.repo.complete(input);
    });
  },
);
