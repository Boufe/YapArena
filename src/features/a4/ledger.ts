import type { PoolClient } from "pg";
import { A4Error } from "./engine.ts";
export type Account = {
  id: string;
  scope: string;
  asset: string;
  userId: string | null;
  kind:
    | "available"
    | "reserved"
    | "center"
    | "collateral"
    | "fees_pending"
    | "fees"
    | "issuer";
};
export type Posting = { account: Account; amount: bigint };
export function account(
  scope: string,
  name: string,
  kind: Account["kind"],
  userId: string | null = null,
  asset = "YAP",
): Account {
  return {
    id: `${scope}:${asset}:${name}:${kind}`,
    scope,
    asset,
    userId,
    kind,
  };
}
export function transfer(
  from: Account,
  to: Account,
  amount: bigint,
): Posting[] {
  if (amount < 0n) throw new A4Error("negative transfer", 400);
  return [
    { account: from, amount: -amount },
    { account: to, amount },
  ];
}
export async function post(
  client: PoolClient,
  reference: string,
  kind: string,
  postings: Posting[],
  metadata: Record<string, unknown> = {},
) {
  const first = postings[0]?.account;
  if (
    !first ||
    postings.some(
      (p) => p.account.asset !== first.asset || p.account.scope !== first.scope,
    ) ||
    postings.reduce((sum, p) => sum + p.amount, 0n) !== 0n
  )
    throw new A4Error("unbalanced or mixed-asset postings", 400);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `a4-ledger:${first.scope}`,
  ]);
  const existing = await client.query(
    "SELECT reference FROM a4_journals WHERE reference=$1",
    [reference],
  );
  if (existing.rowCount) throw new A4Error("journal reference already posted");
  const merged = new Map<string, Posting>();
  for (const p of postings) {
    const previous = merged.get(p.account.id);
    merged.set(p.account.id, {
      account: p.account,
      amount: p.amount + (previous?.amount ?? 0n),
    });
  }
  const rows = [...merged.values()]
    .sort((a, b) => a.account.id.localeCompare(b.account.id))
    .map((p) => ({ ...p.account, amount: String(p.amount) }));
  const data = JSON.stringify(rows);
  await client.query(
    `INSERT INTO a4_accounts(id,scope,asset,user_id,kind)
    SELECT id,scope,asset,"userId"::bigint,kind FROM jsonb_to_recordset($1) AS r(id text,scope text,asset text,"userId" text,kind text)
    ON CONFLICT(id) DO NOTHING`,
    [data],
  );
  // Scope advisory lock serializes projection changes across rounds/processes.
  // The nonnegative CHECK is the final funds guard; append-only postings commit with it.
  await client.query(
    `UPDATE a4_accounts a SET amount=a.amount+r.amount::numeric
    FROM jsonb_to_recordset($1) AS r(id text,amount text) WHERE a.id=r.id`,
    [data],
  );
  await client.query(
    "INSERT INTO a4_journals(reference,scope,asset,kind,metadata) VALUES($1,$2,$3,$4,$5)",
    [reference, first.scope, first.asset, kind, JSON.stringify(metadata)],
  );
  await client.query(
    `INSERT INTO a4_postings(reference,account_id,amount)
    SELECT $1,id,amount::numeric FROM jsonb_to_recordset($2) AS r(id text,amount text)`,
    [reference, data],
  );
}
export async function balance(client: PoolClient, a: Account) {
  const result = await client.query<{ amount: string }>(
    "SELECT amount::text FROM a4_accounts WHERE id=$1",
    [a.id],
  );
  return BigInt(result.rows[0]?.amount ?? "0");
}
export async function reconcile(client: PoolClient, scope: string) {
  const result = await client.query(
    `SELECT a.id FROM a4_accounts a LEFT JOIN
    (SELECT p.account_id,sum(p.amount) AS amount FROM a4_postings p JOIN a4_accounts b ON b.id=p.account_id WHERE b.scope=$1 GROUP BY p.account_id) j ON j.account_id=a.id
    WHERE a.scope=$1 AND a.amount<>COALESCE(j.amount,0)`,
    [scope],
  );
  if (result.rowCount) throw new A4Error("ledger reconciliation failed", 503);
  return { reconciled: true };
}
