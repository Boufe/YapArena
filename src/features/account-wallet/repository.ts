import type { Pool } from "pg";
import type { AccountWalletSummary, GrantProgress } from "./types.ts";
export function formatYapCoins(usdcAtomic: string) {
  const amount = BigInt(usdcAtomic);
  const magnitude = amount < 0n ? -amount : amount;
  const whole = magnitude / 10_000n;
  const fraction = (magnitude % 10_000n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return (
    (amount < 0n ? "-" : "") + String(whole) + (fraction ? `.${fraction}` : "")
  );
}
export function grantProgress(row: {
  id: string;
  kind: string;
  target: string;
  net: string;
  peak: string;
}): GrantProgress {
  const target = BigInt(row.target),
    net = BigInt(row.net),
    peak = BigInt(row.peak);
  if (target <= 0n) throw new Error("invalid grant target");
  const qualified = peak >= target;
  const remaining = qualified || net >= target ? 0n : target - net;
  const basis = qualified
    ? 10_000n
    : net <= 0n
      ? 0n
      : net >= target
        ? 10_000n
        : (net * 10_000n) / target;
  return {
    id: row.id,
    label: row.kind === "welcome" ? "Welcome grant" : "Daily grant",
    target: formatYapCoins(row.target),
    netProfit: formatYapCoins(row.net),
    remaining: formatYapCoins(String(remaining)),
    qualified,
    percent: Number(basis) / 100,
  };
}
export function createAccountWallet(database: Pool) {
  return {
    async balances(userId: string) {
      const result = await database.query<{ kind: string; amount: string }>(
        `SELECT kind,COALESCE(sum(balance),0)::text AS amount FROM coin_accounts
         WHERE user_id=$1 AND environment='live' AND asset='USDC'
           AND kind IN ('available','reserved','pending','promotional') GROUP BY kind`,
        [userId],
      );
      const progress = await database.query<{
        id: string;
        kind: string;
        target: string;
        net: string;
        peak: string;
      }>(
        `WITH owned AS (SELECT * FROM coin_grant_lots WHERE user_id=$1 AND environment='live' AND asset='USDC'),
         running AS (SELECT e.lot_id,e.net_profit,sum(e.net_profit) OVER(PARTITION BY e.lot_id ORDER BY e.id) AS cumulative
         FROM coin_grant_profit_events e JOIN owned l ON l.id=e.lot_id)
         SELECT l.id,l.kind,l.target::text,COALESCE(sum(r.net_profit),0)::text AS net,
         GREATEST(COALESCE(max(r.cumulative),0),0)::text AS peak FROM owned l LEFT JOIN running r ON r.lot_id=l.id
         GROUP BY l.id,l.kind,l.target,l.created_at ORDER BY l.created_at,l.id`,
        [userId],
      );
      const balance: AccountWalletSummary = {
        available: "0",
        reserved: "0",
        pending: "0",
        promotional: "0",
        withdrawable: "0",
        grants: progress.rows.map(grantProgress),
      };
      for (const row of result.rows) {
        if (
          row.kind === "available" ||
          row.kind === "reserved" ||
          row.kind === "pending" ||
          row.kind === "promotional"
        )
          balance[row.kind] = formatYapCoins(row.amount);
      }
      balance.withdrawable = balance.available;
      return balance;
    },
  };
}
