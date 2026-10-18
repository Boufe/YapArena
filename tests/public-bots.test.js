import assert from "node:assert/strict";
import { it } from "node:test";
import express from "express";
import request from "../scripts/test-http-request.ts";
import {
  argumentEndorsements,
  simulationArguments,
  syntheticRound,
  createPublicBotRepository,
  fractionNumber,
} from "../dist/features/a4/public-bots.js";
import { publicHomepage } from "../dist/features/discovery/homepage-model.js";
import { createDiscoveryRouter } from "../dist/features/discovery/router.js";
import {
  chartGeometry,
  chartSeries,
} from "../dist/features/discovery/homepage-chart.js";
const id = "11111111-1111-4111-8111-111111111111",
  topicId = "22222222-2222-4222-8222-222222222222";
const topic = {
  id: topicId,
  slug: "topic",
  title: "Topic",
  sideALabel: "Yes",
  sideBLabel: "No",
  isDemo: false,
};
const debate = {
  id,
  slug: "debate",
  proposition: "Should transport be free?",
  status: "scheduled",
  topic: { slug: "topic" },
};
const catalog = simulationArguments(debate.proposition);
const row = (i = 1) => ({
  id: `round-${i}`,
  runId: null,
  debateId: id,
  debateSlug: "debate",
  topicId,
  number: i,
  period: i,
  settledAt: new Date(Date.UTC(2026, 9, 16, 0, i)).toISOString(),
  closesAt: new Date(Date.UTC(2026, 9, 16, 0, i)).toISOString(),
  seed: `seed-${i}`,
  mode: "seed",
  ...syntheticRound("fixture", i, 20),
  ...catalog,
  proposition: debate.proposition,
  argumentLabel: null,
});

it("generates heterogeneous, reproducible results and independent argument cohorts", () => {
  for (const title of [
    "recording",
    "chat",
    "monopolies",
    "minimum wage",
    "transport",
    "AI creativity",
    "Caufield goals",
    "work week",
    "Other question",
  ]) {
    const c = simulationArguments(title);
    assert.equal(c.arguments.length, 6);
    assert.equal(c.arguments.filter((a) => a.stance === "against").length, 3);
  }
  const first = syntheticRound("heterogeneous", 1, 500),
    next = syntheticRound("heterogeneous", 2, 500);
  assert.deepEqual(syntheticRound("heterogeneous", 1, 500), first);
  assert.notDeepEqual(first.share, next.share);
  assert.equal(first.bots, 500);
  assert.equal(first.humans, 0);
  assert.ok(fractionNumber(first.share) > 0 && fractionNumber(first.share) < 1);
  assert.equal(fractionNumber(null), null);
  const args = argumentEndorsements("fixture", catalog.arguments, 500);
  assert.deepEqual(args, argumentEndorsements("fixture", catalog.arguments));
  assert.ok(
    args.every(
      (a) => a.rate >= 0 && a.rate <= 100 && a.endorsed / 5 === a.rate,
    ),
  );
  assert.notEqual(
    args.reduce((sum, a) => sum + a.rate, 0),
    100,
  );
});
it("adapts only aggregate simulation fields, restores real charts and preserves unavailable states", async () => {
  let rows = [row(), row(2), row(3)];
  const queries = [];
  const repo = createPublicBotRepository({
    query: async (sql) => {
      queries.push(sql);
      return sql.startsWith("SELECT 1")
        ? { rowCount: 1 }
        : sql.startsWith("SELECT d.id")
          ? { rows: [{ id }] }
          : { rows };
    },
  });
  const history = await repo.debate(id);
  assert.equal(history.items.length, 3);
  assert.equal(history.arguments.length, 6);
  assert.equal(JSON.stringify(history).includes("seed-"), false);
  assert.equal(JSON.stringify(history).includes("creator"), false);
  assert.equal(history.items[0].ownLimit, null);
  assert.equal(history.items[0].runId, null);
  assert.deepEqual(await repo.debate(id), history);
  assert.deepEqual(await repo.topics([]), {});
  assert.equal(
    (await repo.topics([topicId]))[topicId].revision,
    history.revision,
  );
  const data = publicHomepage([topic], [debate], { [topicId]: history }),
    m = data.ideas[0];
  assert.equal(m.activity.revision, history.revision);
  assert.ok(m.pct > 0);
  assert.equal(m.debates[0].kind, "upcoming");
  assert.equal(m.arguments.length, 6);
  assert.equal(m.points.length, 3);
  for (const metric of ["endorsement", "price"])
    for (const range of ["1D", "1W", "1M"]) {
      const chart = chartGeometry(m, metric, range, 600, true);
      assert.equal(chart.points.length, 3);
      assert.equal(chart.x(2), chart.w - chart.right);
      assert.equal(chart.valueAt(0), chart.points[0]);
      assert.equal(chart.valueAt(1), chart.points.at(-1));
      assert.ok(Number.isFinite(chart.valueAt(0.37)));
      assert.equal(chart.times.length, 3);
    }
  assert.ok(chartSeries(m, "price", "1D").every((v) => v >= 0 && v <= 1));
  const storedArguments = argumentEndorsements(
    "stored-results",
    catalog.arguments,
  );
  rows[2].argumentResults = storedArguments;
  assert.deepEqual((await repo.debate(id)).arguments, storedArguments);
  rows = Array.from({ length: 101 }, (_, i) => ({ ...row(i + 1), total: 500 }));
  const windowed = await repo.debate(id);
  assert.equal(windowed.items.length, 100);
  assert.equal(windowed.items.at(-1).number, 500);
  assert.equal(windowed.hasMore, true);
  rows = [];
  const empty = await repo.debate(id);
  assert.equal(empty.arguments.length, 0);
  assert.equal(empty.items.length, 0);
  const hidden = createPublicBotRepository({
    query: async () => ({ rowCount: 0 }),
  });
  assert.equal(await hidden.debate(id), null);
  assert.ok(
    queries.some((sql) => sql.includes("s.mode IN ('mixed','observer')")),
  );
});
it("serves versioned no-store homepage and debate feeds without private identifiers or silent fixtures", async () => {
  let broken = false;
  const activity = {
    ...(await createPublicBotRepository({
      query: async (sql) =>
        sql.startsWith("SELECT 1") ? { rowCount: 1 } : { rows: [row()] },
    }).debate(id)),
  };
  const discovery = {
    listTopics: async () => {
      if (broken) throw Error("unavailable");
      return { items: [topic] };
    },
    listHomepageDebates: async () => [debate],
  };
  const app = express().use(
    createDiscoveryRouter({
      discovery,
      publicBots: {
        topics: async () => ({ [topicId]: activity }),
        debate: async (key) => (key === id ? activity : null),
      },
      applicationOrigin: "https://arena.test",
    }),
  );
  const first = await request(app).get("/api/public/homepage").expect(200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.body.ideas[0].activity.items.length, 1);
  await request(app)
    .get("/api/public/homepage?revision=" + first.body.revision)
    .expect(204);
  await request(app).get(`/api/public/debates/${id}/activity`).expect(200);
  await request(app).get("/api/public/debates/invalid/activity").expect(404);
  await request(app)
    .get("/api/public/debates/33333333-3333-4333-8333-333333333333/activity")
    .expect(404);
  broken = true;
  const failure = await request(app).get("/api/public/homepage").expect(503);
  assert.ok(!JSON.stringify(failure.body).includes("fixture"));
});
