# Yap Coins operations

This guide governs the historical nonredeemable A4/YAP play ledger. Under
[decision 0010](decisions/0010-single-ledger.md) ordinary YAP play (human runs, the
account-wide balance and its refill) is retired and its ledger scope `global` is frozen
read-only; past runs and balances stay readable. Bots mode continues on its own run scopes.
The later
[email-first account contract](email-first-accounts.md) and
[coin sandbox runbook](coin-sandbox-operations.md) govern the separate YC source
books, simulated funding/withdrawals, append-only error corrections and isolated
Base Sepolia adapter. They do not convert historical play balances or enable live
funding/redemption. Use those current guides for the approved grant, withdrawal,
fee and recovery policies; the play grants and modes below retain their original
rules.

The founder-authorized October 15 [staging trial](https://github.com/Boufe/YapArena/pull/31)
applied the three A4 migrations separately as owner, then deployed `fcb162d` with
runtime-only credentials and `A4_MODE=bots`. This is a recorded play-mode trial,
not a change to the default-off configuration. The [live/replay workspace](debate-workspace.md)
extends that UI without schema changes; its dated evidence records its own checks.

The [mechanism](a4-mechanism.md) and [implementation plan](financial-implementation-plan.md)
govern these play rounds. This historical module has no deposits, cash-out,
conversion or external payment adapter; the separate sandbox integration above
does not add those capabilities to the play ledger.

## Local activation and exercise

Apply migrations in an owner-only process using the existing README provisioning workflow.
Web/worker processes keep only runtime credentials. Set `A4_MODE=bots` in `.env.runtime` to
allow bot runs. `yap-coins` allowed human-only participation and now enables nothing. Default
is `disabled`. Separately, in the controlled local owner process set:

```sql
UPDATE yaparena.a4_controls SET enabled=true,bots_enabled=true WHERE id=true;
```

`A4_STARTER_COINS` and `A4_REFILL_COINS` configure the whole-coin grants of a run's own
balance (1–1,000,000; 1,000 by default). `A4_BOT_COINS` configures per-period bot funding (105–1,000,000;
1,000 by default), with the minimum backing the maximum allowed quantity and fee. The browser
shows the current policy. Existing grant references stay idempotent across policy changes;
changing an amount does not reissue an already granted starter or daily refill.

This is an explicit play-mode switch, not a hosted migration instruction. There is no paid-mode
value: unknown values fail startup. Open a published debate's participation panel or `/coins`,
sign in through the existing account page, choose a debate, start a labeled bot run, review
terms and commit. Reload restores persistent state. Within a bot run the account can request a
daily refill at the configured `A4_REFILL_COINS` amount (1,000 by default). Each bot run gets
its own recorded starter funding; resets cannot issue ordinary spendable balance or erase other
runs. Human runs, the account-wide refill and commitments to human rounds answer 410. The observer choice permanently excludes people.

Configure the same A4 mode on every web and maintenance-worker instance. Start the ordinary web process with background jobs or `npm run start:worker`. Both recover
A4 transitions. Do not launch the replay encoder for financial work. Each tick processes at most
ten sessions; PostgreSQL run locks and unique journal references serialize competing workers.
The default cap is three active runs per creator. Per-account API reads are bounded at 120/minute
and writes at 30/minute, in addition to existing application controls. These
historical A4 route ceilings remain process-local. The later
[shared Redis controls](email-first-accounts.md#redis-configuration-and-measurements)
protect account-authentication mutations across instances; they do not make these
A4 route ceilings distributed or secure financial limits. PostgreSQL remains
authoritative for financial state. Wider hosted A4 capacity acceptance remains open.

## Reconciliation, pause and recovery

Set `enabled=false` to reject new issuance, commitments and run creation. Existing lock, price,
execution and settlement recovery remains active even with `A4_MODE=disabled`. Never terminate
recovery merely to stop new exposure. Expired unopened windows in paused runs void explicitly so they cannot strand pending payouts.
Failed recovery attempts record a durable audit event and back off for 30 seconds while other
due runs continue. Bot pause is a run scheduling control, not a way to extend
admission past recorded cutoff. Archive voids only pre-lock sandbox windows with explicit refund
journals; already locked obligations retain their original seeds and settlement shares.

In a read-only owner transaction, reconcile projections. It lists every balance that differs
from its postings, every empty or unbalanced journal and every scope that does not sum to zero;
pass a scope (`'global'` or a bot run ID) to check one:

```sql
SELECT * FROM yaparena.a4_ledger_discrepancies();
```

It returns no rows. Review center issuance separately from trading result and fees. Full
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
with a separately reviewed reversal policy. Post-finality correction is not
implemented for this historical play ledger; the separate coin sandbox's funded
original-source corrections follow its own runbook.

## Retired YAP play freeze

Migration `1792860564050_freeze-a4-play-ledger` records every `global` balance in
`a4_play_closing_balances`, then refuses any insert, update or delete of `global` accounts and
journals, for the owner too, and any truncation of the ledger tables. It refuses to apply while
`SELECT * FROM yaparena.a4_ledger_closing_blockers('global');` returns rows: an unfinished
human round, play value still reserved, or a discrepancy. The worker settles open human rounds
and voids unopened ones even with `A4_MODE=disabled`, so leave it running and apply the
migration once the blockers are gone. Closing records must keep matching the frozen balances:

```sql
SELECT a.id FROM yaparena.a4_accounts a
FULL JOIN yaparena.a4_play_closing_balances c ON c.account_id=a.id
WHERE (a.scope='global' OR c.account_id IS NOT NULL) AND c.amount IS DISTINCT FROM a.amount;
```

A4 tables are private-schema, owner-migrated, RLS-enabled and backend-only. The runtime identity
has no asset/control update or journal update/delete grants. Authenticated account/session validity
is rechecked inside financial transactions under the account lock; linked-wallet changes and
account-wide revocation retain the existing ordering contract. Current account
suspension, recovery and revocation behavior follows the email-first account
contract rather than this play-mode guide. Future deletion must preserve retained
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
