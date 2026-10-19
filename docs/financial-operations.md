# Yap Coins operations

The founder-authorized October 15 [staging trial](https://github.com/Boufe/YapArena/pull/31)
applied the three A4 migrations separately as owner, then deployed `fcb162d` with
runtime-only credentials and `A4_MODE=bots`. This is a recorded play-mode trial,
not a change to the default-off configuration. The [live/replay workspace](debate-workspace.md)
extends that UI without schema changes; its dated evidence records its own checks.

The [mechanism](a4-mechanism.md) and [implementation plan](financial-implementation-plan.md)
govern play rounds. No deposits, cash-out, minting, conversion or real payment adapters exist.

## Local activation and exercise

Apply migrations in an owner-only process using the existing README provisioning workflow.
Web/worker processes keep only runtime credentials. Set `A4_MODE=bots` in `.env.runtime` to
allow the bot and Yap Coins code paths, or `yap-coins` for human-only participation. Default
is `disabled`. Separately, in the controlled local owner process set:

```sql
UPDATE yaparena.a4_controls SET enabled=true,bots_enabled=true WHERE id=true;
```

`A4_STARTER_COINS` and `A4_REFILL_COINS` configure whole-coin grants (1–1,000,000;
1,000 by default). `A4_BOT_COINS` configures per-period bot funding (105–1,000,000;
1,000 by default), with the minimum backing the maximum allowed quantity and fee. The browser
shows the current policy. Existing grant references stay idempotent across policy changes;
changing an amount does not reissue an already granted starter or daily refill.

This is an explicit play-mode switch, not a hosted migration instruction. There is no paid-mode
value: unknown values fail startup. Open a published debate's participation panel or `/coins`,
sign in through the existing account page, choose a debate, start/join a human or labeled bot
run, review terms and commit. Reload restores persistent state. Every account can request a
daily refill at the configured `A4_REFILL_COINS` amount (1,000 by default). Bot scopes get their own recorded starter funding; resets cannot issue
ordinary spendable balance or erase other runs. The observer choice permanently excludes people.

Configure the same A4 mode on every web and maintenance-worker instance. Start the ordinary web process with background jobs or `npm run start:worker`. Both recover
A4 transitions. Do not launch the replay encoder for financial work. Each tick processes at most
ten sessions; PostgreSQL run locks and unique journal references serialize competing workers.
The default cap is three active runs per creator. Per-account API reads are bounded at 120/minute
and writes at 30/minute, in addition to existing application controls. These limits are process-local;
shared multi-instance abuse controls and production capacity acceptance remain open.

## Reconciliation, pause and recovery

Set `enabled=false` to reject new issuance, commitments and run creation. Existing lock, price,
execution and settlement recovery remains active even with `A4_MODE=disabled`. Never terminate
recovery merely to stop new exposure. Expired unopened windows in paused runs void explicitly so they cannot strand pending payouts.
Failed recovery attempts record a durable audit event and back off for 30 seconds while other
due runs continue. Bot pause is a run scheduling control, not a way to extend
admission past recorded cutoff. Archive voids only pre-lock sandbox windows with explicit refund
journals; already locked obligations retain their original seeds and settlement shares.

In a read-only operator transaction, reconcile projections:

```sql
SELECT a.id,a.amount,COALESCE(sum(p.amount),0) AS journal_amount
FROM yaparena.a4_accounts a LEFT JOIN yaparena.a4_postings p ON p.account_id=a.id
GROUP BY a.id HAVING a.amount<>COALESCE(sum(p.amount),0);
SELECT j.reference FROM yaparena.a4_journals j
LEFT JOIN yaparena.a4_postings p USING(reference)
GROUP BY j.reference HAVING count(p.reference)=0 OR sum(p.amount)<>0;
```

Both return no rows. Review center issuance separately from trading result and fees. Full
contract backing stays in per-round collateral until settlement. Participant P&L plus center
trading result is zero; net participant P&L additionally subtracts earned fees. Dust is retained
as exact rational receipt fields and is part of the center's charged-premium/payout difference.
Do not treat fees or future deposits as collateral.

After interruption, restart the same reviewed runtime. Scheduled/open/locked/priced/pending
records, secret seeds, frozen snapshots and business references survive. A failed transaction
rolls back projections and journal together. Retry requests with the original key. Snapshot,
funding or reconciliation failures require pausing admission and inspecting the failed run with
a controlled operator connection; never delete a journal, alter the seed, recalculate a locked
population, disable constraints or silently mint repair balances. Record any approved correction
with a separately reviewed reversal policy. Post-finality correction is not implemented.

A4 tables are private-schema, owner-migrated, RLS-enabled and backend-only. The runtime identity
has no asset/control update or journal update/delete grants. Authenticated account/session validity
is rechecked inside financial transactions under the account lock; linked-wallet changes and
account-wide revocation retain the existing ordering contract. Suspension, deletion/export and
recovery features remain absent where already documented. Future deletion must preserve retained
financial records and eligibility snapshots and explicitly handle open obligations.

## Verification and future money rails

`npm run verify:a4` runs disposable fresh/upgrade isolation plus runtime-role A4 concurrency tests.
It accepts no hosted database URL. `A4_TEST_DATABASE_URL` and `A4_TEST_OWNER_URL` are explicit
disposable-test identities for the Node suite; the owner sets up fixtures, runtime executes product
queries. Use `A4_QUALITY=true` with the disposable isolation harness to run `npm run check` with
A4, wallet and revocation PostgreSQL suites enabled, and `A4_BROWSER=true` for its local browser
journey. `npm run verify:browser` coordinates these flags and the homepage/preview suites;
see [the maintained browser gate](browser-release-checks.md). The harness database names satisfy the existing auth suites' disposable-name guards.
`npm run check` remains the quality gate; separate database/community/replay suites keep
their existing scope. See the saved evidence for actual passes, skips and browser observations.

`funding.ts` defines idempotent pending/final/failed/reversed event behavior with immutable asset
and amount. Only recorded play issuance is connected. Future fiat requires authenticated webhooks,
provider reconciliation and funded reversal/chargeback policy. Crypto requires chain/asset matching,
confirmation and reorg policy, transaction replay protection, custody and withdrawal authorization.
No test asset becomes a selectable live asset. One asset per round and scope is enforced through
foreign keys and journal checks. Future authorization must bind account, action, asset, round,
terms, version, nonce and expiry, independently of login/wallet identity signatures.

Paid activation also depends on reviewed custody/provider/jurisdiction decisions, eligibility,
security/incident controls, actual five-day scheduling, related-party policy, correction reserves,
creator reward rules and the combined ongoing/event-market release gates. Local software or
research passes establish none of those approvals. PR #31's play implementation is merged;
the dated staging trial above does not authorize later deployments or real-fund activation.
