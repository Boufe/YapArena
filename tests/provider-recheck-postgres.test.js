import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import pg from "pg";
import request from "../scripts/test-http-request.ts";
import { createProviderAccounts } from "../dist/platform/auth/provider-accounts.js";
import { createProviderRecheck } from "../dist/platform/auth/provider-recheck.js";
import { providerCredentialsDigest } from "../dist/platform/auth/provider-credentials.js";
import {
  ProviderCredentialChangedError,
  ProviderUnavailableError,
} from "../dist/platform/auth/privy.js";
import {
  createAuthRouter,
  createRequireAuthentication,
} from "../dist/platform/auth/router.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { createUserRepository } from "../dist/platform/auth/users.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };

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
  "provider re-check outside the request path in PostgreSQL",
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
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      a = new pg.Pool({ ...options, connectionString: runtimeUrl });
      b = new pg.Pool({ ...options, connectionString: runtimeUrl });
    });
    after(async () => {
      await Promise.all([owner?.end(), a?.end(), b?.end()]);
    });

    function identityFor(methods = ["email"], subject = randomUUID()) {
      const credentials = methods.map((type) => ({
        type,
        id: type === "email" ? `${subject}@example.invalid` : `${type}-1`,
      }));
      return {
        subject: `did:privy:${subject}`,
        sessionId: randomUUID(),
        email: `${subject}@example.invalid`,
        methods: [...methods].sort(),
        credentials,
        credentialsDigest: providerCredentialsDigest(credentials),
        issuedAt: Math.floor(Date.now() / 1000),
      };
    }
    async function signIn(identity = identityFor()) {
      const token = createSessionToken();
      const { user } = await createProviderAccounts(a).exchange(
        identity,
        token.tokenHash,
        new Date(Date.now() + 600_000),
      );
      return { userId: user.id, identity, ...token };
    }
    async function makeStale(userId) {
      await owner.query(
        "UPDATE provider_identities SET checked_at=clock_timestamp()-interval '16 minutes' WHERE user_id=$1",
        [userId],
      );
    }
    async function liveSessions(userId) {
      return (
        await owner.query(
          "SELECT count(*)::int AS n FROM sessions WHERE user_id=$1",
          [userId],
        )
      ).rows[0].n;
    }
    function verifierFor(inspect) {
      const calls = { inspect: 0, verify: 0, configuration: 0 };
      return {
        calls,
        async inspect(subject) {
          calls.inspect++;
          return inspect(subject);
        },
        async verify() {
          calls.verify++;
          throw new Error("a protected request must not verify a token");
        },
        async configuration() {
          calls.configuration++;
          return { google: true, passkeys: true };
        },
      };
    }
    function appFor(sessions, verifier) {
      const app = express();
      app.use(cookieParser());
      app.use(
        "/api/auth",
        createAuthRouter({
          users: createUserRepository(a),
          sessions,
          environment: "test",
          provider: {
            appId: "synthetic-app",
            verifier,
            accounts: createProviderAccounts(a),
          },
        }),
      );
      app.get(
        "/api/feature",
        createRequireAuthentication({ sessions, environment: "test" }),
        (req, res) => res.json({ id: req.user.id }),
      );
      return app;
    }
    function countingPool(pool) {
      const counted = { queries: 0, connections: 0 };
      return {
        counted,
        query: (...args) => {
          counted.queries++;
          return pool.query(...args);
        },
        connect: (...args) => {
          counted.connections++;
          return pool.connect(...args);
        },
      };
    }

    it("serves a protected request with one session query and no verifier call", async () => {
      const signedIn = await signIn();
      const verifier = verifierFor(() => signedIn.identity);
      const counting = countingPool(a);
      const sessions = createSessionRepository(counting, {
        providerCheck: createProviderRecheck(a, verifier),
      });
      const app = appFor(sessions, verifier);
      for (const path of ["/api/auth/me", "/api/feature"]) {
        counting.counted.queries = 0;
        const response = await request(app)
          .get(path)
          .set("Cookie", `session=${signedIn.token}`);
        assert.equal(response.status, 200);
        assert.equal(counting.counted.queries, 1, path);
        assert.equal(counting.counted.connections, 0, path);
      }
      assert.deepEqual(verifier.calls, {
        inspect: 0,
        verify: 0,
        configuration: 0,
      });
    });

    it("keeps signed-in requests working during a Privy outage and backs off", async () => {
      const signedIn = await signIn();
      await makeStale(signedIn.userId);
      const outcomes = [];
      const verifier = verifierFor(() => {
        throw new ProviderUnavailableError("synthetic Privy outage");
      });
      const recheck = createProviderRecheck(a, verifier, {
        observe: (outcome) => outcomes.push(outcome),
      });
      const app = appFor(
        createSessionRepository(a, { providerCheck: recheck }),
        verifier,
      );
      for (let n = 0; n < 3; n++) {
        const response = await request(app)
          .get("/api/feature")
          .set("Cookie", `session=${signedIn.token}`);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { id: signedIn.userId });
        await recheck.drain();
      }
      // One read per interval: the first request claimed the check, so the
      // later requests are not due and schedule nothing.
      assert.equal(verifier.calls.inspect, 1);
      assert.deepEqual(outcomes, ["unavailable"]);
      assert.equal(await liveSessions(signedIn.userId), 1);
      // Every other account in this process waits for the back-off too.
      const other = await signIn();
      await makeStale(other.userId);
      assert.equal(await recheck.run(other.userId), "skipped");
      assert.equal(verifier.calls.inspect, 1);
    });

    it("answers without waiting for a slow Privy read", async () => {
      const signedIn = await signIn();
      await makeStale(signedIn.userId);
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      const verifier = verifierFor(async () => {
        entered.resolve();
        await release.promise;
        return signedIn.identity;
      });
      const recheck = createProviderRecheck(a, verifier);
      const app = appFor(
        createSessionRepository(a, { providerCheck: recheck }),
        verifier,
      );
      try {
        const response = await bounded(
          request(app)
            .get("/api/auth/me")
            .set("Cookie", `session=${signedIn.token}`),
          "request waited for the provider",
        );
        assert.equal(response.status, 200);
        await bounded(entered.promise, "re-check did not start");
      } finally {
        release.resolve();
        await recheck.drain();
      }
    });

    it("ends every session of a deleted, frozen or guest Privy user", async () => {
      const signedIn = await signIn();
      const second = createSessionToken();
      await createSessionRepository(a).create(
        signedIn.userId,
        second.tokenHash,
        new Date(Date.now() + 600_000),
        (
          await owner.query(
            'SELECT auth_generation AS "authGeneration" FROM users WHERE id=$1',
            [signedIn.userId],
          )
        ).rows[0],
      );
      await makeStale(signedIn.userId);
      const verifier = verifierFor(() => {
        throw new ProviderCredentialChangedError(
          "provider account unavailable",
        );
      });
      const recheck = createProviderRecheck(b, verifier);
      const sessions = createSessionRepository(a, { providerCheck: recheck });
      // The request that notices the stale read still succeeds.
      assert.equal(
        (await sessions.findUserByTokenHash(signedIn.tokenHash)).id,
        signedIn.userId,
      );
      await recheck.drain();
      assert.equal(await liveSessions(signedIn.userId), 0);
      for (const hash of [signedIn.tokenHash, second.tokenHash])
        assert.equal(await sessions.findUserByTokenHash(hash), null);
      const audit = (
        await owner.query(
          "SELECT metadata FROM identity_audit_events WHERE user_id=$1 AND event_type='sessions.incident'",
          [signedIn.userId],
        )
      ).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].metadata.reason, "provider_change");
      // The existing provider reset machinery then fences sign-in as before.
      await assert.rejects(
        createProviderAccounts(a).exchange(
          { ...signedIn.identity, sessionId: randomUUID() },
          createSessionToken().tokenHash,
          new Date(Date.now() + 600_000),
        ),
        { code: "provider_reset_pending" },
      );
    });

    it("records a sign-in method change with an audit event and notice, keeping sessions", async () => {
      const signedIn = await signIn();
      await makeStale(signedIn.userId);
      const changed = {
        ...identityFor(["email", "google_oauth"]),
        subject: signedIn.identity.subject,
      };
      // A wallet setup job parked on the old methods continues afterwards.
      await owner.query(
        "UPDATE embedded_wallet_provisioning SET state='retry_wait',last_failure='account_verification' WHERE user_id=$1",
        [signedIn.userId],
      );
      const recheck = createProviderRecheck(
        b,
        verifierFor(() => changed),
      );
      assert.equal(await recheck.run(signedIn.userId), "recorded");
      assert.equal(
        (
          await owner.query(
            "SELECT state FROM embedded_wallet_provisioning WHERE user_id=$1",
            [signedIn.userId],
          )
        ).rows[0].state,
        "pending",
      );
      assert.equal(await liveSessions(signedIn.userId), 1);
      const mapping = (
        await owner.query(
          `SELECT credentials_digest AS digest,methods,credentials_snapshot AS snapshot,
          checked_at > clock_timestamp()-interval '1 minute' AS fresh
          FROM provider_identities WHERE user_id=$1`,
          [signedIn.userId],
        )
      ).rows[0];
      assert.equal(mapping.digest, changed.credentialsDigest);
      assert.deepEqual(mapping.methods, ["email", "google_oauth"]);
      assert.deepEqual(mapping.snapshot, changed.credentials);
      assert.equal(mapping.fresh, true);
      const audit = (
        await owner.query(
          "SELECT metadata FROM identity_audit_events WHERE user_id=$1 AND event_type='provider.credentials.changed'",
          [signedIn.userId],
        )
      ).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].metadata.source, "recheck");
      assert.equal(
        audit[0].metadata.oldDigest,
        signedIn.identity.credentialsDigest,
      );
      const notices = (
        await owner.query(
          "SELECT message FROM account_notifications WHERE user_id=$1 AND event_type='account.signin_changed'",
          [signedIn.userId],
        )
      ).rows;
      assert.equal(notices.length, 1);
      assert.match(notices[0].message, /Current methods: email code, Google\./);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int AS n FROM identity_audit_events WHERE user_id=$1 AND event_type='sessions.incident'",
            [signedIn.userId],
          )
        ).rows[0].n,
        0,
      );
    });

    it("hands an inconclusive check back so the account is due again after the retry delay", async () => {
      const signedIn = await signIn();
      await makeStale(signedIn.userId);
      let outage = true;
      const verifier = verifierFor(() => {
        if (outage) throw new ProviderUnavailableError("synthetic outage");
        return signedIn.identity;
      });
      // Default retry delay: due again in about a minute, not 15.
      assert.equal(
        await createProviderRecheck(a, verifier, {
          pauseAfterUnavailableMs: 0,
        }).run(signedIn.userId),
        "unavailable",
      );
      const due = (
        await owner.query(
          `SELECT checked_at < clock_timestamp()-interval '13 minutes' AS soon
          FROM provider_identities WHERE user_id=$1`,
          [signedIn.userId],
        )
      ).rows[0];
      assert.equal(due.soon, true);
      await makeStale(signedIn.userId);
      const immediate = createProviderRecheck(a, verifier, {
        pauseAfterUnavailableMs: 0,
        retryAfterMs: 0,
      });
      assert.equal(await immediate.run(signedIn.userId), "unavailable");
      outage = false;
      assert.equal(await immediate.run(signedIn.userId), "unchanged");
      assert.equal(await immediate.run(signedIn.userId), "skipped");
      // A deferral during the app's own reset is handed back too.
      await endAllAccountSessions(a, signedIn.userId);
      await makeStale(signedIn.userId);
      assert.equal(await immediate.run(signedIn.userId), "deferred");
      assert.equal(await immediate.run(signedIn.userId), "deferred");
    });

    it("lets one process read Privy once per interval for an account", async () => {
      const signedIn = await signIn();
      const verifier = verifierFor(() => signedIn.identity);
      // A fresh sign-in is a Privy read: nothing is due yet.
      assert.equal(
        await createProviderRecheck(a, verifier).run(signedIn.userId),
        "skipped",
      );
      await makeStale(signedIn.userId);
      const outcomes = await Promise.all([
        createProviderRecheck(a, verifier).run(signedIn.userId),
        createProviderRecheck(b, verifier).run(signedIn.userId),
      ]);
      assert.deepEqual(outcomes.sort(), ["skipped", "unchanged"]);
      assert.equal(verifier.calls.inspect, 1);
      assert.equal(
        await createProviderRecheck(b, verifier).run(signedIn.userId),
        "skipped",
      );
    });

    it("holds no connection or lock during the Privy read; an account-wide revocation that wins discards its result", async () => {
      const single = new pg.Pool({
        ...options,
        connectionString: runtimeUrl,
        max: 1,
      });
      try {
        for (const failure of [false, true]) {
          const signedIn = await signIn(),
            otherDevice = await signIn({
              ...signedIn.identity,
              sessionId: randomUUID(),
            });
          await makeStale(signedIn.userId);
          const entered = Promise.withResolvers(),
            release = Promise.withResolvers();
          const recheck = createProviderRecheck(
            single,
            verifierFor(async () => {
              entered.resolve();
              await release.promise;
              if (failure)
                throw new ProviderCredentialChangedError("synthetic freeze");
              return {
                ...identityFor(["email", "passkey"]),
                subject: signedIn.identity.subject,
              };
            }),
          );
          const running = recheck.run(signedIn.userId);
          try {
            await bounded(entered.promise, "re-check did not start");
            assert.equal(single.idleCount, 1);
            await bounded(
              createSessionRepository(single).revokeSession(
                signedIn.userId,
                otherDevice.tokenHash,
              ),
              "sign-out waited for the provider read",
            );
            assert.equal(await liveSessions(signedIn.userId), 1);
            await bounded(
              endAllAccountSessions(single, signedIn.userId),
              "account-wide revocation waited for the provider read",
            );
          } finally {
            release.resolve();
          }
          assert.equal(await running, "deferred");
          assert.equal(await liveSessions(signedIn.userId), 0);
          // Only the winning revocation is recorded; the re-check result
          // (a method change or a provider-side freeze) is discarded.
          const audit = (
            await owner.query(
              `SELECT event_type,metadata->>'reason' AS reason FROM identity_audit_events
              WHERE user_id=$1 AND event_type IN ('sessions.incident','provider.credentials.changed')`,
              [signedIn.userId],
            )
          ).rows;
          assert.deepEqual(audit, [
            { event_type: "sessions.incident", reason: null },
          ]);
        }
      } finally {
        await single.end();
      }
    });

    it("takes no action while the app's own Privy reset is in progress", async () => {
      const signedIn = await signIn();
      const generation = await endAllAccountSessions(a, signedIn.userId);
      // A device that signs in again while the reset is still pending.
      await createSessionRepository(a).create(
        signedIn.userId,
        createSessionToken().tokenHash,
        new Date(Date.now() + 600_000),
        { authGeneration: generation },
      );
      await makeStale(signedIn.userId);
      const verifier = verifierFor(() => {
        throw new ProviderCredentialChangedError("own reset freeze");
      });
      assert.equal(
        await createProviderRecheck(a, verifier).run(signedIn.userId),
        "deferred",
      );
      assert.equal(verifier.calls.inspect, 0);
      assert.equal(await liveSessions(signedIn.userId), 1);
    });

    it("does not schedule a re-check from sign-out routes or for unmapped accounts", async () => {
      const signedIn = await signIn(),
        otherDevice = await signIn({
          ...signedIn.identity,
          sessionId: randomUUID(),
        });
      await makeStale(signedIn.userId);
      const scheduled = [];
      const sessions = createSessionRepository(a, {
        providerCheck: {
          staleAfterMs: 15 * 60_000,
          schedule: (userId) => scheduled.push(userId),
        },
      });
      assert.ok(
        await sessions.findUserByTokenHash(signedIn.tokenHash, {
          localRevocation: true,
        }),
      );
      assert.deepEqual(scheduled, []);
      // Signing out ends this device only: no re-check, no Privy call, no
      // generation change and no provider reset.
      const accountState = async () =>
        (
          await owner.query(
            `SELECT u.auth_generation::text AS generation,
            (SELECT count(*)::int FROM provider_revocation_jobs j WHERE j.user_id=u.id) AS jobs
            FROM users u WHERE u.id=$1`,
            [signedIn.userId],
          )
        ).rows[0];
      const before = await accountState();
      const verifier = verifierFor(() => {
        throw new Error("sign-out must not read Privy");
      });
      const response = await request(appFor(sessions, verifier))
        .post("/api/auth/logout")
        .set("Cookie", `session=${signedIn.token}`);
      assert.equal(response.status, 204);
      assert.deepEqual(scheduled, []);
      assert.deepEqual(verifier.calls, {
        inspect: 0,
        verify: 0,
        configuration: 0,
      });
      assert.deepEqual(await accountState(), before);
      assert.equal(await liveSessions(signedIn.userId), 1);
      assert.equal(
        await sessions.findUserByTokenHash(signedIn.tokenHash, {
          localRevocation: true,
        }),
        null,
      );
      assert.deepEqual(scheduled, []);
      assert.ok(await sessions.findUserByTokenHash(otherDevice.tokenHash));
      assert.deepEqual(scheduled, [signedIn.userId]);
      assert.equal(
        await createProviderRecheck(
          a,
          verifierFor(() => null),
        ).run("9223372036854775806"),
        "skipped",
      );
    });
  },
);
