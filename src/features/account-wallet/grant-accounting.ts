import { createHash } from "node:crypto";
import { atomicAmount, CoinOperationError } from "./external-operations.ts";
import type { CoinEnvironment } from "./external-operations.ts";

export interface AccountCoinScope {
  accountId: string;
  environment: CoinEnvironment;
  asset: "USDC";
  precision: 6;
}
// These are USDC-equivalent accounting units, not proof of cash. Grant
// principal is a permanently spend-only entitlement. Keep it in a separate
// promotional-source ledger: it must never credit real USDC reserves, center
// collateral, purchased backing or fees when used as an A4 stake premium.
// Purchased and earned-profit cash movements require independently reconciled
// ledger backing; the pure book cannot mint or establish that backing.
export interface AccountingGrant {
  id: string;
  kind: "welcome" | "daily";
  createdAt: string;
  principal: string;
  principalRemaining: string;
  profitRemaining: string;
  netProfit: string;
  peakNetProfit: string;
}
export interface PurchasedSource {
  id: string;
  kind: "purchased_principal" | "purchased_profit";
  purchaseId: string;
  createdAt: string;
  balance: string;
}
export interface GrantAccountingBook {
  scope: Readonly<AccountCoinScope>;
  grants: readonly Readonly<AccountingGrant>[];
  purchased: readonly Readonly<PurchasedSource>[];
}
export interface AccountingSourceSlice {
  id: string;
  kind: "grant" | "purchased_principal" | "purchased_profit";
  grantKind?: "welcome" | "daily";
  purchaseId?: string;
  principal: string;
  profit: string;
  amount: string;
}
export interface StakeFunding {
  scope: Readonly<AccountCoinScope>;
  amount: string;
  sources: readonly Readonly<AccountingSourceSlice>[];
}
export type GrantProfitBacking = Readonly<Record<string, string>>;

function invalid(message: string): never {
  throw new CoinOperationError(message, 400);
}
function identifier(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value))
    invalid("invalid accounting source identity");
}
function timestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    invalid("invalid accounting timestamp");
}
function signed(value: string) {
  if (!/^(0|-?[1-9][0-9]{0,35})$/.test(value))
    invalid("invalid signed atomic amount");
  return BigInt(value);
}
function scopeKey(scope: Readonly<AccountCoinScope>) {
  if (
    !/^[1-9][0-9]*$/.test(scope.accountId) ||
    !["sandbox", "live"].includes(scope.environment) ||
    scope.asset !== "USDC" ||
    scope.precision !== 6
  )
    invalid("invalid accounting environment or asset");
  return JSON.stringify([
    scope.accountId,
    scope.environment,
    scope.asset,
    scope.precision,
  ]);
}
function validate(book: GrantAccountingBook) {
  scopeKey(book.scope);
  const ids = new Set<string>();
  for (const source of [...book.grants, ...book.purchased]) {
    identifier(source.id);
    timestamp(source.createdAt);
    if (ids.has(source.id)) invalid("duplicate accounting source");
    ids.add(source.id);
  }
  for (const grant of book.grants) {
    if (!["welcome", "daily"].includes(grant.kind))
      invalid("invalid grant category");
    const principal = atomicAmount(grant.principal);
    if (
      principal !== (grant.kind === "welcome" ? 25_000_000n : 5_000_000n) ||
      atomicAmount(grant.principalRemaining, true) > principal ||
      atomicAmount(grant.peakNetProfit, true) < signed(grant.netProfit)
    )
      invalid("invalid grant principal or profit history");
    atomicAmount(grant.profitRemaining, true);
  }
  for (const source of book.purchased) {
    if (!["purchased_principal", "purchased_profit"].includes(source.kind))
      invalid("invalid purchased source category");
    identifier(source.purchaseId);
    atomicAmount(source.balance, true);
  }
}
function mutable(book: GrantAccountingBook) {
  validate(book);
  return {
    scope: { ...book.scope },
    grants: book.grants.map((grant) => ({ ...grant })),
    purchased: book.purchased.map((source) => ({ ...source })),
  };
}
function freeze(book: GrantAccountingBook): GrantAccountingBook {
  validate(book);
  return Object.freeze({
    scope: Object.freeze({ ...book.scope }),
    grants: Object.freeze(
      book.grants.map((grant) => Object.freeze({ ...grant })),
    ),
    purchased: Object.freeze(
      book.purchased.map((source) => Object.freeze({ ...source })),
    ),
  });
}
function oldest<T extends { id: string; createdAt: string }>(
  sources: readonly T[],
) {
  return [...sources].sort((a, b) =>
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
}
function purchaseOrder<T extends Readonly<PurchasedSource>>(
  book: { purchased: readonly T[] },
  order: readonly string[],
) {
  if (
    order.length !== book.purchased.length ||
    new Set(order).size !== order.length
  )
    invalid("explicit purchased source order is required");
  const sources = new Map(book.purchased.map((source) => [source.id, source]));
  return order.map((id) => {
    const source = sources.get(id);
    if (!source) invalid("unknown purchased source in order");
    return source;
  });
}
function add(value: string, delta: bigint) {
  const result = BigInt(value) + delta;
  atomicAmount(String(result), true);
  return String(result);
}
function minimum(a: bigint, b: bigint) {
  return a < b ? a : b;
}

// Allocate magnitudes, then restore the sign. Remainders use source order for
// ties, making profit and loss allocation symmetric and every atom conserved.
export function allocateAtomicProportionally(
  total: bigint,
  weights: readonly bigint[],
) {
  if (
    typeof total !== "bigint" ||
    !weights.length ||
    weights.some((weight) => typeof weight !== "bigint" || weight < 0n)
  )
    invalid("invalid proportional allocation");
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  if (denominator === 0n) invalid("proportional allocation requires a source");
  const magnitude = total < 0n ? -total : total;
  const shares = weights.map((weight) => (magnitude * weight) / denominator);
  const residual = magnitude - shares.reduce((sum, share) => sum + share, 0n);
  const ranked = weights
    .map((weight, index) => ({
      index,
      remainder: (magnitude * weight) % denominator,
    }))
    .sort((a, b) =>
      a.remainder > b.remainder
        ? -1
        : a.remainder < b.remainder
          ? 1
          : a.index - b.index,
    );
  for (let i = 0; BigInt(i) < residual; i++) shares[ranked[i]!.index]! += 1n;
  return shares.map((share) => (total < 0n ? -share : share));
}

export function torontoGrantDay(at: Date) {
  if (!Number.isFinite(at.getTime())) invalid("invalid grant claim date");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (name: string) =>
    parts.find((entry) => entry.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function grantClaimKey(
  scope: Readonly<AccountCoinScope>,
  kind: "welcome" | "daily",
  at: Date,
) {
  const owner = scopeKey(scope);
  if (!["welcome", "daily"].includes(kind)) invalid("invalid grant claim kind");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "yaparena.grant-claim.v1",
        owner,
        kind,
        kind === "daily" ? torontoGrantDay(at) : "once",
      ]),
    )
    .digest("hex");
}
export function newAccountingGrant(input: {
  id: string;
  kind: "welcome" | "daily";
  createdAt: string;
}): Readonly<AccountingGrant> {
  identifier(input.id);
  timestamp(input.createdAt);
  if (!["welcome", "daily"].includes(input.kind))
    invalid("invalid grant category");
  const principal = input.kind === "welcome" ? "25000000" : "5000000";
  return Object.freeze({
    ...input,
    principal,
    principalRemaining: principal,
    profitRemaining: "0",
    netProfit: "0",
    peakNetProfit: "0",
  });
}
export function grantQualified(grant: Readonly<AccountingGrant>) {
  return (
    atomicAmount(grant.peakNetProfit, true) >= atomicAmount(grant.principal)
  );
}

// This is an exact funding PLAN, not promotional exposure admission. A caller
// must reserve independently funded maximum exposure before committing a grant
// stake. Purchased component order is explicit until its product rule is chosen.
export function planStake(
  book: GrantAccountingBook,
  amount: string,
  purchasedOrder: readonly string[],
) {
  const result = mutable(book);
  const ordered = purchaseOrder(result, purchasedOrder);
  let remaining = atomicAmount(amount);
  const slices: AccountingSourceSlice[] = [];
  for (const grant of oldest(result.grants)) {
    if (!remaining) break;
    const principal = minimum(remaining, BigInt(grant.principalRemaining));
    const profit = minimum(
      remaining - principal,
      BigInt(grant.profitRemaining),
    );
    const used = principal + profit;
    if (!used) continue;
    grant.principalRemaining = add(grant.principalRemaining, -principal);
    grant.profitRemaining = add(grant.profitRemaining, -profit);
    slices.push({
      id: grant.id,
      kind: "grant",
      grantKind: grant.kind,
      principal: String(principal),
      profit: String(profit),
      amount: String(used),
    });
    remaining -= used;
  }
  for (const source of ordered) {
    if (!remaining) break;
    const used = minimum(remaining, BigInt(source.balance));
    if (!used) continue;
    source.balance = add(source.balance, -used);
    slices.push({
      id: source.id,
      kind: source.kind,
      purchaseId: source.purchaseId,
      principal: source.kind === "purchased_principal" ? String(used) : "0",
      profit: source.kind === "purchased_profit" ? String(used) : "0",
      amount: String(used),
    });
    remaining -= used;
  }
  if (remaining) throw new CoinOperationError("insufficient source balance");
  const funding: StakeFunding = Object.freeze({
    scope: Object.freeze({ ...book.scope }),
    amount,
    sources: Object.freeze(slices.map((source) => Object.freeze(source))),
  });
  return { book: freeze(result), funding };
}

function validateFunding(book: GrantAccountingBook, funding: StakeFunding) {
  validate(book);
  if (scopeKey(book.scope) !== scopeKey(funding.scope))
    invalid("funding belongs to another account or environment");
  const ids = new Set<string>();
  let total = 0n;
  for (const slice of funding.sources) {
    if (ids.has(slice.id)) invalid("duplicate funding source");
    ids.add(slice.id);
    const amount = atomicAmount(slice.amount);
    const principal = atomicAmount(slice.principal, true),
      profit = atomicAmount(slice.profit, true);
    if (principal + profit !== amount)
      invalid("funding components do not balance");
    if (slice.kind === "grant") {
      if (
        !book.grants.some(
          (grant) => grant.id === slice.id && grant.kind === slice.grantKind,
        ) ||
        slice.purchaseId !== undefined
      )
        invalid("grant funding provenance does not match");
    } else {
      const purchased = book.purchased.find((source) => source.id === slice.id);
      if (
        !purchased ||
        purchased.kind !== slice.kind ||
        purchased.purchaseId !== slice.purchaseId ||
        slice.grantKind !== undefined ||
        (slice.kind === "purchased_principal"
          ? profit !== 0n
          : principal !== 0n)
      )
        invalid("purchase funding provenance does not match");
    }
    total += amount;
  }
  if (total !== atomicAmount(funding.amount))
    invalid("funding total does not balance");
}

export function settleStake(
  book: GrantAccountingBook,
  funding: StakeFunding,
  netResult: string,
  settledAt: string,
) {
  validateFunding(book, funding);
  timestamp(settledAt);
  const net = signed(netResult);
  if (net < -BigInt(funding.amount)) invalid("net loss exceeds reserved stake");
  const result = mutable(book);
  const allocation = allocateAtomicProportionally(
    net,
    funding.sources.map((source) => BigInt(source.amount)),
  );
  const receipts = funding.sources.map((slice, index) => {
    const share = allocation[index]!;
    const returned = BigInt(slice.amount) + share;
    if (slice.kind === "grant") {
      const grant = result.grants.find((source) => source.id === slice.id)!;
      // Approved rule: earlier earned profit absorbs intra-grant losses first.
      // Returning value restores only this stake's original principal, then
      // original earned profit and new net profit. Lost principal never returns.
      const principalReturned = minimum(returned, BigInt(slice.principal));
      grant.principalRemaining = add(
        grant.principalRemaining,
        principalReturned,
      );
      grant.profitRemaining = add(
        grant.profitRemaining,
        returned - principalReturned,
      );
      grant.netProfit = String(signed(grant.netProfit) + share);
      const peak = BigInt(grant.peakNetProfit);
      if (BigInt(grant.netProfit) > peak) grant.peakNetProfit = grant.netProfit;
      return {
        ...slice,
        netResult: String(share),
        returned: String(returned),
        principalReturned: String(principalReturned),
        profitReturned: String(returned - principalReturned),
        qualified: grantQualified(grant),
      };
    }
    const source = result.purchased.find((entry) => entry.id === slice.id)!;
    const originalReturned = minimum(returned, BigInt(slice.amount));
    source.balance = add(source.balance, originalReturned);
    const profit = share > 0n ? share : 0n;
    if (profit) {
      if (source.kind === "purchased_profit")
        source.balance = add(source.balance, profit);
      else {
        const profitId = `profit:${createHash("sha256").update(source.purchaseId).digest("hex")}`;
        let profitSource = result.purchased.find(
          (entry) => entry.id === profitId,
        );
        if (
          profitSource &&
          (profitSource.kind !== "purchased_profit" ||
            profitSource.purchaseId !== source.purchaseId)
        )
          invalid("purchased profit identity conflict");
        if (!profitSource) {
          profitSource = {
            id: profitId,
            kind: "purchased_profit",
            purchaseId: source.purchaseId,
            createdAt: settledAt,
            balance: "0",
          };
          result.purchased.push(profitSource);
        }
        profitSource.balance = add(profitSource.balance, profit);
      }
    }
    return {
      ...slice,
      netResult: String(share),
      returned: String(returned),
      principalReturned:
        source.kind === "purchased_principal" ? String(originalReturned) : "0",
      profitReturned:
        source.kind === "purchased_profit" ? String(returned) : String(profit),
      qualified: true,
    };
  });
  return {
    book: freeze(result),
    receipts: Object.freeze(receipts.map((receipt) => Object.freeze(receipt))),
  };
}

// Only for a persisted, never-executed stake. Caller must lock its operation and
// atomically mark it released: pure functions cannot prevent receipt replay.
export function refundStake(book: GrantAccountingBook, funding: StakeFunding) {
  validateFunding(book, funding);
  const result = mutable(book);
  for (const slice of funding.sources) {
    if (slice.kind === "grant") {
      const grant = result.grants.find((source) => source.id === slice.id)!;
      grant.principalRemaining = add(
        grant.principalRemaining,
        BigInt(slice.principal),
      );
      grant.profitRemaining = add(grant.profitRemaining, BigInt(slice.profit));
    } else {
      const source = result.purchased.find((entry) => entry.id === slice.id)!;
      source.balance = add(source.balance, BigInt(slice.amount));
    }
  }
  return freeze(result);
}

function backingFor(book: GrantAccountingBook, backing: GrantProfitBacking) {
  const balances = new Map<string, bigint>();
  for (const [id, amount] of Object.entries(backing)) {
    const grant = book.grants.find((entry) => entry.id === id);
    const backed = atomicAmount(amount, true);
    if (!grant || backed > BigInt(grant.profitRemaining))
      invalid("invalid grant profit backing");
    balances.set(id, backed);
  }
  return balances;
}
export function projectGrantAccounting(
  book: GrantAccountingBook,
  backing: GrantProfitBacking,
) {
  validate(book);
  const backed = backingFor(book, backing);
  const sum = (values: readonly string[]) =>
    String(values.reduce((total, value) => total + BigInt(value), 0n));
  const purchasedPrincipal = sum(
    book.purchased
      .filter((source) => source.kind === "purchased_principal")
      .map((source) => source.balance),
  );
  const purchasedProfit = sum(
    book.purchased
      .filter((source) => source.kind === "purchased_profit")
      .map((source) => source.balance),
  );
  const eligibleGrantProfit = book.grants.reduce(
    (total, grant) =>
      total + (grantQualified(grant) ? (backed.get(grant.id) ?? 0n) : 0n),
    0n,
  );
  return Object.freeze({
    grantPrincipal: sum(book.grants.map((grant) => grant.principalRemaining)),
    grantProfit: sum(book.grants.map((grant) => grant.profitRemaining)),
    purchasedPrincipal,
    purchasedProfit,
    withdrawable: String(
      BigInt(purchasedPrincipal) +
        BigInt(purchasedProfit) +
        eligibleGrantProfit,
    ),
    grants: Object.freeze(
      book.grants.map((grant) =>
        Object.freeze({
          id: grant.id,
          kind: grant.kind,
          qualified: grantQualified(grant),
          netProfit: grant.netProfit,
          peakNetProfit: grant.peakNetProfit,
          remainingTarget: String(
            grantQualified(grant)
              ? 0n
              : BigInt(grant.principal) - BigInt(grant.netProfit),
          ),
          withdrawableProfit: String(
            grantQualified(grant) ? (backed.get(grant.id) ?? 0n) : 0n,
          ),
        }),
      ),
    ),
  });
}

// No withdrawal minimum/day/fee policy is decided here. Exact requested debit
// is allocated to purchased sources first, then qualified funded grant profit.
export function planWithdrawal(
  book: GrantAccountingBook,
  amount: string,
  purchasedOrder: readonly string[],
  backing: GrantProfitBacking,
) {
  const result = mutable(book);
  const ordered = purchaseOrder(result, purchasedOrder);
  const backed = backingFor(result, backing);
  let remaining = atomicAmount(amount);
  const sources: {
    id: string;
    amount: string;
    kind: AccountingSourceSlice["kind"];
  }[] = [];
  for (const source of ordered) {
    const used = minimum(remaining, BigInt(source.balance));
    if (!used) continue;
    source.balance = add(source.balance, -used);
    sources.push({ id: source.id, kind: source.kind, amount: String(used) });
    remaining -= used;
  }
  for (const grant of oldest(result.grants)) {
    if (!remaining) break;
    if (!grantQualified(grant)) continue;
    const used = minimum(remaining, backed.get(grant.id) ?? 0n);
    if (!used) continue;
    grant.profitRemaining = add(grant.profitRemaining, -used);
    backed.set(grant.id, (backed.get(grant.id) ?? 0n) - used);
    sources.push({ id: grant.id, kind: "grant", amount: String(used) });
    remaining -= used;
  }
  if (remaining)
    throw new CoinOperationError("insufficient withdrawable backing");
  return {
    book: freeze(result),
    backing: Object.freeze(
      Object.fromEntries([...backed].map(([id, value]) => [id, String(value)])),
    ),
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
  };
}
export function planPurchaseRefund(
  book: GrantAccountingBook,
  purchaseId: string,
  amount: string,
) {
  const result = mutable(book);
  identifier(purchaseId);
  let remaining = atomicAmount(amount);
  const sources: { id: string; amount: string }[] = [];
  for (const source of oldest(result.purchased)) {
    if (
      source.kind !== "purchased_principal" ||
      source.purchaseId !== purchaseId
    )
      continue;
    const used = minimum(remaining, BigInt(source.balance));
    if (!used) continue;
    source.balance = add(source.balance, -used);
    sources.push({ id: source.id, amount: String(used) });
    remaining -= used;
  }
  if (remaining)
    throw new CoinOperationError("unused purchase principal is unavailable");
  return {
    book: freeze(result),
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
  };
}
