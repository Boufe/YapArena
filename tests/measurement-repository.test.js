import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMeasurementRepository } from "../dist/features/measurement/repository.js";

const debateId = "11111111-1111-4111-8111-111111111111";
const topicId = "22222222-2222-4222-8222-222222222222";
const watchId = "33333333-3333-4333-8333-333333333333";

function fakePool(handle) {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push([sql, params]);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    return handle(sql, params, calls);
  };
  return {
    calls,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

const result = (rows = []) => ({ rows, rowCount: rows.length });

describe("product measurement repository", () => {
  it("records only public discovery, deduplicates refreshes, and derives a different-event return", async () => {
    let duplicate = false;
    const pool = fakePool((sql) => {
      if (sql.includes("FROM product_measurement_consents"))
        return result([{}]);
      if (sql.includes("FROM debates WHERE"))
        return result([{ debateId, topicId }]);
      if (sql.includes("FROM topics WHERE"))
        return result([{ debateId: null, topicId }]);
      if (sql.includes("SELECT 1 FROM product_measurement_events"))
        return result(duplicate ? [{}] : []);
      return result();
    });
    const repository = createMeasurementRepository(pool);
    assert.equal(
      await repository.recordDiscovery("hash", "7", "debate", debateId),
      true,
    );
    assert.equal(
      pool.calls.filter(([sql]) => sql.includes("'return_visit'")).length,
      1,
    );
    duplicate = true;
    assert.equal(
      await repository.recordDiscovery("hash", "7", "debate", debateId),
      true,
    );
    assert.equal(
      pool.calls.filter(([sql]) => sql.includes("'return_visit'")).length,
      1,
    );
    assert.equal(
      await repository.recordDiscovery("hash", null, "topic", topicId),
      true,
    );
    assert.equal(
      await repository.recordDiscovery("hash", null, "home", null),
      true,
    );
    assert.equal(
      await repository.recordDiscovery("hash", null, "home", topicId),
      false,
    );
    assert.equal(pool.calls.filter(([sql]) => sql === "COMMIT").length, 5);
  });

  it("does not record anything without a live consent row", async () => {
    const pool = fakePool(() => result());
    const repository = createMeasurementRepository(pool);
    assert.equal(await repository.hasConsent("hash"), false);
    assert.equal(
      await repository.recordDiscovery("hash", null, "home", null),
      false,
    );
    assert.equal(
      await repository.recordAction("hash", "7", {
        type: "match_accepted",
        debateId,
      }),
      false,
    );
    assert.equal(
      await repository.startWatch("hash", null, watchId, debateId, "live"),
      false,
    );
    assert.equal(await repository.progressWatch("hash", watchId), false);
    assert.equal(
      pool.calls.some(([sql]) =>
        sql.includes("INSERT INTO product_measurement_events"),
      ),
      false,
    );
  });

  it("checks account action targets and records only verified actions", async () => {
    let targetMissing = false;
    const pool = fakePool((sql) => {
      if (sql.includes("FROM product_measurement_consents"))
        return result([{}]);
      if (sql.includes("FROM match_requests"))
        return result(
          targetMissing
            ? []
            : [{ requestId: topicId, debateId: null, topicId }],
        );
      if (sql.includes("FROM debates d JOIN event_participants"))
        return result([{ debateId, topicId }]);
      if (sql.includes("FROM moderation_cases"))
        return result([{ caseId: topicId, debateId, topicId }]);
      if (sql.includes("FROM follows f JOIN topics"))
        return result([{ debateId: null, topicId }]);
      if (sql.includes("FROM follows f JOIN public_profiles"))
        return result([{ debateId: null, topicId: null, profileId: topicId }]);
      return result();
    });
    const repository = createMeasurementRepository(pool);
    for (const action of [
      { type: "match_requested", requestId: topicId },
      { type: "match_accepted", debateId },
      { type: "report_submitted", caseId: topicId },
      { type: "follow_created", targetType: "topic", slug: "topic-one" },
      { type: "follow_created", targetType: "profile", slug: "alice" },
    ])
      assert.equal(await repository.recordAction("hash", "7", action), true);
    assert.equal(
      pool.calls.filter(([sql]) =>
        sql.includes("INSERT INTO product_measurement_events"),
      ).length,
      5,
    );
    targetMissing = true;
    assert.equal(
      await repository.recordAction("hash", "7", {
        type: "match_requested",
        requestId: topicId,
      }),
      false,
    );
  });

  it("bounds watch sessions, protects ownership, and counts replay starts once", async () => {
    let insert = true;
    let progress = true;
    const pool = fakePool((sql) => {
      if (sql.includes("FROM product_measurement_consents"))
        return result([{}]);
      if (sql.includes("INSERT INTO product_measurement_watch_sessions"))
        return result(insert ? [{ id: watchId }] : []);
      if (sql.includes("UPDATE product_measurement_watch_sessions"))
        return result(progress ? [{ id: watchId }] : []);
      return result();
    });
    const repository = createMeasurementRepository(pool);
    assert.equal(
      await repository.startWatch("hash", "7", watchId, debateId, "live"),
      true,
    );
    assert.equal(
      pool.calls.some(([sql]) => sql.includes("'replay_started'")),
      false,
    );
    assert.equal(
      await repository.startWatch("hash", "7", watchId, debateId, "replay"),
      true,
    );
    assert.equal(
      pool.calls.filter(([sql]) => sql.includes("'replay_started'")).length,
      1,
    );
    insert = false;
    assert.equal(
      await repository.startWatch("hash", "7", watchId, debateId, "replay"),
      false,
    );
    assert.equal(await repository.progressWatch("hash", watchId, true), true);
    progress = false;
    assert.equal(await repository.progressWatch("hash", watchId), false);
  });

  it("requires a reviewed profile for affiliation changes and keeps the audit", async () => {
    let profile = true;
    const pool = fakePool((sql) => {
      if (sql.includes("FROM public_profiles"))
        return result(profile ? [{ userId: "7" }] : []);
      if (
        sql.includes("FROM product_measurement_affiliations") &&
        sql.includes("FOR UPDATE")
      )
        return result([{ affiliation: "founder" }]);
      return result();
    });
    const repository = createMeasurementRepository(pool);
    assert.equal(
      await repository.setAffiliation(
        "alice",
        "independent",
        "Reviewed account",
        "9",
      ),
      true,
    );
    assert.equal(
      await repository.setAffiliation(
        "alice",
        "unclassified",
        "Review withdrawn",
        "9",
      ),
      true,
    );
    assert.equal(
      pool.calls.filter(([sql]) =>
        sql.includes("INSERT INTO product_measurement_affiliation_audit"),
      ).length,
      2,
    );
    profile = false;
    assert.equal(
      await repository.setAffiliation(
        "missing",
        "founder",
        "No such profile",
        "9",
      ),
      false,
    );
  });

  it("keeps aggregate output numeric and enforces all retention windows", async () => {
    const pool = fakePool((sql) => {
      if (sql.includes("WITH completion_affiliation"))
        return result([
          { eventType: "debate_completed", affiliation: "founder", count: "2" },
        ]);
      if (sql.includes("FROM product_measurement_watch_sessions w"))
        return result([
          {
            mode: "replay",
            affiliation: "independent",
            sessions: "3",
            watchedSeconds: "80",
          },
        ]);
      if (sql.includes("JOIN public_profiles p")) return result([]);
      if (sql.startsWith("DELETE")) return { rows: [], rowCount: 1 };
      return result();
    });
    const repository = createMeasurementRepository(pool);
    const summary = await repository.summary();
    assert.deepEqual(summary, {
      windowDays: 28,
      events: [
        { eventType: "debate_completed", affiliation: "founder", count: 2 },
      ],
      watch: [
        {
          mode: "replay",
          affiliation: "independent",
          sessions: 3,
          watchedSeconds: 80,
        },
      ],
    });
    assert.deepEqual(await repository.listAffiliations(), []);
    assert.deepEqual(await repository.pruneExpired(), {
      events: 1,
      watch: 1,
      consents: 1,
      audit: 1,
    });
    await repository.grant("hash");
    assert.equal(await repository.withdraw("hash"), 1);
  });

  it("rolls back a failed measurement write and never leaves a partial return", async () => {
    let released = false;
    const calls = [];
    const pool = {
      async connect() {
        return {
          async query(sql) {
            calls.push(sql);
            if (sql.includes("FROM product_measurement_consents"))
              return result([{}]);
            if (sql.includes("INSERT INTO product_measurement_events"))
              throw new Error("storage unavailable");
            return result();
          },
          release() {
            released = true;
          },
        };
      },
    };
    await assert.rejects(
      createMeasurementRepository(pool).recordDiscovery(
        "hash",
        null,
        "home",
        null,
      ),
      /storage unavailable/,
    );
    assert.ok(calls.includes("ROLLBACK"));
    assert.equal(calls.includes("COMMIT"), false);
    assert.equal(released, true);
  });

  it("rejects unavailable targets and returns an empty dashboard without inventing people", async () => {
    const pool = fakePool((sql) => {
      if (sql.includes("FROM product_measurement_consents"))
        return result([{}]);
      return result();
    });
    const repository = createMeasurementRepository(pool);
    assert.equal(await repository.hasConsent("hash"), true);
    assert.equal(
      await repository.recordDiscovery("hash", "7", "debate", null),
      false,
    );
    assert.equal(
      await repository.recordDiscovery("hash", "7", "topic", null),
      false,
    );
    assert.equal(
      await repository.recordDiscovery("hash", "7", "debate", debateId),
      false,
    );
    assert.equal(
      await repository.recordDiscovery("hash", "7", "topic", topicId),
      false,
    );
    assert.equal(
      await repository.startWatch("hash", "7", watchId, debateId, "replay"),
      false,
    );
    assert.deepEqual(await repository.summary(), {
      windowDays: 28,
      events: [],
      watch: [],
    });
  });
});
