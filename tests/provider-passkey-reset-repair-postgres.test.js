import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createFirstPasskeyResetRepair } from "../dist/platform/auth/provider-passkey-reset-repair.js";
import { ProviderResetRetryError } from "../dist/platform/auth/provider-revocation.js";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import { createProviderPasskeys } from "../dist/platform/auth/provider-passkeys.js";
import { createProviderPasskeyBootstrap } from "../dist/platform/auth/provider-passkey-bootstrap.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../dist/platform/auth/session-tokens.js";
import { providerPasskeyFixture } from "./provider-passkey-fixture.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";

const runtimeUrl = process.env.WALLET_TEST_DATABASE_URL;
const ownerUrl = process.env.WALLET_TEST_OWNER_DATABASE_URL;
const origin = "http://localhost:53024";
describe(
  "owner-only reset repair for an unfinished first provider passkey",
  { skip: !runtimeUrl || !ownerUrl },
  () => {
    let owner, runtime;
    const users = [];
    before(() => {
      for (const raw of [runtimeUrl, ownerUrl]) {
        const url = new URL(raw);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/(?:revocation_test|yaparena_f02)[a-z0-9_]*$/,
        );
      }
      owner = new pg.Pool({ connectionString: ownerUrl });
      runtime = new pg.Pool({ connectionString: runtimeUrl });
    });
    after(async () => {
      if (users.length)
        await owner.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [
          users,
        ]);
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    async function fixture({ captured = false } = {}) {
      const subject = `did:privy:${randomUUID()}`,
        email = `${randomUUID()}@example.invalid`,
        token = createSessionToken();
      let identity = {
        subject,
        email,
        sessionId: randomUUID(),
        issuedAt: Math.floor(Date.now() / 1000),
        methods: ["email"],
        credentials: [{ type: "email", id: email }],
        credentialsDigest: providerCredentialsDigest([
          { type: "email", id: email },
        ]),
        passkeys: [],
      };
      const { user } = await createProviderAccounts(runtime).exchange(
        identity,
        token.tokenHash,
        new Date(Date.now() + 600000),
      );
      users.push(user.id);
      let frozenAt = null,
        unfreezes = 0,
        inspections = 0,
        uncertain = false,
        laggingConfirmation = false;
      const verifier = {
        async inspect(value) {
          assert.equal(value, subject);
          inspections++;
          return structuredClone(identity);
        },
        async verify() {
          return structuredClone(identity);
        },
      };
      const passkeys = createProviderPasskeys(runtime, verifier),
        context = {
          userId: user.id,
          sessionTokenHash: token.tokenHash,
          origin,
        },
        intent = await passkeys.begin(context),
        key = providerPasskeyFixture(),
        beforeDigest = identity.credentialsDigest;
      identity = {
        ...identity,
        methods: ["email", "passkey"],
        credentials: [
          ...identity.credentials,
          { type: "passkey", id: key.credentialId },
        ],
        passkeys: [key.evidence],
      };
      identity.credentialsDigest = providerCredentialsDigest(
        identity.credentials,
      );
      if (captured)
        await passkeys.activationOptions({
          ...context,
          id: intent.id,
          token: "synthetic",
        });
      await endAllAccountSessions(runtime, user.id);
      // Simulate a completed worker freeze whose immediate confirmation lagged.
      // Shift ONLY this synthetic revocation window to avoid a 30-second sleep.
      await owner.query(
        "UPDATE identity_audit_events SET occurred_at=clock_timestamp()-interval '20 seconds' WHERE user_id=$1 AND event_type='sessions.incident'",
        [user.id],
      );
      await owner.query(
        "UPDATE provider_revocation_jobs SET state='manual',attempts=1,failure_reason='uncertain_provider_outcome',lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",
        [user.id],
      );
      const generation = (
        await owner.query(
          "SELECT auth_generation::text generation FROM users WHERE id=$1",
          [user.id],
        )
      ).rows[0].generation;
      frozenAt = Math.floor(Date.now() / 1000) - 10;
      const input = {
        userId: user.id,
        requestId: randomUUID(),
        activityReview: {
          evidenceDigest: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
          noIndependentFreeze: true,
          frozenAt,
          expectedGeneration: generation,
          expectedAttempts: 1,
        },
      };
      const provider = {
        async state(value) {
          assert.equal(value, subject);
          return { frozenAt };
        },
        async unfreeze(value) {
          assert.equal(value, subject);
          unfreezes++;
          if (!laggingConfirmation) frozenAt = null;
          if (uncertain) throw Error("synthetic lost unfreeze response");
        },
      };
      return {
        userId: user.id,
        context,
        intent,
        key,
        beforeDigest,
        input,
        verifier,
        provider,
        service: createFirstPasskeyResetRepair(owner, verifier, provider, {
          origin,
        }),
        get identity() {
          return identity;
        },
        setIdentity(value) {
          identity = value;
        },
        freshSession() {
          identity = {
            ...identity,
            sessionId: randomUUID(),
            issuedAt: Math.floor(Date.now() / 1000),
          };
        },
        setFrozen(value) {
          frozenAt = value;
        },
        setUncertain() {
          uncertain = true;
        },
        setLaggingConfirmation() {
          laggingConfirmation = true;
        },
        counters() {
          return { inspections, unfreezes };
        },
      };
    }
    async function snapshot(f) {
      return (
        await owner.query(
          `SELECT u.auth_generation::text generation,p.auth_generation::text mapped,p.credentials_digest digest,p.credentials_snapshot snapshot,p.minimum_issued_at::text cutoff,
      j.state,j.confirmed_frozen_at::text confirmed,(SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id) sessions,
      (SELECT count(*)::int FROM account_security_keys k WHERE k.user_id=u.id) keys,
      (SELECT count(*)::int FROM provider_session_exchanges e WHERE e.user_id=u.id) exchanges
      FROM users u JOIN provider_identities p ON p.user_id=u.id JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.generation=u.auth_generation WHERE u.id=$1`,
          [f.userId],
        )
      ).rows[0];
    }
    async function rejected(f, service = f.service, input = f.input) {
      const before = await snapshot(f),
        counters = f.counters();
      await assert.rejects(service.repair(input), ProviderResetRetryError);
      assert.deepEqual(await snapshot(f), before);
      assert.equal(f.counters().unfreezes, counters.unfreezes);
    }
    it("completes only reset fences and requires a fresh provider SID plus native UV before first key adoption", async () => {
      for (const captured of [false, true]) {
        const f = await fixture({ captured }),
          before = await snapshot(f);
        assert.deepEqual(await f.service.repair(f.input), {
          state: "complete",
        });
        const after = await snapshot(f);
        assert.equal(after.generation, before.generation);
        assert.equal(after.mapped, before.generation);
        assert.equal(after.digest, before.digest);
        assert.deepEqual(after.snapshot, before.snapshot);
        assert.equal(after.sessions, 0);
        assert.equal(after.keys, 0);
        assert.equal(after.exchanges, before.exchanges);
        assert.equal(after.cutoff, String(f.input.activityReview.frozenAt + 1));
        assert.equal(f.counters().unfreezes, 1);
        assert.deepEqual(await f.service.repair(f.input), {
          state: "complete",
        });
        assert.equal(f.counters().unfreezes, 1);
        f.freshSession();
        const bootstrap = createProviderPasskeyBootstrap(runtime, f.verifier, {
          authorizeAttempt: async () => {},
        });
        const challenge = await bootstrap.restart({
          token: "synthetic",
          origin,
        });
        await assert.rejects(
          bootstrap.complete({
            id: challenge.id,
            token: "synthetic",
            origin,
            authentication: f.key.authentication(
              challenge.authenticationOptions,
              { flags: 0x01 },
            ),
            sessionDurationMs: 600000,
          }),
        );
        assert.equal((await snapshot(f)).keys, 0);
        const result = await bootstrap.complete({
          id: challenge.id,
          token: "synthetic",
          origin,
          authentication: f.key.authentication(challenge.authenticationOptions),
          sessionDurationMs: 600000,
        });
        assert.equal(
          (
            await createSessionRepository(runtime).findUserByTokenHash(
              hashSessionToken(result.token),
            )
          ).id,
          f.userId,
        );
        assert.equal((await snapshot(f)).keys, 1);
      }
    });
    it("denies runtime role before provider inspection and refuses wrong review/generation/attempt/window or unrecognized revocation", async () => {
      const runtimeCase = await fixture(),
        counters = runtimeCase.counters();
      await rejected(
        runtimeCase,
        createFirstPasskeyResetRepair(
          runtime,
          runtimeCase.verifier,
          runtimeCase.provider,
          { origin },
        ),
      );
      assert.deepEqual(runtimeCase.counters(), counters);
      for (const scenario of [
        "generation",
        "attempt",
        "review",
        "window",
        "before-claim",
        "event",
        "prior-unresolved",
        "confirmed-before-review",
      ]) {
        const f = await fixture(),
          input = structuredClone(f.input);
        if (scenario === "generation")
          input.activityReview.expectedGeneration = String(
            BigInt(input.activityReview.expectedGeneration) + 1n,
          );
        if (scenario === "attempt") input.activityReview.expectedAttempts++;
        if (scenario === "review")
          input.activityReview.noIndependentFreeze = false;
        if (scenario === "window") {
          input.activityReview.frozenAt -= 120;
          f.setFrozen(input.activityReview.frozenAt);
        }
        if (scenario === "before-claim") {
          await owner.query(
            "UPDATE identity_audit_events SET occurred_at=clock_timestamp()-interval '2 minutes' WHERE user_id=$1 AND event_type='sessions.incident'",
            [f.userId],
          );
          input.activityReview.frozenAt -= 30;
          f.setFrozen(input.activityReview.frozenAt);
        }
        if (scenario === "event")
          await owner.query(
            "UPDATE identity_audit_events SET event_type='synthetic.not_a_revocation' WHERE user_id=$1 AND event_type='sessions.incident'",
            [f.userId],
          );
        if (scenario === "prior-unresolved")
          await owner.query(
            "INSERT INTO provider_revocation_jobs(user_id,subject,generation,state) VALUES($1,$2,$3,'manual')",
            [
              f.userId,
              f.identity.subject,
              String(BigInt(f.input.activityReview.expectedGeneration) - 1n),
            ],
          );
        if (scenario === "confirmed-before-review")
          await owner.query(
            "UPDATE provider_revocation_jobs SET confirmed_frozen_at=$2 WHERE user_id=$1",
            [f.userId, f.input.activityReview.frozenAt],
          );
        await rejected(f, f.service, input);
      }
    });
    it("rejects financial/strong-method history, changed email, multiple keys, captured COSE mismatch and dead baseline", async () => {
      for (const scenario of [
        "funds",
        "historical-wallet",
        "email",
        "multiple-keys",
        "captured-key",
        "baseline",
      ]) {
        const f = await fixture({ captured: scenario === "captured-key" });
        if (scenario === "funds")
          await owner.query(
            "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'sandbox','USDC','welcome',$1::text,25000000)",
            [randomUUID(), f.userId],
          );
        if (scenario === "historical-wallet")
          await owner.query(
            "INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata) VALUES($1,'wallet.unlinked',$2,'{}')",
            [f.userId, randomUUID()],
          );
        if (scenario === "email") {
          const credentials = f.identity.credentials.map((entry) =>
            entry.type === "email"
              ? { ...entry, id: `${randomUUID()}@example.invalid` }
              : entry,
          );
          f.setIdentity({
            ...f.identity,
            credentials,
            credentialsDigest: providerCredentialsDigest(credentials),
          });
        }
        if (scenario === "multiple-keys") {
          const key = providerPasskeyFixture(),
            credentials = [
              ...f.identity.credentials,
              { type: "passkey", id: key.credentialId },
            ];
          f.setIdentity({
            ...f.identity,
            credentials,
            credentialsDigest: providerCredentialsDigest(credentials),
            passkeys: [...f.identity.passkeys, key.evidence],
          });
        }
        if (scenario === "captured-key")
          f.setIdentity({
            ...f.identity,
            passkeys: [
              {
                ...f.key.evidence,
                publicKey: providerPasskeyFixture().evidence.publicKey,
              },
            ],
          });
        if (scenario === "baseline")
          await owner.query(
            "UPDATE provider_identities SET credentials_snapshot=NULL,credentials_digest=repeat('0',64) WHERE user_id=$1",
            [f.userId],
          );
        await rejected(f);
      }
    });
    it("permits at most one reviewed unfreeze across concurrent owner instances", async () => {
      const f = await fixture(),
        second = createFirstPasskeyResetRepair(owner, f.verifier, f.provider, {
          origin,
        });
      const results = await Promise.allSettled([
        f.service.repair(f.input),
        second.repair(f.input),
      ]);
      assert.ok(results.some((result) => result.status === "fulfilled"));
      assert.equal(f.counters().unfreezes, 1);
      assert.equal((await snapshot(f)).state, "complete");
      assert.deepEqual(await f.service.finalize(f.input), {
        state: "complete",
      });
      assert.equal(f.counters().unfreezes, 1);
    });
    it("keeps a durable one-use marker after an uncertain unfreeze and finishes with GET-only reconciliation", async () => {
      const f = await fixture();
      f.setUncertain();
      await assert.rejects(f.service.repair(f.input), { stage: "unfreeze" });
      const admitted = await snapshot(f);
      assert.equal(admitted.state, "manual");
      assert.notEqual(admitted.generation, admitted.mapped);
      assert.equal(admitted.confirmed, String(f.input.activityReview.frozenAt));
      assert.equal(admitted.keys, 0);
      assert.equal(admitted.sessions, 0);
      await assert.rejects(f.service.repair(f.input), ProviderResetRetryError);
      assert.equal(f.counters().unfreezes, 1);
      const readOnly = createFirstPasskeyResetRepair(
        owner,
        f.verifier,
        {
          state: f.provider.state,
          unfreeze: async () =>
            assert.fail("finalizer must never mutate provider"),
        },
        { origin },
      );
      const wrong = structuredClone(f.input);
      wrong.activityReview.evidenceDigest = "0".repeat(64);
      await assert.rejects(readOnly.finalize(wrong), ProviderResetRetryError);
      f.setFrozen(f.input.activityReview.frozenAt);
      await assert.rejects(readOnly.finalize(f.input), ProviderResetRetryError);
      f.setFrozen(null);
      assert.deepEqual(await readOnly.finalize(f.input), { state: "complete" });
      assert.equal(f.counters().unfreezes, 1);
      assert.equal((await snapshot(f)).digest, f.beforeDigest);
    });
    it("does not repeat an unfreeze when successful control responses have lagging GET confirmation", async () => {
      const f = await fixture();
      f.setLaggingConfirmation();
      await assert.rejects(f.service.repair(f.input), {
        stage: "unfreeze_confirmation",
      });
      assert.equal(f.counters().unfreezes, 1);
      await assert.rejects(f.service.repair(f.input), ProviderResetRetryError);
      assert.equal(f.counters().unfreezes, 1);
      f.setFrozen(null);
      assert.deepEqual(await f.service.finalize(f.input), {
        state: "complete",
      });
      assert.equal(f.counters().unfreezes, 1);
      assert.equal((await snapshot(f)).keys, 0);
    });
    it("rolls final SQL mutations back while preserving the earlier one-use review marker", async () => {
      const f = await fixture(),
        name = `synthetic_repair_${randomUUID().replaceAll("-", "")}`;
      await owner.query(
        `CREATE FUNCTION yaparena.${name}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,yaparena,pg_temp AS $$ BEGIN IF NEW.user_id=${f.userId} AND NEW.event_type='provider.passkey.reset_repair_completed' THEN RAISE EXCEPTION 'synthetic repair commit failure'; END IF; RETURN NEW; END $$`,
      );
      await owner.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON identity_audit_events FOR EACH ROW EXECUTE FUNCTION yaparena.${name}()`,
      );
      try {
        await assert.rejects(f.service.repair(f.input), { stage: "commit" });
        const failed = await snapshot(f);
        assert.equal(failed.state, "manual");
        assert.notEqual(failed.mapped, failed.generation);
        assert.equal(failed.digest, f.beforeDigest);
        assert.equal(failed.keys, 0);
        assert.equal(failed.sessions, 0);
        assert.equal(f.counters().unfreezes, 1);
      } finally {
        await owner.query(`DROP TRIGGER ${name} ON identity_audit_events`);
        await owner.query(`DROP FUNCTION yaparena.${name}()`);
      }
      assert.deepEqual(await f.service.finalize(f.input), {
        state: "complete",
      });
      assert.equal(f.counters().unfreezes, 1);
    });
  },
);
