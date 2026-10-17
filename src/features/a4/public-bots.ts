import type { Pool } from "pg";
import { generateBots } from "./bots.ts";
import {
  digest,
  executeRound,
  priceRound,
  randomWord,
  RULE,
  type Fraction,
} from "./engine.ts";
import type {
  BotArgument,
  PublicBotRound,
  PublicBotActivity,
} from "./public-bot-types.ts";
export type {
  BotArgument,
  PublicBotRound,
  PublicBotActivity,
} from "./public-bot-types.ts";

export const fractionNumber = (v: Fraction | null | undefined) =>
  v ? Number(v.n) / Number(v.d) : null;
export function simulationArguments(proposition: string): {
  category: string;
  arguments: BotArgument[];
} {
  const bank: [RegExp, string, string[]][] = [
    [
      /record/,
      "Technology",
      [
        "Recorded audio and video can preserve the full conversation.",
        "A playable file alone does not establish recording quality.",
        "A replay lets viewers revisit details they missed live.",
        "Missing segments or timing drift can distort the discussion.",
        "Clear captions make the recording easier to follow.",
        "Device and network differences still need testing.",
      ],
    ],
    [
      /chat/,
      "Technology",
      [
        "Immediate messages let viewers respond to the debate.",
        "Delivery delays can make replies lose their context.",
        "Conversation helps people compare interpretations.",
        "Spam can crowd out thoughtful contributions.",
        "Moderation can keep the discussion useful.",
        "Message delivery alone does not guarantee a good conversation.",
      ],
    ],
    [
      /monopol/,
      "Economy",
      [
        "Large firms can spread substantial fixed costs.",
        "Limited competition can raise prices and reduce choice.",
        "Scale can support investment in research and infrastructure.",
        "Dominant firms can make entry harder for competitors.",
        "Coordinated networks can improve service reliability.",
        "Market power can weaken incentives to improve quality.",
      ],
    ],
    [
      /minimum|salaire|wage/,
      "Economy",
      [
        "Higher wages can improve workers’ purchasing power.",
        "Higher payroll costs can put pressure on small employers.",
        "A wage floor can reduce reliance on income supplements.",
        "Employers may reduce hours or hiring to absorb costs.",
        "More household spending can benefit local businesses.",
        "The effects depend on local prices and productivity.",
      ],
    ],
    [
      /transport|walk|cities|cars/,
      "Society",
      [
        "Better access can make everyday trips easier.",
        "Service still needs reliable funding and capacity.",
        "Shared transport can reduce congestion and emissions.",
        "Poor coverage can leave some communities behind.",
        "Safer shared spaces can support local activity.",
        "Maintenance and implementation involve trade-offs.",
      ],
    ],
    [
      /vibecod|vibe.cod|\bai\b|creativ/,
      "Technology",
      [
        "Tools can lower the barrier to creating useful software.",
        "Generated code can contain subtle security or reliability flaws.",
        "Fast prototypes can help people test their ideas.",
        "Maintaining a system requires understanding how it works.",
        "People can combine domain knowledge with new tools.",
        "Convenient output can hide mistakes that need human review.",
      ],
    ],
    [
      /suzuki|caufield|woods|goat|goals|points|flyers|basketball/,
      "Sport",
      [
        "Strong past performances support an optimistic outlook.",
        "Injuries and changing conditions make outcomes uncertain.",
        "Consistency across demanding competition is meaningful evidence.",
        "One statistic cannot capture every part of performance.",
        "Support and preparation can help sustain improvement.",
        "Comparisons depend on era, role and opposition.",
      ],
    ],
    [
      /work|week/,
      "Society",
      [
        "A shorter week can reward focused output.",
        "Some services cannot easily close for an extra day.",
        "More recovery time can help reduce burnout.",
        "Compressed schedules can increase daily pressure.",
        "Pilot programs can reveal practical benefits.",
        "Results may differ across industries and workplaces.",
      ],
    ],
  ];
  const match = bank.find(([pattern]) =>
    pattern.test(proposition.toLocaleLowerCase()),
  );
  const texts = match?.[2] ?? [
    `Supporters see a practical benefit in the position “${proposition}”.`,
    "The strongest counterexample may limit how broadly the claim applies.",
    "A concrete trial could make the possible benefits easier to assess.",
    "Implementation costs and unintended effects need examination.",
    "The position may address a problem overlooked by the status quo.",
    "Alternative explanations and options deserve comparison.",
  ];
  return {
    category: match?.[1] ?? "Ideas",
    arguments: texts.map((text, i) => ({
      stance: i % 2 ? "against" : "for",
      text,
    })),
  };
}
// Each argument has an independent heterogeneous cohort, not a share of a total.
export function argumentEndorsements(
  seed: string,
  args: BotArgument[],
  population = 500,
) {
  return args.map((argument, i) => {
    const orders = generateBots(
      digest({ seed, argument: argument.text, i }),
      1,
      population,
      "heterogeneous",
      1,
      0,
    );
    const endorsed = orders.filter((o) => o.side === "YES").length;
    return {
      ...argument,
      endorsed,
      population,
      rate: (endorsed * 100) / population,
    };
  });
}
export function syntheticRound(seed: string, period: number, population = 500) {
  const terms = {
    rule: RULE,
    epsilon: 50000,
    feeBps: 0,
    maxQuantity: 100,
    capacity: 1001,
  } as const;
  const orders = generateBots(seed, period, population, "heterogeneous", 1, 0);
  const pricing = priceRound(
    orders,
    terms,
    randomWord(seed, `branch:${period}`),
    randomWord(seed, `offer:${period}`),
  );
  const outcomes = executeRound(orders, terms, pricing, 1000000n);
  return {
    share: pricing.share,
    offer: pricing.price,
    medianNo: pricing.a,
    medianYes: pricing.b,
    branch: pricing.branch,
    humans: 0,
    bots: population,
    executed: outcomes.filter((o) => o.executed).length,
    premium: outcomes.reduce((n, o) => n + BigInt(o.premium), 0n).toString(),
    quantity: outcomes
      .reduce((n, o, i) => n + (o.executed ? orders[i]!.quantity : 0), 0)
      .toString(),
  };
}
type Row = Omit<
  PublicBotRound,
  "number" | "runId" | "ownLimit" | "argumentLabel"
> & {
  seed: string;
  argumentLabel: string | null;
  arguments: BotArgument[];
  category: string;
  topicId: string;
  proposition: string;
  total?: number;
  argumentResults?: PublicBotActivity["arguments"] | null;
};
export function createPublicBotRepository(database: Pool) {
  const memo = new Map<string, PublicBotActivity["arguments"]>();
  function activity(rows: Row[]): PublicBotActivity {
    const recent = rows.slice(-100),
      last = recent.at(-1);
    const totals = new Map<string, number>();
    for (const r of rows)
      totals.set(
        r.debateId,
        r.total ?? rows.filter((v) => v.debateId === r.debateId).length,
      );
    const total = [...totals.values()].reduce((n, v) => n + v, 0);
    const key = last ? digest([last.seed, last.arguments]) : "";
    let args = last?.argumentResults ?? memo.get(key);
    if (!args && last) {
      args = argumentEndorsements(last.seed, last.arguments);
      if (memo.size >= 100) memo.delete(memo.keys().next().value!);
      memo.set(key, args);
    }
    const items = recent.map(
      (r, i) =>
        ({
          id: r.id,
          runId: null,
          debateId: r.debateId,
          debateSlug: r.debateSlug,
          number: total - recent.length + i + 1,
          period: r.period,
          settledAt: new Date(r.settledAt).toISOString(),
          closesAt: new Date(r.closesAt).toISOString(),
          mode: r.mode,
          share: r.share,
          offer: r.offer,
          medianNo: r.medianNo,
          medianYes: r.medianYes,
          branch: r.branch,
          argumentLabel:
            r.argumentLabel ??
            r.arguments[(r.period - 1) % r.arguments.length]!.text.slice(0, 80),
          ownLimit: null,
          humans: r.humans,
          bots: r.bots,
          executed: r.executed,
          premium: r.premium,
          quantity: r.quantity,
        }) satisfies PublicBotRound,
    );
    return {
      scope: "shared",
      synthetic: true,
      revision: digest([items, args]),
      hasMore: total > 100,
      window: 100,
      items,
      arguments: args ?? [],
      category: last?.category ?? "Ideas",
      totals: {
        premium: items.reduce((n, r) => n + BigInt(r.premium), 0n).toString(),
        humanCommitments: items.reduce((n, r) => n + r.humans, 0),
        botCommitments: items.reduce((n, r) => n + r.bots, 0),
        executed: items.reduce((n, r) => n + r.executed, 0),
      },
    };
  }
  async function read(debateIds: string[]) {
    if (!debateIds.length) return [];
    const result = await database.query<Row>(
      `
      WITH base_visible AS MATERIALIZED (
        SELECT d.id,d.slug,d.topic_id,COALESCE(f.arguments,'[]'::jsonb) AS arguments,
          COALESCE(f.category,'Ideas') AS category,d.proposition
        FROM debates d JOIN topics t ON t.id=d.topic_id LEFT JOIN a4_synthetic_debates f ON f.debate_id=d.id
        WHERE d.id=ANY($1::uuid[]) AND d.publication_state='published' AND t.publication_state='published'
      ), visible AS MATERIALIZED (
        SELECT v.*,
          ((SELECT count(*) FROM a4_synthetic_rounds r WHERE r.debate_id=v.id AND r.simulated_at<=clock_timestamp())+
          (SELECT count(*) FROM a4_sessions s JOIN a4_public_publishers p ON p.user_id=s.creator_id JOIN a4_rounds r ON r.session_id=s.id
            WHERE s.debate_id=v.id AND s.mode IN ('mixed','observer') AND s.asset='YAP' AND r.state='settled'
              AND r.revealed_at IS NOT NULL AND s.reveal_at<=clock_timestamp() AND r.revealed_at<=clock_timestamp()))::int AS total
        FROM base_visible v
      ), rounds AS (
        SELECT v.*,r.id AS round_id,r.simulated_at AS at,r.seed,r.result,r.number AS period,'seed' AS mode,NULL::text AS argument_label
        FROM visible v JOIN LATERAL (
          SELECT *,row_number() OVER(ORDER BY simulated_at,id)::int AS number FROM a4_synthetic_rounds
          WHERE debate_id=v.id AND simulated_at<=clock_timestamp() ORDER BY simulated_at DESC,id DESC LIMIT 101
        ) r ON true
        UNION ALL
        SELECT v.*,r.id,r.revealed_at,r.seed,
          jsonb_build_object('share',r.pricing->'share','offer',r.pricing->'price','medianNo',r.pricing->'a','medianYes',r.pricing->'b','branch',r.pricing->'branch',
            'humans',stats.humans,'bots',stats.bots,'executed',stats.executed,'premium',stats.premium,'quantity',stats.quantity),
          r.period,r.mode,r.argument_label
        FROM visible v JOIN LATERAL (
          SELECT r.*,s.mode,s.config->>'argumentLabel' AS argument_label FROM a4_sessions s
          JOIN a4_public_publishers p ON p.user_id=s.creator_id JOIN a4_rounds r ON r.session_id=s.id
          WHERE s.debate_id=v.id AND s.mode IN ('mixed','observer') AND s.asset='YAP' AND r.state='settled'
            AND r.revealed_at IS NOT NULL AND s.reveal_at<=clock_timestamp() AND r.revealed_at<=clock_timestamp()
          ORDER BY r.revealed_at DESC,r.id DESC LIMIT 101
        ) r ON true JOIN LATERAL (
          SELECT count(*) FILTER(WHERE kind='human')::int AS humans,count(*) FILTER(WHERE kind='bot')::int AS bots,
            count(*) FILTER(WHERE (outcome->>'executed')::boolean)::int AS executed,
            COALESCE(sum((outcome->>'premium')::numeric),0)::text AS premium,
            COALESCE(sum(quantity) FILTER(WHERE (outcome->>'executed')::boolean),0)::text AS quantity
          FROM a4_submissions WHERE round_id=r.id
        ) stats ON true
      ) SELECT round_id AS id,id AS "debateId",slug AS "debateSlug",topic_id AS "topicId",period,
        at AS "settledAt",at AS "closesAt",mode,seed,result->'share' AS share,result->'offer' AS offer,
        result->'medianNo' AS "medianNo",result->'medianYes' AS "medianYes",result->>'branch' AS branch,
        (result->>'humans')::int AS humans,(result->>'bots')::int AS bots,(result->>'executed')::int AS executed,
        result->>'premium' AS premium,result->>'quantity' AS quantity,result->'argumentResults' AS "argumentResults",argument_label AS "argumentLabel",arguments,category,proposition
        ,total FROM rounds ORDER BY at,round_id`,
      [debateIds],
    );
    return result.rows.map((r) => ({
      ...r,
      arguments: r.arguments.length
        ? r.arguments
        : simulationArguments(r.proposition).arguments,
    }));
  }
  return {
    async debate(id: string) {
      const visible = await database.query(
        "SELECT 1 FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.id=$1 AND d.publication_state='published' AND t.publication_state='published'",
        [id],
      );
      return visible.rowCount ? activity(await read([id])) : null;
    },
    async topics(ids: string[]) {
      if (!ids.length) return {} as Record<string, PublicBotActivity>;
      const debates = await database.query<{ id: string }>(
        `SELECT d.id FROM debates d JOIN topics t ON t.id=d.topic_id WHERE d.topic_id=ANY($1::uuid[]) AND d.publication_state='published' AND t.publication_state='published' ORDER BY d.created_at DESC,d.id DESC LIMIT 100`,
        [ids],
      );
      const rows = await read(debates.rows.map((d) => d.id));
      return Object.fromEntries(
        ids.map((id) => [id, activity(rows.filter((r) => r.topicId === id))]),
      );
    },
  };
}
