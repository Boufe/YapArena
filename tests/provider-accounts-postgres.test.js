import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import {
  createProviderAccounts,
  ProviderAccountError,
} from "../dist/platform/auth/provider-accounts.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import {
  createProviderRevocation,
  ProviderResetRetryError,
} from "../dist/platform/auth/provider-revocation.js";
import { createAccountWallet } from "../dist/features/account-wallet/repository.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";
const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
async function boundedProviderBarrier(promise, message, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
describe(
  "provider ownership and financial isolation in PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, a, b;
    const identity = (subject = randomUUID(), sessionId = randomUUID()) => ({
      subject: `did:privy:${subject}`,
      sessionId,
      email: "unverified-provider@example.test",
      methods: ["email"],
      issuedAt: Math.floor(Date.now() / 1000),
      credentialsDigest: "a".repeat(64),
    });
    const exchange = (repo, id, token = randomUUID()) =>
      repo.exchange(
        id,
        hashSessionToken(token),
        new Date(Date.now() + 600_000),
      );
    const rejectedExchange = (code, status) => (error) => {
      assert.ok(error instanceof ProviderAccountError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    };
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
      a = new pg.Pool({ ...options, connectionString: runtimeUrl });
      b = new pg.Pool({ ...options, connectionString: runtimeUrl });
    });
    after(async () => {
      await Promise.all([owner?.end(), a?.end(), b?.end()]);
    });
    it("reopens a fence only after provider revocation and rejects pre-freeze tokens", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await endAllAccountSessions(a, made.user.id);
      // Like Privy, the fake reports the freeze time when the freeze happens.
      // The confirmation rejects a freeze earlier than its request's second.
      let frozenAt = null,
        cutoff;
      const calls = [];
      const control = {
        async state() {
          return { frozenAt };
        },
        async freeze() {
          calls.push("freeze");
          cutoff = Math.floor(Date.now() / 1000);
          frozenAt = cutoff;
        },
        async unfreeze() {
          calls.push("unfreeze");
          frozenAt = null;
        },
      };
      const service = createProviderRevocation(b, control);
      await service.synchronize(made.user.id);
      assert.deepEqual(calls, ["freeze", "unfreeze"]);
      await assert.rejects(
        exchange(repo, { ...id, sessionId: randomUUID(), issuedAt: cutoff }),
        rejectedExchange("provider_session_revoked", 401),
      );
      const fresh = await exchange(repo, {
        ...id,
        sessionId: randomUUID(),
        issuedAt: cutoff + 1,
      });
      assert.equal(fresh.user.id, made.user.id);
      await service.synchronize(made.user.id);
      assert.equal(calls.length, 2);
    });
    it("records a provider method change at sign-in without merging accounts or ending sessions", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      const changed = await exchange(repo, {
        ...id,
        sessionId: randomUUID(),
        methods: ["email", "google_oauth"],
        credentialsDigest: "b".repeat(64),
      });
      assert.equal(changed.user.id, made.user.id);
      assert.equal(changed.created, false);
      assert.equal(
        (
          await createSessionRepository(a).findUserByTokenHash(
            hashSessionToken(token),
          )
        ).id,
        made.user.id,
      );
      const mapping = (
        await owner.query(
          `SELECT credentials_digest AS digest,methods,checked_at IS NOT NULL AS checked,
          (SELECT count(*)::int FROM provider_session_exchanges e WHERE e.user_id=p.user_id) AS exchanges,
          (SELECT count(*)::int FROM identity_audit_events e WHERE e.user_id=p.user_id
            AND e.event_type='provider.credentials.changed' AND e.metadata->>'source'='exchange') AS audits,
          (SELECT count(*)::int FROM account_notifications n WHERE n.user_id=p.user_id
            AND n.event_type='account.signin_changed') AS notices
          FROM provider_identities p WHERE p.user_id=$1`,
          [made.user.id],
        )
      ).rows[0];
      assert.deepEqual(mapping, {
        digest: "b".repeat(64),
        methods: ["email", "google_oauth"],
        checked: true,
        exchanges: 2,
        audits: 1,
        notices: 1,
      });
    });
    it("reports pending, uncertain and unmatched session-reset fences without accepting an unchanged credential or consuming its SID", async () => {
      const id = identity(),
        repo = createProviderAccounts(a),
        token = randomUUID(),
        made = await exchange(repo, id, token);
      await endAllAccountSessions(a, made.user.id);
      const state = async () =>
        (
          await owner.query(
            `SELECT u.auth_generation::text AS generation,p.auth_generation::text AS mapped_generation,
              p.credentials_digest,p.minimum_issued_at::text,
              (SELECT count(*)::int FROM sessions WHERE user_id=u.id) AS sessions,
              (SELECT count(*)::int FROM provider_session_exchanges WHERE user_id=u.id) AS consumed
             FROM users u JOIN provider_identities p ON p.user_id=u.id WHERE u.id=$1`,
            [made.user.id],
          )
        ).rows[0];
      const before = await state();
      assert.notEqual(before.generation, before.mapped_generation);
      assert.equal(before.sessions, 0);
      assert.equal(before.consumed, 1);
      for (const [jobState, code, status] of [
        ["pending", "provider_reset_pending", 503],
        ["running", "provider_reset_pending", 503],
        ["manual", "provider_reset_review_required", 403],
        ["complete", "provider_access_review_required", 403],
      ]) {
        await owner.query(
          "UPDATE provider_revocation_jobs SET state=$2 WHERE user_id=$1",
          [made.user.id, jobState],
        );
        await assert.rejects(
          exchange(createProviderAccounts(b), {
            ...id,
            sessionId: randomUUID(),
            issuedAt: id.issuedAt + 3600,
          }),
          rejectedExchange(code, status),
        );
        assert.deepEqual(await state(), before);
      }
      // A job for another subject must not be mistaken for this mapping's reset.
      await owner.query(
        "UPDATE provider_revocation_jobs SET state='manual',subject=$2 WHERE user_id=$1",
        [made.user.id, `did:privy:${randomUUID()}`],
      );
      await assert.rejects(
        exchange(repo, { ...id, sessionId: randomUUID() }),
        rejectedExchange("provider_access_review_required", 403),
      );
      assert.deepEqual(await state(), before);
    });
    it("reads each owned grant separately and retains qualification after later losses", async () => {
      const user = (await exchange(createProviderAccounts(a), identity())).user;
      const lot = randomUUID(),
        other = randomUUID(),
        operating = randomUUID(),
        backing = randomUUID();
      await owner.query(
        "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'live','USDC','welcome',$1::text,25000000)",
        [lot, user.id],
      );
      await owner.query(
        "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'sandbox','USDC','daily',$1::text,5000000)",
        [other, user.id],
      );
      for (const [id, kind] of [
        [operating, "operating"],
        [backing, "backing"],
      ])
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,kind) VALUES($1,'live','USDC',$2)",
          [id, kind],
        );
      const c = await owner.connect();
      try {
        for (const net of [10000000, 15000000, -20000000]) {
          const journal = randomUUID();
          await c.query("BEGIN");
          await c.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'live','USDC',$1::text,'funding')",
            [journal],
          );
          await c.query(
            "INSERT INTO coin_postings VALUES($1,$2,'live','USDC',$4),($1,$3,'live','USDC',-$4)",
            [journal, operating, backing, net],
          );
          await c.query(
            "INSERT INTO coin_grant_profit_events(lot_id,journal_id,environment,asset,net_profit) VALUES($1,$2,'live','USDC',$3)",
            [lot, journal, net],
          );
          await c.query("COMMIT");
        }
        const view = await createAccountWallet(a).balances(user.id);
        assert.equal(view.grants.length, 1);
        assert.equal(view.grants[0].netProfit, "500");
        assert.equal(view.grants[0].qualified, true);
        assert.equal(view.grants[0].remaining, "0");
        assert.equal(view.grants[0].percent, 100);
        assert.equal(view.withdrawable, "0");
        const stranger = (await exchange(createProviderAccounts(b), identity()))
          .user;
        assert.deepEqual(
          (await createAccountWallet(b).balances(stranger.id)).grants,
          [],
        );
        await assert.rejects(
          a.query(
            "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'live','USDC','daily',$1::text,5000000)",
            [randomUUID(), user.id],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          owner.query("DELETE FROM coin_grant_lots WHERE id=$1", [lot]),
          { code: "23514" },
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
    it("keeps provider read outages fenced and retries without changing external state", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await endAllAccountSessions(a, made.user.id);
      let fail = true,
        frozenAt = null;
      const control = {
        async state() {
          if (fail) throw Error("outage");
          return { frozenAt };
        },
        async freeze() {
          frozenAt = Math.floor(Date.now() / 1000);
        },
        async unfreeze() {
          frozenAt = null;
        },
      };
      const service = createProviderRevocation(b, control);
      await service.synchronize(made.user.id);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state,control_phase,control_reads FROM provider_revocation_jobs WHERE user_id=$1",
            [made.user.id],
          )
        ).rows[0],
        { state: "pending", control_phase: "preflight", control_reads: 1 },
      );
      await assert.rejects(
        exchange(repo, { ...id, sessionId: randomUUID() }),
        rejectedExchange("provider_reset_pending", 503),
      );
      await service.synchronize(made.user.id);
      await owner.query(
        "UPDATE provider_revocation_jobs SET control_next_check_at='-infinity',control_lease_until='-infinity' WHERE user_id=$1",
        [made.user.id],
      );
      fail = false;
      await service.synchronize(made.user.id);
      assert.equal(
        (
          await owner.query(
            "SELECT state FROM provider_revocation_jobs WHERE user_id=$1",
            [made.user.id],
          )
        ).rows[0].state,
        "complete",
      );
    });
    it("keeps uncertain provider mutations and later generations fenced for manual reconciliation", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await endAllAccountSessions(a, made.user.id);
      let frozenAt = null,
        unfreezes = 0,
        freezes = 0;
      const control = {
        async state() {
          return { frozenAt };
        },
        async freeze() {
          freezes++;
          frozenAt = Math.floor(Date.now() / 1000);
          throw Error("uncertain response");
        },
        async unfreeze() {
          unfreezes++;
          frozenAt = null;
        },
      };
      await createProviderRevocation(b, control).synchronize(made.user.id);
      await owner.query(
        "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
        [made.user.id],
      );
      await createProviderRevocation(a, control).synchronize(made.user.id);
      assert.equal(freezes, 1);
      assert.equal(unfreezes, 0);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state,failure_reason FROM provider_revocation_jobs WHERE user_id=$1 ORDER BY generation",
            [made.user.id],
          )
        ).rows,
        [
          { state: "manual", failure_reason: "uncertain_provider_outcome" },
          { state: "manual", failure_reason: "inherited_manual" },
        ],
      );
      await assert.rejects(
        exchange(repo, { ...id, sessionId: randomUUID() }),
        rejectedExchange("provider_reset_review_required", 403),
      );
    });
    async function uncertainResetFixture() {
      const id = identity(),
        token = randomUUID(),
        made = await exchange(createProviderAccounts(a), id, token);
      await endAllAccountSessions(a, made.user.id);
      await owner.query(
        `UPDATE provider_revocation_jobs SET state='manual',attempts=1,
          failure_reason='uncertain_provider_outcome',lease_until='-infinity'
         WHERE user_id=$1`,
        [made.user.id],
      );
      return { id, made };
    }
    const stoppedRetry = (stage, status) => (error) => {
      assert.ok(error instanceof ProviderResetRetryError);
      assert.equal(error.stage, stage);
      assert.equal(error.providerStatus, status);
      assert.equal(error.message, `provider reset retry stopped at ${stage}`);
      return true;
    };
    async function delayedFreezeFixture() {
      const f = await uncertainResetFixture(),
        requestId = randomUUID(),
        frozenAt = Math.floor(Date.now() / 1000) - 45,
        activityReview = {
          evidenceDigest: "c".repeat(64),
          noIndependentFreeze: true,
        };
      await owner.query(
        "UPDATE provider_revocation_jobs SET attempts=2,lease_until=clock_timestamp()-interval '30 seconds' WHERE user_id=$1",
        [f.made.user.id],
      );
      await owner.query(
        `INSERT INTO identity_audit_events(user_id,event_type,subject_id,metadata,occurred_at)
        SELECT $1,'provider.reset.retry_requested',$1::bigint::text,$2::jsonb,clock_timestamp()-interval '60 seconds'`,
        [
          f.made.user.id,
          JSON.stringify({
            requestId,
            authGeneration: (
              await owner.query(
                "SELECT auth_generation::text AS generation FROM users WHERE id=$1",
                [f.made.user.id],
              )
            ).rows[0].generation,
            attempts: 2,
            credentialsDigest: f.id.credentialsDigest,
            providerSubjectDigest: createHash("sha256")
              .update(f.id.subject)
              .digest("hex"),
          }),
        ],
      );
      return { ...f, requestId, frozenAt, activityReview };
    }
    const reconciliationState = async (userId) =>
      (
        await owner.query(
          `SELECT j.state,j.attempts,j.confirmed_frozen_at::text AS confirmed,
      u.auth_generation<>p.auth_generation AS fenced,p.minimum_issued_at::text AS cutoff,
      (SELECT count(*)::int FROM identity_audit_events WHERE user_id=u.id AND event_type='provider.reset.reconciliation_requested') AS requested,
      (SELECT count(*)::int FROM identity_audit_events WHERE user_id=u.id AND event_type='provider.reset.reconciled') AS completed
      FROM users u JOIN provider_identities p ON p.user_id=u.id JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.generation=u.auth_generation WHERE u.id=$1`,
          [userId],
        )
      ).rows[0];
    it("reconciles only the exact owner-reviewed delayed freeze once, confirms unfreeze and preserves the old-token cutoff", async () => {
      const f = await delayedFreezeFixture();
      let reads = 0,
        unfreezes = 0,
        freezes = 0;
      const service = createProviderRevocation(
        owner,
        {
          async state() {
            reads++;
            return { frozenAt: unfreezes && reads >= 5 ? null : f.frozenAt };
          },
          async freeze() {
            freezes++;
          },
          async unfreeze() {
            unfreezes++;
          },
        },
        { operatorFrozenInspector: { inspect: async () => f.id } },
      );
      const input = {
        userId: f.made.user.id,
        requestId: f.requestId,
        activityReview: f.activityReview,
      };
      assert.deepEqual(await service.reconcileUncertain(input), {
        state: "complete",
      });
      assert.equal(unfreezes, 1);
      assert.equal(freezes, 0);
      assert.equal(reads, 5);
      assert.deepEqual(await reconciliationState(f.made.user.id), {
        state: "complete",
        attempts: 2,
        confirmed: String(f.frozenAt),
        fenced: false,
        cutoff: String(f.frozenAt + 1),
        requested: 1,
        completed: 1,
      });
      assert.deepEqual(await service.reconcileUncertain(input), {
        state: "complete",
      });
      assert.equal(unfreezes, 1);
      assert.equal(reads, 5);
      await assert.rejects(
        exchange(createProviderAccounts(a), {
          ...f.id,
          sessionId: randomUUID(),
          issuedAt: f.frozenAt,
        }),
        rejectedExchange("provider_session_revoked", 401),
      );
      await assert.rejects(
        service.reconcileUncertain({
          ...input,
          activityReview: {
            ...f.activityReview,
            evidenceDigest: "d".repeat(64),
          },
        }),
        stoppedRetry("snapshot"),
      );
    });
    it("rejects runtime, missing review, mismatched audit, changed provider and out-of-window freeze without unfreezing", async () => {
      for (const scenario of [
        "runtime",
        "no-review",
        "wrong-request",
        "changed-provider",
        "outside-window",
        "changed-freeze",
        "older-unresolved",
      ]) {
        const f = await delayedFreezeFixture();
        let unfreezes = 0,
          reads = 0,
          inspections = 0;
        if (scenario === "older-unresolved")
          await owner.query(
            "INSERT INTO provider_revocation_jobs(user_id,subject,generation,state) SELECT user_id,subject,generation-1,'manual' FROM provider_revocation_jobs WHERE user_id=$1",
            [f.made.user.id],
          );
        const before = await reconciliationState(f.made.user.id);
        const service = createProviderRevocation(
          scenario === "runtime" ? a : owner,
          {
            async state() {
              reads++;
              return {
                frozenAt:
                  scenario === "outside-window"
                    ? f.frozenAt - 120
                    : scenario === "changed-freeze" && reads > 1
                      ? f.frozenAt + 1
                      : f.frozenAt,
              };
            },
            async freeze() {
              throw Error("must not freeze");
            },
            async unfreeze() {
              unfreezes++;
            },
          },
          {
            operatorFrozenInspector: {
              async inspect() {
                inspections++;
                return scenario === "changed-provider"
                  ? { ...f.id, credentialsDigest: "d".repeat(64) }
                  : f.id;
              },
            },
          },
        );
        await assert.rejects(
          service.reconcileUncertain({
            userId: f.made.user.id,
            requestId:
              scenario === "wrong-request" ? randomUUID() : f.requestId,
            activityReview:
              scenario === "no-review"
                ? {
                    evidenceDigest: f.activityReview.evidenceDigest,
                    noIndependentFreeze: false,
                  }
                : f.activityReview,
          }),
          stoppedRetry(
            scenario === "runtime"
              ? "owner"
              : scenario === "no-review"
                ? "input"
                : scenario === "wrong-request"
                  ? "snapshot"
                  : scenario === "older-unresolved"
                    ? "claim"
                    : scenario === "changed-freeze"
                      ? "provider_state"
                      : "provider_inspection",
          ),
        );
        assert.equal(unfreezes, 0);
        assert.deepEqual(await reconciliationState(f.made.user.id), before);
        if (["runtime", "no-review", "wrong-request"].includes(scenario))
          assert.equal(inspections, 0);
      }
    });
    it("durably records the one unfreeze attempt and leaves generation fenced on an uncertain or unconfirmed result", async () => {
      for (const scenario of [
        "mutation-error",
        "confirmation-stale",
        "completion-sql-error",
      ]) {
        const f = await delayedFreezeFixture();
        let unfreezes = 0;
        const wrapped = {
          query: owner.query.bind(owner),
          async connect() {
            const client = await owner.connect();
            return {
              release: () => client.release(),
              async query(text, values) {
                if (
                  scenario === "completion-sql-error" &&
                  text.startsWith("INSERT INTO identity_audit_events") &&
                  text.includes("'provider.reset.reconciled'")
                )
                  throw Error("synthetic local completion fault");
                return client.query(text, values);
              },
            };
          },
        };
        const service = createProviderRevocation(
          wrapped,
          {
            state: async () => ({
              frozenAt:
                unfreezes && scenario === "completion-sql-error"
                  ? null
                  : f.frozenAt,
            }),
            async freeze() {
              throw Error("must not freeze");
            },
            async unfreeze() {
              unfreezes++;
              if (scenario === "mutation-error")
                throw Object.assign(Error("private response"), { status: 503 });
            },
          },
          { operatorFrozenInspector: { inspect: async () => f.id } },
        );
        const input = {
          userId: f.made.user.id,
          requestId: f.requestId,
          activityReview: f.activityReview,
        };
        await assert.rejects(
          service.reconcileUncertain(input),
          stoppedRetry(
            scenario === "mutation-error"
              ? "unfreeze"
              : scenario === "completion-sql-error"
                ? "commit"
                : "unfreeze_confirmation",
            scenario === "mutation-error" ? 503 : undefined,
          ),
        );
        assert.equal(unfreezes, 1);
        const after = await reconciliationState(f.made.user.id);
        assert.equal(after.fenced, true);
        assert.equal(after.state, "manual");
        assert.equal(after.requested, 1);
        assert.equal(after.completed, 0);
        assert.equal(after.confirmed, String(f.frozenAt));
        await assert.rejects(
          service.reconcileUncertain(input),
          stoppedRetry("snapshot"),
        );
        assert.equal(unfreezes, 1);
      }
    });
    it("polls only bounded GET confirmations while making each normal reset mutation once", async () => {
      const f = await uncertainResetFixture();
      let reads = 0,
        freezes = 0,
        unfreezes = 0;
      const frozenAt = Math.floor(Date.now() / 1000);
      const service = createProviderRevocation(
        owner,
        {
          async state() {
            reads++;
            return {
              frozenAt:
                reads < 5 ? null : unfreezes && reads >= 8 ? null : frozenAt,
            };
          },
          async freeze() {
            freezes++;
          },
          async unfreeze() {
            unfreezes++;
          },
        },
        { operatorInspector: { inspect: async () => f.id } },
      );
      assert.deepEqual(
        await service.retryUncertain({
          userId: f.made.user.id,
          requestId: randomUUID(),
        }),
        { state: "complete" },
      );
      assert.equal(freezes, 1);
      assert.equal(unfreezes, 1);
      assert.equal(reads, 8);
    });
    async function reviewedUnfreezeFixture() {
      const f = await delayedFreezeFixture();
      let frozenAt = f.frozenAt,
        mutations = 0;
      await assert.rejects(
        createProviderRevocation(
          owner,
          {
            state: async () => ({ frozenAt }),
            async freeze() {
              throw Error("must not freeze");
            },
            async unfreeze() {
              mutations++;
              frozenAt = null;
              throw Object.assign(Error("uncertain unfreeze response"), {
                status: 503,
              });
            },
          },
          { operatorFrozenInspector: { inspect: async () => f.id } },
        ).reconcileUncertain({
          userId: f.made.user.id,
          requestId: f.requestId,
          activityReview: f.activityReview,
        }),
        stoppedRetry("unfreeze", 503),
      );
      assert.equal(mutations, 1);
      return f;
    }
    it("finalizes an already reviewed and actually unfrozen reset through GET-only verification, with replay and old-token protection", async () => {
      const f = await reviewedUnfreezeFixture();
      let reads = 0,
        inspections = 0,
        mutations = 0;
      const service = createProviderRevocation(
        owner,
        {
          async state() {
            reads++;
            return { frozenAt: null };
          },
          async freeze() {
            mutations++;
            throw Error("forbidden mutation");
          },
          async unfreeze() {
            mutations++;
            throw Error("forbidden mutation");
          },
        },
        {
          operatorFrozenInspector: {
            async inspect() {
              inspections++;
              return f.id;
            },
          },
        },
      );
      const input = {
        userId: f.made.user.id,
        requestId: f.requestId,
        activityReview: f.activityReview,
      };
      assert.deepEqual(await service.finalizeReviewed(input), {
        state: "complete",
      });
      assert.deepEqual(await reconciliationState(f.made.user.id), {
        state: "complete",
        attempts: 2,
        confirmed: String(f.frozenAt),
        fenced: false,
        cutoff: String(f.frozenAt + 1),
        requested: 1,
        completed: 1,
      });
      assert.equal(reads, 2);
      assert.equal(inspections, 1);
      assert.equal(mutations, 0);
      assert.deepEqual(await service.finalizeReviewed(input), {
        state: "complete",
      });
      assert.equal(reads, 2);
      assert.equal(mutations, 0);
      await assert.rejects(
        exchange(createProviderAccounts(a), {
          ...f.id,
          issuedAt: f.frozenAt,
          sessionId: randomUUID(),
        }),
        rejectedExchange("provider_session_revoked", 401),
      );
    });
    it("refuses finalization for runtime, missing reviewed intent, changed terms, frozen provider or a concurrent generation without repeating mutations", async () => {
      for (const scenario of [
        "runtime",
        "no-intent",
        "wrong-review",
        "changed-provider",
        "frozen",
        "fresh-freeze",
        "generation",
      ]) {
        const f =
          scenario === "no-intent"
            ? await delayedFreezeFixture()
            : await reviewedUnfreezeFixture();
        let reads = 0,
          mutations = 0;
        const before = await reconciliationState(f.made.user.id);
        const service = createProviderRevocation(
          scenario === "runtime" ? a : owner,
          {
            async state() {
              reads++;
              return {
                frozenAt:
                  scenario === "frozen" ||
                  (scenario === "fresh-freeze" && reads > 1)
                    ? f.frozenAt + 1
                    : null,
              };
            },
            async freeze() {
              mutations++;
            },
            async unfreeze() {
              mutations++;
            },
          },
          {
            operatorFrozenInspector: {
              async inspect() {
                if (scenario === "generation")
                  await owner.query(
                    "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
                    [f.made.user.id],
                  );
                return scenario === "changed-provider"
                  ? { ...f.id, credentialsDigest: "b".repeat(64) }
                  : f.id;
              },
            },
          },
        );
        await assert.rejects(
          service.finalizeReviewed({
            userId: f.made.user.id,
            requestId: f.requestId,
            activityReview:
              scenario === "wrong-review"
                ? { ...f.activityReview, evidenceDigest: "d".repeat(64) }
                : f.activityReview,
          }),
          stoppedRetry(
            scenario === "runtime"
              ? "owner"
              : ["no-intent", "wrong-review"].includes(scenario)
                ? "snapshot"
                : scenario === "generation"
                  ? "claim"
                  : scenario === "fresh-freeze"
                    ? "provider_state"
                    : "provider_inspection",
          ),
        );
        assert.equal(mutations, 0);
        if (scenario !== "generation")
          assert.deepEqual(await reconciliationState(f.made.user.id), before);
        else
          assert.equal(
            (
              await owner.query(
                "SELECT u.auth_generation<>p.auth_generation AS fenced FROM users u JOIN provider_identities p ON p.user_id=u.id WHERE u.id=$1",
                [f.made.user.id],
              )
            ).rows[0].fenced,
            true,
          );
      }
    });
    it("rolls back finalization's provisional mapping and job updates if the completion audit fails", async () => {
      const f = await reviewedUnfreezeFixture(),
        before = await reconciliationState(f.made.user.id);
      let mutations = 0;
      const wrapped = {
        query: owner.query.bind(owner),
        async connect() {
          const client = await owner.connect();
          return {
            release: () => client.release(),
            async query(text, values) {
              if (
                text.startsWith("INSERT INTO identity_audit_events") &&
                text.includes("'provider.reset.reconciled'")
              )
                throw Error("synthetic final audit fault");
              return client.query(text, values);
            },
          };
        },
      };
      await assert.rejects(
        createProviderRevocation(
          wrapped,
          {
            state: async () => ({ frozenAt: null }),
            async freeze() {
              mutations++;
            },
            async unfreeze() {
              mutations++;
            },
          },
          { operatorFrozenInspector: { inspect: async () => f.id } },
        ).finalizeReviewed({
          userId: f.made.user.id,
          requestId: f.requestId,
          activityReview: f.activityReview,
        }),
        stoppedRetry("commit"),
      );
      assert.equal(mutations, 0);
      assert.deepEqual(await reconciliationState(f.made.user.id), before);
    });
    it("atomically claims one owner-reviewed uncertain reset, excludes a competing worker and makes only the same completed retry idempotent", async () => {
      const f = await uncertainResetFixture(),
        entered = Promise.withResolvers(),
        release = Promise.withResolvers(),
        requestId = randomUUID();
      let frozenAt = null,
        cutoff,
        reads = 0,
        mutations = 0,
        inspections = 0,
        competitorCalls = 0;
      const control = {
        async state() {
          reads++;
          if (reads === 2) {
            entered.resolve();
            await release.promise;
          }
          return { frozenAt };
        },
        async freeze() {
          mutations++;
          cutoff = Math.floor(Date.now() / 1000);
          frozenAt = cutoff;
        },
        async unfreeze() {
          mutations++;
          frozenAt = null;
        },
      };
      const service = createProviderRevocation(owner, control, {
        operatorInspector: {
          async inspect() {
            inspections++;
            return f.id;
          },
        },
      });
      const retry = service.retryUncertain({
        userId: f.made.user.id,
        requestId,
      });
      try {
        await boundedProviderBarrier(
          entered.promise,
          "owner retry did not reach provider GET",
        );
        const claimed = (
          await owner.query(
            `SELECT state,attempts,lease_until>clock_timestamp() AS live
             FROM provider_revocation_jobs WHERE user_id=$1`,
            [f.made.user.id],
          )
        ).rows[0];
        assert.deepEqual(claimed, {
          state: "running",
          attempts: 2,
          live: true,
        });
        await boundedProviderBarrier(
          createProviderRevocation(b, {
            async state() {
              competitorCalls++;
              return { frozenAt: null };
            },
            async freeze() {
              competitorCalls++;
            },
            async unfreeze() {
              competitorCalls++;
            },
          }).synchronize(f.made.user.id),
          "normal worker waited on owner account lock",
          1500,
        );
        assert.equal(competitorCalls, 0);
      } finally {
        release.resolve();
        await retry;
      }
      assert.deepEqual(await retry, { state: "complete" });
      assert.equal(mutations, 2);
      assert.equal(reads, 4);
      assert.equal(inspections, 1);
      const done = (
        await owner.query(
          `SELECT u.auth_generation=p.auth_generation AS synchronized,j.state,j.attempts,
           p.minimum_issued_at::text AS cutoff,
           (SELECT count(*)::int FROM sessions WHERE user_id=u.id) AS sessions,
           (SELECT count(*)::int FROM identity_audit_events WHERE user_id=u.id
             AND event_type='provider.reset.retry_requested' AND metadata->>'requestId'=$2) AS audits
           FROM users u JOIN provider_identities p ON p.user_id=u.id
           JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.generation=u.auth_generation WHERE u.id=$1`,
          [f.made.user.id, requestId],
        )
      ).rows[0];
      assert.deepEqual(done, {
        synchronized: true,
        state: "complete",
        attempts: 2,
        cutoff: String(cutoff + 1),
        sessions: 0,
        audits: 1,
      });
      await assert.rejects(
        exchange(createProviderAccounts(a), {
          ...f.id,
          sessionId: randomUUID(),
          issuedAt: cutoff,
        }),
        rejectedExchange("provider_session_revoked", 401),
      );
      assert.deepEqual(
        await service.retryUncertain({ userId: f.made.user.id, requestId }),
        { state: "complete" },
      );
      assert.equal(mutations, 2);
      assert.equal(reads, 4);
      assert.equal(inspections, 1);
      await assert.rejects(
        service.retryUncertain({
          userId: f.made.user.id,
          requestId: randomUUID(),
        }),
        stoppedRetry("snapshot"),
      );
      const newToken = randomUUID();
      await exchange(
        createProviderAccounts(a),
        {
          ...f.id,
          sessionId: randomUUID(),
          issuedAt: cutoff + 1,
        },
        newToken,
      );
      await endAllAccountSessions(a, f.made.user.id);
      await assert.rejects(
        service.retryUncertain({ userId: f.made.user.id, requestId }),
        stoppedRetry("snapshot"),
      );
      assert.equal(mutations, 2);
    });
    it("denies runtime authority and unsafe operator reset evidence before claiming or changing a fence", async () => {
      for (const scenario of [
        "runtime",
        "missing-inspector",
        "changed-provider",
        "frozen-provider",
        "outage",
        "confirmed-freeze",
        "older-unresolved",
      ]) {
        const f = await uncertainResetFixture();
        let mutations = 0,
          inspections = 0;
        if (scenario === "confirmed-freeze")
          await owner.query(
            "UPDATE provider_revocation_jobs SET confirmed_frozen_at=12345 WHERE user_id=$1",
            [f.made.user.id],
          );
        if (scenario === "older-unresolved")
          await owner.query(
            `INSERT INTO provider_revocation_jobs(user_id,subject,generation,state)
             SELECT user_id,subject,generation-1,'pending' FROM provider_revocation_jobs WHERE user_id=$1`,
            [f.made.user.id],
          );
        const snapshot = async () =>
          (
            await owner.query(
              `SELECT u.auth_generation::text,p.auth_generation::text AS mapped_generation,
           j.state,j.attempts,j.confirmed_frozen_at::text
           FROM users u JOIN provider_identities p ON p.user_id=u.id
           JOIN provider_revocation_jobs j ON j.user_id=u.id AND j.generation=u.auth_generation WHERE u.id=$1`,
              [f.made.user.id],
            )
          ).rows[0];
        const before = await snapshot();
        const service = createProviderRevocation(
          scenario === "runtime" ? a : owner,
          {
            async state() {
              return {
                frozenAt: scenario === "frozen-provider" ? 12345 : null,
              };
            },
            async freeze() {
              mutations++;
            },
            async unfreeze() {
              mutations++;
            },
          },
          scenario === "missing-inspector"
            ? {}
            : {
                operatorInspector: {
                  async inspect() {
                    inspections++;
                    if (scenario === "outage")
                      throw Object.assign(
                        new Error("private provider failure"),
                        { status: 503 },
                      );
                    return scenario === "changed-provider"
                      ? { ...f.id, credentialsDigest: "b".repeat(64) }
                      : f.id;
                  },
                },
              },
        );
        const stage =
          scenario === "runtime"
            ? "owner"
            : scenario === "missing-inspector"
              ? "input"
              : scenario === "confirmed-freeze"
                ? "snapshot"
                : scenario === "older-unresolved"
                  ? "claim"
                  : "provider_inspection";
        await assert.rejects(
          service.retryUncertain({
            userId: f.made.user.id,
            requestId: randomUUID(),
          }),
          stoppedRetry(stage, scenario === "outage" ? 503 : undefined),
        );
        assert.deepEqual(await snapshot(), before);
        assert.equal(mutations, 0);
        if (
          ["runtime", "missing-inspector", "confirmed-freeze"].includes(
            scenario,
          )
        )
          assert.equal(inspections, 0);
        assert.equal(
          (
            await owner.query(
              "SELECT count(*)::int n FROM identity_audit_events WHERE user_id=$1 AND event_type='provider.reset.retry_requested'",
              [f.made.user.id],
            )
          ).rows[0].n,
          0,
        );
      }
    });
    it("releases its only owner connection during inspection and rejects a generation change before claiming", async () => {
      const f = await uncertainResetFixture(),
        single = new pg.Pool({
          connectionString: ownerUrl,
          max: 1,
          options: "-c search_path=pg_catalog,yaparena,pg_temp",
        }),
        entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      let mutations = 0;
      const retry = createProviderRevocation(
        single,
        {
          state: async () => ({ frozenAt: null }),
          async freeze() {
            mutations++;
          },
          async unfreeze() {
            mutations++;
          },
        },
        {
          operatorInspector: {
            async inspect() {
              entered.resolve();
              await release.promise;
              return f.id;
            },
          },
        },
      ).retryUncertain({ userId: f.made.user.id, requestId: randomUUID() });
      const rejected = assert.rejects(retry, stoppedRetry("claim"));
      try {
        await entered.promise;
        await Promise.race([
          single.query(
            "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
            [f.made.user.id],
          ),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () =>
                reject(new Error("inspection held owner pool or account lock")),
              2000,
            );
            timer.unref();
          }),
        ]);
      } finally {
        release.resolve();
        await rejected;
        await single.end();
      }
      assert.equal(mutations, 0);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM identity_audit_events WHERE user_id=$1 AND event_type='provider.reset.retry_requested'",
            [f.made.user.id],
          )
        ).rows[0].n,
        0,
      );
    });
    it("retains the manual fence and reports only bounded stage/status when an owner retry has an uncertain provider mutation", async () => {
      const f = await uncertainResetFixture(),
        requestId = randomUUID();
      let freezes = 0,
        unfreezes = 0;
      const service = createProviderRevocation(
        owner,
        {
          state: async () => ({ frozenAt: null }),
          async freeze() {
            freezes++;
            throw Object.assign(
              new Error("private provider transport details"),
              { status: 400 },
            );
          },
          async unfreeze() {
            unfreezes++;
          },
        },
        { operatorInspector: { inspect: async () => f.id } },
      );
      await assert.rejects(
        service.retryUncertain({ userId: f.made.user.id, requestId }),
        stoppedRetry("freeze", 400),
      );
      assert.equal(freezes, 1);
      assert.equal(unfreezes, 0);
      assert.deepEqual(
        (
          await owner.query(
            `SELECT j.state,j.attempts,j.failure_reason,u.auth_generation<>p.auth_generation AS fenced
         FROM provider_revocation_jobs j JOIN users u ON u.id=j.user_id
         JOIN provider_identities p ON p.user_id=u.id WHERE u.id=$1 AND j.generation=u.auth_generation`,
            [f.made.user.id],
          )
        ).rows[0],
        {
          state: "manual",
          attempts: 2,
          failure_reason: "uncertain_provider_outcome",
          fenced: true,
        },
      );
      await assert.rejects(
        service.retryUncertain({ userId: f.made.user.id, requestId }),
        stoppedRetry("snapshot"),
      );
      assert.equal(freezes, 1);
      assert.equal(unfreezes, 0);
    });
    it("keeps an owner retry manual after its post-claim provider read fails so an older worker cannot take over", async () => {
      const f = await uncertainResetFixture();
      let reads = 0,
        mutations = 0;
      const control = {
        async state() {
          reads++;
          if (reads === 2)
            throw Object.assign(new Error("private provider read failure"), {
              status: 503,
            });
          return { frozenAt: null };
        },
        async freeze() {
          mutations++;
        },
        async unfreeze() {
          mutations++;
        },
      };
      await assert.rejects(
        createProviderRevocation(owner, control, {
          operatorInspector: { inspect: async () => f.id },
        }).retryUncertain({ userId: f.made.user.id, requestId: randomUUID() }),
        stoppedRetry("provider_state", 503),
      );
      await owner.query(
        "UPDATE provider_revocation_jobs SET lease_until='-infinity' WHERE user_id=$1",
        [f.made.user.id],
      );
      await createProviderRevocation(b, control).synchronize(f.made.user.id);
      assert.equal(reads, 2);
      assert.equal(mutations, 0);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state,attempts FROM provider_revocation_jobs WHERE user_id=$1",
            [f.made.user.id],
          )
        ).rows[0],
        { state: "manual", attempts: 2 },
      );
    });
    it("rejects an expired operator claim before external mutation and does not let a worker reuse it", async () => {
      const f = await uncertainResetFixture();
      let intercepted = false,
        mutations = 0;
      const wrapped = {
        query: owner.query.bind(owner),
        async connect() {
          const client = await owner.connect();
          return {
            async query(text, values) {
              const result = await client.query(text, values);
              if (text === "COMMIT" && !intercepted) {
                intercepted = true;
                await owner.query(
                  "UPDATE provider_revocation_jobs SET lease_until='-infinity' WHERE user_id=$1",
                  [f.made.user.id],
                );
                await createProviderRevocation(b, {
                  state: async () => {
                    mutations++;
                    return { frozenAt: null };
                  },
                  async freeze() {
                    mutations++;
                  },
                  async unfreeze() {
                    mutations++;
                  },
                }).synchronize(f.made.user.id);
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      };
      await assert.rejects(
        createProviderRevocation(
          wrapped,
          {
            state: async () => ({ frozenAt: null }),
            async freeze() {
              mutations++;
            },
            async unfreeze() {
              mutations++;
            },
          },
          { operatorInspector: { inspect: async () => f.id } },
        ).retryUncertain({ userId: f.made.user.id, requestId: randomUUID() }),
        stoppedRetry("result"),
      );
      assert.equal(intercepted, true);
      assert.equal(mutations, 0);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state,attempts FROM provider_revocation_jobs WHERE user_id=$1",
            [f.made.user.id],
          )
        ).rows[0],
        { state: "manual", attempts: 2 },
      );
    });
    it("does not freeze a superseded generation between claiming and provider control", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await endAllAccountSessions(a, made.user.id);
      let commits = 0,
        freezes = 0,
        frozenAt = null;
      const database = {
        query: (...args) => b.query(...args),
        async connect() {
          const client = await b.connect();
          return {
            async query(sql, values) {
              const result = await client.query(sql, values);
              if (sql === "COMMIT" && ++commits === 1)
                await owner.query(
                  "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
                  [made.user.id],
                );
              return result;
            },
            release: () => client.release(),
          };
        },
      };
      const control = {
        async state() {
          return { frozenAt };
        },
        async freeze() {
          freezes++;
          frozenAt = Math.floor(Date.now() / 1000);
        },
        async unfreeze() {
          frozenAt = null;
        },
      };
      await createProviderRevocation(database, control).synchronize(
        made.user.id,
      );
      assert.equal(freezes, 0);
      await createProviderRevocation(b, control).synchronize(made.user.id);
      assert.equal(freezes, 1);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state FROM provider_revocation_jobs WHERE user_id=$1 ORDER BY generation",
            [made.user.id],
          )
        ).rows.map((row) => row.state),
        ["complete", "complete"],
      );
    });
    it("orders a new generation after in-flight provider control across application pools", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await endAllAccountSessions(a, made.user.id);
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      let frozenAt = null,
        freezes = 0;
      const control = {
        async state() {
          return { frozenAt };
        },
        async freeze() {
          freezes++;
          frozenAt = Math.floor(Date.now() / 1000);
          entered.resolve();
          await release.promise;
        },
        async unfreeze() {
          frozenAt = null;
        },
      };
      const c = await owner.connect();
      const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const processing = createProviderRevocation(b, control).synchronize(
        made.user.id,
      );
      let revoking;
      try {
        await entered.promise;
        revoking = c.query(
          "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
          [made.user.id],
        );
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          const state = await owner.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
            [pid],
          );
          if (state.rowCount) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          blocked,
          true,
          "revocation waits for provider control's account lock",
        );
      } finally {
        release.resolve();
        await processing;
        await revoking;
        c.release();
      }
      assert.ok(Number.isSafeInteger(frozenAt));
      await createProviderRevocation(a, control).synchronize(made.user.id);
      assert.equal(
        freezes,
        1,
        "a superseding generation cannot repeat the acknowledged freeze",
      );
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state FROM provider_revocation_jobs WHERE user_id=$1 ORDER BY generation",
            [made.user.id],
          )
        ).rows.map((row) => row.state),
        ["manual", "manual"],
      );
    });
    it("never unfreezes suspended accounts or independent provider freezes", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await owner.query(
        "UPDATE users SET account_status='suspended' WHERE id=$1",
        [made.user.id],
      );
      let unfreezes = 0,
        frozenAt = null;
      const control = {
        async state() {
          return { frozenAt };
        },
        async freeze() {
          frozenAt = Math.floor(Date.now() / 1000);
        },
        async unfreeze() {
          unfreezes++;
        },
      };
      await createProviderRevocation(b, control).synchronize(made.user.id);
      assert.equal(unfreezes, 0);
      assert.deepEqual(
        (
          await owner.query(
            "SELECT state,control_phase,confirmed_frozen_at FROM provider_revocation_jobs WHERE user_id=$1",
            [made.user.id],
          )
        ).rows[0],
        {
          state: "complete",
          control_phase: "done",
          confirmed_frozen_at: String(frozenAt),
        },
      );
      const other = await exchange(repo, identity(), randomUUID());
      await owner.query(
        "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
        [other.user.id],
      );
      await createProviderRevocation(b, control).synchronize(other.user.id);
      assert.equal(
        (
          await owner.query(
            "SELECT state FROM provider_revocation_jobs WHERE user_id=$1",
            [other.user.id],
          )
        ).rows[0].state,
        "manual",
      );
      assert.equal(unfreezes, 0);
    });
    it("provisions once under simultaneous callbacks without merging accounts by provider email", async () => {
      // Every fixture identity reports the same unverified email address.
      const existing = (await exchange(createProviderAccounts(a), identity()))
        .user;
      const id = identity();
      const results = await Promise.allSettled([
        exchange(createProviderAccounts(a), id),
        exchange(createProviderAccounts(b), id),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      const made = results.find((r) => r.status === "fulfilled").value;
      assert.notEqual(made.user.id, existing.id);
      assert.equal(made.created, true);
      assert.equal(made.user.email, null);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM provider_identities WHERE subject=$1",
            [id.subject],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await createProviderAccounts(a).details(made.user.id)).email,
        id.email,
      );
      assert.equal(
        await createProviderAccounts(a).details("9223372036854775807"),
        null,
      );
      const again = await exchange(createProviderAccounts(b), {
        ...id,
        sessionId: randomUUID(),
      });
      assert.equal(again.user.id, made.user.id);
      assert.equal(again.created, false);
    });
    it("rejects a consumed sid after current logout and any old/unknown provider sid after account-wide revocation", async () => {
      const id = identity(),
        repo = createProviderAccounts(a),
        token = randomUUID();
      const made = await exchange(repo, id, token),
        sessions = createSessionRepository(a);
      assert.ok(await sessions.findUserByTokenHash(hashSessionToken(token)));
      await sessions.deleteByTokenHash(hashSessionToken(token));
      await assert.rejects(
        exchange(createProviderAccounts(b), id),
        rejectedExchange("provider_session_revoked", 401),
      );
      const next = randomUUID();
      await exchange(repo, { ...id, sessionId: randomUUID() }, next);
      assert.ok(await sessions.findUserByTokenHash(hashSessionToken(next)));
      await endAllAccountSessions(a, made.user.id);
      await assert.rejects(
        exchange(createProviderAccounts(b), { ...id, sessionId: randomUUID() }),
        rejectedExchange("provider_reset_pending", 503),
      );
      assert.equal(
        await sessions.findUserByTokenHash(hashSessionToken(next)),
        null,
      );
    });
    it("enforces suspension across application pools and retains deleted-identity fences", async () => {
      const id = identity(),
        repo = createProviderAccounts(a),
        token = randomUUID();
      const made = await exchange(repo, id, token);
      await owner.query(
        "UPDATE users SET account_status='suspended' WHERE id=$1",
        [made.user.id],
      );
      assert.equal(
        await createSessionRepository(b).findUserByTokenHash(
          hashSessionToken(token),
        ),
        null,
      );
      await assert.rejects(
        exchange(createProviderAccounts(b), { ...id, sessionId: randomUUID() }),
      );
      await owner.query("DELETE FROM users WHERE id=$1", [made.user.id]);
      await assert.rejects(
        exchange(createProviderAccounts(b), { ...id, sessionId: randomUUID() }),
        rejectedExchange("provider_identity_retired", 403),
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM provider_session_exchanges WHERE subject=$1",
            [id.subject],
          )
        ).rows[0].n,
        1,
      );
    });
    it("enforces balanced immutable journals, exact projections and environment isolation", async () => {
      const user = (await exchange(createProviderAccounts(a), identity())).user;
      const credit = randomUUID(),
        backing = randomUUID(),
        live = randomUUID();
      for (const [id, kind, environment, userId] of [
        [credit, "available", "sandbox", user.id],
        [backing, "backing", "sandbox", null],
        [live, "available", "live", user.id],
      ])
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,user_id,kind) VALUES($1,$2,'USDC',$3,$4)",
          [id, environment, userId, kind],
        );
      const journal = randomUUID();
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'sandbox','USDC',$1::text,'funding')",
          [journal],
        );
        await c.query(
          "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',1000000),($1,$3,'sandbox','USDC',-1000000)",
          [journal, credit, backing],
        );
        await c.query("COMMIT");
        assert.equal(
          (
            await owner.query(
              "SELECT balance::text n FROM coin_accounts WHERE id=$1",
              [credit],
            )
          ).rows[0].n,
          "1000000",
        );
        for (const sql of [
          "DELETE FROM coin_journals WHERE id=$1",
          "UPDATE coin_journals SET reference='changed' WHERE id=$1",
          "DELETE FROM coin_postings WHERE journal_id=$1",
        ])
          await assert.rejects(owner.query(sql, [journal]), { code: "23514" });
        await assert.rejects(
          owner.query("UPDATE coin_accounts SET balance=2000000 WHERE id=$1", [
            credit,
          ]),
          { code: "23514" },
        );
        const lateAccount = randomUUID();
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,user_id,kind) VALUES($1,'sandbox','USDC',$2,'reserved')",
          [lateAccount, user.id],
        );
        await assert.rejects(
          owner.query(
            "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',1)",
            [journal, lateAccount],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          a.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'live','USDC',$1::text,'funding')",
            [randomUUID()],
          ),
          { code: "42501" },
        );
        for (const account of [credit, live]) {
          await c.query("BEGIN");
          const j = randomUUID();
          await c.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'sandbox','USDC',$1::text,'funding')",
            [j],
          );
          await assert.rejects(async () => {
            await c.query(
              "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',1)",
              [j, account],
            );
            await c.query("COMMIT");
          });
          await c.query("ROLLBACK");
        }
        for (const amount of [999999, 1000000]) {
          await c.query("BEGIN");
          const reversal = randomUUID();
          await c.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation,reversal_of) VALUES($1::uuid,'sandbox','USDC',$1::text,'reversal',$2)",
            [reversal, journal],
          );
          await c.query(
            "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',$4),($1,$3,'sandbox','USDC',-$4)",
            [reversal, backing, credit, amount],
          );
          if (amount === 999999) {
            await assert.rejects(c.query("COMMIT"), { code: "23514" });
            await c.query("ROLLBACK");
          } else await c.query("COMMIT");
        }
        assert.equal(
          (
            await owner.query(
              "SELECT balance::text n FROM coin_accounts WHERE id=$1",
              [credit],
            )
          ).rows[0].n,
          "0",
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  },
);
