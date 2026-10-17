// Wire values used by the existing A4 browser views. Dates arrive as JSON strings.
import type { Fraction } from "../src/features/a4/fraction-types.ts";
import type { PublicBotActivity } from "../src/features/a4/public-bot-types.ts";
export type { Fraction } from "../src/features/a4/fraction-types.ts";
export interface RoundPoint {
  id: string;
  runId: string | null;
  number: number;
  argumentLabel: string | null;
  share: Fraction | null;
  offer: Fraction | null;
  medianNo: Fraction | null;
  medianYes: Fraction | null;
  ownLimit: string | null;
  branch: string | null;
  state?: string;
  revealed?: boolean;
}
export interface Timeline {
  revision: string;
  scope: "human" | "sandbox" | "shared";
  items: RoundPoint[];
  totals: { premium: string; humanCommitments: number; botCommitments: number };
}
export type SharedActivity = PublicBotActivity;
export interface Receipt {
  side: string;
  limit: string;
  quantity: number;
  status: string;
  reserved: string;
  premium?: string;
  fee?: string;
  released?: string;
  payout?: string;
  net?: string;
}
export interface Round {
  id: string;
  period: number;
  state: string;
  opensAt: string;
  closesAt: string;
  seedCommitment: string;
  offer: Fraction | null;
  receipt: Receipt | null;
  revealed: boolean;
  diagnostics?: {
    totals: {
      humans: number;
      bots: number;
      participants: number;
      accepted: number;
      executed: number;
      quantity: string;
      premium: string;
      payout: string;
      fee: string;
    };
    pricing: {
      share: Fraction | null;
      branch: string | null;
      a: Fraction | null;
      b: Fraction | null;
      price: Fraction | null;
    } | null;
    centerFunding: string;
    centerAvailable: string;
    centerTrading: string;
    centerFees: string;
    centerResult: string;
    noTrade: boolean;
    snapshotHash: string | null;
    pagination: { hasMore: boolean };
    book: {
      label: string;
      kind: string;
      side: string;
      limit: string;
      quantity: number;
      outcome: { status: string; net: string } | null;
    }[];
  };
}
export interface Balance {
  kind: string;
  amount: string;
}
export interface FundingPolicy {
  starterCoins: number;
  refillCoins: number;
}
export interface Wallet {
  balances: Balance[];
  fundingPolicy: FundingPolicy;
  mode: string;
}
export interface Run {
  id: string;
  mode: string;
  state: string;
  observer: boolean;
  speed: number;
  revealAt: string;
  debate: { proposition: string; slug: string };
  config: {
    population: number;
    preset: string;
    feeBps: number;
    epsilon: number;
    rule: string;
    argumentLabel?: string;
  };
  balances: Balance[];
  fundingPolicy: FundingPolicy;
  rounds: Round[];
}
// A selection stores only its id until the immediately following refresh fills it.
export type SelectedRun = Pick<Run, "id"> & Partial<Omit<Run, "id">>;
export interface Runs {
  items: {
    id: string;
    mode: string;
    state: string;
    argumentLabel: string | null;
  }[];
}
export interface Auth {
  user: { id: string };
}
export interface Publication {
  published: boolean;
}
export interface Workspace {
  accountId: string;
  runs: Runs;
  run: Run | null;
  wallet: Wallet;
  timeline: Timeline;
}
export interface Commitment {
  roundId: string;
  key: string;
  body: {
    accountId: string | null | undefined;
    side: FormDataEntryValue | undefined;
    ceiling: FormDataEntryValue | undefined;
    quantity: number;
    rule: string;
  };
}
