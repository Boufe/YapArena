import assert from "node:assert/strict";

const base = process.env.TRIAL_BASE_URL ?? "http://localhost:3000";
const count = Number(process.env.TRIAL_REQUESTS ?? "30");
if (!Number.isInteger(count) || count < 1 || count > 200)
  throw new Error("TRIAL_REQUESTS must be 1-200");

async function sample(path) {
  const started = performance.now();
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(15000),
  });
  await response.arrayBuffer();
  return { status: response.status, milliseconds: performance.now() - started };
}

function summarize(samples) {
  const values = samples.map((item) => item.milliseconds).sort((a, b) => a - b);
  return {
    requests: values.length,
    failures: samples.filter((item) => item.status !== 200).length,
    statuses: Object.fromEntries(
      [...new Set(samples.map((item) => item.status))].map((status) => [
        status,
        samples.filter((item) => item.status === status).length,
      ]),
    ),
    p50Ms: Math.round(values[Math.ceil(values.length * 0.5) - 1]),
    p95Ms: Math.round(values[Math.ceil(values.length * 0.95) - 1]),
    maxMs: Math.round(values.at(-1)),
  };
}

const journeys = {};
for (const path of ["/ready", "/debates", "/api/measurement/consent"]) {
  const samples = [];
  for (let i = 0; i < count; i += 1) samples.push(await sample(path));
  journeys[path] = summarize(samples);
}
const concurrent = await Promise.all(
  Array.from({ length: count }, () => sample("/debates")),
);
journeys["/debates concurrent"] = summarize(concurrent);
console.log(
  JSON.stringify({ at: new Date().toISOString(), base, journeys }, null, 2),
);
for (const result of Object.values(journeys)) assert.equal(result.failures, 0);
