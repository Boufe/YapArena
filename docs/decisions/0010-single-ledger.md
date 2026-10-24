# Decision 0010 — One ledger for value: YAP play retired

Status: approved by the founder, 2026-10-24 (prompt 17). Narrows
[Decision 0007](0007-a4-adjusted-ftm.md): ordinary Yap Coins (YAP) play ends, Bots mode
continues. Custody and hidden tallies were settled first, in
[financial architecture](../financial-architecture-options.md) F01–F03 and F11–F13.

## Why

- Two double-entry ledgers existed. `coin_*` (USDC atoms, YC) keeps balances by trigger, is
  immutable by trigger, idempotent and row-secured. `a4_*` (YAP) has its balances written by
  application code.
- Phase 1 runs A4 debate markets on free YC under the grant rules (F06, F08), and
  `src/features/account-wallet/debate-sandbox.ts` already runs the A4 engine on `coin_*`. YAP
  has no phase-1 role, and existing decisions keep it separate and never redeemable
  ([accounts](../email-first-accounts.md#financial-decision-sheet)).
- Moving YAP into `coin_*` was rejected. It would need a play environment, accounts with no user
  (bots), several reserved accounts per user, a negative issuer, journals of about 2,000 entries
  and a bulk history copy, inside the ledger that will hold USDC claims.

## Decision

1. **`coin_*` is the only ledger for value people hold.** New balances, debates and markets post
   there.
2. **Ordinary YAP play is retired.** Its part of the A4 ledger, scope `global` (every human run,
   the account-wide balance and its starter and daily refill grants), is frozen read-only for
   every database role, the owner included. New human runs, the account-wide refill and commitments
   to human rounds are refused with 410. Nothing converts to YC.
3. **Past YAP stays readable.** Wallet, history, run views, debate timelines and homepage ordering
   keep reading the frozen rows. Each `global` balance at the freeze is recorded in
   `a4_play_closing_balances`.
4. **Bots mode continues** (founder, 2026-10-24). Mixed and observer runs keep writing their own
   run scopes of the A4 ledger, including the creator's run-scoped play balance, until a later
   ledger-free simulator replaces them. Published bot histories keep working.
   `A4_MODE=yap-coins` (human runs only) now enables nothing.

## Rollout

Expand: `1792860563050_add-a4-ledger-reconciliation` adds `a4_ledger_discrepancies(scope)`, the
read-only check (balances against postings, unbalanced journals, scope totals),
`a4_ledger_closing_blockers(scope)` and the closing table. The release stops YAP play writes. Its
worker still settles human rounds already open and voids unopened ones, so it may deploy before or
after the freeze.

Contract: `1792860564050_freeze-a4-play-ledger` refuses with SQLSTATE 55000, naming up to 20
blockers, while a human round is unfinished, play value is reserved or the check finds a
discrepancy. It then records the closing balances and adds triggers refusing inserts, updates,
deletes and truncation of `global` accounts and journals, and truncation of any ledger table.

Apply both as the owner, then deploy, as usual. On staging the worker drains human rounds even
with `A4_MODE=disabled`; this read-only query must return no rows first:

    SELECT r.state, count(*) FROM yaparena.a4_rounds r JOIN yaparena.a4_sessions s ON s.id=r.session_id
    WHERE s.mode='human' AND r.state NOT IN ('settled','void') GROUP BY r.state;

## Verification

The fresh and upgraded isolation databases run the A4 PostgreSQL suite. The upgrade seeds YAP
history before the freeze, checks the refusal, lets this release's worker void the unopened round,
then requires every `global` balance to be unchanged and recorded. The suite compares closing
records with balances and postings, refuses writes as runtime and owner, and checks the blockers on
a live bot run.

## Later

- A separate PR removes the human-run and refill controls from the A4 pages, the A4 write routes
  that only YAP used, and `A4_MODE=yap-coins`.
- A ledger-free bot simulator would let the bot scopes freeze too, leaving `coin_*` alone.
