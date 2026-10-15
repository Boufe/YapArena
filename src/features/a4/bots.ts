import {
  randomWord,
  fraction,
  priceRound,
  executeRound,
  type Order,
  type Terms,
} from "./engine.ts";

function sample(seed: string, domain: string) {
  return Number(randomWord(seed, domain) >> 11n) / 2 ** 53;
}
export function generateBots(
  seed: string,
  period: number,
  population: number,
  preset: "heterogeneous" | "reference",
  quantity: number,
  feeBps: number,
): Order[] {
  // Reference: two-state Bayesian fixture; each order sees only its signal.
  // Heterogeneous behavioral UX stress fixture: fresh latent belief center + broad per-bot private
  // expectations each round, then noisy side selection. Not a Bayesian theorem fixture.
  const center =
    preset === "reference"
      ? sample(seed, `belief:${period}:state`) < 0.5
        ? 0.4
        : 0.1
      : 0.15 + 0.7 * sample(seed, `belief:${period}:center`);
  return Array.from({ length: population }, (_, index) => {
    const side =
      sample(seed, `belief:${period}:${index}:side`) < center ? "YES" : "NO";
    const expectation =
      preset === "reference"
        ? side === "YES"
          ? 0.34
          : 0.22
        : 0.02 +
          0.96 *
            (0.35 * center +
              0.65 * sample(seed, `belief:${period}:${index}:private`));
    const lambda = feeBps / 10000;
    const limit =
      side === "YES"
        ? expectation / (1 + lambda)
        : (expectation + lambda) / (1 + lambda);
    return {
      participant: `bot:${index}`,
      kind: "bot",
      side,
      limit: limit.toFixed(6),
      quantity,
    };
  });
}
export function benchmark(rho: number, omegaY: number, omegaN: number) {
  const yes = rho * omegaY + (1 - rho) * omegaN;
  const afterYes = (rho * omegaY) / yes;
  const afterNo = (rho * (1 - omegaY)) / (1 - yes);
  return {
    a: afterNo * omegaY + (1 - afterNo) * omegaN,
    b: afterYes * omegaY + (1 - afterYes) * omegaN,
  };
}
export function ideal(delta: number, epsilon: number) {
  const rate = 1 - epsilon + epsilon * delta;
  return { rate, profit: (rate * delta) / 2 };
}
export function auditDeviation(
  orders: Order[],
  terms: Terms,
  participant: string,
  seed: string,
  samples = 2000,
) {
  const target = orders.find((o) => o.participant === participant);
  if (!target || samples < 2 || samples > 10000)
    throw new Error("invalid research audit");
  const candidates = ["YES", "NO"].flatMap((side) =>
    Array.from({ length: 21 }, (_, i) => ({
      ...target,
      side: side as "YES" | "NO",
      limit: (i / 20).toFixed(6),
    })),
  );
  function compareCandidate(candidate: Order, domain: string) {
    const differences: number[] = [];
    for (let i = 0; i < samples; i++) {
      const branch = randomWord(seed, `${domain}:${i}:branch`),
        price = randomWord(seed, `${domain}:${i}:price`);
      const evaluate = (replacement: Order) => {
        const cohort = orders.map((o) =>
          o.participant === participant ? replacement : o,
        );
        const pricing = priceRound(cohort, terms, branch, price);
        return (
          Number(
            executeRound(cohort, terms, pricing, 1000000n).find(
              (o) => o.participant === participant,
            )!.net,
          ) / 1000000
        );
      };
      differences.push(evaluate(candidate) - evaluate(target!));
    }
    const mean = differences.reduce((a, b) => a + b, 0) / samples;
    const variance =
      differences.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples - 1);
    return { mean, standardError: Math.sqrt(variance / samples), samples };
  }
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      training: compareCandidate(candidate, "search"),
    }))
    .sort((a, b) => b.training.mean - a.training.mean);
  const best = ranked[0]!;
  return {
    original: target,
    best: best.candidate,
    search: best.training,
    confirmation: compareCandidate(best.candidate, "confirmation"),
    settlement: fraction(
      orders.filter((o) => o.side === "YES").length,
      orders.length,
    ),
    assumptions:
      "Finite cohort; endogenous medians, execution and settlement recomputed; fixed quantity; paired draws; unconditional profit including nonexecution; independent confirmation.",
  };
}
