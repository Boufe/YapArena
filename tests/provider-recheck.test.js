import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProviderRecheck } from "../dist/platform/auth/provider-recheck.js";
import { ProviderUnavailableError } from "../dist/platform/auth/privy.js";

const claim = {
  subject: "did:privy:unit",
  credentialsDigest: "a".repeat(64),
  authGeneration: "1",
  providerControl: null,
  providerResetActive: false,
};

// Answers the claim query and records the settle transaction's statements.
function fakeDatabase({ failMapping = false } = {}) {
  const log = [];
  return {
    log,
    async query(sql) {
      const claiming = sql.includes("SET checked_at=clock_timestamp()");
      log.push(
        claiming
          ? "claim"
          : sql.includes("checked_at=checked_at")
            ? "handback"
            : "other",
      );
      return { rows: claiming ? [{ ...claim, claimedAt: "now" }] : [] };
    },
    async connect() {
      return {
        async query(sql) {
          log.push(sql.trim().split(/\s+/)[0]);
          if (sql.includes("FOR UPDATE"))
            return { rows: [{ id: "1", authGeneration: "1" }] };
          if (failMapping && sql.includes("FROM provider_identities"))
            throw new Error("synthetic mapping failure");
          return { rows: [] };
        },
        release() {
          log.push("release");
        },
      };
    },
  };
}

describe("provider re-check scheduling", () => {
  it("runs one check per account at a time and caps concurrent checks", async () => {
    const release = Promise.withResolvers();
    let reads = 0;
    const recheck = createProviderRecheck(
      fakeDatabase(),
      {
        async inspect() {
          reads++;
          await release.promise;
          return claim;
        },
      },
      { maxConcurrent: 1 },
    );
    const first = recheck.run("1");
    assert.equal(recheck.run("1"), first);
    assert.equal(await recheck.run("2"), "skipped");
    release.resolve();
    assert.equal(await first, "unchanged");
    await recheck.drain();
    assert.equal(reads, 1);
    // Shutdown: no new checks start after close.
    await recheck.close();
    assert.equal(await recheck.run("3"), "skipped");
    assert.equal(reads, 1);
  });

  it("pauses every account after a Privy failure until the back-off ends", async () => {
    let clock = 0;
    const database = fakeDatabase();
    const recheck = createProviderRecheck(
      database,
      {
        async inspect() {
          throw new ProviderUnavailableError("synthetic rate limit");
        },
      },
      { now: () => clock, pauseAfterUnavailableMs: 1000 },
    );
    assert.equal(await recheck.run("1"), "unavailable");
    clock = 999;
    assert.equal(await recheck.run("2"), "skipped");
    // The unavailable check handed its claim back for an early retry.
    assert.deepEqual(database.log, ["claim", "handback"]);
    clock = 1000;
    assert.equal(await recheck.run("2"), "unavailable");
  });

  it("rolls back and reports a failed write without throwing from schedule", async () => {
    const database = fakeDatabase({ failMapping: true });
    const observed = Promise.withResolvers();
    const recheck = createProviderRecheck(
      database,
      {
        inspect: async () => ({ ...claim, credentialsDigest: "b".repeat(64) }),
      },
      { observe: (outcome, error) => observed.resolve({ outcome, error }) },
    );
    recheck.schedule("1");
    const { outcome, error } = await observed.promise;
    assert.equal(outcome, "error");
    assert.match(error.message, /synthetic mapping failure/);
    assert.deepEqual(database.log, [
      "claim",
      "BEGIN",
      "SELECT",
      "SELECT",
      "ROLLBACK",
      "release",
      "handback",
    ]);
  });
});
