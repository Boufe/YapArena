import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  createSessionRepository,
  SessionUnavailableError,
} from "../dist/platform/auth/sessions.js";
import { hashSessionToken } from "../dist/platform/auth/session-tokens.js";
import request from "../scripts/test-http-request.ts";

describe("owned-session HTTP management", () => {
  const id = "100";
  function app({ fail = false, removed = { current: false } } = {}) {
    const calls = [];
    const server = createApp({
      environment: "test",
      logger: createLogger({ enabled: false }),
      messages: {},
      sessions: {
        async findUserByTokenHash(token) {
          return token === hashSessionToken("cookie")
            ? { id: "72", email: null, createdAt: new Date() }
            : null;
        },
        async list(user, token) {
          calls.push({ user, token });
          if (fail) throw new SessionUnavailableError();
          return {
            sessions: [
              {
                id,
                current: true,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 60000),
              },
            ],
            hasMore: false,
          };
        },
        async revokeSession(user, token, target) {
          calls.push({ user, token, target });
          if (fail) throw new SessionUnavailableError();
          return removed;
        },
      },
    });
    return { server, calls };
  }
  it("lists metadata without bearer values and derives owner from the cookie", async () => {
    const f = app();
    const response = await request(f.server)
      .get("/api/auth/sessions")
      .set("Cookie", "session=cookie")
      .expect(200);
    assert.equal(response.body.sessions[0].id, id);
    assert.equal(response.body.sessions[0].current, true);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /cookie|token|hashSession/,
    );
    assert.equal(f.calls[0].user, "72");
    assert.equal(f.calls[0].token, hashSessionToken("cookie"));
    assert.match(response.headers["cache-control"], /no-store/);
    await request(f.server).get("/api/auth/sessions").expect(401);
    await request(app({ fail: true }).server)
      .get("/api/auth/sessions")
      .set("Cookie", "session=cookie")
      .expect(401);
  });
  it("rejects account selectors and invalid target IDs", async () => {
    const f = app();
    await request(f.server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .send({ accountId: "73" })
      .expect(400);
    await request(f.server)
      .delete("/api/auth/sessions/invalid")
      .set("Cookie", "session=cookie")
      .expect(400);
    assert.equal(f.calls.length, 0);
  });
  it("compares the observed account before removing a session and still requires a cookie", async () => {
    const f = app();
    await request(f.server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .set("X-YapArena-Expected-Account", "73")
      .expect(409);
    await request(f.server)
      .delete(`/api/auth/sessions/${id}`)
      .set("X-YapArena-Expected-Account", "72")
      .expect(401);
    assert.equal(f.calls.length, 0);
    await request(f.server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .set("X-YapArena-Expected-Account", "72")
      .expect(200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].user, "72");
  });
  it("revokes one owned session without deleting a potentially newer browser cookie", async () => {
    const f = app();
    const response = await request(f.server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .expect(200);
    assert.equal(response.body.current, false);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(f.calls[0].target, id);
    const current = await request(app({ removed: { current: true } }).server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .expect(200);
    assert.equal(current.headers["set-cookie"], undefined);
    await request(app({ removed: null }).server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .expect(404);
    await request(app({ fail: true }).server)
      .delete(`/api/auth/sessions/${id}`)
      .set("Cookie", "session=cookie")
      .expect(401);
  });
});

const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "session management across PostgreSQL instances",
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
      const user = (
        await owner.query(
          "INSERT INTO users DEFAULT VALUES RETURNING id,auth_generation AS generation",
        )
      ).rows[0];
      const repo = createSessionRepository(a),
        token = randomUUID(),
        other = randomUUID();
      const first = await repo.create(
        user.id,
        hashSessionToken(token),
        new Date(Date.now() + 60000),
        { authGeneration: user.generation },
      );
      const second = await repo.create(
        user.id,
        hashSessionToken(other),
        new Date(Date.now() + 60000),
        { authGeneration: user.generation },
      );
      return { user, repo, token, other, first, second };
    }
    it("sign out ends only this device across instances and never queues a provider reset", async () => {
      const value = await fixture();
      // A Privy-linked account: any generation change would queue a reset.
      await owner.query(
        `INSERT INTO provider_identities(provider,subject,user_id,methods,auth_generation,credentials_digest,credentials_snapshot)
         VALUES('privy',$1,$2,'["email"]',$3,$4,'[]'::jsonb)`,
        [
          `did:privy:${randomUUID()}`,
          value.user.id,
          value.user.generation,
          createHash("sha256").update(randomUUID()).digest("hex"),
        ],
      );
      const providerCalls = [];
      const refuse = (name) => async () => {
        providerCalls.push(name);
        throw new Error("sign out must not call the sign-in provider");
      };
      const app = createApp({
        messages: { isReady: async () => {} },
        sessions: value.repo,
        logger: createLogger({ enabled: false }),
        environment: "test",
        applicationOrigin: "http://localhost:3000",
        auth0: {
          client: {
            authorizationUrl: refuse("authorizationUrl"),
            verifyCallback: refuse("verifyCallback"),
            // Building the provider's logout URL is local; nothing is sent.
            logoutUrl: (returnTo) => {
              const url = new URL("https://synthetic.auth0.test/v2/logout");
              url.searchParams.set("returnTo", returnTo);
              return url;
            },
          },
          accounts: { signIn: refuse("signIn"), methods: refuse("methods") },
          state: {
            create: refuse("state.create"),
            consume: refuse("state.consume"),
            deleteExpired: refuse("state.deleteExpired"),
          },
        },
      });
      const response = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `session=${value.token}`);
      assert.equal(response.status, 200);
      assert.equal(
        response.body.redirectTo,
        "https://synthetic.auth0.test/v2/logout?returnTo=http%3A%2F%2Flocalhost%3A3000%2F",
      );
      assert.equal(response.headers["set-cookie"], undefined);
      const otherRepo = createSessionRepository(b);
      assert.equal(
        await otherRepo.findUserByTokenHash(hashSessionToken(value.token)),
        null,
      );
      assert.equal(
        (await otherRepo.findUserByTokenHash(hashSessionToken(value.other)))
          ?.id,
        value.user.id,
      );
      const state = (
        await owner.query(
          `SELECT (SELECT auth_generation::text FROM users WHERE id=$1) AS generation,
             (SELECT count(*)::int FROM sessions WHERE user_id=$1) AS sessions,
             (SELECT count(*)::int FROM provider_revocation_jobs WHERE user_id=$1) AS jobs,
             (SELECT array_agg(event_type ORDER BY id) FROM identity_audit_events
               WHERE user_id=$1 AND event_type IN ('sessions.logout_one','sessions.logout_all','sessions.logout_others','sessions.incident')) AS events`,
          [value.user.id],
        )
      ).rows[0];
      assert.deepEqual(state, {
        generation: value.user.generation,
        sessions: 1,
        jobs: 0,
        events: ["sessions.logout_one"],
      });
      assert.deepEqual(providerCalls, []);
      // The ended cookie cannot sign out again; the other device still can.
      await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `session=${value.token}`)
        .expect(401);
      await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `session=${value.other}`)
        .expect(200);
      assert.equal(
        await otherRepo.findUserByTokenHash(hashSessionToken(value.other)),
        null,
      );
    });
    it("lists only the current owner's live sessions and revokes across instances", async () => {
      const f = await fixture(),
        stranger = await fixture(),
        otherRepo = createSessionRepository(b);
      const listed = await f.repo.list(f.user.id, hashSessionToken(f.token));
      assert.equal(listed.sessions.length, 2);
      assert.equal(listed.sessions.filter((s) => s.current).length, 1);
      assert.equal(listed.hasMore, false);
      assert.equal(
        await otherRepo.revokeSession(
          f.user.id,
          hashSessionToken(f.token),
          stranger.first.id,
        ),
        null,
      );
      assert.ok(
        await otherRepo.findUserByTokenHash(hashSessionToken(stranger.token)),
      );
      assert.deepEqual(
        await otherRepo.revokeSession(
          f.user.id,
          hashSessionToken(f.token),
          f.second.id,
        ),
        { current: false },
      );
      assert.equal(
        await f.repo.findUserByTokenHash(hashSessionToken(f.other)),
        null,
      );
      assert.ok(await f.repo.findUserByTokenHash(hashSessionToken(f.token)));
      assert.deepEqual(
        await otherRepo.revokeSession(
          f.user.id,
          hashSessionToken(f.token),
          f.first.id,
        ),
        { current: true },
      );
      await assert.rejects(
        f.repo.list(f.user.id, hashSessionToken(f.token)),
        SessionUnavailableError,
      );
      await assert.rejects(
        f.repo.revokeSession(
          f.user.id,
          hashSessionToken(f.token),
          stranger.first.id,
        ),
        SessionUnavailableError,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM identity_audit_events WHERE user_id=$1 AND event_type='sessions.logout_one'",
            [f.user.id],
          )
        ).rows[0].n,
        2,
      );
    });
    it("refuses inactive accounts without listing or changing sessions", async () => {
      const f = await fixture();
      await owner.query(
        "UPDATE users SET account_status='suspended' WHERE id=$1",
        [f.user.id],
      );
      await assert.rejects(
        f.repo.list(f.user.id, hashSessionToken(f.token)),
        SessionUnavailableError,
      );
      await assert.rejects(
        f.repo.revokeSession(f.user.id, hashSessionToken(f.token), f.second.id),
        SessionUnavailableError,
      );
    });
  },
);
