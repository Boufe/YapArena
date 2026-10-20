import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import pg from "pg";
import {
  coinJournalReference,
  normalizeCoinPostings,
  postCoinJournal,
  reverseCoinJournal,
} from "../dist/features/account-wallet/ledger.js";

const ownerUrl = process.env.A4_TEST_OWNER_URL;
const runtimeUrl = process.env.A4_TEST_DATABASE_URL;
const one = "11111111-1111-4111-8111-111111111111";
const two = "22222222-2222-4222-8222-222222222222";

describe("exact coin journal contracts", () => {
  it("aggregates same-account entries and conserves exact signed atomic values", () => {
    assert.deepEqual(
      normalizeCoinPostings([
        { accountId: two, amount: "-5" },
        { accountId: one, amount: "2" },
        { accountId: one, amount: "3" },
      ]),
      [
        { accountId: one, amount: "5" },
        { accountId: two, amount: "-5" },
      ],
    );
    for (const postings of [
      [],
      [{ accountId: one, amount: "1" }],
      [
        { accountId: one, amount: "1" },
        { accountId: two, amount: "-2" },
      ],
      [
        { accountId: one, amount: "1" },
        { accountId: one, amount: "-1" },
      ],
      [
        { accountId: "invalid", amount: "1" },
        { accountId: two, amount: "-1" },
      ],
      [
        { accountId: one, amount: "0" },
        { accountId: two, amount: "0" },
      ],
    ])
      assert.throws(() => normalizeCoinPostings(postings));
  });
  it("scopes business references to owner, environment, operation and exact key", () => {
    const scope = {
      environment: "sandbox",
      accountId: "72",
      operation: "funding",
      idempotencyKey: "deposit-1",
    };
    const reference = coinJournalReference(scope);
    for (const override of [
      { accountId: "73" },
      { environment: "live" },
      { operation: "refund" },
      { idempotencyKey: "DEPOSIT-1" },
    ])
      assert.notEqual(
        coinJournalReference({ ...scope, ...override }),
        reference,
      );
    for (const override of [
      { environment: "play" },
      { accountId: "0" },
      { operation: "" },
      { idempotencyKey: "" },
    ])
      assert.throws(() => coinJournalReference({ ...scope, ...override }));
  });
});

describe(
  "balanced coin writer in disposable PostgreSQL",
  { skip: !ownerUrl || !runtimeUrl },
  () => {
    let owner, runtime;
    before(() => {
      for (const input of [ownerUrl, runtimeUrl]) {
        const url = new URL(input);
        assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
        assert.match(
          url.pathname,
          /^\/revocation_test_(ci|a4_(fresh|upgrade))$/,
        );
      }
      const options = { options: "-c search_path=pg_catalog,yaparena,pg_temp" };
      owner = new pg.Pool({ ...options, connectionString: ownerUrl });
      runtime = new pg.Pool({ ...options, connectionString: runtimeUrl });
    });
    after(async () => {
      await Promise.all([owner?.end(), runtime?.end()]);
    });
    async function tx(work) {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        const result = await work(c);
        await c.query("COMMIT");
        return result;
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      } finally {
        c.release();
      }
    }
    async function fixture() {
      const user = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0].id;
      const available = randomUUID(),
        backing = randomUUID(),
        reserved = randomUUID();
      for (const [id, kind, uid] of [
        [available, "available", user],
        [reserved, "reserved", user],
        [backing, "backing", null],
      ])
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,kind,user_id) VALUES($1,'sandbox','USDC',$2,$3)",
          [id, kind, uid],
        );
      const journal = (
        reference,
        amount = "1000",
        from = backing,
        to = available,
      ) => ({
        id: randomUUID(),
        environment: "sandbox",
        asset: "USDC",
        operation: "funding",
        reference,
        postings: [
          { accountId: from, amount: String(-BigInt(amount)) },
          { accountId: to, amount },
        ],
      });
      return { user, available, backing, reserved, journal };
    }
    it("funds exactly once across concurrent retries and rejects changed terms", async () => {
      const f = await fixture(),
        reference = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          tx((c) => postCoinJournal(c, f.journal(reference))),
        ),
      );
      assert.equal(results.filter((r) => r.created).length, 1);
      assert.equal(new Set(results.map((r) => r.id)).size, 1);
      assert.equal(
        (
          await owner.query(
            "SELECT balance::text FROM coin_accounts WHERE id=$1",
            [f.available],
          )
        ).rows[0].balance,
        "1000",
      );
      await assert.rejects(
        tx((c) => postCoinJournal(c, f.journal(reference, "1001"))),
        /different journal terms/,
      );
      await assert.rejects(
        tx((c) =>
          postCoinJournal(c, { ...f.journal(reference), operation: "reserve" }),
        ),
        /different journal terms/,
      );
    });
    it("serializes competing reservations, prevents overspend and reverses exactly", async () => {
      const f = await fixture();
      const funded = await tx((c) =>
        postCoinJournal(c, f.journal(randomUUID())),
      );
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          tx((c) =>
            postCoinJournal(c, {
              ...f.journal(randomUUID(), "700", f.available, f.reserved),
              operation: "reserve",
            }),
          ),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = results.find((r) => r.status === "rejected");
      assert.match(rejected.reason.message, /insufficient funds/);
      const reference = randomUUID(),
        reservedJournal = results.find((r) => r.status === "fulfilled").value;
      const reversal = await tx((c) =>
        reverseCoinJournal(c, {
          originalId: reservedJournal.id,
          environment: "sandbox",
          reference,
        }),
      );
      assert.equal(reversal.created, true);
      assert.equal(
        (
          await tx((c) =>
            reverseCoinJournal(c, {
              originalId: reservedJournal.id,
              environment: "sandbox",
              reference,
            }),
          )
        ).created,
        false,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT balance::text FROM coin_accounts WHERE id=$1",
            [f.available],
          )
        ).rows[0].balance,
        "1000",
      );
      await tx((c) =>
        reverseCoinJournal(c, {
          originalId: funded.id,
          environment: "sandbox",
          reference: randomUUID(),
        }),
      );
      assert.equal(
        (
          await owner.query(
            "SELECT balance::text FROM coin_accounts WHERE id=$1",
            [f.available],
          )
        ).rows[0].balance,
        "0",
      );
    });
    it("isolates environments and keeps web runtime read-only", async () => {
      const f = await fixture();
      await assert.rejects(
        tx((c) =>
          postCoinJournal(c, {
            ...f.journal(randomUUID()),
            environment: "live",
          }),
        ),
        /environment\/asset/,
      );
      await assert.rejects(
        runtime.query(
          "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1,'live','USDC',$2,'funding')",
          [randomUUID(), randomUUID()],
        ),
        { code: "42501" },
      );
      for (const override of [
        { id: "bad" },
        { asset: "YAP" },
        { environment: "play" },
        { reference: "" },
        { operation: "unknown" },
        { operation: "reversal" },
        { reversalOf: randomUUID() },
      ])
        await assert.rejects(
          tx((c) =>
            postCoinJournal(c, { ...f.journal(randomUUID()), ...override }),
          ),
          /invalid coin journal/,
        );
      await assert.rejects(
        tx((c) =>
          reverseCoinJournal(c, {
            originalId: "invalid",
            environment: "sandbox",
            reference: randomUUID(),
          }),
        ),
        /invalid original/,
      );
      await assert.rejects(
        tx((c) =>
          reverseCoinJournal(c, {
            originalId: randomUUID(),
            environment: "sandbox",
            reference: randomUUID(),
          }),
        ),
        /unavailable/,
      );
      await assert.rejects(
        tx((c) =>
          postCoinJournal(c, {
            ...f.journal(randomUUID()),
            operation: "reversal",
            reversalOf: "bad",
          }),
        ),
        /invalid coin journal/,
      );
    });
    it("rolls back projections and exact reversals when transaction fails", async () => {
      const f = await fixture();
      await assert.rejects(
        tx(async (c) => {
          await postCoinJournal(c, f.journal(randomUUID()));
          throw new Error("injected failure");
        }),
        /injected failure/,
      );
      assert.equal(
        (
          await owner.query(
            "SELECT balance::text FROM coin_accounts WHERE id=$1",
            [f.available],
          )
        ).rows[0].balance,
        "0",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT count(*)::int n FROM coin_postings WHERE account_id=$1",
            [f.available],
          )
        ).rows[0].n,
        0,
      );
    });
  },
);
