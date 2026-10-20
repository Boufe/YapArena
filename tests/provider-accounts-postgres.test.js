import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createProviderRevocation } from "../dist/platform/auth/provider-revocation.js";
import { createAccountWallet } from "../dist/features/account-wallet/repository.js";
import { createProviderSessionMonitor } from "../dist/platform/auth/provider-session-monitor.js";
import {
  ProviderUnavailableError,
  ProviderCredentialChangedError,
} from "../dist/platform/auth/privy.js";
import { createLegacyProviderLink } from "../dist/platform/auth/legacy-provider-link.js";
import { hashPassword } from "../dist/platform/auth/passwords.js";
const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "provider ownership and financial isolation in PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, a, b;
    const identity = (subject = randomUUID(), sessionId = randomUUID()) => ({
      subject: `did:privy:${subject}`,
      sessionId,
      email: "unverified-legacy@example.test",
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
      await createSessionRepository(a).revoke(
        made.user.id,
        hashSessionToken(token),
        false,
      );
      let frozenAt = null;
      const calls = [];
      const cutoff = Math.floor(Date.now() / 1000);
      const control = {
        async state() {
          return { frozenAt };
        },
        async freeze() {
          calls.push("freeze");
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
        /authenticate again/,
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
    it("rejects an unapproved provider credential change without merging accounts", async () => {
      const id = identity(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id);
      await assert.rejects(
        exchange(repo, {
          ...id,
          sessionId: randomUUID(),
          credentialsDigest: "b".repeat(64),
        }),
        /ownership reconciliation/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM provider_session_exchanges WHERE user_id=$1",
            [made.user.id],
          )
        ).rows[0].n,
        1,
      );
    });
    async function legacyFixture() {
      const password = "synthetic legacy linking passphrase",
        token = randomUUID();
      const user = (
        await owner.query(
          `INSERT INTO users(email,password_hash) VALUES($1,$2)
        RETURNING id,email,password_hash AS "passwordHash",auth_generation AS "authGeneration"`,
          [`${randomUUID()}@example.test`, await hashPassword(password)],
        )
      ).rows[0];
      await createSessionRepository(a).create(
        user.id,
        hashSessionToken(token),
        new Date(Date.now() + 600000),
        user,
      );
      return {
        user,
        password,
        token,
        context: {
          userId: user.id,
          sessionTokenHash: hashSessionToken(token),
          origin: "http://localhost:53024",
        },
      };
    }
    it("links a never-provisioned verified provider identity to the retained legacy ID using fresh retained proof", async () => {
      const f = await legacyFixture(),
        id = identity(),
        link = createLegacyProviderLink(a, {
          async verify() {
            return id;
          },
        });
      const operation = await link.create({
        ...f.context,
        token: "synthetic-provider",
        credential: { type: "password" },
      });
      await assert.rejects(
        link.complete({
          ...f.context,
          id: operation.id,
          token: "synthetic-provider",
          password: "wrong",
          rpcUrls: {},
          sessionDurationMs: 600000,
        }),
        /password is incorrect/,
      );
      const made = await link.complete({
        ...f.context,
        id: operation.id,
        token: "synthetic-provider",
        password: f.password,
        rpcUrls: {},
        sessionDurationMs: 600000,
      });
      assert.equal(
        (await createProviderAccounts(b).details(f.user.id)).email,
        id.email,
      );
      assert.equal(
        await createSessionRepository(b).findUserByTokenHash(
          f.context.sessionTokenHash,
        ),
        null,
      );
      assert.equal(
        (
          await createSessionRepository(b).findUserByTokenHash(
            hashSessionToken(made.token),
          )
        ).id,
        f.user.id,
      );
      const retained = (
        await owner.query("SELECT email,password_hash FROM users WHERE id=$1", [
          f.user.id,
        ])
      ).rows[0];
      assert.equal(retained.email, f.user.email);
      assert.equal(retained.password_hash, f.user.passwordHash);
      assert.equal(
        (
          await owner.query(
            "SELECT user_id::text FROM provider_identities WHERE subject=$1",
            [id.subject],
          )
        ).rows[0].user_id,
        f.user.id,
      );
      await assert.rejects(
        link.create({
          ...f.context,
          token: "synthetic-provider",
          credential: { type: "password" },
        }),
        /no accounts were merged/,
      );
    });
    it("never moves a previously provisioned manual identity or accepts a changed candidate credential digest", async () => {
      const f = await legacyFixture(),
        id = identity(),
        manual = await exchange(createProviderAccounts(a), id);
      const link = createLegacyProviderLink(a, {
        async verify() {
          return id;
        },
      });
      await assert.rejects(
        link.candidate(f.user.id, "synthetic-provider"),
        /no accounts were merged/,
      );
      await assert.rejects(
        link.create({
          ...f.context,
          token: "synthetic-provider",
          credential: { type: "password" },
        }),
        /no accounts were merged/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT user_id::text FROM provider_identities WHERE subject=$1",
            [id.subject],
          )
        ).rows[0].user_id,
        manual.user.id,
      );
      assert.ok(
        await createSessionRepository(b).findUserByTokenHash(
          f.context.sessionTokenHash,
        ),
      );
      let candidate = identity();
      const changed = createLegacyProviderLink(b, {
          async verify() {
            return candidate;
          },
        }),
        operation = await changed.create({
          ...f.context,
          token: "synthetic-provider",
          credential: { type: "password" },
        });
      candidate = { ...candidate, credentialsDigest: "c".repeat(64) };
      await assert.rejects(
        changed.complete({
          ...f.context,
          id: operation.id,
          token: "synthetic-provider",
          password: f.password,
          rpcUrls: {},
          sessionDurationMs: 600000,
        }),
        /expired or invalid/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM provider_identities WHERE user_id=$1",
            [f.user.id],
          )
        ).rows[0].n,
        0,
      );
    });
    it("serializes legacy linking against a simultaneous ordinary provisioning callback without merging IDs", async () => {
      const f = await legacyFixture(),
        id = identity(),
        link = createLegacyProviderLink(a, {
          async verify() {
            return id;
          },
        });
      const operation = await link.create({
        ...f.context,
        token: "synthetic-provider",
        credential: { type: "password" },
      });
      const results = await Promise.allSettled([
        link.complete({
          ...f.context,
          id: operation.id,
          token: "synthetic-provider",
          password: f.password,
          rpcUrls: {},
          sessionDurationMs: 600000,
        }),
        exchange(createProviderAccounts(b), id),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
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
        (
          await owner.query("SELECT password_hash FROM users WHERE id=$1", [
            f.user.id,
          ])
        ).rows[0].password_hash,
        f.user.passwordHash,
      );
    });
    it("inspects every protected cookie lookup, fails closed on outages and leaves local revocation available", async () => {
      const id = identity(),
        token = randomUUID(),
        made = await exchange(createProviderAccounts(a), id, token);
      let calls = 0,
        outage = false;
      const monitor = createProviderSessionMonitor(b, {
        async inspect(subject) {
          calls++;
          assert.equal(subject, id.subject);
          if (outage)
            throw new ProviderUnavailableError("provider unavailable");
          return id;
        },
      });
      const sessions = createSessionRepository(a, {
        verifyProviderSession: monitor,
      });
      for (let n = 0; n < 2; n++)
        assert.equal(
          (await sessions.findUserByTokenHash(hashSessionToken(token))).id,
          made.user.id,
        );
      assert.equal(calls, 2);
      outage = true;
      await assert.rejects(
        sessions.findUserByTokenHash(hashSessionToken(token)),
        ProviderUnavailableError,
      );
      assert.equal(
        (
          await sessions.findUserByTokenHash(hashSessionToken(token), {
            localRevocation: true,
          })
        ).id,
        made.user.id,
      );
      assert.equal(calls, 3);
      await sessions.revoke(made.user.id, hashSessionToken(token), false);
      assert.equal(
        await sessions.findUserByTokenHash(hashSessionToken(token), {
          localRevocation: true,
        }),
        null,
      );
    });
    it("revokes existing app cookies across instances for provider credential changes or removed/frozen accounts", async () => {
      for (const invalidAccount of [false, true]) {
        const id = identity(),
          token = randomUUID();
        await exchange(createProviderAccounts(a), id, token);
        const monitor = createProviderSessionMonitor(a, {
          async inspect() {
            if (invalidAccount)
              throw new ProviderCredentialChangedError(
                "provider account unavailable",
              );
            return { ...id, credentialsDigest: "b".repeat(64) };
          },
        });
        await assert.rejects(
          createSessionRepository(b, {
            verifyProviderSession: monitor,
          }).findUserByTokenHash(hashSessionToken(token)),
          /ownership reconciliation/,
        );
        assert.equal(
          await createSessionRepository(a).findUserByTokenHash(
            hashSessionToken(token),
          ),
          null,
        );
        await assert.rejects(
          exchange(createProviderAccounts(b), {
            ...id,
            sessionId: randomUUID(),
          }),
          /ownership verification/,
        );
      }
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
      await createSessionRepository(a).revoke(
        made.user.id,
        hashSessionToken(token),
        false,
      );
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
      await assert.rejects(service.synchronize(made.user.id), /outage/);
      await assert.rejects(
        exchange(repo, { ...id, sessionId: randomUUID() }),
        /ownership verification/,
      );
      await service.synchronize(made.user.id);
      await owner.query(
        "UPDATE provider_revocation_jobs SET lease_until='-infinity' WHERE user_id=$1",
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
      await createSessionRepository(a).revoke(
        made.user.id,
        hashSessionToken(token),
        false,
      );
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
      await assert.rejects(
        createProviderRevocation(b, control).synchronize(made.user.id),
        /uncertain response/,
      );
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
        /ownership verification/,
      );
    });
    it("does not freeze a superseded generation between claiming and provider control", async () => {
      const id = identity(),
        token = randomUUID(),
        repo = createProviderAccounts(a);
      const made = await exchange(repo, id, token);
      await createSessionRepository(a).revoke(
        made.user.id,
        hashSessionToken(token),
        false,
      );
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
      await createSessionRepository(a).revoke(
        made.user.id,
        hashSessionToken(token),
        false,
      );
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
      assert.equal(frozenAt, null);
      await createProviderRevocation(a, control).synchronize(made.user.id);
      assert.equal(freezes, 2);
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
          frozenAt = 12345;
        },
        async unfreeze() {
          unfreezes++;
        },
      };
      await createProviderRevocation(b, control).synchronize(made.user.id);
      assert.equal(unfreezes, 0);
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
    it("provisions once under simultaneous callbacks without merging legacy email ownership", async () => {
      const legacy = (
        await owner.query(
          "INSERT INTO users(email,password_hash) VALUES($1,'unused') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id",
          ["unverified-legacy@example.test"],
        )
      ).rows[0];
      const id = identity();
      const results = await Promise.allSettled([
        exchange(createProviderAccounts(a), id),
        exchange(createProviderAccounts(b), id),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      const made = results.find((r) => r.status === "fulfilled").value;
      assert.notEqual(made.user.id, legacy.id);
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
        /already been used/,
      );
      const next = randomUUID();
      await exchange(repo, { ...id, sessionId: randomUUID() }, next);
      await sessions.revoke(made.user.id, hashSessionToken(next), false);
      await assert.rejects(
        exchange(createProviderAccounts(b), { ...id, sessionId: randomUUID() }),
        /ownership verification/,
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
        /previous identity/,
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
