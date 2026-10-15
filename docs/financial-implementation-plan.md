# A4 Yap Coins implementation

Baseline: fetched `origin/main` = `c63308e` on 2026-10-15; shared checkout clean,
ahead/behind 0/0. Work uses `feat/a4-yap-coins` in `/private/tmp/yaparena-a4-20261015`.
No executable A3/A4 simulator was found. External simulator parity is unverified.

## Authority and conflicts

| Source                                      | Authority for this change                                    | Resolution                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| October 15 founder implementation prompt    | A4 economics, Yap Coins, Bots scope                          | Selected in decision 0007; copied rules into the mechanism contract                                          |
| September 29 PRD and specification outlines | Other product decisions and future paid release dependencies | Money-share movement, paired issuance, matching, clipped payouts and draw refunds are superseded for A4 only |
| PR #30 status index and current code        | Existing features and saved evidence                         | Preserve discovery, auth, matching, media, community and measurement                                         |
| Historical trials                           | Evidence at recorded revisions                               | No new hosted/device/paid acceptance inferred                                                                |
| External simulator discussion               | Provenance, conditional incentive claims                     | No source available; independently test fixtures and finite deviations                                       |

## Implementation and evidence

The engine, private-schema migrations, balanced ledger/reservations, durable lifecycle,
account/session authorization, APIs, debate integration, receipts and bot controls are implemented
on this branch. [Local acceptance evidence](evidence/a4/acceptance-2026-10-15.md) records actual
quality, PostgreSQL, browser, community and replay results. A subsequent founder-authorized
[staging functional trial](https://github.com/Boufe/YapArena/pull/31) deployed `fcb162d`
and verified one 500-bot/one-human round through settlement. Wider hosted capacity,
physical-device and paid acceptance remain open. The [live/replay workspace](debate-workspace.md)
records the later UI extension and its separate evidence. The runbook documents
default-off configuration and operational recovery.

## Work packages

1. Exact rational engine, injected random words, acceptance and independent economic fixtures.
2. Additive private-schema migration; append-only balanced journal; projections; isolated issuance,
   pre-funded center collateral; account/session locks, database cutoff checks and idempotency.
3. Durable locked snapshot/draw/execution/settlement transitions, recovery and confidential views.
4. Authenticated API, debate participation panel, balances/receipts/history and bot run controls.
5. Seeded heterogeneous stress and homogeneous reference generators; finite counterfactual harness.
6. Real runtime-role PostgreSQL concurrency/security tests, browser/mobile/keyboard verification,
   existing quality gates and operating documentation. Record actual outcomes in evidence files.

## Defaults and bounds

YAP is nonredeemable play money with six decimal places and a one-coin contract face value.
Starter issuance is 1,000 coins per account and balance scope; refill is 1,000 once per UTC day.
Starter/refill/bot grant amounts are bounded operator configuration through `A4_STARTER_COINS`,
`A4_REFILL_COINS` and `A4_BOT_COINS`; the active policy is displayed by the browser.
Bots use isolated run scopes, 500 synthetic participants by default, maximum 1,000. Human-only
rounds never contain bots. Quantity is 1–100, capacity at most 1,001, periods at most 10.
Default epsilon is 0.05; controls also allow 0 and 1. Fees default to zero; experimental 5%
of premium is available. Each admission reserves full face value plus the maximum fee, and
the center separately reserves full face value. This deliberately conservative policy backs
every accepted quantity without smaller-side caps or dependence on subsequent issuance.
No pre-cutoff revisions: the first successful explicit commitment is binding; retries require
the same idempotency key and terms. This makes one account's linked wallets one entry.

## Future decisions

Real funds fail closed: the asset registry and funding interface do not enable payment rails.
Provider/custody, currencies/chains, chargebacks/reorgs, withdrawal authorization, legal eligibility,
operational epsilon/fee/capacity policy, five-day event schedule, related-party access,
post-finality correction reserves, creator rewards and the ongoing instrument remain dependencies.
Affected boundaries: `funding.ts`, asset registry, session configuration, account lifecycle,
ledger reversal policy and paid-mode activation. The original coding task reserved hosted
changes; its subsequent staging trial was explicitly authorized. Merging and real-fund
activation remain separate decisions.
