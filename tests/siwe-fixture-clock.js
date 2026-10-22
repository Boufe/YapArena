import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { parseSiweMessage } from "viem/siwe";

// Test-only: an instant synthetic signer can outrun the small host/VM clock
// difference. Wait for the actual server-issued boundary; never alter a message
// or loosen application validity checks. Larger drift is a fixture failure.
export async function waitForSiweIssuedAt(message) {
  const issuedAt = parseSiweMessage(message).issuedAt?.getTime();
  assert.ok(
    Number.isFinite(issuedAt),
    "fixture requires an issued-at timestamp",
  );
  assert.ok(
    issuedAt - Date.now() <= 1000,
    "test database clock is over one second ahead",
  );
  const deadline = performance.now() + 1000;
  while (Date.now() < issuedAt) {
    assert.ok(
      performance.now() < deadline,
      "fixture clock did not reach the issued-at boundary",
    );
    await setTimeout(Math.max(1, Math.min(1000, issuedAt - Date.now())));
  }
}
