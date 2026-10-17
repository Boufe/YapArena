import { A4Error } from "./engine.ts";
export type FundingEvent = {
  id: string;
  asset: string;
  amount: string;
  state: "pending" | "final" | "failed" | "reversed";
};
export type FundingState = { event: FundingEvent; credited: string } | null;
// Adapter contract only. Live fiat/crypto implementations are deliberately absent.
export function applyFundingEvent(
  previous: FundingState,
  event: FundingEvent,
  expectedAsset: string,
) {
  if (
    !event.id ||
    event.asset !== expectedAsset ||
    !/^[1-9]\d{0,35}$/.test(event.amount) ||
    !["pending", "final", "failed", "reversed"].includes(event.state)
  )
    throw new A4Error("invalid funding event", 400);
  if (
    previous &&
    (previous.event.id !== event.id ||
      previous.event.asset !== event.asset ||
      previous.event.amount !== event.amount)
  )
    throw new A4Error("conflicting funding event");
  const prior = previous?.event.state;
  if (prior === event.state) return { state: previous!, delta: "0" };
  if (
    (prior === "final" && event.state !== "reversed") ||
    prior === "failed" ||
    prior === "reversed" ||
    (!prior && event.state === "reversed")
  )
    throw new A4Error("invalid funding transition");
  const credited = event.state === "final" ? event.amount : "0";
  return {
    state: { event, credited },
    delta: String(BigInt(credited) - BigInt(previous?.credited ?? 0)),
  };
}
export function requirePlayAsset(asset: string, mode: string) {
  if (asset !== "YAP" || mode !== "play")
    throw new A4Error("real-fund adapters are unavailable", 503);
}
