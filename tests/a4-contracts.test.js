import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "../scripts/test-http-request.ts";
import { createApp } from "../dist/app.js";
import { createLogger } from "../dist/platform/logger.js";
import {
  createA4Repository,
  runConfig,
} from "../dist/features/a4/repository.js";
import { A4Error, fraction } from "../dist/features/a4/engine.js";
import { SessionUnavailableError } from "../dist/platform/auth/sessions.js";
import {
  account,
  balance,
  post,
  reconcile,
  transfer,
} from "../dist/features/a4/ledger.js";
const userId = "1",
  id = "00000000-0000-4000-8000-000000000001",
  roundId = "00000000-0000-4000-8000-000000000002";
const actor = { userId, tokenHash: "hash" };
const outcome = {
  participant: "user:1",
  accepted: true,
  executed: true,
  status: "pending",
  premium: "280000",
  fee: "0",
  payout: "400000",
  net: "120000",
  reservation: "1000000",
  released: "720000",
  premiumDust: fraction(0),
  payoutDust: fraction(0),
};
function fixture({
  revealed = false,
  mode = "mixed",
  account = true,
  session = true,
  missing = false,
  commitFail = false,
} = {}) {
  const calls = [];
  const config = runConfig();
  const s = {
    id,
    creator_id: userId,
    debate_id: id,
    topic_id: id,
    proposition: "Frozen proposition",
    asset: "YAP",
    mode,
    state: revealed ? "complete" : "running",
    config,
    seed: "secret-run-seed",
    reveal_at: new Date("2030-01-01T00:00:00Z"),
    speed: 1,
  };
  const r = {
    id: roundId,
    session_id: id,
    asset: "YAP",
    period: 1,
    state: revealed ? "settled" : "pending",
    opens_at: new Date("2026-01-01T00:00:00Z"),
    closes_at: new Date("2026-01-02T00:00:00Z"),
    seed: "secret-price-seed",
    seed_commitment: "commitment",
    snapshot: [{ secret: true }],
    snapshot_hash: "snapshot-hash",
    pricing: {
      a: fraction(22, 100),
      b: fraction(34, 100),
      share: fraction(2, 5),
      price: fraction(28, 100),
      branch: "targeted",
      reason: null,
    },
    revealed_at: revealed ? new Date() : null,
    locked_at: new Date(),
  };
  const own = {
    participant: "user:1",
    user_id: "1",
    kind: "human",
    side: "YES",
    limit_value: "1",
    quantity: 1,
    request_key: "request-1",
    outcome,
  };
  const totals = {
    participants: 5,
    humans: 1,
    bots: 4,
    accepted: 3,
    executed: 3,
    premium: "1000000",
    payout: "1100000",
    fee: "0",
    quantity: "3",
  };
  const client = {
    on() {},
    removeListener() {},
    release() {
      calls.push(["release"]);
    },
    async query(sql, values) {
      calls.push([sql, values]);
      if (sql.includes("clock_timestamp()>=reveal_at"))
        return { rows: [{ eligible: false }] };
      if (sql.includes("clock_timestamp()>=opens_at"))
        return { rows: [{ started: false, pastCutoff: false }] };
      if (sql === "COMMIT" && commitFail) throw new Error("commit unavailable");
      if (sql.includes("FROM users WHERE id"))
        return { rows: account ? [{ id: userId, authGeneration: "0" }] : [] };
      if (sql.includes("FROM sessions s JOIN users u"))
        return { rows: session ? [{ id: "session-1" }] : [] };
      if (sql.includes("SELECT * FROM a4_sessions"))
        return { rows: missing ? [] : [s] };
      if (sql.includes("SELECT * FROM a4_rounds")) return { rows: [r] };
      if (
        sql.includes("SELECT * FROM a4_submissions") &&
        sql.includes("user_id=$2")
      )
        return { rows: mode === "observer" ? [] : [own] };
      if (sql.includes("SELECT * FROM a4_submissions"))
        return { rows: Array.from({ length: 3 }, () => own) };
      if (sql.includes("count(*)::int AS participants"))
        return { rows: [totals] };
      if (sql.includes("FROM debates WHERE id"))
        return {
          rows: [
            {
              proposition: "Changed proposition",
              slug: "example-debate",
              topic_id: id,
            },
          ],
        };
      if (sql.includes("SELECT amount::text"))
        return { rows: [{ amount: "100000000000" }] };
      if (sql.includes("SELECT kind,COALESCE(sum(amount)"))
        return { rows: [{ kind: "available", amount: "999720000" }] };
      if (sql.includes("FROM a4_postings p JOIN a4_accounts"))
        return {
          rows: Array.from({ length: 51 }, (_, i) => ({
            reference: `ref-${i}`,
            kind: "execution",
            asset: "YAP",
            amount: "0",
          })),
        };
      if (sql.includes('SELECT s.id,s.debate_id AS "debateId"'))
        return {
          rows: Array.from({ length: 21 }, () => ({ id, mode: "human" })),
        };
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    repo: createA4Repository(
      {
        async connect() {
          return client;
        },
        async query(...args) {
          return client.query(...args);
        },
      },
      "bots",
    ),
    calls,
    s,
    r,
  };
}
describe("A4 server disclosure contracts", () => {
  it("whitelists pending participant fields despite fully populated hidden rows", async () => {
    const f = fixture(),
      view = await f.repo.view(actor, id);
    assert.equal(view.debate.proposition, "Frozen proposition");
    assert.equal(view.observer, false);
    assert.equal(view.researchSeed, undefined);
    assert.deepEqual(
      Object.keys(view.rounds[0]).sort(),
      [
        "id",
        "period",
        "state",
        "opensAt",
        "closesAt",
        "lockedAt",
        "seedCommitment",
        "offer",
        "receipt",
        "revealed",
      ].sort(),
    );
    assert.deepEqual(view.rounds[0].offer, fraction(28, 100));
    assert.deepEqual(view.rounds[0].receipt, {
      side: "YES",
      limit: "1",
      quantity: 1,
      status: "pending",
      reserved: "1000000",
      accepted: true,
      executed: true,
      premium: "280000",
      fee: "0",
      released: "720000",
    });
    const text = JSON.stringify(view);
    for (const secret of [
      "secret-run-seed",
      "secret-price-seed",
      "snapshot-hash",
      '"payout"',
      '"net"',
      '"share"',
      '"pricing"',
    ])
      assert.equal(text.includes(secret), false, secret);
    assert.equal(
      f.calls.filter(([sql]) => sql.includes("INSERT INTO a4_audit")).length,
      0,
    );
  });
  it("reveals bounded pseudonymous books, receipts, center loss and audit commitments", async () => {
    const f = fixture({ revealed: true }),
      view = await f.repo.view(actor, id, 50, 2),
      d = view.rounds[0].diagnostics;
    assert.equal(d.book.length, 2);
    assert.equal(d.book[0].label, "Participant 51");
    assert.equal(d.book[0].user_id, undefined);
    assert.equal(d.pagination.hasMore, true);
    assert.equal(d.centerTrading, "-100000");
    assert.equal(d.centerResult, "-100000");
    assert.equal(d.book[0].outcome.status, "settled");
    assert.equal(view.rounds[0].receipt.payout, "400000");
    assert.equal(view.rounds[0].receipt.net, "120000");
    assert.equal(d.snapshotHash, "snapshot-hash");
    assert.equal(view.researchSeed, "secret-run-seed");
  });
  it("audits bot-only observer access independently of reveal, with no human receipt", async () => {
    const f = fixture({ mode: "observer" }),
      view = await f.repo.view(actor, id);
    assert.equal(view.observer, true);
    assert.equal(view.rounds[0].receipt, null);
    assert.ok(view.rounds[0].diagnostics);
    assert.ok(
      f.calls.some(
        ([sql, values]) =>
          sql.includes("INSERT INTO a4_audit") && values[3] === "observer.read",
      ),
    );
    f.s.creator_id = "2";
    await assert.rejects(f.repo.view(actor, id), /not found/);
  });
  it("returns committed/void and nonexecuted receipts without inventing a payout", async () => {
    const f = fixture();
    f.r.state = "void";
    f.r.pricing = null;
    const view = await f.repo.view(actor, id);
    assert.equal(view.rounds[0].receipt.status, "void");
    assert.equal(view.rounds[0].offer, null);
    const empty = fixture();
    empty.r.revealed_at = new Date();
    empty.r.pricing = null;
    const v = await empty.repo.view(actor, id);
    assert.equal(v.rounds[0].diagnostics.pricing, null);
  });
  it("rechecks active account/session before confidential reads and rolls back failed commits", async () => {
    for (const option of [{ account: false }, { session: false }])
      await assert.rejects(
        fixture(option).repo.wallet(actor),
        SessionUnavailableError,
      );
    const f = fixture({ commitFail: true });
    await assert.rejects(f.repo.wallet(actor), /commit unavailable/);
    assert.ok(f.calls.some(([sql]) => sql === "ROLLBACK"));
    assert.equal(f.calls.at(-1)[0], "release");
    await assert.rejects(
      fixture({ missing: true }).repo.view(actor, id),
      /not found/,
    );
  });
  it("uses database reveal eligibility even when serialized timestamps appear past", async () => {
    const f = fixture();
    f.s.reveal_at = new Date(0);
    await f.repo.control(actor, "timing-key-123", id, "step");
    assert.ok(
      f.calls.some(([sql]) => sql.includes("clock_timestamp()>=reveal_at")),
    );
    assert.equal(
      f.calls.some(([sql]) => sql.includes("state='settled'")),
      false,
    );
  });
  it("bounds lists and private journal history and excludes journal metadata from SQL", async () => {
    const f = fixture();
    assert.equal((await f.repo.wallet(actor)).mode, "bots");
    assert.equal((await f.repo.list(actor, id, 20)).items.length, 20);
    const history = await f.repo.history(actor, 50);
    assert.equal(history.items.length, 50);
    assert.equal(history.hasMore, true);
    const sql = f.calls.find(([s]) =>
      s.includes("FROM a4_postings p JOIN a4_accounts"),
    )[0];
    assert.ok(!sql.includes("metadata"));
    assert.ok(sql.includes("a.user_id=$1"));
  });
});
describe("A4 ledger posting boundary", () => {
  it("merges balanced atomic postings and serializes the balance scope", async () => {
    const calls = [],
      c = {
        async query(sql, values) {
          calls.push([sql, values]);
          return { rows: [], rowCount: 0 };
        },
      };
    const issuer = account("sandbox", "issuer", "issuer"),
      user = account("sandbox", "user", "available", "1");
    await post(
      c,
      "ref",
      "issuance",
      [...transfer(issuer, user, 100n), ...transfer(issuer, user, 50n)],
      { policy: "play" },
    );
    const posted = calls.find(([sql]) =>
      sql.includes("INSERT INTO a4_postings"),
    );
    const rows = JSON.parse(posted[1][1]);
    assert.deepEqual(rows.map((x) => x.amount).sort(), ["-150", "150"]);
    assert.ok(calls[0][1][0].includes("sandbox"));
    assert.equal(await balance(c, user), 0n);
    assert.deepEqual(await reconcile(c, "sandbox"), { reconciled: true });
  });
  it("rejects negative transfers, imbalance, cross-assets, duplicate refs and broken projections", async () => {
    const issuer = account("global", "issuer", "issuer"),
      user = account("global", "user", "available");
    assert.throws(() => transfer(issuer, user, -1n));
    const c = {
      async query() {
        return { rows: [{ amount: "123" }], rowCount: 1 };
      },
    };
    await assert.rejects(post(c, "ref", "bad", []), /unbalanced/);
    await assert.rejects(
      post(c, "ref", "bad", [{ account: user, amount: 1n }]),
      /unbalanced/,
    );
    await assert.rejects(
      post(
        c,
        "ref",
        "bad",
        transfer(
          issuer,
          account("global", "user", "available", null, "TEST"),
          1n,
        ),
      ),
      /mixed-asset/,
    );
    await assert.rejects(
      post(c, "ref", "bad", transfer(issuer, user, 1n)),
      /already posted/,
    );
    assert.equal(await balance(c, user), 123n);
    await assert.rejects(reconcile(c, "global"), /reconciliation/);
  });
});
function apiFixture(error) {
  const calls = [];
  const a4 = { mode: "bots" };
  for (const method of [
    "wallet",
    "timeline",
    "history",
    "list",
    "create",
    "view",
    "refill",
    "submit",
    "control",
  ])
    a4[method] = async (...args) => {
      calls.push([method, ...args]);
      if (error) throw error;
      if (method === "view") return { ok: true, debateId: id, mode: "mixed" };
      return { ok: true };
    };
  const app = createApp({
    a4,
    messages: {},
    sessions: {
      async findUserByTokenHash() {
        return { id: "1" };
      },
    },
    logger: createLogger({ enabled: false }),
    environment: "test",
    apiRateLimit: 10000,
  });
  const call = (method, path, body) =>
    request(app)
      [method](`/api/a4/${path}`)
      .set("Cookie", "session=synthetic-cookie")
      .set("Idempotency-Key", "test-key-123")
      .send(body);
  return { app, call, calls, a4 };
}
describe("A4 HTTP contracts", () => {
  it("combines workspace reads into one account-bound response and rejects unrelated/observer runs", async () => {
    const f = apiFixture();
    assert.equal(
      (await request(f.app).get(`/api/a4/debates/${id}/workspace`)).status,
      401,
    );
    const empty = await f.call("get", `debates/${id}/workspace`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.accountId, "1");
    assert.equal(empty.body.run, null);
    assert.equal(f.calls.findLast((c) => c[0] === "timeline")[3], "human");
    const run = await f.call("get", `debates/${id}/workspace?runId=${id}`);
    assert.equal(run.status, 200);
    assert.equal(run.body.run.mode, "mixed");
    assert.equal(f.calls.findLast((c) => c[0] === "timeline")[3], "sandbox");
    f.a4.view = async () => ({ debateId: id, mode: "observer" });
    assert.equal(
      (await f.call("get", `debates/${id}/workspace?runId=${id}`)).status,
      404,
    );
    f.a4.view = async () => ({ debateId: "other", mode: "human" });
    assert.equal(
      (await f.call("get", `debates/${id}/workspace?runId=${id}`)).status,
      404,
    );
    assert.equal(
      (await f.call("get", `debates/${id}/workspace?runId=bad`)).status,
      404,
    );
  });
  it("authenticates settlement timelines and rejects arbitrary scope selectors", async () => {
    const f = apiFixture();
    assert.equal(
      (await request(f.app).get(`/api/a4/debates/${id}/timeline`)).status,
      401,
    );
    for (const suffix of ["", "?scope=sandbox"]) {
      const response = await f.call("get", `debates/${id}/timeline${suffix}`);
      assert.equal(response.status, 200);
      assert.match(response.headers["cache-control"], /private, no-store/);
      assert.equal(f.calls.at(-1)[0], "timeline");
      assert.equal(f.calls.at(-1)[1].userId, "1");
    }
    assert.equal(
      (await f.call("get", `debates/${id}/timeline?scope=observer`)).status,
      400,
    );
    assert.equal((await f.call("get", `debates/bad/timeline`)).status, 404);
  });
  it("derives actors from auth and converts NO ceilings exactly through all routes", async () => {
    const f = apiFixture();
    for (const path of [
      "wallet",
      "history?offset=50",
      `runs?debateId=${id}`,
      `runs/${id}?limit=10&offset=20`,
    ]) {
      const r = await f.call("get", path);
      assert.equal(r.status, 200);
      assert.match(r.headers["cache-control"], /no-store/);
    }
    for (const [path, body] of [
      [
        "runs",
        {
          debateId: id,
          mode: "mixed",
          config: { argumentLabel: "Cost analysis" },
        },
      ],
      ["refill", {}],
      ["refill", { runId: id }],
      [
        `rounds/${id}/submit`,
        {
          side: "NO",
          ceiling: "0.78",
          quantity: 10,
          rule: "a4-v1",
          accountId: "1",
        },
      ],
      [`runs/${id}/control`, { action: "speed", speed: 5 }],
    ])
      assert.ok([200, 201].includes((await f.call("post", path, body)).status));
    const order = f.calls.find((c) => c[0] === "submit");
    assert.equal(
      f.calls.find((c) => c[0] === "create")[3].config.argumentLabel,
      "Cost analysis",
    );
    assert.equal(order[4].limit, "0.220000");
    assert.equal(order[1].userId, "1");
    assert.notEqual(order[1].tokenHash, "synthetic-cookie");
  });
  it("rejects unknown fields, bad pages/IDs, missing keys, stale account and role flags", async () => {
    const f = apiFixture();
    for (const [method, path, body] of [
      ["get", "runs/no-id"],
      ["get", "history?offset=-1"],
      ["get", `runs/${id}?limit=101`],
      ["post", "runs", { debateId: id, observer: true }],
      ["post", "refill", null],
      ["post", `runs/${id}/control`, { action: "observer" }],
      ["post", `runs/${id}/control`, { action: ["run"] }],
      [
        "post",
        `rounds/${id}/submit`,
        { side: ["YES"], ceiling: "0.5", quantity: 1, accountId: "1" },
      ],
      [
        "post",
        `rounds/${id}/submit`,
        { side: "NO", ceiling: ".5", quantity: 1, accountId: "1" },
      ],
      [
        "post",
        `rounds/${id}/submit`,
        { side: "MAYBE", ceiling: "0.5", quantity: 1 },
      ],
      [
        "post",
        `rounds/${id}/submit`,
        { side: "YES", ceiling: "0.5", quantity: 1, accountId: "2" },
      ],
    ])
      assert.ok(
        [400, 404, 409].includes((await f.call(method, path, body)).status),
        path,
      );
    assert.equal(
      (
        await request(f.app)
          .post("/api/a4/refill")
          .set("Cookie", "session=x")
          .send({})
      ).status,
      400,
    );
    assert.equal((await request(f.app).get("/api/a4/wallet")).status, 401);
  });
  it("maps expected errors and keeps unexpected failures generic", async () => {
    for (const [error, status] of [
      [new A4Error("not found", 404), 404],
      [new SessionUnavailableError("private"), 401],
      [new Error("private secret"), 500],
    ]) {
      const f = apiFixture(error),
        r = await f.call("get", "wallet");
      assert.equal(r.status, status);
      assert.ok(!JSON.stringify(r.body).includes("private secret"));
    }
  });
});
