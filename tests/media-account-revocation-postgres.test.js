import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  createMediaAccountRevocation,
  MediaRevocationPendingError,
  MediaRevocationUnsupportedError,
} from "../dist/features/media/account-revocation.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";

it("requires supported token revocation and a bounded provider deadline", async () => {
  const database = {
    connect() {
      throw Error("must not connect");
    },
  };
  const unsupported = createMediaAccountRevocation(database, {
    supportsTokenRevocation: false,
  });
  await assert.rejects(
    unsupported.issueSpeakerGrant({ debateId: randomUUID() }),
    MediaRevocationUnsupportedError,
  );
  assert.throws(
    () => createMediaAccountRevocation(database, { timeoutMs: 0 }),
    /timeout/,
  );
  await assert.rejects(unsupported.flush(0), /batch limit/);
});
const ownerUrl = process.env.A4_TEST_OWNER_URL,
  runtimeUrl = process.env.A4_TEST_DATABASE_URL;
describe(
  "account media containment in isolated PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, a, b;
    before(() => {
      for (const value of [ownerUrl, runtimeUrl]) {
        const url = new URL(value);
        assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
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
    after(async () => Promise.all([owner?.end(), a?.end(), b?.end()]));
    async function session(userId, expiresAt = new Date(Date.now() + 600000)) {
      const user = (
        await owner.query("SELECT auth_generation FROM users WHERE id=$1", [
          userId,
        ])
      ).rows[0];
      const token = createSessionToken();
      const created = await createSessionRepository(a).create(
        userId,
        token.tokenHash,
        expiresAt,
        { authGeneration: user.auth_generation },
      );
      return {
        userId,
        sessionTokenHash: token.tokenHash,
        sessionId: created.id,
      };
    }
    async function actor(expiresAt) {
      const user = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0];
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM account_roles WHERE user_id=$1 AND role='participant'",
            [user.id],
          )
        ).rows[0].n,
        1,
        "new accounts receive the participant role from the account trigger",
      );
      return session(user.id, expiresAt);
    }
    async function debate(context, checked = true) {
      const topic = (
        await owner.query(
          `INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state)
      VALUES($1,'Media containment','Synthetic isolated fixture','Support','Oppose','published') RETURNING id`,
          [`media-auth-${randomUUID()}`],
        )
      ).rows[0];
      const event = (
        await owner.query(
          `INSERT INTO debates(topic_id,slug,proposition,status,publication_state,rules_version,rules_snapshot)
      VALUES($1,$2,'Should the assigned speaker retain access?','scheduled','published','preview-1','{}') RETURNING id`,
          [topic.id, `media-auth-${randomUUID()}`],
        )
      ).rows[0];
      await owner.query(
        "INSERT INTO event_participants(debate_id,user_id,side) VALUES($1,$2,'A')",
        [event.id, context.userId],
      );
      if (checked)
        await owner.query(
          "INSERT INTO media_device_checks(debate_id,user_id,camera_ok,microphone_ok) VALUES($1,$2,true,true)",
          [event.id, context.userId],
        );
      return { ...context, debateId: event.id };
    }
    function fixture(database = a, overrides = {}) {
      const minted = [],
        removed = [],
        observed = [];
      const provider = {
        supportsTokenRevocation: true,
        mintSpeakerToken: async (debateId, identity, side) => {
          minted.push({ debateId, identity, side });
          return `synthetic-token-${identity}`;
        },
        removeSpeaker: async (debateId, identity) => {
          removed.push({ debateId, identity });
        },
        observe: (value) => observed.push(value),
        ...overrides,
      };
      return {
        repo: createMediaAccountRevocation(database, provider),
        minted,
        removed,
        observed,
      };
    }
    const grants = async (context) =>
      (
        await owner.query(
          "SELECT * FROM media_account_grants WHERE user_id=$1 ORDER BY created_at,id",
          [context.userId],
        )
      ).rows;
    async function due(grantId) {
      await owner.query(
        "UPDATE media_account_revocations SET available_at=clock_timestamp()-INTERVAL '1 second' WHERE grant_id=$1",
        [grantId],
      );
    }
    it("issues only to the assigned, device-ready speaker in the permitted phase", async () => {
      const context = await debate(await actor(), false),
        stranger = await actor(),
        f = fixture();
      await assert.rejects(
        f.repo.issueSpeakerGrant({
          ...context,
          userId: stranger.userId,
          sessionTokenHash: stranger.sessionTokenHash,
        }),
        /assigned speaker seat/,
      );
      await assert.rejects(
        f.repo.issueSpeakerGrant(context),
        /camera\/microphone/,
      );
      await owner.query(
        "INSERT INTO media_device_checks(debate_id,user_id,camera_ok,microphone_ok) VALUES($1,$2,true,true)",
        [context.debateId, context.userId],
      );
      await owner.query(
        "UPDATE debates SET publication_state='hidden' WHERE id=$1",
        [context.debateId],
      );
      await assert.rejects(
        f.repo.issueSpeakerGrant(context),
        /assigned speaker seat/,
      );
      await owner.query(
        "UPDATE debates SET publication_state='published',status='cancelled' WHERE id=$1",
        [context.debateId],
      );
      await assert.rejects(
        f.repo.issueSpeakerGrant(context),
        /assigned speaker seat/,
      );
      await assert.rejects(
        f.repo.issueSpeakerGrant({
          ...context,
          sessionTokenHash: stranger.sessionTokenHash,
        }),
        /session/,
      );
      assert.equal(f.minted.length, 0);
      assert.equal((await grants(context)).length, 0);
    });
    it("reuses one session's opaque identity across simultaneous retries and protects tracking history", async () => {
      const context = await debate(await actor()),
        f = fixture(),
        other = fixture(b);
      const issued = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? f : other).repo.issueSpeakerGrant(context),
        ),
      );
      assert.equal(new Set(issued.map((entry) => entry.token)).size, 1);
      assert.ok(issued.every((entry) => entry.side === "A"));
      const [grant] = await grants(context);
      assert.equal(grant.session_id, context.sessionId);
      assert.match(grant.identity, /^speaker-[a-f0-9-]{36}$/);
      assert.equal(
        await f.repo.isCurrentGrant(context.debateId, grant.identity),
        true,
      );
      assert.equal(
        await f.repo.isCurrentGrant(randomUUID(), grant.identity),
        false,
      );
      assert.equal(
        await f.repo.isCurrentGrant(context.debateId, "speaker-untracked"),
        false,
      );
      await assert.rejects(
        a.query(
          "UPDATE media_account_grants SET identity='speaker-forged' WHERE id=$1",
          [grant.id],
        ),
        { code: "42501" },
      );
      await assert.rejects(
        owner.query(
          "UPDATE media_account_grants SET session_id=session_id+1 WHERE id=$1",
          [grant.id],
        ),
        /immutable/,
      );
      await assert.rejects(
        owner.query("DELETE FROM media_account_grants WHERE id=$1", [grant.id]),
        /immutable/,
      );
    });
    it("orders an all-session revocation against issuance and contains only the retired identity across pools", async () => {
      const context = await debate(await actor()),
        f = fixture();
      await f.repo.issueSpeakerGrant(context);
      const [old] = await grants(context);
      await endAllAccountSessions(b, context.userId);
      assert.equal(
        await f.repo.isCurrentGrant(context.debateId, old.identity),
        false,
      );
      assert.equal((await grants(context))[0].state, "revoking");
      assert.equal(f.removed.length, 0);
      await f.repo.flush();
      assert.ok(
        f.removed.some(
          (entry) =>
            entry.identity === old.identity &&
            entry.debateId === context.debateId,
        ),
      );
      const next = {
        ...(await session(context.userId)),
        debateId: context.debateId,
      };
      await f.repo.issueSpeakerGrant(next);
      const newer = (await grants(context)).find(
        (grant) => grant.state === "active",
      );
      assert.notEqual(newer.identity, old.identity);
      await f.repo.flush();
      assert.equal(
        await f.repo.isCurrentGrant(context.debateId, newer.identity),
        true,
      );
      assert.equal(
        f.removed.filter((entry) => entry.identity === old.identity).length,
        1,
      );
      await assert.rejects(f.repo.issueSpeakerGrant(context), /session/);
    });
    it("keeps the remaining device's SID when another device signs out and retires only the signed-out SID", async () => {
      const context = await debate(await actor()),
        f = fixture(),
        other = await session(context.userId);
      await f.repo.issueSpeakerGrant(context);
      const [grant] = await grants(context);
      const generation = async (userId) =>
        (
          await owner.query(
            "SELECT auth_generation::text AS generation FROM users WHERE id=$1",
            [userId],
          )
        ).rows[0].generation;
      const before = await generation(context.userId);
      assert.deepEqual(
        await createSessionRepository(b).revokeSession(
          context.userId,
          other.sessionTokenHash,
        ),
        { current: true },
      );
      assert.equal(await generation(context.userId), before);
      assert.equal((await grants(context))[0].state, "active");
      assert.equal(
        await f.repo.isCurrentGrant(context.debateId, grant.identity),
        true,
      );
      await f.repo.issueSpeakerGrant(context);
      assert.equal((await grants(context))[0].identity, grant.identity);
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM media_account_revocations WHERE grant_id=$1",
            [grant.id],
          )
        ).rows[0].n,
        0,
      );
      const second = await debate(await actor()),
        another = await session(second.userId);
      await f.repo.issueSpeakerGrant(second);
      assert.deepEqual(
        await createSessionRepository(b).revokeSession(
          second.userId,
          another.sessionTokenHash,
          second.sessionId,
        ),
        { current: false },
      );
      assert.equal((await grants(second))[0].state, "revoking");
      assert.equal(
        await f.repo.isCurrentGrant(
          second.debateId,
          (await grants(second))[0].identity,
        ),
        false,
      );
      await f.repo.flush();
    });
    it("requires confirmed old-token revocation before moving the publishing device and retries provider outages", async () => {
      const first = await debate(await actor()),
        next = { ...(await session(first.userId)), debateId: first.debateId };
      let broken = true;
      const f = fixture(a, {
        removeSpeaker: async (debateId, identity) => {
          if (broken) throw Error("https://private-provider.example/secret");
          f.removed.push({ debateId, identity });
        },
      });
      await f.repo.issueSpeakerGrant(first);
      const [old] = await grants(first);
      await assert.rejects(
        f.repo.issueSpeakerGrant(next),
        /active on another device/,
      );
      assert.equal((await grants(first))[0].state, "active");
      await assert.rejects(
        f.repo.issueSpeakerGrant({ ...next, allowReplacement: true }),
        MediaRevocationPendingError,
      );
      assert.equal(f.minted.length, 1);
      await f.repo.flush();
      const retry = (
        await owner.query(
          "SELECT state,last_error FROM media_account_revocations WHERE grant_id=$1",
          [old.id],
        )
      ).rows[0];
      assert.deepEqual(retry, {
        state: "pending",
        last_error: "provider_error",
      });
      await assert.rejects(
        f.repo.issueSpeakerGrant(first),
        /active on another device/,
      );
      await assert.rejects(
        f.repo.issueSpeakerGrant(next),
        MediaRevocationPendingError,
      );
      assert.equal(f.minted.length, 1);
      broken = false;
      await due(old.id);
      await f.repo.flush();
      assert.equal(
        (await grants(first))[0].intended_session_id,
        next.sessionId,
      );
      const contenders = await Promise.allSettled([
        f.repo.issueSpeakerGrant(first),
        fixture(b).repo.issueSpeakerGrant(next),
      ]);
      assert.equal(contenders[0].status, "rejected");
      assert.match(contenders[0].reason.message, /another device/);
      assert.equal(contenders[1].status, "fulfilled");
      const active = (await grants(first)).filter(
        (grant) => grant.state === "active",
      );
      assert.equal(active.length, 1);
      assert.equal(active[0].session_id, next.sessionId);
      assert.notEqual(active[0].identity, old.identity);
      await assert.rejects(
        f.repo.issueSpeakerGrant(first),
        /active on another device/,
      );
      assert.equal(
        (await grants(first)).find((grant) => grant.state === "active").id,
        active[0].id,
      );
      assert.ok(
        f.observed.every(
          (value) => Object.keys(value).sort().join(",") === "result,seconds",
        ),
      );
      assert.ok(!JSON.stringify(f.observed).includes("secret"));
    });
    it("binds a pending replacement to its owned current session and requires manual Join after intent expiry", async () => {
      const first = await debate(await actor()),
        next = { ...(await session(first.userId)), debateId: first.debateId },
        stranger = await actor(),
        f = fixture();
      await f.repo.issueSpeakerGrant(first);
      await assert.rejects(
        f.repo.issueSpeakerGrant({ ...next, allowReplacement: true }),
        MediaRevocationPendingError,
      );
      const [old] = await grants(first);
      await assert.rejects(
        a.query(
          "UPDATE media_account_grants SET intended_session_id=$2 WHERE id=$1",
          [old.id, stranger.sessionId],
        ),
        /replacement session/,
      );
      await owner.query(
        "UPDATE media_account_grants SET intent_expires_at=clock_timestamp()+INTERVAL '100 milliseconds' WHERE id=$1",
        [old.id],
      );
      await owner.query("SELECT pg_sleep(0.11)");
      await f.repo.flush();
      await assert.rejects(f.repo.issueSpeakerGrant(next), /use Join/);
      await assert.rejects(f.repo.issueSpeakerGrant(first), /use Join/);
      await f.repo.issueSpeakerGrant({ ...next, allowReplacement: true });
      const active = (await grants(first)).find(
        (grant) => grant.state === "active",
      );
      assert.equal(active.session_id, next.sessionId);
      assert.notEqual(active.identity, old.identity);
    });
    it("ignores delayed departures for replaced UUID and legacy identities while pausing current or unknown departures", async () => {
      const first = await debate(await actor()),
        next = { ...(await session(first.userId)), debateId: first.debateId },
        f = fixture();
      await f.repo.issueSpeakerGrant(first);
      const [old] = await grants(first);
      await assert.rejects(
        f.repo.issueSpeakerGrant({ ...next, allowReplacement: true }),
        MediaRevocationPendingError,
      );
      await f.repo.flush();
      await f.repo.issueSpeakerGrant(next);
      const active = (await grants(first)).find(
        (grant) => grant.state === "active",
      );
      let pauses = 0;
      const pause = async (client) => {
        await client.query("SELECT 1");
        pauses++;
      };
      for (const identity of [old.identity, `speaker-${first.userId}`])
        assert.equal(
          await f.repo.withSpeakerDeparture(first.debateId, identity, pause),
          false,
        );
      assert.equal(pauses, 0);
      for (const identity of [
        active.identity,
        "speaker-untracked",
        "speaker-9223372036854775808",
      ])
        assert.equal(
          await f.repo.withSpeakerDeparture(first.debateId, identity, pause),
          true,
        );
      assert.equal(pauses, 3);
    });
    it("fences the departure relevance check and database pause against replacement issuance", async () => {
      const first = await debate(await actor()),
        next = { ...(await session(first.userId)), debateId: first.debateId },
        f = fixture(),
        other = fixture(b);
      await f.repo.issueSpeakerGrant(first);
      const [old] = await grants(first);
      let began, finish;
      const started = new Promise((resolve) => {
        began = resolve;
      });
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      const departure = f.repo.withSpeakerDeparture(
        first.debateId,
        old.identity,
        async (client) => {
          const { pid } = (await client.query("SELECT pg_backend_pid() AS pid"))
            .rows[0];
          began(pid);
          await gate;
          await client.query("SELECT 1");
        },
      );
      const pausePid = await started;
      const replacement = assert.rejects(
        other.repo.issueSpeakerGrant({ ...next, allowReplacement: true }),
        MediaRevocationPendingError,
      );
      let blocked = false;
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          blocked = Boolean(
            (
              await owner.query(
                "SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
                [pausePid],
              )
            ).rowCount,
          );
          if (blocked) break;
          await owner.query("SELECT pg_sleep(0.01)");
        }
        assert.equal(
          blocked,
          true,
          "replacement must wait until the fenced pause commits",
        );
        assert.equal((await grants(first))[0].state, "active");
      } finally {
        finish();
      }
      assert.equal(await departure, true);
      await replacement;
      assert.equal(
        (await grants(first))[0].intended_session_id,
        next.sessionId,
      );
    });
    it("contains suspension, an all-session incident and a raw generation advance while keeping logout independent of provider calls", async () => {
      for (const action of ["suspend", "incident", "generation"]) {
        const context = await debate(await actor()),
          f = fixture();
        await f.repo.issueSpeakerGrant(context);
        if (action === "suspend")
          await owner.query(
            "UPDATE users SET account_status='suspended' WHERE id=$1",
            [context.userId],
          );
        else if (action === "incident")
          // Decision 0009 removed password changes; the security-incident
          // path is the remaining credential-driven generation advance.
          await endAllAccountSessions(b, context.userId);
        else
          await owner.query(
            "UPDATE users SET auth_generation=auth_generation+1 WHERE id=$1",
            [context.userId],
          );
        const [grant] = await grants(context);
        assert.equal(grant.state, "revoking");
        assert.equal(
          await f.repo.isCurrentGrant(context.debateId, grant.identity),
          false,
        );
        await f.repo.flush();
        assert.equal((await grants(context))[0].state, "revoked");
      }
    });
    it("reconciles a naturally expired session even if its cookie row has not been deleted", async () => {
      const context = await debate(await actor(new Date(Date.now() + 1000))),
        f = fixture();
      await f.repo.issueSpeakerGrant(context);
      await owner.query("SELECT pg_sleep(1.05)");
      assert.equal((await grants(context))[0].state, "active");
      await f.repo.flush();
      assert.equal((await grants(context))[0].state, "revoked");
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM sessions WHERE id=$1",
            [context.sessionId],
          )
        ).rows[0].n,
        1,
      );
    });
    it("rolls back an in-flight minted token when its application session expires before commit", async () => {
      let minted = false;
      const context = await debate(await actor(new Date(Date.now() + 2000))),
        f = fixture(a, {
          mintSpeakerToken: async () => {
            minted = true;
            await owner.query("SELECT pg_sleep(2.1)");
            return "synthetic-unpublished-token";
          },
        });
      await assert.rejects(f.repo.issueSpeakerGrant(context), /session/);
      assert.equal(
        minted,
        true,
        "session must expire after local signing begins",
      );
      assert.equal((await grants(context)).length, 0);
    });
    it("claims a removal across workers without holding the account lock during the provider request", async () => {
      const context = await debate(await actor());
      let began, finish;
      const started = new Promise((resolve) => {
        began = resolve;
      });
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      const f = fixture(a, {
        timeoutMs: 1000,
        removeSpeaker: async (debateId, identity) => {
          f.removed.push({ debateId, identity });
          began();
          await gate;
        },
      });
      await f.repo.issueSpeakerGrant(context);
      const next = {
        ...(await session(context.userId)),
        debateId: context.debateId,
      };
      await assert.rejects(
        f.repo.issueSpeakerGrant({ ...next, allowReplacement: true }),
        MediaRevocationPendingError,
      );
      const processing = f.repo.flush();
      await started;
      const duplicate = fixture(b);
      await duplicate.repo.flush();
      const revoke = endAllAccountSessions(b, context.userId);
      let timer;
      try {
        await Promise.race([
          revoke,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("provider held account lock")),
              500,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        finish();
      }
      await processing;
      assert.equal(f.removed.length, 1);
      assert.equal(duplicate.removed.length, 0);
      assert.equal((await grants(context))[0].state, "revoked");
    });
    it("recovers an expired worker lease and ignores its delayed acknowledgement without kicking a new identity", async () => {
      const context = await debate(await actor()),
        initial = fixture();
      await initial.repo.issueSpeakerGrant(context);
      const [old] = await grants(context);
      await endAllAccountSessions(b, context.userId);
      let began, finish;
      const started = new Promise((resolve) => {
        began = resolve;
      });
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      const slow = fixture(a, {
        removeSpeaker: async (debateId, identity) => {
          began();
          await gate;
          slow.removed.push({ debateId, identity });
        },
      });
      const pending = slow.repo.flush();
      await started;
      try {
        await owner.query(
          "UPDATE media_account_revocations SET lease_until=clock_timestamp()-INTERVAL '1 second',available_at=clock_timestamp()-INTERVAL '1 second' WHERE grant_id=$1",
          [old.id],
        );
        const recovery = fixture(b);
        await recovery.repo.flush();
        assert.equal((await grants(context))[0].state, "revoked");
        const next = {
          ...(await session(context.userId)),
          debateId: context.debateId,
        };
        await recovery.repo.issueSpeakerGrant(next);
        const active = (await grants(context)).find(
          (grant) => grant.state === "active",
        );
        assert.notEqual(active.identity, old.identity);
        finish();
        await pending;
        assert.equal(
          await recovery.repo.isCurrentGrant(context.debateId, active.identity),
          true,
        );
        assert.equal(
          slow.observed.length,
          0,
          "a superseded acknowledgement is not reported as successful",
        );
      } finally {
        finish();
        await pending;
      }
    });
    it("times out failed removal, retains the publishing fence, and never calls self-hosted token invalidation complete", async () => {
      const context = await debate(await actor()),
        initial = fixture();
      await initial.repo.issueSpeakerGrant(context);
      await endAllAccountSessions(b, context.userId);
      const [grant] = await grants(context);
      const timed = fixture(a, {
        timeoutMs: 100,
        removeSpeaker: () => new Promise(() => {}),
      });
      await timed.repo.flush();
      assert.equal(
        (
          await owner.query(
            "SELECT last_error FROM media_account_revocations WHERE grant_id=$1",
            [grant.id],
          )
        ).rows[0].last_error,
        "provider_timeout",
      );
      await due(grant.id);
      const selfHosted = fixture(a, { supportsTokenRevocation: false });
      await selfHosted.repo.flush();
      assert.equal((await grants(context))[0].state, "revoking");
      assert.equal(
        (
          await owner.query(
            "SELECT last_error FROM media_account_revocations WHERE grant_id=$1",
            [grant.id],
          )
        ).rows[0].last_error,
        "unsupported_token_revocation",
      );
      assert.ok(
        selfHosted.observed.some((value) => value.result === "unsupported"),
      );
      await due(grant.id);
      await initial.repo.flush();
      assert.equal((await grants(context))[0].state, "revoked");
    });
  },
);
