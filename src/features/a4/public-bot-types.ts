import type { Fraction } from "./fraction-types.ts";

export type BotArgument = { stance: "for" | "against"; text: string };
export type PublicBotRound = {
  id: string;
  runId: null;
  debateId: string;
  debateSlug: string;
  number: number;
  period: number;
  settledAt: string;
  closesAt: string;
  mode: "seed" | "mixed" | "observer";
  share: Fraction | null;
  offer: Fraction | null;
  medianNo: Fraction | null;
  medianYes: Fraction | null;
  branch: string | null;
  argumentLabel: string;
  ownLimit: null;
  humans: number;
  bots: number;
  executed: number;
  premium: string;
  quantity: string;
};
export type PublicBotActivity = {
  scope: "shared";
  synthetic: true;
  revision: string;
  hasMore: boolean;
  window: number;
  items: PublicBotRound[];
  arguments: (BotArgument & {
    rate: number;
    endorsed: number;
    population: number;
  })[];
  category: string;
  totals: {
    premium: string;
    humanCommitments: number;
    botCommitments: number;
    executed: number;
  };
};
