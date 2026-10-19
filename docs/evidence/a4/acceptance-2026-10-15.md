# Local A4 acceptance — October 15, 2026

Current-state note — 2026-10-19: PR #31 is merged. Browser sources now live in
`frontend/` and critical verifier entrypoints use `.ts`; the paths and results below
remain the October 15 record. Use [current A4 operations](../../financial-operations.md)
and [browser release checks](../../browser-release-checks.md) for today's commands.

Baseline: `c63308e`, fetched `origin/main`; shared checkout clean and ahead/behind 0/0.
Implementation branch: `feat/a4-yap-coins`, isolated worktree `/private/tmp/yaparena-a4-20261015`.
All application data, accounts and secrets used here were synthetic and local. No hosted migration,
deployment, paid activation or merge occurred. Final trials use Node.js 24.19.0 and PostgreSQL 17.10.

## Changed implementation and authority

- `src/features/a4/engine.ts`, `ledger.ts`, `repository.ts`, `funding.ts`, `bots.ts` and `router.ts`
  implement the mechanism, posting boundary, lifecycle, funding contract, synthetic participants and API.
- `public/a4.js`, `public/a4-inline.js` and discovery `web.ts` provide advanced and inline participation.
  `app.ts`, `server.ts`, `worker.ts`, runtime and configuration wire the existing service.
- New migrations: `1792093616251_add-a4-yap-coins.js`,
  `1792094255152_harden-a4-terms-and-journals.js`,
  `1792095078306_enforce-a4-transition-guards.js`. Applied historical migrations were not edited.
- Decision 0007 and the financial plan/mechanism/operations documents select and specify A4.
  README and the nonfinancial current-status index point to them; the PRD and specification
  outlines carry precise A4 supersession notes. The main operations guide links recovery and
  reconciliation. Dated trials and unrelated product decisions from PR #30 remain preserved.

## Verified paths

- Exact unweighted medians/NO conversion, targeted/exploratory/fallback/empty branches, digital
  random endpoints, equality acceptance, whole-quantity opposite-side execution and nonexecution.
- Minority profit examples, independent center reconciliation, unequal quantities, explicit
  fees/allowances/dust, two asset precisions and funding adapter event contracts.
- Persistent account-scoped starter/refill grants, isolated bot funding, balanced journal and
  projections, runtime grants/RLS and append-only transaction sealing.
- Account/session revalidation, request payload conflicts, same-account concurrent spending,
  cutoff after ledger lock waits, price/execute rollback, committed-draw restart recovery,
  duplicate due workers, pending obligations after disable/pause and selected-sandbox archival.
- Two delayed periods with different own settlement shares: no early payout, profit, medians,
  side counts, book or secret seed in participant APIs or balance history.
- Bot-only observer authorization/audit and permanent exclusion of human orders; no client flag
  grants diagnostics. Revealed books and histories are bounded and paginated.

## Commands and outcomes

The full disposable gate is:

```sh
A4_VERIFY=true A4_BROWSER=true A4_QUALITY=true DATABASE_TEST_MODE=host \
  node scripts/verify-database-isolation.js
```

It provisions owner/runtime identities in separate disposable fresh/upgrade databases, applies
migrations, checks private tables/browser SQL denial, runs the A4 PostgreSQL suite, and executes
`npm run check` with the A4, wallet and account-revocation disposable URLs. Browser evidence uses
a separate web child that receives only runtime secrets. Existing auth disposable-name guards
remain intact. CI now supplies A4 test identities alongside the existing wallet/revocation URLs.

The complete `npm run check` passed **467 tests**, with **98.14% line, 92.83% branch,
and 95.69% function coverage** and no skipped A4/wallet/revocation PostgreSQL suites.
The separate A4 PostgreSQL suite passed **15 cases in fresh and 15 in upgrade**. These include
configured grant amounts and actual runtime-backend termination during execution, with the
persisted draw recovered and rolled-back postings absent. A default quality run without
explicit disposable URLs also passed; those database suites skip in that mode. The full
local gate above supplied the identities instead of treating skips as database evidence.

Separate regressions passed:

- `COMMUNITY_POSTGRES_MODE=host COMMUNITY_DURABLE_TRIAL=1 COMMUNITY_SOAK_SECONDS=30 node scripts/verify-community-local.js`:
  real PostgreSQL delivery/idempotency, browser races, desktop/mobile/zoom/accessibility, independent
  media controllers, and 500 local HTTP streams across 50 rooms for 30 seconds. 300 writes,
  3,000 delivery samples, P50 39 ms/P95 234 ms, all streams released. Synthetic provider/local HTTP.
- `REPLAY_POSTGRES_MODE=host node scripts/verify-replay-pipeline.js`: real runtime PostgreSQL
  transactions, recovery/fencing/canary isolation and FFmpeg 9.0.2, six-second synthetic source,
  13 package files, 0.616-second encode. Stalled-heartbeat shutdown completed in 1,512 ms.
  In-memory object adapter; no hosted storage/edge or device evidence.
- Clean locked `npm ci` under Node 24, `git diff --check`, formatting and documentation references.

A measured 500-bot create/settle scenario took 110 ms on the fresh database and 110 ms on upgrade
in the final trial. These are local workload observations, not approved SLOs.

## Browser evidence

[Machine-readable journey](browser-evidence.json) records the exercised path. Synthetic email
registration used actual app auth; no wallet was required. The 500-bot reference fixture executed
the human NO order with a nonzero payout, restored its receipt after reload, and revealed the
book only after settlement. Inline commitment retained the debate's media/chat DOM; the
advanced view opened in a separate tab. Logout cleared private financial UI.
Pause/run/step/speed, bot-only observation and archive/new-run passed.
Desktop was 1440×1000; mobile was 390×844 emulation. Keyboard focus remained in the review dialog;
page overflow and axe WCAG A/AA checks passed. There were no page-script errors.

- [Inline debate participation](inline-debate-desktop.png)
- [Exact commitment review](commitment-desktop.png)
- [Settled desktop receipt and book](settled-desktop.png)
- [Settled mobile receipt and book](settled-mobile.png)

The in-app Browser connector could not initialize because of its runtime's module restriction.
The repository's existing local Chrome/Playwright approach supplied the observations above.
This is emulation/automated accessibility evidence, not physical-device or human accessibility acceptance.

## Research and limits

[Reproducible diagnostics](../../../public/a4-research.json) preserve the homogeneous analytical
fixtures, a minimal two-participant pivotal shading example, and a separate 500-person heterogeneous
behavioral-cohort audit. Both side and limit counterfactuals keep quantity fixed and recompute
endogenous medians, population share and execution, including nonexecution zeros. Independent
confirmation and standard errors are reported. The two-person limit 0.34 → 0.25 deviation gained
about 0.04478 Yap Coins per opportunity (confirmation SE 0.0005894; 2,000 samples).
The 500-cohort audit conditions on a behavioral stress cohort; it is not an ex ante Bayesian
strategy or a proof of generalized honesty. No external executable A3/A4 source was available.

Real-fund adapters, paid-release eligibility/custody/provider/jurisdiction choices, five-day timing,
ongoing market, event winner/creator reward and post-finality correction policies remain unimplemented
or require separate review. Existing hosted API-isolation/device/media/operational gates remain open.
The default A4 mode and database participation controls are disabled.
