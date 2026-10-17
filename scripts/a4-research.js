import { writeFile } from "node:fs/promises";
import {
  RULE,
  priceRound,
  executeRound,
  randomWord,
} from "../dist/features/a4/engine.js";
import {
  auditDeviation,
  generateBots,
  benchmark,
  ideal,
} from "../dist/features/a4/bots.js";
const terms = {
  rule: RULE,
  epsilon: 0,
  feeBps: 0,
  maxQuantity: 100,
  capacity: 1001,
};
const cohort = [
  { participant: "y", kind: "bot", side: "YES", limit: "0.34", quantity: 1 },
  { participant: "n1", kind: "bot", side: "NO", limit: "0.22", quantity: 1 },
];
const seed = "a4-two-person-reference-20261015";
const report = auditDeviation(cohort, terms, "y", seed, 2000);
const population = Number(process.env.A4_RESEARCH_POPULATION ?? 500);
if (!Number.isInteger(population) || population < 2 || population > 1000)
  throw new Error("population must be 2–1000");
const started = performance.now(),
  orders = generateBots(
    "a4-heterogeneous",
    1,
    population,
    "heterogeneous",
    1,
    0,
  );
const priced = priceRound(
  orders,
  { ...terms, epsilon: 50000 },
  randomWord("a4-price", "branch"),
  randomWord("a4-price", "price"),
);
const results = executeRound(orders, terms, priced, 1000000n);
const engineMs = Math.round(performance.now() - started),
  auditStarted = performance.now();
const finite500 = auditDeviation(
  orders,
  { ...terms, epsilon: 50000 },
  "bot:0",
  "a4-500-confirmation",
  100,
);
const artifact = {
  rule: RULE,
  seed,
  scope:
    "Local reproducible fixtures; no external simulator source was available",
  benchmark: benchmark(0.5, 0.4, 0.1),
  ideal: [0, 0.05, 1].map((epsilon) => ({ epsilon, ...ideal(0.12, epsilon) })),
  finite: {
    cohort,
    ...report,
    interpretation:
      "A fixed two-person cohort permits pivotal shading. Candidate changes recompute both medians, settlement and executions. This conditional-cohort counterexample is not a general Bayesian equilibrium result; bots never receive realized settlement as input.",
  },
  finitePopulationAudit: {
    population,
    epsilon: 0.05,
    feeBps: 0,
    ...finite500,
    interpretation:
      "Conditional on the observed behavioral stress cohort; this evaluates alternative orders under paired price randomness, including nonexecution, with independently confirmed uncertainty. It does not establish an ex ante Bayesian strategy or general honesty result.",
  },
  heterogeneous: {
    seed: "a4-heterogeneous",
    period: 1,
    epsilon: 0.05,
    population,
    model:
      "Behavioral stress fixture: period belief center uniform on [0.15,0.85); per-bot belief = 0.02+0.96*(0.35*center+0.65*independent uniform); side sampled with center probability. Research and price domains are separate.",
    uniqueLimits: new Set(orders.map((o) => o.limit)).size,
    pricing: priced,
    executed: results.filter((o) => o.executed).length,
    engineMs,
    auditMs: Math.round(performance.now() - auditStarted),
  },
  claims:
    "No guaranteed truthfulness, uniqueness, Sybil/coalition resistance, calibrated estimator, objective truth or production SLO.",
};
await writeFile(
  new URL("../public/a4-research.json", import.meta.url),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    confirmation: report.confirmation,
    finitePopulationConfirmation: finite500.confirmation,
    best: report.best,
    engine: artifact.heterogeneous,
  }),
);
