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
import { createAccountWallet } from "../dist/features/account-wallet/repository.js";

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
    it("reads each owned grant separately and retains qualification after later losses", async () => {
      const user = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0];
      const lot = randomUUID(),
        other = randomUUID(),
        operating = randomUUID(),
        backing = randomUUID();
      await owner.query(
        "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'live','USDC','welcome',$1::text,25000000)",
        [lot, user.id],
      );
      await owner.query(
        "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'sandbox','USDC','daily',$1::text,5000000)",
        [other, user.id],
      );
      for (const [id, kind] of [
        [operating, "operating"],
        [backing, "backing"],
      ])
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,kind) VALUES($1,'live','USDC',$2)",
          [id, kind],
        );
      const c = await owner.connect();
      try {
        for (const net of [10000000, 15000000, -20000000]) {
          const journal = randomUUID();
          await c.query("BEGIN");
          await c.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'live','USDC',$1::text,'funding')",
            [journal],
          );
          await c.query(
            "INSERT INTO coin_postings VALUES($1,$2,'live','USDC',$4),($1,$3,'live','USDC',-$4)",
            [journal, operating, backing, net],
          );
          await c.query(
            "INSERT INTO coin_grant_profit_events(lot_id,journal_id,environment,asset,net_profit) VALUES($1,$2,'live','USDC',$3)",
            [lot, journal, net],
          );
          await c.query("COMMIT");
        }
        const view = await createAccountWallet(runtime).balances(user.id);
        assert.equal(view.grants.length, 1);
        assert.equal(view.grants[0].netProfit, "500");
        assert.equal(view.grants[0].qualified, true);
        assert.equal(view.grants[0].remaining, "0");
        assert.equal(view.grants[0].percent, 100);
        assert.equal(view.withdrawable, "0");
        const stranger = (
          await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
        ).rows[0];
        assert.deepEqual(
          (await createAccountWallet(runtime).balances(stranger.id)).grants,
          [],
        );
        await assert.rejects(
          runtime.query(
            "INSERT INTO coin_grant_lots(id,user_id,environment,asset,kind,reference,target) VALUES($1::uuid,$2,'live','USDC','daily',$1::text,5000000)",
            [randomUUID(), user.id],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          owner.query("DELETE FROM coin_grant_lots WHERE id=$1", [lot]),
          { code: "23514" },
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
    it("enforces balanced immutable journals, exact projections and environment isolation", async () => {
      const user = (
        await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")
      ).rows[0];
      const credit = randomUUID(),
        backing = randomUUID(),
        live = randomUUID();
      for (const [id, kind, environment, userId] of [
        [credit, "available", "sandbox", user.id],
        [backing, "backing", "sandbox", null],
        [live, "available", "live", user.id],
      ])
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,user_id,kind) VALUES($1,$2,'USDC',$3,$4)",
          [id, environment, userId, kind],
        );
      const journal = randomUUID();
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'sandbox','USDC',$1::text,'funding')",
          [journal],
        );
        await c.query(
          "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',1000000),($1,$3,'sandbox','USDC',-1000000)",
          [journal, credit, backing],
        );
        await c.query("COMMIT");
        assert.equal(
          (
            await owner.query(
              "SELECT balance::text n FROM coin_accounts WHERE id=$1",
              [credit],
            )
          ).rows[0].n,
          "1000000",
        );
        for (const sql of [
          "DELETE FROM coin_journals WHERE id=$1",
          "UPDATE coin_journals SET reference='changed' WHERE id=$1",
          "DELETE FROM coin_postings WHERE journal_id=$1",
        ])
          await assert.rejects(owner.query(sql, [journal]), { code: "23514" });
        await assert.rejects(
          owner.query("UPDATE coin_accounts SET balance=2000000 WHERE id=$1", [
            credit,
          ]),
          { code: "23514" },
        );
        const lateAccount = randomUUID();
        await owner.query(
          "INSERT INTO coin_accounts(id,environment,asset,user_id,kind) VALUES($1,'sandbox','USDC',$2,'reserved')",
          [lateAccount, user.id],
        );
        await assert.rejects(
          owner.query(
            "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',1)",
            [journal, lateAccount],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          runtime.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'live','USDC',$1::text,'funding')",
            [randomUUID()],
          ),
          { code: "42501" },
        );
        for (const account of [credit, live]) {
          await c.query("BEGIN");
          const j = randomUUID();
          await c.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation) VALUES($1::uuid,'sandbox','USDC',$1::text,'funding')",
            [j],
          );
          await assert.rejects(async () => {
            await c.query(
              "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',1)",
              [j, account],
            );
            await c.query("COMMIT");
          });
          await c.query("ROLLBACK");
        }
        for (const amount of [999999, 1000000]) {
          await c.query("BEGIN");
          const reversal = randomUUID();
          await c.query(
            "INSERT INTO coin_journals(id,environment,asset,reference,operation,reversal_of) VALUES($1::uuid,'sandbox','USDC',$1::text,'reversal',$2)",
            [reversal, journal],
          );
          await c.query(
            "INSERT INTO coin_postings VALUES($1,$2,'sandbox','USDC',$4),($1,$3,'sandbox','USDC',-$4)",
            [reversal, backing, credit, amount],
          );
          if (amount === 999999) {
            await assert.rejects(c.query("COMMIT"), { code: "23514" });
            await c.query("ROLLBACK");
          } else await c.query("COMMIT");
        }
        assert.equal(
          (
            await owner.query(
              "SELECT balance::text n FROM coin_accounts WHERE id=$1",
              [credit],
            )
          ).rows[0].n,
          "0",
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  },
);
