import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { atomicAmount, CoinOperationError } from "./external-operations.ts";
import type { CoinEnvironment } from "./external-operations.ts";

export interface CoinPosting {
  accountId: string;
  amount: string;
}
export type CoinLedgerAsset = "USDC" | "YC_PROMO";

export interface CoinJournal {
  id: string;
  environment: CoinEnvironment;
  asset: CoinLedgerAsset;
  reference: string;
  operation: "funding" | "reserve" | "payout" | "release" | "reversal";
  reversalOf?: string;
  postings: readonly CoinPosting[];
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeCoinPostings(postings: readonly CoinPosting[]) {
  if (postings.length < 2 || postings.length > 1000)
    throw new CoinOperationError("invalid posting count", 400);
  const amounts = new Map<string, bigint>();
  for (const posting of postings) {
    if (
      !uuidPattern.test(posting.accountId) ||
      typeof posting.amount !== "string" ||
      !/^-?[1-9][0-9]{0,35}$/.test(posting.amount)
    )
      throw new CoinOperationError("invalid posting", 400);
    const amount = BigInt(posting.amount);
    amounts.set(
      posting.accountId,
      (amounts.get(posting.accountId) ?? 0n) + amount,
    );
  }
  const normalized = [...amounts.entries()]
    .filter(([, amount]) => amount !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([accountId, amount]) => {
      atomicAmount(String(amount < 0n ? -amount : amount));
      return { accountId, amount: String(amount) };
    });
  if (
    normalized.length < 2 ||
    normalized.reduce((sum, p) => sum + BigInt(p.amount), 0n) !== 0n
  )
    throw new CoinOperationError("journal must balance", 400);
  return normalized;
}

// Reference components are hashed, preserving exact case/bytes and scope without
// putting wallet destinations, provider tokens or arbitrary customer text in logs.
export function coinJournalReference(input: {
  environment: CoinEnvironment;
  accountId: string;
  operation: string;
  idempotencyKey: string;
}) {
  if (
    !["sandbox", "live"].includes(input.environment) ||
    typeof input.accountId !== "string" ||
    !/^[1-9][0-9]*$/.test(input.accountId) ||
    typeof input.operation !== "string" ||
    !/^[a-z][a-z0-9_.]{0,79}$/.test(input.operation) ||
    typeof input.idempotencyKey !== "string" ||
    !input.idempotencyKey ||
    input.idempotencyKey.length > 200
  )
    throw new CoinOperationError("invalid idempotency scope", 400);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "yaparena.coin-journal.v1",
        input.environment,
        input.accountId,
        input.operation,
        input.idempotencyKey,
      ]),
    )
    .digest("hex");
}

// The caller owns BEGIN/COMMIT and authorization. Financial-worker/owner access
// is required for live assets; web runtime writes are restricted to sandbox by
// PostgreSQL policies. YC_PROMO is a separate spend-only asset, never USDC.
// Call after account/session/operation locks, before any other financial locks.
// No provider call belongs inside this transaction.
export async function postCoinJournal(
  client: PoolClient,
  journal: CoinJournal,
) {
  if (
    !uuidPattern.test(journal.id) ||
    !["sandbox", "live"].includes(journal.environment) ||
    !["USDC", "YC_PROMO"].includes(journal.asset) ||
    (journal.asset === "YC_PROMO" && journal.environment !== "sandbox") ||
    typeof journal.reference !== "string" ||
    !journal.reference ||
    journal.reference.length > 200 ||
    !["funding", "reserve", "payout", "release", "reversal"].includes(
      journal.operation,
    ) ||
    (journal.operation === "reversal") !== Boolean(journal.reversalOf) ||
    (journal.reversalOf !== undefined && !uuidPattern.test(journal.reversalOf))
  )
    throw new CoinOperationError("invalid coin journal", 400);
  const postings = normalizeCoinPostings(journal.postings);
  // One scoped business operation serializes before account locks. A UUID is not
  // an idempotency key; retries compare the original exact journal terms below.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `coin-journal:${journal.environment}:${journal.reference}`,
  ]);
  const prior = await client.query<{
    id: string;
    asset: string;
    operation: string;
    reversalOf: string | null;
  }>(
    `SELECT id,asset,operation,reversal_of AS "reversalOf" FROM coin_journals
    WHERE environment=$1 AND reference=$2`,
    [journal.environment, journal.reference],
  );
  if (prior.rows[0]) {
    const previous = prior.rows[0];
    const recorded = await client.query<CoinPosting>(
      `SELECT account_id AS "accountId",amount::text
      FROM coin_postings WHERE journal_id=$1 ORDER BY account_id`,
      [previous.id],
    );
    if (
      previous.asset !== journal.asset ||
      previous.operation !== journal.operation ||
      previous.reversalOf !== (journal.reversalOf ?? null) ||
      JSON.stringify(recorded.rows) !== JSON.stringify(postings)
    )
      throw new CoinOperationError(
        "idempotency key has different journal terms",
      );
    return { id: previous.id, created: false };
  }
  const accounts = await client.query<{
    id: string;
    balance: string;
    kind: string;
  }>(
    `SELECT id,balance::text,kind FROM coin_accounts WHERE id=ANY($1::uuid[])
      AND environment=$2 AND asset=$3 ORDER BY id FOR UPDATE`,
    [postings.map((p) => p.accountId), journal.environment, journal.asset],
  );
  if (accounts.rows.length !== postings.length)
    throw new CoinOperationError(
      "financial accounts do not match environment/asset",
    );
  for (const account of accounts.rows) {
    const delta = postings.find((p) => p.accountId === account.id)!;
    if (
      account.kind !== "backing" &&
      BigInt(account.balance) + BigInt(delta.amount) < 0n
    )
      throw new CoinOperationError("insufficient funds");
  }
  await client.query(
    `INSERT INTO coin_journals(id,environment,asset,reference,operation,reversal_of)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [
      journal.id,
      journal.environment,
      journal.asset,
      journal.reference,
      journal.operation,
      journal.reversalOf ?? null,
    ],
  );
  // Account locks are already held in stable order. Deferred database triggers
  // independently enforce balanced, sealed journals and exact reversals.
  for (const posting of postings)
    await client.query(
      `INSERT INTO coin_postings(journal_id,account_id,environment,asset,amount)
      VALUES($1,$2,$3,$4,$5)`,
      [
        journal.id,
        posting.accountId,
        journal.environment,
        journal.asset,
        posting.amount,
      ],
    );
  return { id: journal.id, created: true };
}

export async function reverseCoinJournal(
  client: PoolClient,
  input: {
    originalId: string;
    environment: CoinEnvironment;
    reference: string;
  },
) {
  if (!uuidPattern.test(input.originalId))
    throw new CoinOperationError("invalid original journal", 400);
  const original = await client.query<CoinPosting & { asset: string }>(
    `SELECT account_id AS "accountId",(-amount)::text AS amount,asset
    FROM coin_postings WHERE journal_id=$1 AND environment=$2 ORDER BY account_id`,
    [input.originalId, input.environment],
  );
  if (!original.rows.length)
    throw new CoinOperationError("original journal unavailable", 404);
  const asset = original.rows[0]!.asset;
  if (asset !== "USDC" && asset !== "YC_PROMO")
    throw new CoinOperationError("unsupported journal asset");
  return postCoinJournal(client, {
    id: randomUUID(),
    environment: input.environment,
    asset,
    reference: input.reference,
    operation: "reversal",
    reversalOf: input.originalId,
    postings: original.rows.map(({ accountId, amount }) => ({
      accountId,
      amount,
    })),
  });
}
