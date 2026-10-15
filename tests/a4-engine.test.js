import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RULE,
  digest,
  fraction,
  add,
  sub,
  mul,
  compare,
  floor,
  ceil,
  decimal,
  purchaseLimit,
  median,
  priceRound,
  executeRound,
  uniform,
  randomWord,
  secureSeed,
  reservation,
  validateOrder,
  validateTerms,
} from "../dist/features/a4/engine.js";
import {
  generateBots,
  benchmark,
  ideal,
  auditDeviation,
} from "../dist/features/a4/bots.js";
import {
  applyFundingEvent,
  requirePlayAsset,
} from "../dist/features/a4/funding.js";
import { runConfig } from "../dist/features/a4/repository.js";
const terms = {
  rule: RULE,
  epsilon: 0,
  feeBps: 0,
  maxQuantity: 100,
  capacity: 1001,
};
const o = (participant, side, limit, quantity = 1) => ({
  participant,
  kind: "human",
  side,
  limit,
  quantity,
});
const pricing = (v = "0.4", p = "0.28") => ({
  a: decimal("0.22"),
  b: decimal("0.34"),
  share: decimal(v),
  price: decimal(p),
  branch: "exploratory",
  reason: null,
});
describe("A4 exact rules", () => {
  it("converts NO ceilings and takes exact unweighted medians", () => {
    assert.deepEqual(purchaseLimit("NO", "0.78"), fraction(22, 100));
    assert.deepEqual(purchaseLimit("YES", "0.34"), fraction(34, 100));
    assert.deepEqual(
      median([decimal("0.3"), decimal("0.1"), decimal("0.2"), decimal("0.8")]),
      fraction(1, 4),
    );
    assert.equal(median([]), null);
    assert.deepEqual(median([fraction(1, 3)]), fraction(1, 3));
    assert.equal(floor(fraction(10, 3)), 3n);
    assert.equal(ceil(fraction(10, 3)), 4n);
    assert.equal(compare(fraction(1, 2), fraction(1, 2)), 0);
    assert.deepEqual(add(fraction(-2, 3), fraction(1, 3)), fraction(-1, 3));
    assert.deepEqual(sub(fraction(1), fraction(1, 3)), fraction(2, 3));
    assert.deepEqual(mul(fraction(3, 5), fraction(5, 3)), fraction(1));
  });
  it("draws one shared offer, retaining missing, equal and inverted fallback reasons", () => {
    const cohort = [o("y", "YES", "0.34"), o("n", "NO", "0.22")];
    const p = priceRound(cohort, terms, 0n, 2n ** 63n);
    assert.equal(p.branch, "targeted");
    assert.ok(
      compare(p.price, decimal("0.28")) > 0 &&
        compare(p.price, decimal("0.281")) < 0,
    );
    assert.equal(p.share.n, "1");
    assert.equal(p.share.d, "2");
    assert.equal(
      priceRound(cohort, { ...terms, epsilon: 1000000 }, 0n, 0n).branch,
      "exploratory",
    );
    assert.equal(priceRound([cohort[0]], terms, 0n, 0n).reason, "missing_side");
    for (const limit of ["0.22", "0.10"])
      assert.equal(
        priceRound([o("y", "YES", limit), cohort[1]], terms, 0n, 0n).reason,
        "nonpositive_interval",
      );
    const empty = priceRound([], terms, 0n, 0n);
    assert.equal(empty.price, null);
    assert.equal(empty.share, null);
    assert.equal(empty.branch, "empty");
    assert.deepEqual(executeRound([], terms, empty, 100n), []);
  });
  it("executes unequal quantities fully and counts refused endorsements in settlement", () => {
    const orders = [
      o("y", "YES", "0.8", 10),
      o("n", "NO", "0.2", 1),
      o("refused", "NO", "0.9", 100),
    ];
    const p = priceRound(orders, terms, 0n, 2n ** 63n);
    assert.deepEqual(p.share, fraction(1, 3));
    const results = executeRound(
      orders,
      terms,
      { ...p, price: decimal("0.28") },
      1000000n,
    );
    assert.equal(results[0].premium, "2800000");
    assert.equal(results[0].payout, "3333333");
    assert.equal(results[1].premium, "720000");
    assert.equal(results[1].payout, "666666");
    assert.equal(results[2].executed, false);
    assert.equal(results[2].status, "limit_not_met");
    assert.equal(results[2].net, "0");
    assert.equal(results[2].released, "100000000");
    assert.deepEqual(results[0].payoutDust, fraction(1, 3));
  });
  it("does not turn 50% settlement into a refund; equality acceptance and one-sided gate hold", () => {
    const orders = [o("y", "YES", "0.28"), o("n", "NO", "0.28")];
    const out = executeRound(orders, terms, pricing("0.5"), 1000000n);
    assert.ok(out.every((x) => x.executed));
    assert.equal(out[0].net, "220000");
    assert.equal(out[1].net, "-220000");
    const none = executeRound([orders[0]], terms, pricing(), 1000000n);
    assert.equal(none[0].status, "no_opposite");
    assert.equal(none[0].released, "1000000");
  });
  it("preserves minority profits and independent center reconciliation", () => {
    for (const [yes, v, aggregate] of [
      [40, "0.4", "-2400000"],
      [10, "0.1", "14400000"],
    ]) {
      const orders = Array.from({ length: 100 }, (_, i) =>
        o(String(i), i < yes ? "YES" : "NO", i < yes ? "1" : "0"),
      );
      const out = executeRound(orders, terms, pricing(v), 1000000n);
      assert.equal(
        out.reduce((sum, x) => sum + BigInt(x.net), 0n).toString(),
        aggregate,
      );
      assert.equal(out[0].net, v === "0.4" ? "120000" : "-180000");
      assert.equal(out.at(-1).net, v === "0.4" ? "-120000" : "180000");
    }
  });
  it("allows a lone deviating exploratory buyer outside the median interval", () => {
    const orders = [
      o("y1", "YES", "0.34"),
      o("y2", "YES", "0.34"),
      o("deviator", "YES", "0.50"),
      o("n", "NO", "0.22"),
    ];
    const result = executeRound(
      orders,
      { ...terms, epsilon: 1000000 },
      {
        ...priceRound(orders, { ...terms, epsilon: 1000000 }, 0n, 0n),
        price: decimal("0.40"),
      },
      1000000n,
    );
    assert.equal(result[0].executed, false);
    assert.equal(result[2].executed, true);
    // The genuine expectation m=0.34 implies -0.06 expected unit profit at p=0.40.
    // This particular locked cohort realizes v=3/4, so its actual receipt differs.
    assert.deepEqual(sub(decimal("0.34"), decimal("0.40")), fraction(-3, 50));
    assert.equal(result[2].net, "350000");
    assert.equal(result[3].executed, true);
  });
  it("reserves and charges premium fees once, with explicit dust at two precisions", () => {
    const orders = [o("y", "YES", "1"), o("n", "NO", "0")];
    for (const face of [100n, 100000000n]) {
      const out = executeRound(
        orders,
        { ...terms, feeBps: 500 },
        pricing("0.4"),
        face,
      );
      assert.equal(reservation(1, face, 500), (face * 105n) / 100n);
      assert.equal(BigInt(out[0].premium), (face * 28n) / 100n);
      assert.equal(BigInt(out[0].payout), (face * 40n) / 100n);
      assert.equal(
        BigInt(out[0].net),
        BigInt(out[0].payout) - BigInt(out[0].premium) - BigInt(out[0].fee),
      );
    }
    const out = executeRound(
      orders,
      { ...terms, feeBps: 500 },
      { ...pricing(), price: fraction(1, 3), share: fraction(1, 3) },
      100n,
    );
    assert.equal(out[0].premium, "34");
    assert.equal(out[0].fee, "2");
    assert.equal(out[0].payout, "33");
    assert.deepEqual(out[0].premiumDust, fraction(2, 3));
    const no = executeRound(
      [orders[0]],
      { ...terms, feeBps: 500 },
      pricing(),
      100n,
    )[0];
    assert.equal(no.fee, "0");
    assert.equal(no.released, "105");
  });
  it("rejects malformed limits, quantities, versions, duplicate accounts and randomness", () => {
    for (const x of [
      null,
      0.2,
      ".2",
      "-1",
      "1.1",
      "NaN",
      "0.1234567",
      "00",
      "1e-3",
    ])
      assert.throws(() => decimal(x));
    for (const change of [
      { quantity: 0 },
      { quantity: 101 },
      { quantity: 1.5 },
      { side: "MAYBE" },
      { kind: "human-ish" },
      { participant: "" },
    ])
      assert.throws(() =>
        validateOrder({ ...o("y", "YES", "0.2"), ...change }, terms),
      );
    for (const change of [
      { rule: "a3" },
      { epsilon: -1 },
      { epsilon: 1000001 },
      { feeBps: 1 },
      { maxQuantity: 101 },
      { capacity: 0 },
      { capacity: 1002 },
    ])
      assert.throws(() => validateTerms({ ...terms, ...change }));
    assert.throws(() =>
      priceRound([o("same", "YES", "1"), o("same", "NO", "0")], terms, 0n, 0n),
    );
    assert.throws(() =>
      priceRound(
        [o("1", "YES", "1"), o("2", "NO", "0")],
        { ...terms, capacity: 1 },
        0n,
        0n,
      ),
    );
    assert.throws(() => fraction(1, 0));
    assert.throws(() => uniform(-1n));
    assert.throws(() => uniform(2n ** 64n));
    assert.throws(() => executeRound([], terms, pricing(), 0n));
    assert.ok(compare(uniform(0n), fraction(0)) > 0);
    assert.ok(compare(uniform(2n ** 64n - 1n), fraction(1)) < 0);
    assert.equal(randomWord("seed", "price"), randomWord("seed", "price"));
    assert.notEqual(randomWord("seed", "price"), randomWord("seed", "belief"));
    assert.notEqual(secureSeed(), secureSeed());
    assert.equal(
      digest({ a: 1, b: { x: 2, y: 3 } }),
      digest({ b: { y: 3, x: 2 }, a: 1 }),
    );
  });
});
describe("A4 research and asset boundaries", () => {
  it("checks Bayesian, ideal and fixed-median shading reference fixtures", () => {
    const { a, b } = benchmark(0.5, 0.4, 0.1);
    assert.ok(Math.abs(a - 0.22) < 1e-12);
    assert.ok(Math.abs(b - 0.34) < 1e-12);
    for (const [epsilon, rate, profit] of [
      [0, 1, 0.06],
      [0.05, 0.956, 0.05736],
      [1, 0.12, 0.0072],
    ]) {
      const result = ideal(0.12, epsilon);
      assert.ok(Math.abs(result.rate - rate) < 1e-12);
      assert.ok(Math.abs(result.profit - profit) < 1e-12);
    }
    for (const [limit, acceptance, expected] of [
      [0.31, 0.75, 0.05625],
      [0.28, 0.5, 0.045],
    ]) {
      const n = 100000;
      let accepted = 0,
        profit = 0;
      for (let i = 0; i < n; i++) {
        const p = 0.22 + (0.12 * (i + 0.5)) / n;
        if (p <= limit) {
          accepted++;
          profit += 0.34 - p;
        }
      }
      assert.ok(Math.abs(accepted / n - acceptance) < 1e-10);
      assert.ok(Math.abs(profit / n - expected) < 1e-10);
    }
  });
  it("generates reproducible 500-bot stress cohorts with fresh broad beliefs", () => {
    const orders = generateBots("replay", 1, 500, "heterogeneous", 2, 0);
    assert.equal(orders.length, 500);
    assert.equal(new Set(orders.map((o) => o.participant)).size, 500);
    assert.deepEqual(
      orders,
      generateBots("replay", 1, 500, "heterogeneous", 2, 0),
    );
    assert.notDeepEqual(
      orders,
      generateBots("replay", 2, 500, "heterogeneous", 2, 0),
    );
    assert.ok(new Set(orders.map((o) => o.limit)).size > 450);
    const reference = generateBots("replay", 1, 500, "reference", 1, 0);
    assert.equal(
      generateBots("loss-4", 1, 100, "reference", 1, 0).filter(
        (o) => o.side === "YES",
      ).length,
      6,
    );
    assert.deepEqual(
      new Set(reference.map((o) => o.limit)),
      new Set(["0.220000", "0.340000"]),
    );
    assert.notDeepEqual(
      reference,
      generateBots("replay", 1, 500, "reference", 1, 500),
    );
    const config = runConfig();
    assert.equal(config.population, 500);
    assert.equal(runConfig({}, true).population, 0);
    for (const c of [
      { population: 1001 },
      { population: 0 },
      { preset: "bad" },
      { quantity: 0 },
      { periods: 11 },
      { periods: 2 },
      { delayed: 1 },
      { roundSeconds: 9 },
      { roundSeconds: 3601 },
    ])
      assert.throws(() => runConfig(c));
  });
  it("recomputes finite medians/settlement and independently confirms a pivotal deviation", () => {
    const cohort = [
      o("y", "YES", "0.34"),
      o("n1", "NO", "0.22"),
      o("n2", "NO", "0.22"),
    ];
    const report = auditDeviation(cohort, terms, "y", "finite-a4", 100);
    assert.ok(report.confirmation.mean > 0.02);
    assert.equal(report.best.quantity, 1);
    assert.throws(() => auditDeviation(cohort, terms, "missing", "x", 2));
    assert.throws(() => auditDeviation(cohort, terms, "y", "x", 1));
  });
  it("enforces idempotent pending/final/reversed adapter events without exposing real rails", () => {
    const event = {
      id: "provider-1",
      asset: "TEST8",
      amount: "123456789",
      state: "pending",
    };
    let r = applyFundingEvent(null, event, "TEST8");
    assert.equal(r.delta, "0");
    assert.equal(applyFundingEvent(r.state, event, "TEST8").delta, "0");
    r = applyFundingEvent(r.state, { ...event, state: "final" }, "TEST8");
    assert.equal(r.delta, "123456789");
    assert.equal(
      applyFundingEvent(r.state, { ...event, state: "final" }, "TEST8").delta,
      "0",
    );
    assert.throws(() => applyFundingEvent(r.state, event, "TEST8"));
    assert.throws(() =>
      applyFundingEvent(r.state, { ...event, amount: "1" }, "TEST8"),
    );
    r = applyFundingEvent(r.state, { ...event, state: "reversed" }, "TEST8");
    assert.equal(r.delta, "-123456789");
    assert.throws(() =>
      applyFundingEvent(r.state, { ...event, state: "final" }, "TEST8"),
    );
    assert.throws(() => applyFundingEvent(null, event, "YAP"));
    assert.throws(() =>
      applyFundingEvent(null, { ...event, state: "reversed" }, "TEST8"),
    );
    const failed = applyFundingEvent(
      null,
      { ...event, state: "failed" },
      "TEST8",
    );
    assert.throws(() => applyFundingEvent(failed.state, event, "TEST8"));
    assert.throws(() =>
      applyFundingEvent(null, { ...event, amount: "0" }, "TEST8"),
    );
    assert.throws(() =>
      applyFundingEvent(null, { ...event, state: "unknown" }, "TEST8"),
    );
    requirePlayAsset("YAP", "play");
    assert.throws(() => requirePlayAsset("USD", "real"));
  });
});
