import type { PoolClient } from "pg";
import { A4Error, digest, type Fraction } from "./engine.ts";

// A dashboard can only chart final, published settlements. Observer privileges do
// not widen this feed, and another creator's synthetic activity is never included.
export async function readTimeline(
  client: PoolClient,
  userId: string,
  debateId: string,
  scope: "human" | "sandbox",
) {
  const visible = await client.query(
    `SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id
     WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'`,
    [debateId],
  );
  if (!visible.rowCount) throw new A4Error("debate not found", 404);
  const result = await client.query<{
    id: string;
    runId: string;
    number: number;
    period: number;
    settledAt: Date;
    closesAt: Date;
    mode: "human" | "mixed";
    share: Fraction | null;
    offer: Fraction | null;
    medianNo: Fraction | null;
    medianYes: Fraction | null;
    branch: string | null;
    argumentLabel: string | null;
    ownLimit: string | null;
    humans: number;
    bots: number;
    executed: number;
    premium: string;
    quantity: string;
  }>(
    `WITH settled AS (
       SELECT r.id,r.session_id,r.period,r.revealed_at,r.closes_at,r.pricing,s.mode,
         s.config->>'argumentLabel' AS argument_label,
         row_number() OVER (ORDER BY r.revealed_at,r.id)::int AS number
       FROM a4_rounds r JOIN a4_sessions s ON s.id=r.session_id
         JOIN debates d ON d.id=s.debate_id JOIN topics t ON t.id=d.topic_id
       WHERE s.debate_id=$1 AND r.state='settled' AND r.revealed_at IS NOT NULL
         AND d.publication_state='published' AND t.publication_state='published'
         AND s.reveal_at<=clock_timestamp() AND r.revealed_at<=clock_timestamp()
         AND (($3='human' AND s.mode='human') OR
           ($3='sandbox' AND s.mode='mixed' AND s.creator_id=$2))
     ), recent AS (SELECT * FROM settled ORDER BY number DESC LIMIT 101)
     SELECT r.id,r.session_id AS "runId",r.number,r.period,r.revealed_at AS "settledAt",
       r.closes_at AS "closesAt",r.mode,r.pricing->'share' AS share,r.pricing->'price' AS offer,
       r.pricing->'a' AS "medianNo",r.pricing->'b' AS "medianYes",
       r.pricing->>'branch' AS branch,r.argument_label AS "argumentLabel",
       max(o.limit_value) FILTER(WHERE o.user_id=$2) AS "ownLimit",
       count(o.round_id) FILTER(WHERE o.kind='human')::int AS humans,
       count(o.round_id) FILTER(WHERE o.kind='bot')::int AS bots,
       count(o.round_id) FILTER(WHERE (o.outcome->>'executed')::boolean)::int AS executed,
       COALESCE(sum((o.outcome->>'premium')::numeric),0)::text AS premium,
       COALESCE(sum(o.quantity) FILTER(WHERE (o.outcome->>'executed')::boolean),0)::text AS quantity
     FROM recent r LEFT JOIN a4_submissions o ON o.round_id=r.id
     GROUP BY r.id,r.session_id,r.number,r.period,r.revealed_at,r.closes_at,r.mode,r.pricing,r.argument_label
     ORDER BY r.number DESC`,
    [debateId, userId, scope],
  );
  const items = result.rows.slice(0, 100).reverse();
  return {
    scope,
    revision: digest(items),
    hasMore: result.rows.length > 100,
    window: 100,
    items,
    totals: {
      premium: items.reduce((sum, r) => sum + BigInt(r.premium), 0n).toString(),
      humanCommitments: items.reduce((sum, r) => sum + r.humans, 0),
      botCommitments: items.reduce((sum, r) => sum + r.bots, 0),
      executed: items.reduce((sum, r) => sum + r.executed, 0),
    },
  };
}
