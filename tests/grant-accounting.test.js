import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allocateAtomicProportionally,
  commitStakeCost,
  grantClaimKey,
  grantQualified,
  newAccountingGrant,
  orderedPurchasedSourceIds,
  planPurchaseRefund,
  planStake,
  planWithdrawal,
  projectGrantAccounting,
  refundStake,
  restoreWithdrawalSources,
  settleStake,
  torontoGrantDay,
} from "../dist/features/account-wallet/grant-accounting.js";

const scope = {
  accountId: "72",
  environment: "sandbox",
  asset: "USDC",
  precision: 6,
};
const firstDay = "2026-10-19T12:00:00.000Z";
const secondDay = "2026-10-20T12:00:00.000Z";
const settledAt = "2026-10-20T15:00:00.000Z";
const yc = (value) => String(BigInt(value) * 10000n);
function grant(id, kind = "welcome", overrides = {}) {
  return {
    ...newAccountingGrant({ id, kind, createdAt: firstDay }),
    ...overrides,
  };
}
function purchased(id, balance, kind = "purchased_principal", purchaseId = id) {
  return { id, kind, purchaseId, balance, createdAt: firstDay };
}
function book(grants = [], sources = []) {
  return { scope, grants, purchased: sources };
}
const order = (value) => value.purchased.map((source) => source.id);
const balance = (value) =>
  value.grants.reduce(
    (sum, source) =>
      sum + BigInt(source.principalRemaining) + BigInt(source.profitRemaining),
    0n,
  ) + value.purchased.reduce((sum, source) => sum + BigInt(source.balance), 0n);

describe("exact source allocation", () => {
  it("allocates positive and negative residual atoms in stable source order", () => {
    assert.deepEqual(allocateAtomicProportionally(2n, [1n, 1n, 1n]), [
      1n,
      1n,
      0n,
    ]);
    assert.deepEqual(allocateAtomicProportionally(-2n, [1n, 1n, 1n]), [
      -1n,
      -1n,
      0n,
    ]);
    assert.deepEqual(allocateAtomicProportionally(100n, [600n, 400n]), [
      60n,
      40n,
    ]);
    assert.deepEqual(allocateAtomicProportionally(-100n, [600n, 400n]), [
      -60n,
      -40n,
    ]);
    assert.deepEqual(allocateAtomicProportionally(5n, [0n, 2n, 0n]), [
      0n,
      5n,
      0n,
    ]);
    assert.deepEqual(allocateAtomicProportionally(0n, [1n, 2n]), [0n, 0n]);
    for (const [amount, weights] of [
      [1n, []],
      [1n, [0n]],
      [1n, [-1n]],
      [1, [1n]],
      [1n, [1]],
    ])
      assert.throws(() => allocateAtomicProportionally(amount, weights));
  });
  it("conserves every atom over adversarial weights, signs and very large integer products", () => {
    let seed = 64721;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    for (let trial = 0; trial < 300; trial++) {
      const weights = Array.from({ length: (next() % 15) + 1 }, () =>
        BigInt((next() % 100000) + 1),
      );
      const total = BigInt(next()) * 10n ** BigInt(trial % 60);
      const shares = allocateAtomicProportionally(total, weights);
      const loss = allocateAtomicProportionally(-total, weights);
      const denominator = weights.reduce((sum, value) => sum + value, 0n);
      assert.equal(
        shares.reduce((sum, value) => sum + value, 0n),
        total,
      );
      assert.deepEqual(
        loss,
        shares.map((value) => -value),
      );
      for (let i = 0; i < weights.length; i++) {
        const floor = (total * weights[i]) / denominator;
        assert.ok(shares[i] === floor || shares[i] === floor + 1n);
      }
    }
  });
});

describe("independent grant identity and Toronto claim day", () => {
  it("keeps welcome once-only and daily identities separate by account/environment/day", () => {
    const welcome = grantClaimKey(scope, "welcome", new Date(firstDay));
    assert.equal(grantClaimKey(scope, "welcome", new Date(secondDay)), welcome);
    const daily = grantClaimKey(scope, "daily", new Date(firstDay));
    assert.notEqual(daily, welcome);
    assert.notEqual(grantClaimKey(scope, "daily", new Date(secondDay)), daily);
    assert.notEqual(
      grantClaimKey({ ...scope, accountId: "73" }, "daily", new Date(firstDay)),
      daily,
    );
    assert.notEqual(
      grantClaimKey(
        { ...scope, environment: "live" },
        "daily",
        new Date(firstDay),
      ),
      daily,
    );
    assert.match(daily, /^[a-f0-9]{64}$/);
    assert.equal(
      newAccountingGrant({
        id: "welcome",
        kind: "welcome",
        createdAt: firstDay,
      }).principal,
      yc(2500),
    );
    assert.equal(
      newAccountingGrant({ id: "daily", kind: "daily", createdAt: firstDay })
        .principal,
      yc(500),
    );
  });
  it("uses Toronto midnight through standard/daylight time and both DST transitions", () => {
    for (const [date, expected] of [
      ["2026-01-15T04:59:59.999Z", "2026-01-14"],
      ["2026-01-15T05:00:00.000Z", "2026-01-15"],
      ["2026-07-15T03:59:59.999Z", "2026-07-14"],
      ["2026-07-15T04:00:00.000Z", "2026-07-15"],
      ["2026-03-08T06:59:59.999Z", "2026-03-08"],
      ["2026-03-08T07:00:00.000Z", "2026-03-08"],
      ["2026-11-01T05:30:00.000Z", "2026-11-01"],
      ["2026-11-01T06:30:00.000Z", "2026-11-01"],
    ])
      assert.equal(torontoGrantDay(new Date(date)), expected);
    assert.throws(() => torontoGrantDay(new Date("invalid")));
  });
});

describe("source-aware stake accounting", () => {
  it("spends oldest grant principal then its profit, then the next grant, then explicitly ordered purchased sources", () => {
    const original = book(
      [
        grant("later", "daily", {
          createdAt: secondDay,
          principalRemaining: "20",
        }),
        grant("older", "welcome", {
          principalRemaining: "10",
          profitRemaining: "4",
          netProfit: "4",
          peakNetProfit: "4",
        }),
      ],
      [purchased("purchase", "100")],
    );
    const before = structuredClone(original);
    const planned = planStake(original, "16", order(original));
    assert.deepEqual(
      planned.funding.sources.map((source) => [
        source.id,
        source.grantKind,
        source.principal,
        source.profit,
      ]),
      [
        ["older", "welcome", "10", "4"],
        ["later", "daily", "2", "0"],
      ],
    );
    assert.equal(planned.book.purchased[0].balance, "100");
    assert.equal(
      balance(planned.book) + BigInt(planned.funding.amount),
      balance(original),
    );
    assert.deepEqual(original, before);
    assert.ok(
      Object.isFrozen(planned.book) && Object.isFrozen(planned.book.grants[0]),
    );
    assert.throws(
      () => planStake(original, "1000", order(original)),
      /insufficient source/,
    );
    assert.throws(
      () => planStake(original, "1", []),
      /explicit purchased source order/,
    );
    const tied = book([
      grant("z", "daily", { principalRemaining: "1" }),
      grant("a", "daily", { principalRemaining: "1" }),
    ]);
    assert.equal(planStake(tied, "1", []).funding.sources[0].id, "a");
  });
  it("splits a 600-grant/400-purchased gain 60/40 with purchased profit immediately eligible", () => {
    const original = book(
      [grant("welcome", "welcome", { principalRemaining: yc(600) })],
      [purchased("buy", yc(400))],
    );
    const planned = planStake(original, yc(1000), order(original));
    const result = settleStake(
      planned.book,
      planned.funding,
      yc(100),
      settledAt,
    );
    assert.deepEqual(
      result.receipts.map((receipt) => receipt.netResult),
      [yc(60), yc(40)],
    );
    assert.equal(result.book.grants[0].principalRemaining, yc(600));
    assert.equal(result.book.grants[0].profitRemaining, yc(60));
    assert.equal(result.book.grants[0].netProfit, yc(60));
    assert.equal(grantQualified(result.book.grants[0]), false);
    const profit = result.book.purchased.find(
      (source) => source.kind === "purchased_profit",
    );
    assert.equal(profit.balance, yc(40));
    assert.equal(profit.purchaseId, "buy");
    assert.equal(
      projectGrantAccounting(result.book, { welcome: yc(60) }).withdrawable,
      yc(440),
    );
    assert.equal(balance(result.book), balance(original) + BigInt(yc(100)));
  });
  it("splits the same 100 net loss to 540/360, including fees in the supplied net result", () => {
    const original = book(
      [grant("welcome", "welcome", { principalRemaining: yc(600) })],
      [purchased("buy", yc(400))],
    );
    const planned = planStake(original, yc(1000), order(original));
    const result = settleStake(
      planned.book,
      planned.funding,
      `-${yc(100)}`,
      settledAt,
    );
    assert.equal(result.book.grants[0].principalRemaining, yc(540));
    assert.equal(result.book.grants[0].netProfit, `-${yc(60)}`);
    assert.equal(result.book.purchased[0].balance, yc(360));
    assert.equal(projectGrantAccounting(result.book, {}).withdrawable, yc(360));
    assert.equal(balance(result.book), balance(original) - BigInt(yc(100)));
    assert.throws(
      () =>
        settleStake(planned.book, planned.funding, `-${yc(1001)}`, settledAt),
      /exceeds reserved stake/,
    );
  });
  it("loses earlier profit within the same grant first, without restoring previously lost principal", () => {
    const original = book([
      grant("welcome", "welcome", {
        principalRemaining: yc(1000),
        profitRemaining: yc(200),
        netProfit: yc(200),
        peakNetProfit: yc(200),
      }),
    ]);
    const planned = planStake(original, yc(1200), []);
    const loss100 = settleStake(
      planned.book,
      planned.funding,
      `-${yc(100)}`,
      settledAt,
    );
    assert.equal(loss100.book.grants[0].principalRemaining, yc(1000));
    assert.equal(loss100.book.grants[0].profitRemaining, yc(100));
    assert.equal(loss100.book.grants[0].netProfit, yc(100));
    const loss300 = settleStake(
      planned.book,
      planned.funding,
      `-${yc(300)}`,
      settledAt,
    );
    assert.equal(loss300.book.grants[0].principalRemaining, yc(900));
    assert.equal(loss300.book.grants[0].profitRemaining, "0");
    assert.equal(loss300.book.grants[0].netProfit, `-${yc(100)}`);
    const gain = settleStake(planned.book, planned.funding, yc(100), settledAt);
    assert.equal(gain.book.grants[0].principalRemaining, yc(1000));
    assert.equal(gain.book.grants[0].profitRemaining, yc(300));
    assert.notEqual(
      gain.book.grants[0].principalRemaining,
      gain.book.grants[0].principal,
    );
  });
  it("keeps qualification permanent and each later grant's target independent", () => {
    const original = book([
      grant("welcome", "welcome", {
        principalRemaining: "0",
        profitRemaining: yc(2500),
        netProfit: yc(2500),
        peakNetProfit: yc(2500),
      }),
      grant("daily", "daily", {
        createdAt: secondDay,
        profitRemaining: yc(100),
        netProfit: yc(100),
        peakNetProfit: yc(100),
      }),
    ]);
    const planned = planStake(original, yc(1800), []);
    const result = settleStake(
      planned.book,
      planned.funding,
      `-${yc(1800)}`,
      settledAt,
    );
    const projection = projectGrantAccounting(result.book, {
      welcome: yc(700),
      daily: yc(100),
    });
    assert.equal(result.book.grants[0].profitRemaining, yc(700));
    assert.equal(projection.grants[0].qualified, true);
    assert.equal(projection.grants[0].remainingTarget, "0");
    assert.equal(projection.grants[0].withdrawableProfit, yc(700));
    assert.equal(projection.grants[1].qualified, false);
    assert.equal(projection.grants[1].remainingTarget, yc(400));
    assert.equal(projection.grants[1].withdrawableProfit, "0");
    const later = {
      ...result.book,
      grants: [
        ...result.book.grants,
        grant("next-day", "daily", { createdAt: "2026-10-21T12:00:00.000Z" }),
      ],
    };
    assert.equal(
      projectGrantAccounting(later, {}).grants[1].remainingTarget,
      yc(400),
    );
    assert.equal(
      projectGrantAccounting(later, {}).grants[2].remainingTarget,
      yc(500),
    );
  });
  it("qualifies exactly at the independent target and preserves atom conservation at large balances", () => {
    const original = book([
      grant("daily", "daily", {
        netProfit: "4999999",
        peakNetProfit: "4999999",
      }),
    ]);
    const planned = planStake(original, "1", []);
    const result = settleStake(planned.book, planned.funding, "1", settledAt);
    assert.equal(grantQualified(result.book.grants[0]), true);
    assert.equal(result.book.grants[0].peakNetProfit, "5000000");
    const large = book([], [purchased("large", String(3n * 10n ** 30n))]);
    const funded = planStake(large, String(2n * 10n ** 30n), order(large));
    const settled = settleStake(
      funded.book,
      funded.funding,
      String(10n ** 30n),
      settledAt,
    );
    assert.equal(balance(settled.book), balance(large) + 10n ** 30n);
    const second = planStake(
      settled.book,
      String(10n ** 30n),
      [...order(settled.book)].reverse(),
    );
    const secondResult = settleStake(
      second.book,
      second.funding,
      "2",
      settledAt,
    );
    assert.equal(balance(secondResult.book), balance(settled.book) + 2n);
    assert.equal(
      secondResult.book.purchased.filter(
        (source) => source.kind === "purchased_profit",
      ).length,
      1,
    );
  });
  it("returns an unexecuted stake to its exact sources without qualification or profit", () => {
    const original = book(
      [
        grant("grant", "daily", {
          principalRemaining: "4",
          profitRemaining: "3",
          netProfit: "3",
          peakNetProfit: "3",
        }),
      ],
      [
        purchased("purchase", "5"),
        purchased("prior-profit", "2", "purchased_profit", "purchase"),
      ],
    );
    const planned = planStake(original, "13", order(original));
    const restored = refundStake(planned.book, planned.funding);
    assert.deepEqual(restored, original);
    assert.equal(restored.grants[0].netProfit, "3");
    assert.equal(grantQualified(restored.grants[0]), false);
  });
});

describe("eligible withdrawal and internal correction source plans", () => {
  it("defaults to all original principal FIFO before purchased profits, without exposing a user order setting", () => {
    const original = book(
      [],
      [
        purchased("profit-a", "5", "purchased_profit", "purchase-a"),
        {
          ...purchased(
            "principal-b",
            "10",
            "purchased_principal",
            "purchase-b",
          ),
          createdAt: secondDay,
        },
        purchased("principal-a", "10", "purchased_principal", "purchase-a"),
      ],
    );
    assert.deepEqual(orderedPurchasedSourceIds(original), [
      "principal-a",
      "principal-b",
      "profit-a",
    ]);
    const stake = planStake(original, "12");
    assert.deepEqual(
      stake.funding.sources.map((source) => [source.id, source.amount]),
      [
        ["principal-a", "10"],
        ["principal-b", "2"],
      ],
    );
    const withdrawal = planWithdrawal(original, "12", undefined, {});
    assert.deepEqual(
      withdrawal.sources.map((source) => [source.id, source.amount]),
      [
        ["principal-a", "10"],
        ["principal-b", "2"],
      ],
    );
    const internalReceiptOrder = planStake(original, "12", [
      "profit-a",
      "principal-a",
      "principal-b",
    ]);
    assert.deepEqual(
      internalReceiptOrder.funding.sources.map((source) => [
        source.id,
        source.amount,
      ]),
      [
        ["profit-a", "5"],
        ["principal-a", "7"],
      ],
    );
  });
  it("withdraws purchased value before qualified backed profit and supports partial withdrawals", () => {
    const original = book(
      [
        grant("welcome", "welcome", {
          profitRemaining: yc(500),
          netProfit: yc(2500),
          peakNetProfit: yc(2500),
        }),
      ],
      [purchased("purchase", yc(1000))],
    );
    const first = planWithdrawal(original, yc(600), order(original), {
      welcome: yc(500),
    });
    assert.equal(
      projectGrantAccounting(first.book, first.backing).withdrawable,
      yc(900),
    );
    assert.equal(first.book.grants[0].principalRemaining, yc(2500));
    assert.deepEqual(
      first.sources.map((source) => source.id),
      ["purchase"],
    );
    const next = planWithdrawal(
      first.book,
      yc(700),
      order(first.book),
      first.backing,
    );
    assert.deepEqual(
      next.sources.map((source) => source.amount),
      [yc(400), yc(300)],
    );
    assert.equal(next.book.grants[0].profitRemaining, yc(200));
    assert.equal(next.backing.welcome, yc(200));
    assert.equal(
      projectGrantAccounting(next.book, next.backing).withdrawable,
      yc(200),
    );
    assert.equal(grantQualified(next.book.grants[0]), true);
  });
  it("never withdraws grant principal, unqualified profit or unbacked promises", () => {
    const unqualified = book([
      grant("daily", "daily", {
        profitRemaining: yc(100),
        netProfit: yc(100),
        peakNetProfit: yc(100),
      }),
    ]);
    assert.equal(
      projectGrantAccounting(unqualified, { daily: yc(100) }).withdrawable,
      "0",
    );
    assert.throws(
      () => planWithdrawal(unqualified, "1", [], { daily: yc(100) }),
      /insufficient withdrawable/,
    );
    const qualified = book([
      grant("daily", "daily", {
        profitRemaining: yc(100),
        netProfit: yc(500),
        peakNetProfit: yc(500),
      }),
    ]);
    assert.equal(projectGrantAccounting(qualified, {}).withdrawable, "0");
    assert.throws(
      () => planWithdrawal(qualified, yc(51), [], { daily: yc(50) }),
      /insufficient withdrawable/,
    );
    assert.throws(
      () => projectGrantAccounting(qualified, { unknown: "1" }),
      /invalid grant profit backing/,
    );
    assert.throws(
      () => projectGrantAccounting(qualified, { daily: yc(101) }),
      /invalid grant profit backing/,
    );
  });
  it("limits an internal correction to identifiable remaining original purchase principal", () => {
    const original = book(
      [],
      [
        purchased(
          "principal",
          yc(1000),
          "purchased_principal",
          "original-route",
        ),
        purchased("profit", yc(200), "purchased_profit", "original-route"),
      ],
    );
    const staked = planStake(original, yc(200), order(original));
    assert.throws(
      () => planPurchaseRefund(staked.book, "original-route", yc(801)),
      /unused purchase principal/,
    );
    const refund = planPurchaseRefund(staked.book, "original-route", yc(300));
    assert.equal(refund.book.purchased[0].balance, yc(500));
    assert.equal(refund.book.purchased[1].balance, yc(200));
    assert.deepEqual(refund.sources, [{ id: "principal", amount: yc(300) }]);
    assert.throws(
      () => planPurchaseRefund(original, "different-route", "1"),
      /unused purchase principal/,
    );
  });
});

describe("accounting provenance and input boundaries", () => {
  it("rejects mixed owner/environment/assets and corrupt or relabeled source receipts", () => {
    const original = book(
      [grant("grant", "daily")],
      [purchased("purchase", "10")],
    );
    const planned = planStake(original, "5000001", order(original));
    for (const changed of [
      { ...planned.funding, scope: { ...scope, accountId: "73" } },
      { ...planned.funding, scope: { ...scope, environment: "live" } },
      { ...planned.funding, scope: { ...scope, asset: "YAP" } },
      { ...planned.funding, amount: "5000002" },
      {
        ...planned.funding,
        sources: [...planned.funding.sources, planned.funding.sources[0]],
      },
      {
        ...planned.funding,
        sources: planned.funding.sources.map((source) =>
          source.kind === "grant"
            ? { ...source, grantKind: "welcome" }
            : source,
        ),
      },
      {
        ...planned.funding,
        sources: planned.funding.sources.map((source) =>
          source.kind === "purchased_principal"
            ? { ...source, purchaseId: "another" }
            : source,
        ),
      },
      {
        ...planned.funding,
        sources: planned.funding.sources.map((source) =>
          source.kind === "grant" ? { ...source, principal: "1" } : source,
        ),
      },
    ])
      assert.throws(() => settleStake(planned.book, changed, "0", settledAt));
    for (const changed of [
      { ...original, scope: { ...scope, asset: "YAP" } },
      { ...original, scope: { ...scope, precision: 18 } },
      {
        ...original,
        grants: [grant("grant", "daily", { principalRemaining: "5000001" })],
      },
      { ...original, grants: [grant("grant", "daily", { principal: "1" })] },
      { ...original, grants: [grant("grant", "daily", { netProfit: "1" })] },
      { ...original, purchased: [purchased("grant", "1")] },
      { ...original, purchased: [purchased("purchase", "1.0")] },
    ])
      assert.throws(() => projectGrantAccounting(changed, {}));
    assert.throws(() => planStake(original, "0", order(original)));
    assert.throws(() => planStake(original, "1", ["missing"]));
    assert.throws(() =>
      newAccountingGrant({ id: "bad id", kind: "daily", createdAt: firstDay }),
    );
    assert.throws(() =>
      newAccountingGrant({ id: "grant", kind: "daily", createdAt: "invalid" }),
    );
  });
});

describe("A4 actual-cost source commitment", () => {
  it("releases excess admission collateral before attributing profit to actual paid cost", () => {
    const original = book(
      [grant("grant", "daily", { principalRemaining: "50" })],
      [purchased("purchase", "55")],
    );
    const reserved = planStake(original, "105", order(original));
    const committed = commitStakeCost(reserved.book, reserved.funding, "10");
    assert.equal(committed.funding.amount, "10");
    assert.deepEqual(
      committed.funding.sources.map((source) => [source.id, source.amount]),
      [["grant", "10"]],
    );
    assert.deepEqual(
      committed.released.sources.map((source) => [source.id, source.amount]),
      [
        ["grant", "40"],
        ["purchase", "55"],
      ],
    );
    assert.equal(committed.book.grants[0].principalRemaining, "40");
    assert.equal(committed.book.purchased[0].balance, "55");
    assert.equal(committed.book.grants[0].netProfit, "0");
    const settlement = settleStake(
      committed.book,
      committed.funding,
      "10",
      settledAt,
    );
    assert.equal(settlement.book.grants[0].profitRemaining, "10");
    assert.equal(settlement.book.grants[0].principalRemaining, "50");
    assert.equal(settlement.book.purchased.length, 1);
    assert.equal(settlement.book.purchased[0].balance, "55");
    assert.equal(balance(settlement.book), balance(original) + 10n);
    assert.throws(
      () => commitStakeCost(reserved.book, reserved.funding, "106"),
      /exceeds its reservation/,
    );
    assert.throws(() => commitStakeCost(reserved.book, reserved.funding, "-1"));
  });
  it("fully releases zero execution and commits exact full execution without qualification changes", () => {
    const original = book(
      [
        grant("grant", "daily", {
          principalRemaining: "4",
          profitRemaining: "3",
          netProfit: "3",
          peakNetProfit: "3",
        }),
      ],
      [purchased("purchase", "5")],
    );
    const reserved = planStake(original, "12", order(original));
    const zero = commitStakeCost(reserved.book, reserved.funding, "0");
    assert.equal(zero.funding, null);
    assert.equal(zero.released.amount, "12");
    assert.deepEqual(zero.book, original);
    const full = commitStakeCost(reserved.book, reserved.funding, "12");
    assert.equal(full.released, null);
    assert.deepEqual(full.book, reserved.book);
    assert.deepEqual(full.funding, reserved.funding);
  });
  it("cuts the exact prefix inside grant principal/profit and purchased principal/profit", () => {
    const original = book(
      [
        grant("grant", "daily", {
          principalRemaining: "5",
          profitRemaining: "3",
          netProfit: "3",
          peakNetProfit: "3",
        }),
      ],
      [
        purchased("principal", "4", "purchased_principal", "purchase"),
        purchased("profit", "5", "purchased_profit", "purchase"),
      ],
    );
    const reserved = planStake(original, "17", order(original));
    for (const [cost, expected] of [
      ["2", [["grant", "2", "0"]]],
      ["7", [["grant", "5", "2"]]],
      [
        "10",
        [
          ["grant", "5", "3"],
          ["principal", "2", "0"],
        ],
      ],
      [
        "14",
        [
          ["grant", "5", "3"],
          ["principal", "4", "0"],
          ["profit", "0", "2"],
        ],
      ],
    ]) {
      const result = commitStakeCost(reserved.book, reserved.funding, cost);
      assert.deepEqual(
        result.funding.sources.map((source) => [
          source.id,
          source.principal,
          source.profit,
        ]),
        expected,
      );
      assert.equal(
        BigInt(result.funding.amount) + BigInt(result.released.amount),
        17n,
      );
      assert.equal(balance(result.book) + BigInt(cost), balance(original));
      const restored = refundStake(result.book, result.funding);
      assert.deepEqual(restored, original);
    }
  });
  it("includes the actual fee in paid cost and the net result exactly once", () => {
    const original = book([
      grant("grant", "daily", { principalRemaining: "105" }),
    ]);
    const reserved = planStake(original, "105", []);
    const premium = 9n,
      fee = 1n,
      proceeds = 11n;
    const committed = commitStakeCost(
      reserved.book,
      reserved.funding,
      String(premium + fee),
    );
    assert.equal(balance(committed.book), 95n);
    const settled = settleStake(
      committed.book,
      committed.funding,
      String(proceeds - premium - fee),
      settledAt,
    );
    assert.equal(settled.book.grants[0].principalRemaining, "105");
    assert.equal(settled.book.grants[0].profitRemaining, "1");
    assert.equal(settled.book.grants[0].netProfit, "1");
    assert.equal(balance(settled.book), 106n);
  });
});

describe("reconciled failed payout source restoration", () => {
  function reservedPayout() {
    const original = book(
      [
        grant("qualified", "welcome", {
          profitRemaining: "20",
          netProfit: yc(2500),
          peakNetProfit: yc(2500),
        }),
      ],
      [
        purchased("principal", "10", "purchased_principal", "purchase"),
        purchased("profit", "7", "purchased_profit", "purchase"),
      ],
    );
    return {
      original,
      reserved: planWithdrawal(original, "25", order(original), {
        qualified: "20",
      }),
    };
  }
  it("restores the exact purchased and qualified-profit sources and promotional backing", () => {
    const { original, reserved } = reservedPayout();
    assert.equal(reserved.reservation.operation, "withdrawal");
    assert.equal(reserved.reservation.amount, "25");
    assert.deepEqual(
      reserved.reservation.sources.map((source) => [
        source.id,
        source.principal,
        source.profit,
      ]),
      [
        ["principal", "10", "0"],
        ["profit", "0", "7"],
        ["qualified", "0", "8"],
      ],
    );
    assert.deepEqual(reserved.backing, { qualified: "12" });
    const restored = restoreWithdrawalSources(
      reserved.book,
      reserved.reservation,
      reserved.backing,
    );
    assert.deepEqual(restored.book, original);
    assert.deepEqual(restored.backing, { qualified: "20" });
    assert.equal(restored.book.grants[0].netProfit, yc(2500));
    assert.equal(restored.book.grants[0].peakNetProfit, yc(2500));
    assert.equal(
      projectGrantAccounting(restored.book, restored.backing).withdrawable,
      "37",
    );
  });
  it("adds released sources to current state without rolling back unrelated later activity", () => {
    const { reserved } = reservedPayout();
    const current = {
      ...reserved.book,
      grants: reserved.book.grants.map((source) => ({
        ...source,
        profitRemaining: "13",
        netProfit: String(BigInt(source.netProfit) + 1n),
        peakNetProfit: String(BigInt(source.peakNetProfit) + 1n),
      })),
      purchased: reserved.book.purchased.map((source) =>
        source.id === "principal" ? { ...source, balance: "3" } : source,
      ),
    };
    const restored = restoreWithdrawalSources(current, reserved.reservation, {
      qualified: "13",
    });
    assert.equal(restored.book.purchased[0].balance, "13");
    assert.equal(restored.book.purchased[1].balance, "7");
    assert.equal(restored.book.grants[0].profitRemaining, "21");
    assert.equal(
      restored.book.grants[0].netProfit,
      String(BigInt(yc(2500)) + 1n),
    );
    assert.deepEqual(restored.backing, { qualified: "21" });
  });
  it("rejects another account's payout, grant-principal restoration and incompatible source provenance", () => {
    const { reserved } = reservedPayout();
    for (const reservation of [
      { ...reserved.reservation, scope: { ...scope, accountId: "73" } },
      { ...reserved.reservation, operation: "stake" },
      {
        ...reserved.reservation,
        sources: reserved.reservation.sources.map((source) =>
          source.kind === "grant"
            ? { ...source, principal: source.amount, profit: "0" }
            : source,
        ),
      },
      {
        ...reserved.reservation,
        sources: reserved.reservation.sources.map((source) =>
          source.kind === "purchased_principal"
            ? { ...source, purchaseId: "foreign" }
            : source,
        ),
      },
    ])
      assert.throws(() =>
        restoreWithdrawalSources(reserved.book, reservation, reserved.backing),
      );
    const unqualified = {
      ...reserved.book,
      grants: reserved.book.grants.map((source) => ({
        ...source,
        netProfit: "0",
        peakNetProfit: "0",
      })),
    };
    assert.throws(
      () =>
        restoreWithdrawalSources(
          unqualified,
          reserved.reservation,
          reserved.backing,
        ),
      /unqualified profit/,
    );
  });
});
