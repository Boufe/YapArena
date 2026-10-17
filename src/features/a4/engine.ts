import type { Fraction } from "./fraction-types.ts";
export type { Fraction } from "./fraction-types.ts";

import { createHash, createHmac, randomBytes } from "node:crypto";

export const RULE = "a4-v1";
export const YAP = { id: "YAP", precision: 6, face: "1000000" } as const;
export type Side = "YES" | "NO";
export type Order = {
  participant: string;
  kind: "human" | "bot";
  side: Side;
  limit: string;
  quantity: number;
};
export type Terms = {
  rule: typeof RULE;
  epsilon: number;
  feeBps: number;
  maxQuantity: number;
  capacity: number;
};
export class A4Error extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}
export function fraction(
  n: bigint | number | string,
  d: bigint | number | string = 1,
): Fraction {
  const numerator = BigInt(n),
    denominator = BigInt(d);
  if (denominator <= 0n) throw new A4Error("invalid denominator", 400);
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { n: String(numerator / divisor), d: String(denominator / divisor) };
}
export const add = (a: Fraction, b: Fraction) =>
  fraction(
    BigInt(a.n) * BigInt(b.d) + BigInt(b.n) * BigInt(a.d),
    BigInt(a.d) * BigInt(b.d),
  );
export const sub = (a: Fraction, b: Fraction) =>
  add(a, fraction(-BigInt(b.n), b.d));
export const mul = (a: Fraction, b: Fraction) =>
  fraction(BigInt(a.n) * BigInt(b.n), BigInt(a.d) * BigInt(b.d));
export const compare = (a: Fraction, b: Fraction) => {
  const difference = BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
export const floor = (a: Fraction) => BigInt(a.n) / BigInt(a.d);
export const ceil = (a: Fraction) =>
  (BigInt(a.n) + BigInt(a.d) - 1n) / BigInt(a.d);
const ONE = fraction(1);
export function decimal(value: unknown): Fraction {
  if (
    typeof value !== "string" ||
    !/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value)
  )
    throw new A4Error(
      "price must be a decimal string from 0 to 1 with at most six places",
      400,
    );
  const [whole, tail = ""] = value.split(".");
  return fraction(
    BigInt(whole!) * 1000000n + BigInt(tail.padEnd(6, "0")),
    1000000n,
  );
}
export function purchaseLimit(side: Side, ceiling: string) {
  const price = decimal(ceiling);
  return side === "YES" ? price : sub(ONE, price);
}
export function validateTerms(terms: Terms) {
  if (
    terms.rule !== RULE ||
    !Number.isInteger(terms.epsilon) ||
    terms.epsilon < 0 ||
    terms.epsilon > 1000000 ||
    ![0, 500].includes(terms.feeBps) ||
    !Number.isInteger(terms.maxQuantity) ||
    terms.maxQuantity < 1 ||
    terms.maxQuantity > 100 ||
    !Number.isInteger(terms.capacity) ||
    terms.capacity < 1 ||
    terms.capacity > 1001
  )
    throw new A4Error("unsupported A4 terms", 400);
}
export function validateOrder(order: Order, terms: Terms) {
  if (
    !order.participant ||
    !["human", "bot"].includes(order.kind) ||
    !["YES", "NO"].includes(order.side) ||
    !Number.isInteger(order.quantity) ||
    order.quantity < 1 ||
    order.quantity > terms.maxQuantity
  )
    throw new A4Error("invalid submission", 400);
  decimal(order.limit);
}
export function median(values: Fraction[]): Fraction | null {
  if (!values.length) return null;
  const ordered = [...values].sort(compare),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : mul(add(ordered[middle - 1]!, ordered[middle]!), fraction(1, 2));
}
export function secureSeed() {
  return randomBytes(32).toString("hex");
}
export function digest(value: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
}
export function randomWord(seed: string, domain: string): bigint {
  return createHmac("sha256", seed).update(domain).digest().readBigUInt64BE();
}
// Midpoints of 2^64 equal cells: excludes zero/one, avoids modulo bias.
export function uniform(word: bigint): Fraction {
  if (word < 0n || word >= 2n ** 64n)
    throw new A4Error("invalid random word", 400);
  return fraction(2n * word + 1n, 2n ** 65n);
}
export function reservation(quantity: number, face: bigint, feeBps: number) {
  const principal = BigInt(quantity) * face;
  return principal + ceil(fraction(principal * BigInt(feeBps), 10000));
}
export function priceRound(
  orders: Order[],
  terms: Terms,
  branchWord: bigint,
  priceWord: bigint,
) {
  validateTerms(terms);
  if (
    orders.length > terms.capacity ||
    new Set(orders.map((o) => o.participant)).size !== orders.length
  )
    throw new A4Error("invalid locked population", 400);
  for (const order of orders) validateOrder(order, terms);
  const a = median(
    orders.filter((o) => o.side === "NO").map((o) => decimal(o.limit)),
  );
  const b = median(
    orders.filter((o) => o.side === "YES").map((o) => decimal(o.limit)),
  );
  const share = orders.length
    ? fraction(orders.filter((o) => o.side === "YES").length, orders.length)
    : null;
  if (!orders.length)
    return {
      a,
      b,
      share,
      price: null,
      branch: "empty" as const,
      reason: "empty",
    };
  const fallback = !a || !b || compare(a, b) >= 0;
  const targeted =
    !fallback &&
    compare(uniform(branchWord), fraction(terms.epsilon, 1000000)) >= 0;
  const u = uniform(priceWord);
  const price = targeted ? add(a!, mul(sub(b!, a!), u)) : u;
  return {
    a,
    b,
    share,
    price,
    branch: fallback
      ? ("fallback" as const)
      : targeted
        ? ("targeted" as const)
        : ("exploratory" as const),
    reason: fallback
      ? !a || !b
        ? "missing_side"
        : "nonpositive_interval"
      : null,
  };
}
export type Pricing = ReturnType<typeof priceRound>;
export function executeRound(
  orders: Order[],
  terms: Terms,
  pricing: Pricing,
  face: bigint,
) {
  if (face <= 0n) throw new A4Error("invalid face value", 400);
  const accepted = orders.map(
    (o) =>
      pricing.price !== null &&
      (o.side === "YES"
        ? compare(pricing.price, decimal(o.limit)) <= 0
        : compare(pricing.price, decimal(o.limit)) >= 0),
  );
  const both =
    orders.some((o, i) => o.side === "YES" && accepted[i]) &&
    orders.some((o, i) => o.side === "NO" && accepted[i]);
  return orders.map((o, i) => {
    const executed = Boolean(accepted[i] && both);
    const premiumExact = executed
      ? mul(
          fraction(BigInt(o.quantity) * face),
          o.side === "YES" ? pricing.price! : sub(ONE, pricing.price!),
        )
      : fraction(0);
    const premium = ceil(premiumExact);
    const feeExact = fraction(premium * BigInt(terms.feeBps), 10000);
    const fee = ceil(feeExact);
    const payoutExact = executed
      ? mul(
          fraction(BigInt(o.quantity) * face),
          o.side === "YES" ? pricing.share! : sub(ONE, pricing.share!),
        )
      : fraction(0);
    const payout = floor(payoutExact);
    return {
      participant: o.participant,
      accepted: Boolean(accepted[i]),
      executed,
      status: executed
        ? "pending"
        : accepted[i]
          ? "no_opposite"
          : "limit_not_met",
      premium: String(premium),
      fee: String(fee),
      payout: String(payout),
      net: String(payout - premium - fee),
      reservation: String(reservation(o.quantity, face, terms.feeBps)),
      released: String(
        reservation(o.quantity, face, terms.feeBps) - premium - fee,
      ),
      premiumExact,
      feeExact,
      payoutExact,
      premiumDust: sub(fraction(premium), premiumExact),
      payoutDust: sub(payoutExact, fraction(payout)),
    };
  });
}
export type Outcome = ReturnType<typeof executeRound>[number];
