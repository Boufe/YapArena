import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createProviderRevocation } from "../dist/platform/auth/provider-revocation.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createProviderRecheck } from "../dist/platform/auth/provider-recheck.js";
import { ProviderCredentialChangedError } from "../dist/platform/auth/privy.js";
import { createProviderPasskeys } from "../dist/platform/auth/provider-passkeys.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import { createEmbeddedWalletProvisioning } from "../dist/platform/auth/embedded-wallet-provisioning.js";
import { providerPasskeyFixture } from "./provider-passkey-fixture.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";
const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
async function bounded(promise, message, milliseconds = 5000) {
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
  "durable provider control acknowledgement phases in isolated PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, a, b;
    before(() => {
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
    async function fixture() {
      const token = randomUUID(),
        tokenHash = hashSessionToken(token),
        identity = {
          subject: `did:privy:${randomUUID()}`,
          sessionId: randomUUID(),
          email: "synthetic-phase@example.test",
          methods: ["email"],
          credentialsDigest: "a".repeat(64),
          issuedAt: Math.floor(Date.now() / 1000),
        };
      const made = await createProviderAccounts(a).exchange(
        identity,
        tokenHash,
        new Date(Date.now() + 600000),
      );
      // Advance the generation so a provider reset is queued, then keep one
      // current session at the new generation.
      const authGeneration = await endAllAccountSessions(a, made.user.id);
      await createSessionRepository(a).create(
        made.user.id,
        tokenHash,
        new Date(Date.now() + 600000),
        { authGeneration },
      );
      return { userId: made.user.id, tokenHash, identity };
    }
    async function job(f) {
      return (
        await owner.query(
          `SELECT j.*,p.auth_generation AS mapped_generation,u.auth_generation AS current_generation,
      p.minimum_issued_at FROM provider_revocation_jobs j JOIN users u ON u.id=j.user_id
      JOIN provider_identities p ON p.user_id=u.id WHERE j.user_id=$1 ORDER BY j.generation DESC LIMIT 1`,
          [f.userId],
        )
      ).rows[0];
    }
    async function due(f) {
      await owner.query(
        "UPDATE provider_revocation_jobs SET control_next_check_at='-infinity',control_lease_until='-infinity' WHERE user_id=$1",
        [f.userId],
      );
    }
    function immediate() {
      let frozenAt = null;
      const calls = [];
      return {
        calls,
        async state() {
          calls.push("get");
          return { frozenAt };
        },
        async freeze() {
          calls.push("freeze");
          frozenAt = Math.floor(Date.now() / 1000);
        },
        async unfreeze() {
          calls.push("unfreeze");
          frozenAt = null;
        },
      };
    }
    it("rearms a parked wallet only after real accepted-passkey activation and confirmed reset, preserving ownership and retry budget", async () => {
      const origin = "http://localhost:53024";
      const tokenHash = hashSessionToken(randomUUID());
      const credentials = [
        { type: "email", id: `${randomUUID()}@example.invalid` },
      ];
      let identity = {
        subject: `did:privy:${randomUUID()}`,
        sessionId: randomUUID(),
        email: credentials[0].id,
        methods: ["email"],
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        issuedAt: Math.floor(Date.now() / 1000),
      };
      const { user } = await createProviderAccounts(a).exchange(
        identity,
        tokenHash,
        new Date(Date.now() + 600000),
      );
      const verifier = {
        verify: async () => structuredClone(identity),
        inspect: async () => structuredClone(identity),
      };
      const passkeys = createProviderPasskeys(a, verifier);
      const input = { userId: user.id, sessionTokenHash: tokenHash, origin };
      const intent = await passkeys.begin(input);
      const key = providerPasskeyFixture(origin);
      identity = {
        ...identity,
        credentials: [
          ...credentials,
          { type: "passkey", id: key.credentialId },
        ],
        methods: ["email", "passkey"],
        passkeys: [key.evidence],
      };
      identity.credentialsDigest = providerCredentialsDigest(
        identity.credentials,
      );
      let wallet = null,
        creates = 0,
        inspections = 0;
      const adapter = {
        async inspect({ subject }) {
          assert.equal(subject, identity.subject);
          inspections++;
          return { credentialsDigest: identity.credentialsDigest, wallet };
        },
        async create({ subject }) {
          assert.equal(subject, identity.subject);
          creates++;
          wallet = {
            id: `wallet-${randomUUID()}`,
            address: "0x1234567890123456789012345678901234567890",
          };
        },
      };
      const wallets = createEmbeddedWalletProvisioning(a, adapter);
      const walletRow = async () =>
        (
          await owner.query(
            "SELECT * FROM embedded_wallet_provisioning WHERE user_id=$1",
            [user.id],
          )
        ).rows[0];
      await wallets.process(1, user.id);
      const parked = await walletRow();
      assert.equal(parked.state, "retry_wait");
      assert.equal(parked.last_failure, "account_verification");
      assert.equal(parked.attempts, 0);
      assert.equal(creates, 0);
      const challenge = await passkeys.activationOptions({
        ...input,
        id: intent.id,
        token: "synthetic-provider-token",
      });
      await passkeys.complete({
        ...input,
        id: intent.id,
        token: "synthetic-provider-token",
        sessionDurationMs: 600000,
        authentication: key.authentication(challenge.authenticationOptions),
      });
      const beforeReset = await job({ userId: user.id });
      assert.notEqual(
        beforeReset.mapped_generation,
        beforeReset.current_generation,
      );
      assert.equal((await wallets.process(1, user.id)).processed, 0);
      assert.equal(inspections, 1);
      assert.equal(creates, 0);
      const control = immediate();
      await createProviderRevocation(a, control).synchronize(user.id);
      const synchronized = await job({ userId: user.id });
      assert.equal(synchronized.state, "complete");
      assert.equal(synchronized.control_phase, "done");
      assert.equal(
        synchronized.mapped_generation,
        synchronized.current_generation,
      );
      const rearmed = await walletRow();
      assert.equal(rearmed.state, "pending");
      assert.equal(rearmed.last_failure, null);
      for (const name of [
        "user_id",
        "subject",
        "external_id",
        "attempt_key",
        "attempts",
      ])
        assert.equal(rearmed[name], parked[name], name);
      assert.equal(rearmed.subject, identity.subject);
      await Promise.all([
        wallets.process(1, user.id),
        createEmbeddedWalletProvisioning(b, adapter).process(1, user.id),
      ]);
      assert.equal(creates, 1);
      const ready = await walletRow();
      assert.equal(ready.state, "ready");
      assert.equal(ready.wallet_id, wallet.id);
      assert.equal(ready.external_id, parked.external_id);
      assert.equal(ready.attempts, 1);
      await createProviderRevocation(b, control).synchronize(user.id);
      assert.equal((await walletRow()).state, "ready");
      assert.equal(creates, 1);
    });
    it("resumes acknowledged freeze and unfreeze GET lag across restarts and instances without repeating either mutation", async () => {
      const f = await fixture();
      let frozenAt = null,
        froze = false,
        unfroze = false,
        freezeVisible = false,
        unfreezeVisible = false;
      const calls = [];
      const control = {
        async state() {
          calls.push("get");
          return {
            frozenAt:
              !froze || !freezeVisible || (unfroze && unfreezeVisible)
                ? null
                : frozenAt,
          };
        },
        async freeze() {
          calls.push("freeze");
          froze = true;
          frozenAt = Math.floor(Date.now() / 1000);
        },
        async unfreeze() {
          calls.push("unfreeze");
          unfroze = true;
        },
      };
      await createProviderRevocation(a, control).synchronize(f.userId);
      let current = await job(f);
      assert.equal(current.control_phase, "freeze_confirm");
      assert.equal(current.state, "pending");
      assert.ok(current.freeze_acknowledged_at);
      assert.equal(current.confirmed_frozen_at, null);
      assert.notEqual(current.mapped_generation, current.current_generation);
      // The app's own reset is in progress: the re-check takes no action.
      assert.equal(
        await createProviderRecheck(
          a,
          { inspect: async () => f.identity },
          { staleAfterMs: 0 },
        ).run(f.userId),
        "deferred",
      );
      const priorReads = calls.length;
      await createProviderRevocation(b, control).synchronize(f.userId);
      assert.equal(calls.length, priorReads, "not-yet-due phase does not poll");
      freezeVisible = true;
      await due(f);
      await Promise.all([
        createProviderRevocation(a, control).synchronize(f.userId),
        createProviderRevocation(b, control).synchronize(f.userId),
      ]);
      current = await job(f);
      assert.equal(current.control_phase, "unfreeze_confirm");
      assert.equal(current.state, "pending");
      assert.ok(current.unfreeze_acknowledged_at);
      assert.equal(current.confirmed_frozen_at, String(frozenAt));
      assert.notEqual(current.mapped_generation, current.current_generation);
      unfreezeVisible = true;
      await due(f);
      await createProviderRevocation(b, control).synchronize(f.userId);
      current = await job(f);
      assert.equal(current.state, "complete");
      assert.equal(current.control_phase, "done");
      assert.equal(current.mapped_generation, current.current_generation);
      assert.equal(current.minimum_issued_at, String(frozenAt + 1));
      assert.equal(calls.filter((v) => v === "freeze").length, 1);
      assert.equal(calls.filter((v) => v === "unfreeze").length, 1);
      assert.equal(
        await createProviderRecheck(
          a,
          { inspect: async () => f.identity },
          { staleAfterMs: 0 },
        ).run(f.userId),
        "unchanged",
      );
      await assert.rejects(
        createProviderAccounts(a).exchange(
          { ...f.identity, sessionId: randomUUID(), issuedAt: frozenAt },
          hashSessionToken(randomUUID()),
          new Date(Date.now() + 600000),
        ),
        (e) => e.code === "provider_session_revoked",
      );
    });
    it("bounds lagging confirmations by eight reads or a phase deadline and never retries their mutation", async () => {
      for (const expire of [false, true]) {
        const f = await fixture();
        let freezes = 0,
          gets = 0;
        const control = {
          async state() {
            gets++;
            return { frozenAt: null };
          },
          async freeze() {
            freezes++;
          },
          async unfreeze() {
            assert.fail("unconfirmed freeze cannot be undone");
          },
        };
        const service = createProviderRevocation(a, control);
        await service.synchronize(f.userId);
        if (expire)
          await owner.query(
            "UPDATE provider_revocation_jobs SET control_deadline_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
            [f.userId],
          );
        for (let i = 0; i < 9; i++) {
          await due(f);
          await service.synchronize(f.userId);
        }
        const current = await job(f);
        assert.equal(current.state, "manual");
        assert.equal(current.failure_reason, "uncertain_provider_outcome");
        assert.equal(current.control_reads, expire ? 1 : 8);
        assert.equal(
          gets,
          expire ? 2 : 9,
          "one preflight plus bounded confirmation reads",
        );
        assert.equal(freezes, 1);
        assert.notEqual(current.mapped_generation, current.current_generation);
      }
    });
    it("persists intent before a crash and never replays an unacknowledged freeze or unfreeze", async () => {
      for (const target of [
        "freeze_intent",
        "freeze_acknowledged_at",
        "unfreeze_acknowledged_at",
      ]) {
        const f = await fixture(),
          control = immediate();
        let injected = false;
        const wrapped = {
          query: (...args) => a.query(...args),
          async connect() {
            const client = await a.connect();
            return {
              async query(sql, values) {
                if (
                  !injected &&
                  target !== "freeze_intent" &&
                  sql.includes(
                    `SET control_phase='${target.startsWith("unfreeze") ? "unfreeze_confirm" : "freeze_confirm"}'`,
                  )
                ) {
                  injected = true;
                  throw Error("synthetic acknowledgement persistence failure");
                }
                const result = await client.query(sql, values);
                if (
                  !injected &&
                  target === "freeze_intent" &&
                  sql === "COMMIT"
                ) {
                  const current = await job(f);
                  if (current.control_phase === "freeze_intent") {
                    injected = true;
                    throw Error("synthetic process loss after intent commit");
                  }
                }
                return result;
              },
              release: () => client.release(),
            };
          },
        };
        try {
          await createProviderRevocation(wrapped, control).synchronize(
            f.userId,
          );
        } catch (error) {
          assert.match(error.message, /synthetic/);
        }
        assert.equal(injected, true);
        await due(f);
        await createProviderRevocation(b, control).synchronize(f.userId);
        const current = await job(f);
        assert.equal(current.state, "manual");
        assert.equal(current.failure_reason, "uncertain_provider_outcome");
        assert.equal(
          control.calls.filter((v) => v === "freeze").length,
          target === "freeze_intent" ? 0 : 1,
        );
        assert.equal(
          control.calls.filter((v) => v === "unfreeze").length,
          target === "unfreeze_acknowledged_at" ? 1 : 0,
        );
        assert.notEqual(current.mapped_generation, current.current_generation);
      }
    });
    it("does not hold a connection or account lock during GET and rechecks revocation before any mutation", async () => {
      const f = await fixture(),
        entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      let mutations = 0;
      const limited = new pg.Pool({
        connectionString: runtimeUrl,
        max: 1,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      const processing = createProviderRevocation(limited, {
        async state() {
          entered.resolve();
          await release.promise;
          return { frozenAt: null };
        },
        async freeze() {
          mutations++;
        },
        async unfreeze() {
          mutations++;
        },
      }).synchronize(f.userId);
      try {
        await bounded(
          entered.promise,
          "phase worker did not enter provider GET",
        );
        const logout = endAllAccountSessions(limited, f.userId);
        await bounded(
          logout,
          "ending all sessions was blocked by provider GET",
          1500,
        );
        release.resolve();
        await processing;
        assert.equal(mutations, 0);
        assert.equal(
          (
            await owner.query("SELECT 1 FROM sessions WHERE user_id=$1", [
              f.userId,
            ])
          ).rowCount,
          0,
        );
      } finally {
        release.resolve();
        try {
          await processing;
        } finally {
          await limited.end();
        }
      }
    });
    it("ignores a late GET after another instance owns the lease and finishes the reset", async () => {
      const f = await fixture(),
        entered = Promise.withResolvers(),
        release = Promise.withResolvers(),
        control = immediate();
      let first = true;
      const stale = {
        ...control,
        async state() {
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
            return { frozenAt: null };
          }
          return control.state();
        },
      };
      const running = createProviderRevocation(a, stale).synchronize(f.userId);
      try {
        await bounded(entered.promise, "phase worker did not enter held GET");
        await due(f);
        await bounded(
          createProviderRevocation(b, control).synchronize(f.userId),
          "new lease owner did not finish",
        );
      } finally {
        release.resolve();
        await running;
      }
      assert.equal((await job(f)).state, "complete");
      assert.equal(control.calls.filter((v) => v === "freeze").length, 1);
      assert.equal(control.calls.filter((v) => v === "unfreeze").length, 1);
    });
    it("keeps superseding generations, changed baselines and independently changed freezes fenced after acknowledgement", async () => {
      for (const change of [
        "generation",
        "baseline",
        "outside_window",
        "independent_after_unfreeze",
      ]) {
        const f = await fixture();
        let frozenAt = null,
          visible = false,
          freezes = 0,
          unfreezes = 0;
        const control = {
          async state() {
            return { frozenAt: visible ? frozenAt : null };
          },
          async freeze() {
            freezes++;
            frozenAt = Math.floor(Date.now() / 1000);
          },
          async unfreeze() {
            unfreezes++;
            frozenAt = Math.floor(Date.now() / 1000) + 1;
          },
        };
        await createProviderRevocation(a, control).synchronize(f.userId);
        if (change === "generation")
          await owner.query(
            "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
            [f.userId],
          );
        if (change === "baseline")
          await owner.query(
            "UPDATE provider_identities SET credentials_digest=$2 WHERE user_id=$1",
            [f.userId, "b".repeat(64)],
          );
        if (change === "outside_window") frozenAt -= 3600;
        visible = true;
        await due(f);
        await createProviderRevocation(b, control).synchronize(f.userId);
        const rows = (
          await owner.query(
            "SELECT state,failure_reason FROM provider_revocation_jobs WHERE user_id=$1 ORDER BY generation",
            [f.userId],
          )
        ).rows;
        assert.ok(rows.every((row) => row.state === "manual"));
        assert.ok(
          rows.some(
            (row) => row.failure_reason === "uncertain_provider_outcome",
          ),
        );
        assert.equal(freezes, 1);
        assert.equal(
          unfreezes,
          change === "independent_after_unfreeze" ? 1 : 0,
        );
        assert.notEqual(
          (await job(f)).mapped_generation,
          (await job(f)).current_generation,
        );
      }
    });
    it("does not infer acknowledged outcomes for legacy or old-source running claims", async () => {
      for (const [phase, state, attempts] of [
        ["legacy", "running", 1],
        ["legacy", "pending", 1],
        ["preflight", "running", 1],
        ["preflight", "pending", 1],
      ]) {
        const f = await fixture(),
          control = immediate();
        await owner.query(
          "UPDATE provider_revocation_jobs SET control_phase=$2,state=$3,attempts=$4,lease_until='-infinity' WHERE user_id=$1",
          [f.userId, phase, state, attempts],
        );
        await createProviderRevocation(a, control).synchronize(f.userId);
        assert.equal((await job(f)).state, "manual");
        assert.deepEqual(control.calls, []);
      }
      const fresh = await fixture(),
        control = immediate();
      await owner.query(
        "UPDATE provider_revocation_jobs SET control_phase='legacy' WHERE user_id=$1",
        [fresh.userId],
      );
      await createProviderRevocation(a, control).synchronize(fresh.userId);
      assert.equal((await job(fresh)).state, "complete");
    });
    it("keeps preflight outages read-only, bounded and recoverable without converting unknown state into an unfrozen assertion", async () => {
      const f = await fixture(),
        control = immediate();
      let outage = true,
        gets = 0;
      const state = control.state;
      control.state = async () => {
        gets++;
        if (outage) throw Error("synthetic private provider outage");
        return state();
      };
      await createProviderRevocation(a, control).synchronize(f.userId);
      assert.equal((await job(f)).state, "pending");
      assert.equal((await job(f)).control_phase, "preflight");
      assert.equal(control.calls.length, 0);
      assert.equal(gets, 1);
      outage = false;
      await due(f);
      await createProviderRevocation(b, control).synchronize(f.userId);
      assert.equal((await job(f)).state, "complete");
      assert.equal(control.calls.filter((v) => v === "freeze").length, 1);
    });
    it("takes no action on a re-check overlapping a phase transition and records a real credential delta", async () => {
      const recheck = (inspect) =>
        createProviderRecheck(a, { inspect }, { staleAfterMs: 0 });
      // fixture() ends sessions through the incident path without a reason;
      // only a re-check's own revocation records reason provider_change.
      const incidents = async (userId) =>
        (
          await owner.query(
            "SELECT 1 FROM identity_audit_events WHERE user_id=$1 AND event_type='sessions.incident' AND metadata->>'reason'='provider_change'",
            [userId],
          )
        ).rowCount;
      const sessions = async (userId) =>
        (await owner.query("SELECT 1 FROM sessions WHERE user_id=$1", [userId]))
          .rowCount;
      const f = await fixture();
      // fixture() ended the account's sessions, so its reset is pending.
      assert.equal(
        await recheck(async () => f.identity).run(f.userId),
        "deferred",
      );
      await bounded(
        createProviderRevocation(b, immediate()).synchronize(f.userId),
        "phase worker did not finish",
      );
      // A read that overlaps the next own reset sees a frozen user.
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const checking = recheck(async () => {
        entered.resolve();
        await release.promise;
        throw new ProviderCredentialChangedError("synthetic own-reset freeze");
      }).run(f.userId);
      try {
        await bounded(
          entered.promise,
          "re-check did not enter provider inspection",
        );
        const authGeneration = await endAllAccountSessions(b, f.userId);
        await createSessionRepository(b).create(
          f.userId,
          f.tokenHash,
          new Date(Date.now() + 600000),
          { authGeneration },
        );
        await bounded(
          createProviderRevocation(b, immediate()).synchronize(f.userId),
          "phase worker did not finish",
        );
      } finally {
        release.resolve();
      }
      assert.equal(await checking, "deferred");
      assert.equal(await incidents(f.userId), 0);
      assert.equal(await sessions(f.userId), 1);
      const changed = await fixture();
      await bounded(
        createProviderRevocation(b, immediate()).synchronize(changed.userId),
        "phase worker did not finish",
      );
      assert.equal(
        await recheck(async () => ({
          ...changed.identity,
          credentialsDigest: "b".repeat(64),
        })).run(changed.userId),
        "recorded",
      );
      assert.equal(await incidents(changed.userId), 0);
      assert.equal(await sessions(changed.userId), 1);
    });
    it("does not let the normal phase worker cancel a freshly claimed owner retry with older phase metadata", async () => {
      const f = await fixture();
      await createProviderRevocation(a, {
        state: async () => ({ frozenAt: null }),
        async freeze() {
          throw Error("synthetic unknown outcome");
        },
        async unfreeze() {
          assert.fail("no unfreeze");
        },
      }).synchronize(f.userId);
      const failed = await job(f);
      assert.equal(failed.state, "manual");
      assert.ok(failed.control_id);
      await owner.query(
        "UPDATE provider_revocation_jobs SET lease_until='-infinity' WHERE user_id=$1",
        [f.userId],
      );
      let intercepted = false,
        competitorCalls = 0;
      const wrapped = {
        query: (...args) => owner.query(...args),
        async connect() {
          const client = await owner.connect();
          return {
            async query(sql, values) {
              const result = await client.query(sql, values);
              if (sql === "COMMIT" && !intercepted) {
                intercepted = true;
                await createProviderRevocation(b, {
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
                }).synchronize(f.userId);
                assert.equal(
                  (await job(f)).state,
                  "running",
                  "owner claim remains running until it performs its own control",
                );
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      };
      const control = immediate();
      assert.deepEqual(
        await createProviderRevocation(wrapped, control, {
          operatorInspector: { inspect: async () => f.identity },
        }).retryUncertain({ userId: f.userId, requestId: randomUUID() }),
        { state: "complete" },
      );
      assert.equal(intercepted, true);
      assert.equal(competitorCalls, 0);
      assert.equal(control.calls.filter((v) => v === "freeze").length, 1);
      assert.equal(control.calls.filter((v) => v === "unfreeze").length, 1);
      assert.equal((await job(f)).state, "complete");
    });
    it(
      "skips a reviewed owner retry before taking its account lock while the owner holds a provider GET",
      { timeout: 15000 },
      async () => {
        const f = await fixture();
        await createProviderRevocation(a, {
          state: async () => ({ frozenAt: null }),
          async freeze() {
            throw Error("synthetic unknown outcome");
          },
          async unfreeze() {
            assert.fail("no unfreeze");
          },
        }).synchronize(f.userId);
        await owner.query(
          "UPDATE provider_revocation_jobs SET lease_until='-infinity' WHERE user_id=$1",
          [f.userId],
        );
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        let reads = 0,
          competitorCalls = 0,
          frozenAt = null,
          timer;
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
            frozenAt = Math.floor(Date.now() / 1000);
          },
          async unfreeze() {
            frozenAt = null;
          },
        };
        const retry = createProviderRevocation(owner, control, {
          operatorInspector: { inspect: async () => f.identity },
        }).retryUncertain({ userId: f.userId, requestId: randomUUID() });
        try {
          await Promise.race([
            entered.promise,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("owner did not reach held GET")),
                5000,
              );
            }),
          ]);
          clearTimeout(timer);
          await Promise.race([
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
            }).synchronize(f.userId),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(Error("normal selector waited on owner account lock")),
                1500,
              );
            }),
          ]);
          assert.equal(competitorCalls, 0);
          assert.equal((await job(f)).state, "running");
        } finally {
          clearTimeout(timer);
          release.resolve();
          await retry;
        }
        assert.equal((await job(f)).state, "complete");
        assert.equal(reads, 4);
      },
    );
  },
);
