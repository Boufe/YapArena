# Wallet verification pause and reset rearm acceptance

The lead observed both maintained runs terminate successfully on 2026-10-21.
Their base checkout was `a9706ccb55ae342c4f11366145b1896d17656931` with
three frozen backend changes and two frozen PostgreSQL test changes. This is
working-tree acceptance, not a claim that the unchanged base commit contains
the correction. The [archive manifest](archive-manifest.json) pins those exact
sources, their compiled backend files and the copied artifacts.

The correction parks provisioning while an account's provider credentials are
unaccepted, without spending its failure budget on repeated authorization
checks. A verified same-DID exchange or authenticated retry can rearm that
specific parked job. Normal reset completion also rearms it after the accepted
mapping generation and provider cutoff are synchronized, in the same account-
locked transaction. Neither path changes the immutable wallet owner/reference,
resets earlier failure attempts, accepts a credential or permits creation before
the existing authoritative checks pass.

## Integrated run

The [raw terminal log](integrated/run.log) and
[maintained gate result](integrated/browser/result.json) record exit-success
acceptance of `npm run verify:browser` in native PostgreSQL mode:

- Full database-backed quality: **858 tests passed, zero skipped**; coverage
  **95.32% lines / 91.22% branches / 95.35% functions**.
- **239 account/security/ledger tests in each fresh and upgrade database**,
  including 15 wallet-provisioning cases and 12 durable provider-phase cases.
- **17 A4 tests and five dedicated treasury tests in each database path**.
- Maintained account/A4, arena, shared-data, homepage and Live/replay browser
  fixture gates passed. These counts describe separate gates and are not an
  additive unique-test total.

The [fresh](integrated/database/fresh-account-security.log) and
[upgrade](integrated/database/upgrade-account-security.log) logs include actual
runtime-role PostgreSQL checks of parking beyond repeated drains, accepted
same-DID rearm, retained failure budgets, uncertain creation reconciliation,
and real signed passkey activation followed by reset completion and two-worker
exactly-once wallet creation. The
[catalog snapshots](integrated/database/fresh-inventory.json) and
[upgrade snapshot](integrated/database/upgrade-inventory.json) preserve the
effective database inventory. The logs identify PostgreSQL 17.10 (Homebrew).
Five JSON reports have repository-formatted copies with unchanged parsed data;
their original bytes are preserved alongside them as `.json.raw`. Both hashes
and the semantic comparison are recorded in the archive manifest.

The retained-wallet browser used verifier SHA-256
`05c0eae6d63f2a2f22d9cbff08af590f7321c41850ee5c25bfbd7dbe681ef3db`,
as recorded by its [acceptance report](integrated/browser/a4/retained-wallet/acceptance.json).
The verifier was subsequently being extended with a separate CI refresh-race
fixture. This run does **not** establish that new fixture's acceptance; its
focused run and the new exact-revision CI gate are separate requirements.

## Native authentication run

The [new native report](native/results.json) records **18 passed groups** and an
empty error list; [the terminal log](native/run.log) records `PASS`. It includes
the actual installed SDK, Chrome virtual CTAP2 registration/authentication,
same-key operation proof verification and runtime-role PostgreSQL on desktop
and mobile viewports. Four groups cover the same Privy-key bridge and scoped
proofs; the remaining 14 cover labelled retained-independent-key compatibility,
recovery, replay, account isolation and immutable SQL proof boundaries.

Only that run's report, its eight generated screenshots and its new raw log
were copied into [native](native/). The prior complete
`security-passkey-browser/privy-only` leaf was then restored from the private
pre-run copy; all 23 prior files matched byte for byte. Older reports, failure
triage and earlier acceptance claims were not relabelled as this run.

All provider tokens, user-GET data and freeze/unfreeze controls in these local
fixtures are synthetic. Native virtual authenticators are not physical-device
or screen-reader evidence. These runs do not establish genuine hosted Privy
enrollment/export behavior, a new SDK-111 result, provider wallet creation,
hosted deployment, financial provider acceptance or permission to enable live
funding/redemption. No staging account, provider state, service or fund was
changed by this archival work.

## Tested working-tree hashes

These supplementary hashes were captured after the runs while the backend and
compiled assets remained frozen. The manifest also records the native report's
own larger source/asset inventory and the retained verifier's distinct hash.

| Path                                                  | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `src/platform/auth/embedded-wallet-provisioning.ts`   | `afadf4f70fc737d033320cb9e6172073282f512dcb845aff8fdb058a9ef325ba` |
| `src/platform/auth/provider-accounts.ts`              | `a87ccaba271a9c4f30fa712e81f5759fa488749d2224611b61f6b8adeec286e1` |
| `src/platform/auth/provider-control-phases.ts`        | `11935ce851d67589258032a8033c2db871491cfc703c75107669d5cef6937a3f` |
| `dist/platform/auth/embedded-wallet-provisioning.js`  | `93a50583ed8927170e9168b3884a144da05cd722383a6cad3207c79f85d83336` |
| `dist/platform/auth/provider-accounts.js`             | `70ece1a1f2d8db00da7469a24180e1c9764c9ab3d8d6541fcc4db7dcceb55c07` |
| `dist/platform/auth/provider-control-phases.js`       | `302bfacd36ca84d1e269a9bf23ab86f89124241e9b3fa19c3d525c2c3dd3ff40` |
| `tests/embedded-wallet-provisioning-postgres.test.js` | `b4a72d35de3870ea1dfadebbe15a73fb36dde1354d37de8d37830b22b63898c0` |
| `tests/provider-control-phases-postgres.test.js`      | `8a344febfeaec90b27f389e19aa4b2323ec632409bd6835a40872e0ea0432865` |
