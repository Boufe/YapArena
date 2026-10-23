import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  createProviderPasskeys,
  pendingProviderPasskeyAddition,
} from "../dist/platform/auth/provider-passkeys.js";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import { createProviderRecheck } from "../dist/platform/auth/provider-recheck.js";
import { ProviderCredentialChangedError } from "../dist/platform/auth/privy.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { providerPasskeyFixture } from "./provider-passkey-fixture.js";
import { attachSubject, confirmedApproval } from "./helpers/confirmations.js";

const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL;
const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const origin = "http://localhost:53024";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe(
  "same Privy credential activation in disposable PostgreSQL",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let owner, a, b;
    const accounts = [];
    before(() => {
      for (const value of [runtimeUrl, ownerUrl]) {
        const url = new URL(value);
        assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
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
      await Promise.all([owner?.end(), a?.end(), b?.end()]);
    });
    async function fixture(method = "email", existing = []) {
      const subject = `did:privy:${randomUUID()}`;
      const credentials = [
        {
          type: method,
          id:
            method === "email"
              ? `${randomUUID()}@example.invalid`
              : `google-${randomUUID()}`,
        },
        ...existing.map((key) => ({ type: "passkey", id: key.credentialId })),
      ];
      let identity = {
        subject,
        sessionId: randomUUID(),
        email: method === "email" ? credentials[0].id : null,
        methods: [...new Set(credentials.map((entry) => entry.type))].sort(),
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        passkeys: existing.map((key) => key.evidence),
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const token = createSessionToken();
      const { user } = await createProviderAccounts(a).exchange(
        identity,
        token.tokenHash,
        new Date(Date.now() + 600000),
      );
      accounts.push(user.id);
      const verifier = {
        async verify(value) {
          assert.equal(value, "fixture-provider-token");
          return structuredClone(identity);
        },
        async inspect(value) {
          assert.equal(value, subject);
          return structuredClone(identity);
        },
      };
      const f = { userId: user.id, sessionTokenHash: token.tokenHash, origin };
      return {
        f,
        verifier,
        repo: createProviderPasskeys(a, verifier),
        get identity() {
          return identity;
        },
        replace(value) {
          identity = value;
        },
        add(key) {
          const next = [
            ...identity.credentials,
            { type: "passkey", id: key.credentialId },
          ];
          identity = {
            ...identity,
            credentials: next,
            credentialsDigest: providerCredentialsDigest(next),
            methods: [...new Set(next.map((entry) => entry.type))].sort(),
            passkeys: [...identity.passkeys, key.evidence],
          };
        },
      };
    }
    async function options(fixture, begin, key) {
      fixture.add(key);
      return fixture.repo.activationOptions({
        ...fixture.f,
        id: begin.id,
        token: "fixture-provider-token",
      });
    }
    function completion(fixture, challenge, key, extra = {}) {
      return {
        ...fixture.f,
        id: challenge.id,
        token: "fixture-provider-token",
        sessionDurationMs: 600000,
        authentication: key.authentication(challenge.authenticationOptions),
        ...extra,
      };
    }
    async function settleFixtureReset(f) {
      // Explicitly simulated provider control for a later local protocol test;
      // this is not evidence of a real Privy session-reset outcome.
      await owner.query(
        `UPDATE provider_identities p SET auth_generation=u.auth_generation
      FROM users u WHERE p.user_id=u.id AND u.id=$1`,
        [f.userId],
      );
      await owner.query(
        "UPDATE provider_revocation_jobs SET state='complete' WHERE user_id=$1",
        [f.userId],
      );
    }
    async function activate(f, key = providerPasskeyFixture()) {
      const begin = await f.repo.begin(f.f),
        challenge = await options(f, begin, key);
      const result = await f.repo.complete(completion(f, challenge, key));
      f.f.sessionTokenHash = hashSessionToken(result.token);
      await settleFixtureReset(f.f);
      return { key, result };
    }
    async function securitySnapshot(f) {
      return (
        await owner.query(
          `SELECT u.auth_generation::text generation,
        (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id) sessions,
        (SELECT COALESCE(jsonb_agg(jsonb_build_array(k.id,k.revoked_at,k.counter) ORDER BY k.id),'[]'::jsonb)
          FROM account_security_keys k WHERE k.user_id=u.id) keys FROM users u WHERE u.id=$1`,
          [f.f.userId],
        )
      ).rows[0];
    }
    for (const method of ["email", "google_oauth"])
      it(`activates one new ${method} user's same provider key, rotates local session and retains provider fences`, async () => {
        const fixture = await fixtureForMethod(method);
        const key = providerPasskeyFixture();
        const begin = await fixture.repo.begin(fixture.f);
        assert.equal(begin.bootstrapAllowed, true);
        assert.equal((await fixture.repo.begin(fixture.f)).id, begin.id);
        const challenge = await options(fixture, begin, key);
        assert.equal(challenge.bootstrapAllowed, true);
        assert.equal(
          challenge.authenticationOptions.userVerification,
          "required",
        );
        assert.deepEqual(
          challenge.authenticationOptions.allowCredentials.map(
            (entry) => entry.id,
          ),
          [key.credentialId],
        );
        const result = await fixture.repo.complete(
          completion(fixture, challenge, key),
        );
        const saved = (
          await owner.query(
            `SELECT provenance,provider_subject,provider_public_key_digest,rp_id,counter,
      device_type,backed_up FROM account_security_keys WHERE id=$1`,
            [result.keyId],
          )
        ).rows[0];
        assert.equal(saved.provenance, "privy");
        assert.equal(saved.provider_subject, fixture.identity.subject);
        assert.equal(saved.rp_id, "localhost");
        assert.equal(saved.counter, "1");
        assert.equal(saved.device_type, "singleDevice");
        assert.equal(saved.backed_up, false);
        const sessions = createSessionRepository(b);
        assert.equal(
          await sessions.findUserByTokenHash(fixture.f.sessionTokenHash),
          null,
        );
        assert.equal(
          (await sessions.findUserByTokenHash(hashSessionToken(result.token)))
            .id,
          fixture.f.userId,
        );
        const generations = (
          await owner.query(
            `SELECT u.auth_generation::text current,p.auth_generation::text mapped,p.credentials_digest digest
      FROM users u JOIN provider_identities p ON p.user_id=u.id WHERE u.id=$1`,
            [fixture.f.userId],
          )
        ).rows[0];
        assert.notEqual(generations.current, generations.mapped);
        assert.equal(generations.digest, fixture.identity.credentialsDigest);
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int count FROM provider_revocation_jobs WHERE user_id=$1 AND state='pending'",
              [fixture.f.userId],
            )
          ).rows[0].count,
          1,
        );
        await assert.rejects(
          createProviderAccounts(b).exchange(
            fixture.identity,
            createSessionToken().tokenHash,
            new Date(Date.now() + 600000),
          ),
          { code: "provider_reset_pending" },
        );
        await assert.rejects(
          fixture.repo.complete(completion(fixture, challenge, key)),
          { status: 410 },
        );
      });
    const fixtureForMethod = fixture;

    it("activates an existing linked provider credential without a second registration or credential delta", async () => {
      const key = providerPasskeyFixture(),
        f = await fixture("email", [key]);
      const begin = await f.repo.begin({
        ...f.f,
        credentialId: key.credentialId,
      });
      assert.equal(begin.bootstrapAllowed, true);
      const challenge = await f.repo.activationOptions({
        ...f.f,
        id: begin.id,
        token: "fixture-provider-token",
      });
      const before = f.identity.credentialsDigest;
      const result = await f.repo.complete(completion(f, challenge, key));
      assert.equal(
        (
          await owner.query(
            "SELECT credentials_digest FROM provider_identities WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].credentials_digest,
        before,
      );
      assert.ok(result.token);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int count FROM account_security_keys WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        1,
      );
      await settleFixtureReset(f.f);
      await assert.rejects(
        f.repo.begin({
          ...f.f,
          sessionTokenHash: hashSessionToken(result.token),
          credentialId: key.credentialId,
        }),
        { status: 409 },
      );
    });

    it("never bootstraps an additional key over an existing provider key or newly created financial history", async () => {
      for (const kind of ["existing-provider-key", "financial-history"]) {
        const f = await fixture(
          "email",
          kind === "existing-provider-key" ? [providerPasskeyFixture()] : [],
        );
        const begin = await f.repo.begin(f.f),
          key = providerPasskeyFixture();
        assert.equal(begin.bootstrapAllowed, kind !== "existing-provider-key");
        const challenge = await options(f, begin, key);
        if (kind === "financial-history")
          await owner.query(
            `INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target)
        VALUES($1::uuid,$2,'sandbox','USDC','welcome',$1::text,25000000)`,
            [randomUUID(), f.f.userId],
          );
        assert.equal(
          (
            await f.repo.activationOptions({
              ...f.f,
              id: begin.id,
              token: "fixture-provider-token",
            })
          ).bootstrapAllowed,
          false,
        );
        await assert.rejects(f.repo.complete(completion(f, challenge, key)), {
          status: 403,
        });
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int count FROM account_security_keys WHERE user_id=$1",
              [f.f.userId],
            )
          ).rows[0].count,
          0,
        );
      }
    });

    it("requires unchanged selected mode, same DID, supported public key and only the intended provider delta", async () => {
      const f = await fixture(),
        begin = await f.repo.begin(f.f),
        key = providerPasskeyFixture();
      f.add(key);
      const exact = structuredClone(f.identity);
      for (const changed of [
        { ...exact, subject: "did:privy:another" },
        { ...exact, passkeys: [{ ...key.evidence, publicKey: null }] },
        { ...exact, passkeys: [{ ...key.evidence, publicKey: "bad" }] },
        {
          ...exact,
          credentials: exact.credentials.slice(1),
          credentialsDigest: providerCredentialsDigest(
            exact.credentials.slice(1),
          ),
        },
        {
          ...exact,
          credentials: [
            ...exact.credentials,
            { type: "google_oauth", id: "unexpected" },
          ],
          credentialsDigest: providerCredentialsDigest([
            ...exact.credentials,
            { type: "google_oauth", id: "unexpected" },
          ]),
        },
      ]) {
        f.replace(changed);
        await assert.rejects(
          f.repo.activationOptions({
            ...f.f,
            id: begin.id,
            token: "fixture-provider-token",
          }),
        );
      }
      f.replace(exact);
      const challenge = await f.repo.activationOptions({
        ...f.f,
        id: begin.id,
        token: "fixture-provider-token",
      });
      f.replace({ ...exact, sessionId: randomUUID() });
      await assert.rejects(f.repo.complete(completion(f, challenge, key)), {
        status: 410,
      });
      f.replace({
        ...exact,
        passkeys: [
          {
            ...key.evidence,
            publicKey: providerPasskeyFixture().evidence.publicKey,
          },
        ],
      });
      await assert.rejects(f.repo.complete(completion(f, challenge, key)), {
        status: 410,
      });
      f.replace(exact);
      await assert.rejects(
        f.repo.begin({ ...f.f, credentialId: key.credentialId }),
        { status: 410 },
      );
      await assert.rejects(
        owner.query(
          "UPDATE provider_passkey_intents SET intent_mode='existing',selected_credential_id=$2 WHERE id=$1",
          [begin.id, key.credentialId],
        ),
        { code: "23514" },
      );
      await f.repo.complete(completion(f, challenge, key));
    });

    it("verifies challenge, RP, origin, user verification and exact credential before activating", async () => {
      const f = await fixture(),
        key = providerPasskeyFixture(),
        begin = await f.repo.begin(f.f),
        challenge = await options(f, begin, key);
      for (const override of [
        { challenge: "other" },
        { origin: "https://other.example" },
        { rpId: "other.example" },
        { flags: 0x01 },
        { flags: 0x04 },
      ])
        await assert.rejects(
          f.repo.complete(
            completion(f, challenge, key, {
              authentication: key.authentication(
                challenge.authenticationOptions,
                override,
              ),
            }),
          ),
          { status: 401 },
        );
      await assert.rejects(
        f.repo.complete(
          completion(f, challenge, key, {
            authentication: providerPasskeyFixture().authentication(
              challenge.authenticationOptions,
            ),
          }),
        ),
        { status: 401 },
      );
      const other = await fixture();
      await assert.rejects(
        f.repo.complete({
          ...completion(f, challenge, key),
          sessionTokenHash: other.f.sessionTokenHash,
        }),
        { status: 410 },
      );
      await f.repo.complete(completion(f, challenge, key));
    });

    it("permits only exact live addition deferral and consumes an intent once under concurrent completion", async () => {
      const f = await fixture(),
        begin = await f.repo.begin(f.f),
        key = providerPasskeyFixture();
      f.add(key);
      const generation = (
        await owner.query("SELECT auth_generation FROM users WHERE id=$1", [
          f.f.userId,
        ])
      ).rows[0].auth_generation;
      const args = {
        userId: f.f.userId,
        authGeneration: generation,
        subject: f.identity.subject,
        beforeDigest: begin.terms.beforeDigest,
        current: f.identity,
      };
      assert.equal(await pendingProviderPasskeyAddition(a, args), true);
      assert.equal(
        await pendingProviderPasskeyAddition(a, {
          ...args,
          authGeneration: String(BigInt(generation) + 1n),
        }),
        false,
      );
      const challenge = await f.repo.activationOptions({
        ...f.f,
        id: begin.id,
        token: "fixture-provider-token",
      });
      const changed = {
        ...f.identity,
        passkeys: [providerPasskeyFixture().evidence],
      };
      assert.equal(
        await pendingProviderPasskeyAddition(a, { ...args, current: changed }),
        false,
      );
      const outcomes = await Promise.allSettled([
        f.repo.complete(completion(f, challenge, key)),
        createProviderPasskeys(b, f.verifier).complete(
          completion(f, challenge, key),
        ),
      ]);
      assert.equal(
        outcomes.filter((value) => value.status === "fulfilled").length,
        1,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int count FROM account_security_keys WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        1,
      );
      assert.equal(await pendingProviderPasskeyAddition(a, args), false);
    });

    it("rejects an expired or consumed intent without accepting its provider delta or issuing a cookie", async () => {
      const f = await fixture(),
        begin = await f.repo.begin(f.f),
        expired = randomUUID(),
        key = providerPasskeyFixture();
      await owner.query(
        `WITH issued AS(SELECT clock_timestamp() AS at)
      INSERT INTO provider_passkey_intents(id,user_id,session_token_hash,auth_generation,provider_subject,origin,rp_id,
    intent_mode,selected_credential_id,before_digest,before_credentials,created_at,expires_at)
    SELECT $2,user_id,session_token_hash,auth_generation,provider_subject,origin,rp_id,intent_mode,selected_credential_id,before_digest,before_credentials,
      issued.at-interval '6 minutes',issued.at-interval '1 minute' FROM provider_passkey_intents CROSS JOIN issued WHERE id=$1`,
        [begin.id, expired],
      );
      f.add(key);
      await assert.rejects(
        f.repo.activationOptions({
          ...f.f,
          id: expired,
          token: "fixture-provider-token",
        }),
        { status: 410 },
      );
      await owner.query(
        "UPDATE provider_passkey_intents SET consumed_at=clock_timestamp() WHERE id=$1",
        [begin.id],
      );
      await assert.rejects(
        f.repo.activationOptions({
          ...f.f,
          id: begin.id,
          token: "fixture-provider-token",
        }),
        { status: 410 },
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int count FROM account_security_keys WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int count FROM sessions WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        1,
      );
    });

    it("does not occupy a pool connection during provider inspection and rejects a logout that wins the race", async () => {
      const f = await fixture(),
        started = deferred(),
        release = deferred();
      const repo = createProviderPasskeys(a, {
        ...f.verifier,
        async inspect(subject) {
          started.resolve();
          await release.promise;
          return f.verifier.inspect(subject);
        },
      });

      const pending = repo.begin(f.f);
      await started.promise;
      await a.query("DELETE FROM sessions WHERE token_hash=$1", [
        f.f.sessionTokenHash,
      ]);
      release.resolve();
      await assert.rejects(pending, /session is unavailable/);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int count FROM provider_passkey_intents WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        0,
      );
    });

    it("requires a confirmed operation for later addition and consumes it atomically with activation", async () => {
      const f = await fixture(),
        first = providerPasskeyFixture(),
        initial = await f.repo.begin(f.f),
        challenge = await options(f, initial, first);
      const activated = await f.repo.complete(completion(f, challenge, first));
      f.f.sessionTokenHash = hashSessionToken(activated.token);
      await settleFixtureReset(f.f);
      const begin = await f.repo.begin(f.f);
      assert.equal(begin.bootstrapAllowed, false);
      // Decision 0009: a fresh sign-in of one of the account's subjects
      // confirms the operation that approves the later addition.
      const subject = await attachSubject(owner, f.f.userId);
      const confirmed = (purpose, terms) =>
        confirmedApproval(a, {
          userId: f.f.userId,
          sessionTokenHash: f.f.sessionTokenHash,
          purpose,
          terms,
          subject,
        });
      const second = providerPasskeyFixture(),
        next = await options(f, begin, second);
      const { approval: unrelated } = await confirmed("withdraw.request", {
        amount: "1",
        asset: "USDC",
        destination: "fixture",
      });
      const { id: proofId, approval } = await confirmed(
        "provider.passkey.link",
        begin.terms,
      );
      await assert.rejects(f.repo.complete(completion(f, next, second)), {
        status: 403,
      });
      await assert.rejects(
        f.repo.complete(completion(f, next, second, { approval: unrelated })),
        {
          status: 403,
          message: "approval does not authorize this passkey link",
        },
      );
      await assert.rejects(
        f.repo.complete(
          completion(f, next, second, {
            approval,
            authentication: second.authentication(next.authenticationOptions, {
              flags: 1,
            }),
          }),
        ),
        { status: 401 },
      );
      assert.equal(
        (
          await owner.query(
            "SELECT consumed_at FROM account_operations WHERE id=$1",
            [proofId],
          )
        ).rows[0].consumed_at,
        null,
      );
      const completed = await f.repo.complete(
        completion(f, next, second, { approval }),
      );
      assert.ok(completed.token);
      assert.notEqual(
        (
          await owner.query(
            "SELECT consumed_at FROM account_operations WHERE id=$1",
            [proofId],
          )
        ).rows[0].consumed_at,
        null,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int count FROM account_security_keys WHERE user_id=$1",
            [f.f.userId],
          )
        ).rows[0].count,
        2,
      );
    });

    const recheck = (pool, inspector) =>
      createProviderRecheck(pool, inspector, { staleAfterMs: 0 });
    async function auditCount(f, eventType) {
      return (
        await owner.query(
          "SELECT count(*)::int count FROM identity_audit_events WHERE user_id=$1 AND event_type=$2",
          [f.f.userId, eventType],
        )
      ).rows[0].count;
    }

    it("keeps both sessions usable and leaves one exact pending addition to activation", async () => {
      const f = await fixture(),
        other = createSessionToken();
      const user = (
        await owner.query(
          'SELECT auth_generation AS "authGeneration" FROM users WHERE id=$1',
          [f.f.userId],
        )
      ).rows[0];
      await createSessionRepository(b).create(
        f.f.userId,
        other.tokenHash,
        new Date(Date.now() + 600000),
        user,
      );
      const begin = await f.repo.begin(f.f),
        key = providerPasskeyFixture();
      f.add(key);
      const before = await securitySnapshot(f);
      // Requests no longer read Privy, so neither session is denied.
      for (const tokenHash of [f.f.sessionTokenHash, other.tokenHash])
        assert.equal(
          (await createSessionRepository(b).findUserByTokenHash(tokenHash)).id,
          f.f.userId,
        );
      assert.deepEqual(
        await Promise.all([
          recheck(a, f.verifier).run(f.f.userId),
          recheck(b, f.verifier).run(f.f.userId),
        ]),
        ["deferred", "deferred"],
      );
      assert.deepEqual(await securitySnapshot(f), before);
      // Signing in elsewhere meanwhile does not record the change either.
      await createProviderAccounts(b).exchange(
        { ...f.identity, sessionId: randomUUID() },
        createSessionToken().tokenHash,
        new Date(Date.now() + 600000),
      );
      const challenge = await f.repo.activationOptions({
        ...f.f,
        id: begin.id,
        token: "fixture-provider-token",
      });
      const result = await f.repo.complete(completion(f, challenge, key));
      assert.ok(result.keyId);
      assert.equal(
        (
          await createSessionRepository(b).findUserByTokenHash(
            hashSessionToken(result.token),
          )
        ).id,
        f.f.userId,
      );
      assert.equal(await auditCount(f, "sessions.incident"), 0);
      assert.equal(await auditCount(f, "provider.credentials.changed"), 0);
    });

    it("records, without ending sessions, a change that is not one exact pending addition", async () => {
      for (const scenario of [
        "original-session-ended",
        "multiple-added-keys",
        "email-changed-too",
        "captured-key-changed",
      ]) {
        const f = await fixture(),
          other = createSessionToken();
        const account = (
          await owner.query(
            'SELECT auth_generation AS "authGeneration" FROM users WHERE id=$1',
            [f.f.userId],
          )
        ).rows[0];
        await createSessionRepository(b).create(
          f.f.userId,
          other.tokenHash,
          new Date(Date.now() + 600000),
          account,
        );
        const begin = await f.repo.begin(f.f),
          key = providerPasskeyFixture();
        f.add(key);
        if (scenario === "original-session-ended")
          await owner.query("DELETE FROM sessions WHERE token_hash=$1", [
            f.f.sessionTokenHash,
          ]);
        else if (scenario === "multiple-added-keys")
          f.add(providerPasskeyFixture());
        else if (scenario === "email-changed-too") {
          const changedEmail = `${randomUUID()}@example.invalid`,
            credentials = f.identity.credentials.map((entry) =>
              entry.type === "email" ? { ...entry, id: changedEmail } : entry,
            );
          f.replace({
            ...f.identity,
            email: changedEmail,
            credentials,
            credentialsDigest: providerCredentialsDigest(credentials),
          });
        } else {
          await f.repo.activationOptions({
            ...f.f,
            id: begin.id,
            token: "fixture-provider-token",
          });
          f.replace({
            ...f.identity,
            passkeys: [
              {
                ...key.evidence,
                publicKey: providerPasskeyFixture().evidence.publicKey,
              },
            ],
          });
        }
        const before = await securitySnapshot(f);
        assert.equal(
          await recheck(b, f.verifier).run(f.f.userId),
          "recorded",
          scenario,
        );
        assert.deepEqual(await securitySnapshot(f), before, scenario);
        assert.equal(
          await auditCount(f, "provider.credentials.changed"),
          1,
          scenario,
        );
      }
    });

    it("keeps sessions when Privy omits an accepted or pending passkey public key", async () => {
      for (const accepted of [false, true]) {
        const f = await fixture();
        let key;
        if (accepted) ({ key } = await activate(f));
        else {
          await f.repo.begin(f.f);
          key = providerPasskeyFixture();
          f.add(key);
        }
        f.replace({
          ...f.identity,
          passkeys: f.identity.passkeys.map((entry) =>
            entry.credentialId === key.credentialId
              ? { ...entry, publicKey: null }
              : entry,
          ),
        });
        const before = await securitySnapshot(f);
        assert.equal(
          await recheck(a, f.verifier).run(f.f.userId),
          accepted ? "unchanged" : "recorded",
        );
        assert.deepEqual(await securitySnapshot(f), before);
      }
    });

    it("defers a changed accepted key without touching sessions or keys", async () => {
      const f = await fixture(),
        { key } = await activate(f);
      await f.repo.begin(f.f);
      f.add(providerPasskeyFixture());
      f.replace({
        ...f.identity,
        passkeys: f.identity.passkeys.map((entry) =>
          entry.credentialId === key.credentialId
            ? {
                ...entry,
                publicKey: providerPasskeyFixture().evidence.publicKey,
              }
            : entry,
        ),
      });
      const before = await securitySnapshot(f);
      assert.equal(await recheck(a, f.verifier).run(f.f.userId), "deferred");
      assert.deepEqual(await securitySnapshot(f), before);
    });

    it("does not defer a provider delta after its original intent is consumed or expired", async () => {
      const f = await fixture(),
        begin = await f.repo.begin(f.f);
      f.add(providerPasskeyFixture());
      await owner.query(
        "UPDATE provider_passkey_intents SET consumed_at=clock_timestamp() WHERE id=$1",
        [begin.id],
      );
      await owner.query(
        `WITH issued AS(SELECT clock_timestamp() AS at)
        INSERT INTO provider_passkey_intents(id,user_id,session_token_hash,auth_generation,provider_subject,origin,rp_id,
        intent_mode,selected_credential_id,before_digest,before_credentials,created_at,expires_at)
        SELECT $2,user_id,session_token_hash,auth_generation,provider_subject,origin,rp_id,intent_mode,selected_credential_id,
          before_digest,before_credentials,at-interval '6 minutes',at-interval '1 minute'
        FROM provider_passkey_intents CROSS JOIN issued WHERE id=$1`,
        [begin.id, randomUUID()],
      );
      assert.equal(await recheck(a, f.verifier).run(f.f.userId), "recorded");
      assert.equal((await securitySnapshot(f)).sessions, 1);
    });

    it("records a method change that the stored methods have not caught up with, then sets up the passkey", async () => {
      const f = await fixture();
      const credentials = [
        ...f.identity.credentials,
        { type: "google_oauth", id: `google-${randomUUID()}` },
      ];
      f.replace({
        ...f.identity,
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        methods: [...new Set(credentials.map((entry) => entry.type))].sort(),
      });
      const before = await securitySnapshot(f);
      const begin = await f.repo.begin(f.f);
      assert.equal(begin.terms.beforeDigest, f.identity.credentialsDigest);
      assert.deepEqual(await securitySnapshot(f), before);
      const recorded = (
        await owner.query(
          `SELECT e.metadata->>'source' AS source,p.credentials_digest AS digest
          FROM identity_audit_events e JOIN provider_identities p ON p.user_id=e.user_id
          WHERE e.user_id=$1 AND e.event_type='provider.credentials.changed'`,
          [f.f.userId],
        )
      ).rows;
      assert.deepEqual(recorded, [
        { source: "passkey_setup", digest: f.identity.credentialsDigest },
      ]);
      const key = providerPasskeyFixture();
      const challenge = await options(f, begin, key);
      assert.ok((await f.repo.complete(completion(f, challenge, key))).keyId);
    });

    it("takes no action on a frozen response during the matching active provider reset", async () => {
      for (const state of ["pending", "running", "manual"]) {
        const f = await fixture(),
          key = providerPasskeyFixture(),
          begin = await f.repo.begin(f.f),
          challenge = await options(f, begin, key);
        const result = await f.repo.complete(completion(f, challenge, key));
        f.f.sessionTokenHash = hashSessionToken(result.token);
        await owner.query(
          `UPDATE provider_revocation_jobs SET state=$2,
          failure_reason=CASE WHEN $2='manual' THEN 'uncertain_provider_outcome' ELSE NULL END,
          attempts=1,lease_until=clock_timestamp()+interval '30 seconds' WHERE user_id=$1`,
          [f.f.userId, state],
        );
        const before = await securitySnapshot(f);
        assert.equal(
          await recheck(a, {
            async inspect() {
              throw new ProviderCredentialChangedError(
                "synthetic own-reset frozen response",
              );
            },
          }).run(f.f.userId),
          "deferred",
        );
        assert.deepEqual(await securitySnapshot(f), before);
      }
    });

    it("still revokes independent or unrelated freezes while a provider reset record exists", async () => {
      for (const mode of [
        "changed-key",
        "independent-freeze",
        "wrong-subject",
      ]) {
        const f = await fixture(),
          key = providerPasskeyFixture(),
          begin = await f.repo.begin(f.f),
          challenge = await options(f, begin, key);
        const result = await f.repo.complete(completion(f, challenge, key));
        f.f.sessionTokenHash = hashSessionToken(result.token);
        await owner.query(
          `UPDATE provider_revocation_jobs SET state=$2,failure_reason=$3,
          subject=CASE WHEN $4 THEN 'did:privy:other-owner-fixture' ELSE subject END,
          attempts=1,lease_until=clock_timestamp()+interval '30 seconds' WHERE user_id=$1`,
          [
            f.f.userId,
            mode === "independent-freeze" ? "manual" : "running",
            mode === "independent-freeze"
              ? "independent_provider_freeze"
              : null,
            mode === "wrong-subject",
          ],
        );
        if (mode === "changed-key") {
          // A key change is checked at step-up; with a reset running the
          // re-check takes no action at all.
          f.replace({
            ...f.identity,
            passkeys: [
              {
                ...key.evidence,
                publicKey: providerPasskeyFixture().evidence.publicKey,
              },
            ],
          });
          const before = await securitySnapshot(f);
          assert.equal(
            await recheck(a, f.verifier).run(f.f.userId),
            "deferred",
          );
          assert.deepEqual(await securitySnapshot(f), before);
          continue;
        }
        const before = await securitySnapshot(f);
        assert.equal(
          await recheck(a, {
            async inspect() {
              throw new ProviderCredentialChangedError(
                "synthetic unowned freeze",
              );
            },
          }).run(f.f.userId),
          "revoked",
          mode,
        );
        const after = await securitySnapshot(f);
        assert.equal(after.sessions, 0);
        assert.notEqual(after.generation, before.generation);
      }
    });
  },
);
