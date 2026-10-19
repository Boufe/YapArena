// HTTP fixtures retain the public wire types, including receipt settlement fields.
import type {
  Run as BrowserRun,
  Round as BrowserRound,
  Receipt as BrowserReceipt,
} from "../frontend/arena-types.ts";
export type { Fraction } from "../src/features/a4/fraction-types.ts";
export type Round = Omit<BrowserRound, "receipt"> & {
  receipt: (BrowserReceipt & { accepted?: boolean; executed?: boolean }) | null;
};
export type Run = Omit<BrowserRun, "rounds"> & { rounds: Round[] };
