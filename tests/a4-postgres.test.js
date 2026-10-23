import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import request from "../scripts/test-http-request.ts";
import { createA4Repository } from "../dist/features/a4/repository.js";
import {
  createPublicBotRepository,
  simulationArguments,
  syntheticRound,
} from "../dist/features/a4/public-bots.js";
import {
  account,
  post,
  transfer,
  reconcile,
} from "../dist/features/a4/ledger.js";
import { createDatabase } from "../dist/platform/database.js";
import { createLogger } from "../dist/platform/logger.js";
import { createSessionRepository } from "../dist/platform/auth/sessions.js";
import { createSessionToken } from "../dist/platform/auth/session-tokens.js";
import { endAllAccountSessions } from "./helpers/account-sessions.js";
import { createApp } from "../dist/app.js";
import { createMessageRepository } from "../dist/features/messages/repository.js";
const enabled = !!process.env.A4_TEST_DATABASE_URL;
if (enabled) {
  const runtime = new URL(process.env.A4_TEST_DATABASE_URL),
    owner = new URL(process.env.A4_TEST_OWNER_URL);
  for (const url of [runtime, owner]) {
    assert.ok(
      ["localhost", "127.0.0.1"].includes(url.hostname),
      "A4 tests require a local disposable database",
    );
    assert.match(
      url.pathname,
      /^\/(?:revocation_test|yaparena_a4_test)[a-z0-9_]*$/,
    );
  }
  assert.equal(runtime.host, owner.host);
  assert.equal(runtime.pathname, owner.pathname);
  assert.equal(runtime.username, "yaparena_runtime");
  assert.equal(owner.username, "yaparena_owner");
}
const logger = createLogger({ enabled: false });
let pool, owner, a4, sessions, debateId, topicId;
const key = () => randomUUID();
async function actor() {
  const u = (
    await pool.query(
      `INSERT INTO users DEFAULT VALUES
       RETURNING id,auth_generation AS "authGeneration"`,
    )
  ).rows[0];
  const token = createSessionToken();
  await sessions.create(u.id, token.tokenHash, new Date(Date.now() + 3600000), {
    authGeneration: u.authGeneration,
  });
  return {
    userId: u.id,
    tokenHash: token.tokenHash,
    cookie: `session=${token.token}`,
  };
}
async function run(a, config = {}, mode = "mixed", extra = {}) {
  const result = await a4.create(a, key(), {
    debateId,
    mode,
    config: { population: 10, roundSeconds: 60, ...config },
    ...extra,
  });
  return a4.view(a, result.id);
}
async function roundState(a, id) {
  return (await a4.view(a, id)).rounds[0];
}
async function finish(id) {
  await owner.query(
    "UPDATE a4_rounds SET closes_at=clock_timestamp()-INTERVAL '1 second',opens_at=clock_timestamp()-INTERVAL '2 seconds' WHERE session_id=$1 AND state IN ('scheduled','open')",
    [id],
  );
  await owner.query(
    "UPDATE a4_sessions SET reveal_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
    [id],
  );
  for (let i = 0; i < 35; i++) {
    await a4.tick();
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM a4_rounds WHERE session_id=$1 AND state NOT IN ('settled','void')",
      [id],
    );
    if (r.rows[0].n === 0) return;
  }
  throw new Error("round did not finish");
}
async function terminal(a, id) {
  await a4.control(a, key(), id, "archive");
}
function app(repo = a4) {
  return createApp({
    a4: repo,
    sessions,
    messages: createMessageRepository(pool),
    logger,
    environment: "test",
    apiRateLimit: 100000,
  });
}
const command = (app, a, path, body, k = key()) =>
  request(app)
    .post(`/api/a4/${path}`)
    .set("Cookie", a.cookie)
    .set("Idempotency-Key", k)
    .send(body);
describe(
  "A4 runtime-role PostgreSQL",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      pool = createDatabase(process.env.A4_TEST_DATABASE_URL, logger);
      owner = new pg.Pool({
        connectionString: process.env.A4_TEST_OWNER_URL,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      sessions = createSessionRepository(pool);
      a4 = createA4Repository(pool, "bots");
      await owner.query(
        "UPDATE a4_controls SET enabled=true,bots_enabled=true",
      );
      const tag = key();
      topicId = (
        await owner.query(
          "INSERT INTO topics(slug,title,summary,side_a_label,side_b_label,publication_state) VALUES($1,'A4 test topic','Synthetic A4 fixture topic','Support','Oppose','published') RETURNING id",
          [`a4-${tag}`],
        )
      ).rows[0].id;
      debateId = (
        await owner.query(
          "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) VALUES($1,$2,'Should this synthetic proposition be endorsed?','scheduled','published','preview-1','{}') RETURNING id",
          [`a4-${tag}`, topicId],
        )
      ).rows[0].id;
    });
    after(async () => {
      await pool?.end();
      await owner?.end();
    });
    it("shares only consented settled mixed/observer aggregates, excludes hidden/future/private data and follows new rounds automatically", async () => {
      const a = await actor(),
        b = await actor(),
        publicBots = createPublicBotRepository(pool);
      const mixed = await run(a, { argumentLabel: "Public cost analysis" }),
        other = await run(b);
      await a4.submit(a, key(), mixed.rounds[0].id, {
        side: "YES",
        limit: "0.5",
        quantity: 1,
        rule: mixed.config.rule,
      });
      await finish(mixed.id);
      await finish(other.id);
      assert.equal((await publicBots.debate(debateId)).items.length, 0);
      await a4.publication(a, true);
      await a4.publication(a, true);
      const first = await publicBots.debate(debateId);
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0].id, mixed.rounds[0].id);
      assert.equal(first.items[0].humans, 1);
      assert.equal(first.items[0].argumentLabel, "Public cost analysis");
      assert.equal(first.items[0].runId, null);
      assert.equal(JSON.stringify(first).includes(a.userId + "@"), false);
      assert.equal("balances" in first, false);
      const observer = await run(a, {}, "observer");
      assert.equal(
        (await publicBots.debate(debateId)).revision,
        first.revision,
      );
      await finish(observer.id);
      const next = await publicBots.debate(debateId);
      assert.equal(next.items.length, 2);
      assert.equal(next.items.at(-1).mode, "observer");
      assert.notEqual(next.revision, first.revision);
      await owner.query(
        "UPDATE a4_sessions SET reveal_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [observer.id],
      );
      assert.equal((await publicBots.debate(debateId)).items.length, 1);
      await owner.query(
        "UPDATE a4_sessions SET reveal_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [observer.id],
      );
      const catalog = simulationArguments("Should transport be free?");
      await owner.query(
        "INSERT INTO a4_synthetic_debates(debate_id,arguments,category) VALUES($1,$2,$3)",
        [debateId, JSON.stringify(catalog.arguments), catalog.category],
      );
      await owner.query(
        "INSERT INTO a4_synthetic_rounds(id,debate_id,seed_key,simulated_at,seed,result) VALUES($1,$2,$3,clock_timestamp()-interval '1 day','seed',$4)",
        [key(), debateId, key(), JSON.stringify(syntheticRound("seed", 1, 20))],
      );
      const seeded = await publicBots.debate(debateId);
      assert.equal(seeded.items.length, 3);
      assert.equal(seeded.arguments.length, 6);
      assert.equal(seeded.items[0].mode, "seed");
      assert.equal(
        (await publicBots.topics([topicId]))[topicId].items.length,
        3,
      );
      await a4.publication(a, false);
      assert.equal((await publicBots.debate(debateId)).items.length, 1);
      await owner.query(
        "UPDATE debates SET publication_state='hidden' WHERE id=$1",
        [debateId],
      );
      assert.equal(await publicBots.debate(debateId), null);
      assert.equal(
        (await publicBots.topics([topicId]))[topicId].items.length,
        0,
      );
      await owner.query(
        "UPDATE debates SET publication_state='published' WHERE id=$1",
        [debateId],
      );
      await request(app()).get("/api/a4/publication").expect(401);
      await command(app(), a, "publication", { published: "yes" }).expect(400);
      await command(app(), a, "publication", { published: true }).expect(200);
      assert.equal((await a4.publication(a)).published, true);
      await a4.publication(a, false);
      await assert.rejects(
        pool.query(
          "INSERT INTO a4_synthetic_debates(debate_id,arguments,category) VALUES($1,'[]','Ideas')",
          [key()],
        ),
        (error) => error.code === "42501",
      );
    });
    it("charts only finalized settlements, separates private creators and excludes observer/pending information", async () => {
      const a = await actor(),
        b = await actor();
      const first = await run(a, {
          population: 10,
          argumentLabel: "Cost analysis",
        }),
        other = await run(b, { population: 10 });
      assert.deepEqual((await a4.timeline(a, debateId, "sandbox")).items, []);
      await a4.control(a, key(), first.id, "step");
      assert.deepEqual((await a4.timeline(a, debateId, "sandbox")).items, []);
      await finish(first.id);
      await finish(other.id);
      const own = await a4.timeline(a, debateId, "sandbox");
      assert.equal(own.items.length, 1);
      assert.equal(own.items[0].runId, first.id);
      assert.equal(own.items[0].bots, 10);
      assert.equal(own.items[0].argumentLabel, "Cost analysis");
      assert.equal(own.items[0].ownLimit, null);
      const actual = (await a4.view(a, first.id)).rounds[0].diagnostics.pricing;
      assert.deepEqual(own.items[0].medianNo, actual.a);
      assert.deepEqual(own.items[0].medianYes, actual.b);
      assert.deepEqual(own.items[0].offer, actual.price);
      assert.equal(own.totals.botCommitments, 10);
      assert.deepEqual((await a4.timeline(a, debateId, "human")).items, []);
      assert.equal(
        (await a4.timeline(b, debateId, "sandbox")).items[0].runId,
        other.id,
      );
      const observer = await run(a, { population: 10 }, "observer");
      await finish(observer.id);
      assert.equal((await a4.timeline(a, debateId, "sandbox")).items.length, 1);
      const human = await run(
        a,
        { population: 0, argumentLabel: "Pilot studies" },
        "human",
      );
      await a4.submit(a, key(), human.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: human.config.rule,
      });
      await a4.submit(b, key(), human.rounds[0].id, {
        side: "NO",
        limit: "0",
        quantity: 1,
        rule: human.config.rule,
      });
      await finish(human.id);
      const settled = await a4.timeline(b, debateId, "human");
      assert.equal(settled.items.length, 1);
      assert.equal(settled.items[0].humans, 2);
      assert.equal(settled.items[0].bots, 0);
      assert.deepEqual(settled.items[0].share, { n: "1", d: "2" });
      assert.equal(settled.items[0].argumentLabel, "Pilot studies");
      assert.equal(settled.items[0].ownLimit, "0");
      assert.equal(
        (await a4.timeline(a, debateId, "human")).items[0].ownLimit,
        "1",
      );
      assert.equal(settled.totals.premium, "1000001");
      for (const item of settled.items)
        for (const secret of [
          "seed",
          "snapshot",
          "user_id",
          "pricing",
          "outcome",
          "payout",
          "net",
        ])
          assert.equal(item[secret], undefined);
      await owner.query(
        "UPDATE topics SET publication_state='draft' WHERE id=$1",
        [topicId],
      );
      try {
        await assert.rejects(
          a4.timeline(a, debateId, "human"),
          /debate not found/,
        );
      } finally {
        await owner.query(
          "UPDATE topics SET publication_state='published' WHERE id=$1",
          [topicId],
        );
      }
    });
    it("uses actual sessions, persistent starter credit, binding review and idempotent receipts", async () => {
      const a = await actor(),
        api = app();
      assert.equal((await request(api).get("/api/a4/wallet")).status, 401);
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            config: { population: 10 },
          })
        ).status,
        201,
      );
      const list = (
        await request(api).get("/api/a4/runs").set("Cookie", a.cookie)
      ).body;
      const id = list.items[0].id,
        v = await a4.view(a, id),
        r = v.rounds[0];
      assert.equal(
        v.balances.find((b) => b.kind === "available").amount,
        "1000000000",
      );
      const b = {
          side: "NO",
          ceiling: "0.78",
          quantity: 10,
          rule: "a4-v1",
          accountId: a.userId,
        },
        k = key();
      const receipt = await command(api, a, `rounds/${r.id}/submit`, b, k);
      assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
      assert.equal(receipt.body.limit, "0.220000");
      assert.deepEqual(
        (await command(api, a, `rounds/${r.id}/submit`, b, k)).body,
        receipt.body,
      );
      assert.equal(
        (
          await command(
            api,
            a,
            `rounds/${r.id}/submit`,
            { ...b, quantity: 11 },
            k,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await command(api, a, `rounds/${r.id}/submit`, {
            ...b,
            accountId: "999999",
          })
        ).status,
        409,
      );
      assert.equal(
        (await command(api, a, `rounds/${r.id}/submit`, b)).status,
        409,
      );
      const recovered = await createA4Repository(pool, "bots").view(a, id);
      assert.equal(recovered.rounds[0].receipt.reserved, "10000000");
      assert.equal(recovered.rounds[0].diagnostics, undefined);
      await finish(id);
      assert.equal((await a4.view(a, id)).state, "complete");
      assert.ok(
        ["settled", "limit_not_met", "no_opposite"].includes(
          (await a4.view(a, id)).rounds[0].receipt.status,
        ),
      );
      const hist = await a4.history(a);
      assert.ok(hist.items.some((i) => i.kind === "settlement"));
      assert.ok(hist.items.every((i) => !("metadata" in i)));
    });
    it("handles 500 bots, separate center funding, observer access and paginated books", async () => {
      const a = await actor(),
        started = performance.now();
      const v = await run(a, { population: 500 }, "observer", {
        seed: "500-bot-replay",
      });
      assert.equal(v.observer, true);
      assert.equal(v.rounds[0].diagnostics.totals.bots, 500);
      assert.equal(v.rounds[0].diagnostics.totals.humans, 0);
      assert.equal(v.rounds[0].diagnostics.book.length, 50);
      assert.equal(v.rounds[0].diagnostics.pagination.hasMore, true);
      await assert.rejects(
        a4.submit(a, key(), v.rounds[0].id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /observer/,
      );
      await assert.rejects(a4.refill(a, key(), v.id), /observer/);
      const other = await actor();
      await assert.rejects(a4.view(other, v.id), /not found/);
      assert.equal(
        (await a4.list(other)).items.some((i) => i.id === v.id),
        false,
      );
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      const d = (await a4.view(a, v.id, 50, 10)).rounds[0].diagnostics;
      assert.equal(d.book.length, 10);
      assert.equal(d.pagination.offset, 50);
      assert.ok(d.totals.executed >= 0);
      await finish(v.id);
      assert.equal((await a4.view(a, v.id)).state, "complete");
      const c = await pool.connect();
      try {
        assert.deepEqual(await reconcile(c, v.id), { reconciled: true });
      } finally {
        c.release();
      }
      console.log(
        JSON.stringify({
          scenario: "500 bots",
          createAndSettleMs: Math.round(performance.now() - started),
          population: 500,
          asset: "YAP",
        }),
      );
    });
    it("keeps two distinct delayed shares, payouts and aggregate diagnostics sealed until T", async () => {
      const a = await actor(),
        v = await run(a, {
          population: 5,
          periods: 2,
          delayed: true,
          feeBps: 500,
        });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 2,
        rule: "a4-v1",
      });
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      let sealed = await a4.view(a, v.id);
      assert.equal(sealed.rounds[0].state, "pending");
      assert.equal(sealed.rounds[0].diagnostics, undefined);
      assert.equal(sealed.rounds[0].receipt.payout, undefined);
      assert.equal(sealed.rounds[0].receipt.net, undefined);
      assert.equal(sealed.researchSeed, undefined);
      const before = sealed.balances.find((b) => b.kind === "available").amount;
      // Restart/second process recovers the same committed price and posts no early payout.
      const originalOffer = sealed.rounds[0].offer;
      await createA4Repository(pool, "bots").tick();
      sealed = await a4.view(a, v.id);
      assert.equal(
        sealed.balances.find((b) => b.kind === "available").amount,
        before,
      );
      assert.deepEqual(sealed.rounds[0].offer, originalOffer);
      assert.equal(
        (await a4.history(a)).items.some((i) => i.kind === "settlement"),
        false,
      );
      await a4.control(a, key(), v.id, "step");
      const counts = await owner.query(
        "SELECT round_id,count(*) FILTER(WHERE side='YES')::int AS yes FROM a4_submissions WHERE round_id=ANY($1::uuid[]) GROUP BY round_id",
        [v.rounds.map((r) => r.id)],
      );
      const previousYes = counts.rows.find(
        (r) => r.round_id === v.rounds[0].id,
      ).yes;
      const nextYes = counts.rows.find(
        (r) => r.round_id === v.rounds[1].id,
      ).yes;
      await a4.submit(a, key(), v.rounds[1].id, {
        side: previousYes === nextYes + 1 ? "NO" : "YES",
        limit: "0.5",
        quantity: 1,
        rule: "a4-v1",
      });
      await finish(v.id);
      const final = await a4.view(a, v.id);
      assert.ok(final.rounds.every((r) => r.revealed));
      const stored = await pool.query(
        "SELECT pricing FROM a4_rounds WHERE session_id=$1 ORDER BY period",
        [v.id],
      );
      assert.notDeepEqual(
        stored.rows[0].pricing.share,
        stored.rows[1].pricing.share,
      );
      assert.equal(
        final.rounds[0].diagnostics.pricing.share.n,
        stored.rows[0].pricing.share.n,
      );
      assert.equal(
        final.rounds[1].diagnostics.pricing.share.n,
        stored.rows[1].pricing.share.n,
      );
    });
    it("serializes same-account commitments across sessions and prevents overspending", async () => {
      const a = await actor();
      const one = await run(a, { population: 2 }, "human").catch(async () =>
        a4.view(
          a,
          (
            await a4.create(a, key(), {
              debateId,
              mode: "human",
              config: { population: 0 },
            })
          ).id,
        ),
      );
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          a4.submit(a, key(), one.rounds[0].id, {
            side: "YES",
            limit: "1",
            quantity: 100,
            rule: "a4-v1",
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const count = (
        await pool.query(
          "SELECT count(*)::int AS n FROM a4_submissions WHERE round_id=$1 AND user_id=$2",
          [one.rounds[0].id, a.userId],
        )
      ).rows[0].n;
      assert.equal(count, 1);
      const a2 = { ...a, tokenHash: createSessionToken().tokenHash };
      await assert.rejects(
        a4.submit(a2, key(), one.rounds[0].id, {
          side: "NO",
          limit: "0",
          quantity: 1,
          rule: "a4-v1",
        }),
        /session/,
      );
      await finish(one.id);
    });
    it("rechecks cutoff after ledger lock waits, immediately at cutoff and with stale sessions", async () => {
      const a = await actor(),
        v = await run(a, { population: 2 }),
        r = v.rounds[0];
      const blocker = await owner.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`a4-ledger:${v.id}`],
      );
      await owner.query(
        "UPDATE a4_rounds SET closes_at=clock_timestamp()+INTERVAL '0.2 second',opens_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
        [r.id],
      );
      const pending = assert.rejects(
        a4.submit(a, key(), r.id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /cutoff/,
      );
      await delay(300);
      await blocker.query("COMMIT");
      blocker.release();
      await pending;
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM a4_submissions WHERE round_id=$1 AND user_id=$2",
            [r.id, a.userId],
          )
        ).rows[0].n,
        0,
      );
      await assert.rejects(
        a4.submit(a, key(), r.id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /cutoff/,
      );
      await endAllAccountSessions(pool, a.userId);
      await assert.rejects(a4.refill(a, key(), v.id), /session/);
      await finish(v.id);
    });
    it("makes refill and controls idempotent and archives only the selected sandbox", async () => {
      const a = await actor(),
        v = await run(a, { population: 5 }),
        second = await run(a, { population: 2 });
      const k = key();
      const first = await a4.refill(a, k, v.id);
      assert.equal(first.issued, true);
      assert.deepEqual(await a4.refill(a, k, v.id), first);
      assert.equal((await a4.refill(a, key(), v.id)).issued, false);
      assert.equal(
        (await a4.view(a, second.id)).balances.find(
          (b) => b.kind === "available",
        ).amount,
        "1000000000",
      );
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 100,
        rule: "a4-v1",
      });
      await a4.control(a, key(), v.id, "pause");
      await assert.rejects(
        a4.submit(a, key(), v.rounds[0].id, {
          side: "YES",
          limit: "1",
          quantity: 1,
          rule: "a4-v1",
        }),
        /paused/,
      );
      await a4.control(a, key(), v.id, "speed", 20);
      assert.equal((await a4.view(a, v.id)).speed, 20);
      await a4.control(a, key(), v.id, "run");
      const step = key();
      await a4.control(a, step, v.id, "step");
      const state = await roundState(a, v.id);
      await a4.control(a, step, v.id, "step");
      assert.equal((await roundState(a, v.id)).state, state.state);
      await terminal(a, second.id);
      assert.equal((await a4.view(a, second.id)).state, "archived");
      assert.equal((await a4.view(a, v.id)).state, "running");
      await finish(v.id);
      assert.ok((await a4.list(a, debateId)).items.length >= 2);
    });
    it("settles outstanding exposure after disabling admission and survives duplicate workers", async () => {
      const a = await actor(),
        v = await run(a, { population: 10 });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      await owner.query("UPDATE a4_controls SET enabled=false");
      try {
        await assert.rejects(a4.refill(a, key(), v.id), /disabled/);
        await assert.rejects(
          a4.create(a, key(), { debateId, mode: "mixed" }),
          /disabled/,
        );
        await owner.query(
          "UPDATE a4_rounds SET closes_at=clock_timestamp()-INTERVAL '1 second',opens_at=clock_timestamp()-INTERVAL '2 seconds' WHERE session_id=$1",
          [v.id],
        );
        await owner.query(
          "UPDATE a4_sessions SET reveal_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",
          [v.id],
        );
        for (let i = 0; i < 6; i++)
          await Promise.all([
            a4.tick(),
            createA4Repository(pool, "disabled").tick(),
          ]);
        assert.equal((await a4.view(a, v.id)).state, "complete");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
              [`settle:${v.rounds[0].id}`],
            )
          ).rows[0].n,
          1,
        );
      } finally {
        await owner.query("UPDATE a4_controls SET enabled=true");
      }
    });
    it("enforces runtime grants, balanced journals, asset segregation and projection rollback", async () => {
      for (const sql of [
        "DELETE FROM a4_postings",
        "UPDATE a4_journals SET kind=kind",
        "UPDATE a4_assets SET precision=8",
        "UPDATE a4_controls SET enabled=false",
        "UPDATE a4_rounds SET seed=seed",
        "UPDATE a4_sessions SET config=config",
      ])
        await assert.rejects(pool.query(sql), (e) => e.code === "42501");
      const c = await pool.connect();
      const scope = `test-${key()}`;
      try {
        await c.query("BEGIN");
        await assert.rejects(
          post(c, key(), "bad", [
            { account: account(scope, "x", "available"), amount: 1n },
          ]),
          /unbalanced/,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            key(),
            "bad",
            transfer(
              account(scope, "x", "issuer"),
              account(scope, "y", "available", null, "TEST8"),
              1n,
            ),
          ),
          /mixed-asset/,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            key(),
            "bad",
            transfer(
              account(scope, "x", "available"),
              account(scope, "y", "available"),
              1n,
            ),
          ),
          (e) => e.code === "23514",
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query(
          "INSERT INTO a4_journals(reference,scope,asset,kind,metadata) VALUES($1,$2,'YAP','bad','{}')",
          [key(), scope],
        );
        await assert.rejects(c.query("COMMIT"), (e) => e.code === "23514");
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        const ref = key();
        await post(
          c,
          ref,
          "test",
          transfer(
            account(scope, "x", "issuer"),
            account(scope, "y", "available"),
            100n,
          ),
        );
        await c.query("COMMIT");
        await c.query("BEGIN");
        await assert.rejects(
          post(
            c,
            ref,
            "test",
            transfer(
              account(scope, "x", "issuer"),
              account(scope, "y", "available"),
              100n,
            ),
          ),
          /already posted/,
        );
        await c.query("ROLLBACK");
        assert.deepEqual(await reconcile(c, scope), { reconciled: true });
      } finally {
        c.release();
      }
    });
    it("rejects untrusted flags, malformed inputs, unsupported rules and cross-account reads", async () => {
      const a = await actor(),
        b = await actor(),
        v = await run(a, { population: 2 }),
        api = app();
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            observer: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            seed: "known",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await command(api, a, "runs", {
            debateId,
            mode: "mixed",
            config: { asset: "USD" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(api)
            .get(`/api/a4/runs/${v.id}?observer=true`)
            .set("Cookie", b.cookie)
        ).status,
        404,
      );
      assert.equal(
        (
          await request(api)
            .get(`/api/a4/runs/${v.id}?limit=999`)
            .set("Cookie", a.cookie)
        ).status,
        400,
      );
      assert.equal(
        (
          await command(api, a, `rounds/${v.rounds[0].id}/submit`, {
            side: "YES",
            ceiling: "0.5",
            quantity: 1,
            rule: "a3",
            accountId: a.userId,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await command(api, a, `rounds/${v.rounds[0].id}/submit`, {
            side: "YES",
            ceiling: 0.5,
            quantity: 1,
            rule: "a4-v1",
            accountId: a.userId,
          })
        ).status,
        400,
      );
      assert.equal(
        (await command(api, a, `runs/${v.id}/control`, { action: "elevate" }))
          .status,
        400,
      );
      await terminal(a, v.id);
    });
  },
);

// These cases use owner-only failure fixtures; product mutations run as runtime.
describe(
  "A4 durable failure and backing cases",
  { skip: !enabled, concurrency: false },
  () => {
    before(async () => {
      pool = createDatabase(process.env.A4_TEST_DATABASE_URL, logger);
      owner = new pg.Pool({
        connectionString: process.env.A4_TEST_OWNER_URL,
        options: "-c search_path=pg_catalog,yaparena,pg_temp",
      });
      sessions = createSessionRepository(pool);
      a4 = createA4Repository(pool, "bots");
      await owner.query(
        "UPDATE a4_controls SET enabled=true,bots_enabled=true",
      );
    });
    after(async () => {
      await pool?.end();
      await owner?.end();
    });
    it("rolls back failures before/after draw persistence and recovers without new draws or payouts", async () => {
      const a = await actor(),
        v = await run(a, { population: 10 });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      await a4.control(a, key(), v.id, "step");
      const constraint = `a4_fault_${key().replaceAll("-", "")}`;
      try {
        await owner.query(
          `ALTER TABLE a4_audit ADD CONSTRAINT ${constraint} CHECK(action<>'round.price' OR session_id<>'${v.id}'::uuid) NOT VALID`,
        );
        const request = key();
        await assert.rejects(a4.control(a, request, v.id, "step"), /invariant/);
        assert.equal((await roundState(a, v.id)).state, "locked");
        await owner.query(`ALTER TABLE a4_audit DROP CONSTRAINT ${constraint}`);
        await a4.control(a, request, v.id, "step");
        const draw = (await roundState(a, v.id)).offer;
        await owner.query(
          `ALTER TABLE a4_audit ADD CONSTRAINT ${constraint} CHECK(action<>'round.execute' OR session_id<>'${v.id}'::uuid) NOT VALID`,
        );
        await assert.rejects(a4.control(a, key(), v.id, "step"), /invariant/);
        assert.equal((await roundState(a, v.id)).state, "priced");
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
              [`execute:${v.rounds[0].id}`],
            )
          ).rows[0].n,
          0,
        );
        await owner.query(`ALTER TABLE a4_audit DROP CONSTRAINT ${constraint}`);
        await createA4Repository(pool, "bots").tick();
        assert.deepEqual((await roundState(a, v.id)).offer, draw);
        await finish(v.id);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
              [`settle:${v.rounds[0].id}`],
            )
          ).rows[0].n,
          1,
        );
      } finally {
        await owner.query(
          `ALTER TABLE a4_audit DROP CONSTRAINT IF EXISTS ${constraint}`,
        );
      }
    });
    it("records a genuine center loss, separate from play issuance and fees", async () => {
      const a = await actor(),
        v = await run(
          a,
          { population: 100, preset: "reference", epsilon: 0 },
          "observer",
          { seed: "loss-4" },
        );
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      await finish(v.id);
      const d = (await a4.view(a, v.id)).rounds[0].diagnostics;
      assert.equal(d.pricing.share.n, "3");
      assert.equal(d.pricing.share.d, "50");
      assert.ok(BigInt(d.centerTrading) < 0n);
      assert.equal(d.centerFees, "0");
      const issuance = (
        await pool.query(
          "SELECT count(*)::int AS n FROM a4_journals WHERE scope=$1 AND kind='play_center_issuance'",
          [v.id],
        )
      ).rows[0].n;
      assert.equal(issuance, 1);
    });
    it("does not strand a pending payout when paused future windows expire", async () => {
      const a = await actor(),
        v = await run(a, { population: 4, periods: 2, delayed: true });
      await a4.submit(a, key(), v.rounds[0].id, {
        side: "YES",
        limit: "1",
        quantity: 1,
        rule: "a4-v1",
      });
      for (let i = 0; i < 3; i++) await a4.control(a, key(), v.id, "step");
      await a4.control(a, key(), v.id, "pause");
      await finish(v.id);
      const final = await a4.view(a, v.id);
      assert.equal(final.rounds[0].state, "settled");
      assert.equal(final.rounds[1].state, "void");
      assert.equal(final.rounds[1].revealed, true);
    });
    it("shares starter/refill grants and reservations across two sessions on one account", async () => {
      const a = await actor();
      const cloned = (
        await owner.query(
          "INSERT INTO debates(slug,topic_id,proposition,status,publication_state,rules_version,rules_snapshot) SELECT $1,topic_id,proposition,status,publication_state,rules_version,rules_snapshot FROM debates WHERE id=$2 RETURNING id",
          [`a4-${key()}`, debateId],
        )
      ).rows[0].id;
      const one = await a4.create(a, key(), { debateId, mode: "human" });
      const two = await a4.create(a, key(), {
        debateId: cloned,
        mode: "human",
      });
      const token = createSessionToken(),
        u = (
          await pool.query(
            "SELECT auth_generation AS generation FROM users WHERE id=$1",
            [a.userId],
          )
        ).rows[0];
      await sessions.create(
        a.userId,
        token.tokenHash,
        new Date(Date.now() + 3600000),
        { authGeneration: u.generation },
      );
      const second = { ...a, tokenHash: token.tokenHash };
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await post(
          c,
          `fixture-debit:${key()}`,
          "fixture_play_debit",
          transfer(
            account("global", `user:${a.userId}`, "available", a.userId),
            account("global", "play-issuer", "issuer"),
            850000000n,
          ),
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const rounds = await Promise.all([
        a4.view(a, one.id),
        a4.view(second, two.id),
      ]);
      const submitted = await Promise.allSettled(
        rounds.map((v, i) =>
          a4.submit(i ? second : a, key(), v.rounds[0].id, {
            side: "YES",
            limit: "1",
            quantity: 100,
            rule: "a4-v1",
          }),
        ),
      );
      assert.equal(submitted.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(
        (await a4.wallet(a)).balances.find((b) => b.kind === "available")
          .amount,
        "50000000",
      );
      const grants = await Promise.all(
        Array.from({ length: 8 }, () => a4.refill(a, key())),
      );
      assert.equal(grants.filter((x) => x.issued).length, 1);
      await finish(one.id);
      await finish(two.id);
    });
    it("applies configured play grants without reissuing prior business references", async () => {
      const a = await actor(),
        custom = createA4Repository(pool, "bots", {
          starterCoins: 250,
          refillCoins: 50,
          botCoins: 105,
        });
      const v = await custom.create(a, key(), {
        debateId,
        mode: "mixed",
        config: { population: 2 },
      });
      assert.equal(
        (await custom.view(a, v.id)).balances.find(
          (b) => b.kind === "available",
        ).amount,
        "250000000",
      );
      const refill = await custom.refill(a, key(), v.id);
      assert.equal(refill.amount, "50000000");
      assert.equal(
        (await custom.view(a, v.id)).balances.find(
          (b) => b.kind === "available",
        ).amount,
        "300000000",
      );
      assert.equal((await a4.refill(a, key(), v.id)).issued, false);
      assert.equal(
        (await a4.view(a, v.id)).balances.find((b) => b.kind === "available")
          .amount,
        "300000000",
      );
      assert.throws(
        () =>
          createA4Repository(pool, "bots", {
            starterCoins: 1,
            refillCoins: 1,
            botCoins: 104,
          }),
        /funding policy/,
      );
      await custom.control(a, key(), v.id, "archive");
    });
    it("handles runtime backend termination during execution and recovers the persisted draw", async () => {
      const a = await actor(),
        v = await run(a, { population: 5 });
      for (let i = 0; i < 2; i++) await a4.control(a, key(), v.id, "step");
      const draw = (await a4.view(a, v.id)).rounds[0].offer;
      let terminated = false;
      const crashing = createA4Repository(
        {
          query: pool.query.bind(pool),
          async connect() {
            const client = await pool.connect(),
              query = client.query.bind(client);
            client.query = (sql, ...args) => {
              if (
                !terminated &&
                typeof sql === "string" &&
                sql.startsWith("UPDATE a4_submissions s SET outcome")
              ) {
                terminated = true;
                return query("SELECT pg_terminate_backend(pg_backend_pid())");
              }
              return query(sql, ...args);
            };
            return client;
          },
        },
        "bots",
      );
      await assert.rejects(
        crashing.control(a, key(), v.id, "step"),
        (error) =>
          ["57P01", "ECONNRESET", "EPIPE"].includes(error.code) ||
          /connection terminated/i.test(error.message),
      );
      assert.equal(terminated, true);
      assert.equal((await a4.view(a, v.id)).rounds[0].state, "priced");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM a4_journals WHERE reference=$1",
            [`execute:${v.rounds[0].id}`],
          )
        ).rows[0].n,
        0,
      );
      await finish(v.id);
      assert.deepEqual((await a4.view(a, v.id)).rounds[0].offer, draw);
    });
  },
);
