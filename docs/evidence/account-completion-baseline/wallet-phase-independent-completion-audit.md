# Independent pre-release audit — 2026-10-21 wallet/reset continuation

**Overall status: incomplete.** The integrated local implementation and its
required local gates now pass. Exact-revision CI, guarded staging release and
the genuine provider/device/financial eligibility gates below remain open at
this audit. This is a new dated review; the earlier
[independent completion audit](independent-completion-audit.md) and its recorded
50-row boundary are preserved.

The reviewer compared all 52 current checklist rows with the full task, latest
approved overrides, current source, raw gate outputs and individual evidence
limitations. This review is independent of the lead's completion claims. This
reviewer authored some Redis, accounting, media, report and browser work; the
separate [auth review](auth-independent-review.md),
[passkey review](single-privy-passkey-review/README.md) and financial/security
cross-reviews remain necessary for those changes. A checklist audit does not
replace independent review of an author's sensitive state transitions.

## Evidence boundary checked

The following results were inspected, rather than inferred from an agent report:

- [Integrated r5 result](wallet-phase-integrated/result.json) and its
  [raw output](wallet-phase-integrated/output.log): **854/854 tests, zero skips**;
  coverage **95.31% lines / 91.19% branches / 95.35% functions**. Each fresh and
  upgrade path passed **235 account/security/ledger, 17 A4 and five treasury**
  cases. Core, database-isolation and retained-wallet browser gates passed.
  Earlier sandbox, inventory, owner-lock and formatting failures remain archived.
- [Final SDK browser](embedded-wallet-browser/r3/browser-results.json): this
  reviewer executed **111 checks**, exit 0, errors and requirement failures empty.
  Real installed SDK/Chromium WebAuthn behavior is exercised with synthetic OTP,
  provider and application responses. Desktop/mobile single-status assertions
  and matching before/after wallet images passed and were visually inspected.
- [Native security browser](security-passkey-browser/privy-only/results.json):
  **18 groups**, errors empty, real runtime PostgreSQL and native virtual
  WebAuthn; provider token/user/OTP responses remain synthetic. Current same-key
  bridge and operation proof are exercised without a second product enrollment.
- [Coin browser](coin-sandbox-browser/results.json): **22 groups**, errors,
  accessibility and layout failures empty. Real runtime PostgreSQL, native
  retained proof and deterministic financial simulation; expected 403/409/410
  refusals are explicitly recorded. No genuine provider or live money acceptance.
- [Cookie ordering](wallet-phase-cookie-browser/results.json): the lead confirmed
  terminal success, **seven groups across 14 issuer paths**. The current helper
  source and asset hashes were independently recomputed. This is Chromium/local
  synthetic HTTP behavior, not coordination by arbitrary API clients.
- [Real local Redis](../redis-acceptance/embedded-wallet-scopes/results.json):
  this reviewer executed **10 groups**, two separate HTTP processes, real
  disposable Redis, including all three passkey/restart/wallet retry purposes.
  There was no hosted outage or capacity trial.
- The read-only provider acceptance helper passed this reviewer's **20 offline
  self-tests**, no network, database connection or provider mutation. Strict
  operational compilation/lint also passed in the lead's run. Its
  [final-hash review](embedded-wallet-review/README.md) is separate from any
  genuine provider inspection; no such inspection was performed by this reviewer.

Source fingerprints, rather than commit metadata during concurrent commits,
bind these results. The reviewer recomputed:

| Manifest                                                               | Current comparison                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Integrated source hashes](wallet-phase-integrated/source-hashes.json) | 368/370 unchanged; the two changes are the final native verifier fixture and the operational compiler inventory for the new read-only helper. No application source or migration mismatch. |
| Native result source hashes                                            | 35/35 match, including served assets and executed backend modules.                                                                                                                         |
| Coin result source hashes                                              | 31/31 match, including financial engines, backend modules and browser assets.                                                                                                              |
| SDK result                                                             | All seven source and all 17 public asset hashes match.                                                                                                                                     |
| Redis result                                                           | Both exercised source/verifier hashes match.                                                                                                                                               |
| [Earlier financial review](financial-review/source-hashes.json)        | 22/23 unchanged; only the database-isolation harness changed for new inventories/suites. No financial engine, repository, router, migration or financial test change.                      |

The integrated raw-output SHA-256 was independently recomputed as
`d1fa8b5d078a6a453799ac5e7f23a6c876ed6a20247b32cd17d9c864415099ab`.
The integrated source-manifest fingerprint is
`144d1a1947e0bb0b060e5f24e61d37d6c2b3c9dfccd7d4ea808a46eabcbd66b3`.
The final SDK result fingerprint is
`46c27e53d76480634fc3732ee021fbff7744abfe741caa465fdbd4832cbac87d`.
The new read-only helper fingerprint is
`5000fcc118e5be8be9d1c62a8c0263c9eb13f8020e09a79e71d9bc9cf92e90ff`.
These fingerprints establish this dated boundary; later changes require their
own appropriate verification.

## Requirement-by-requirement audit

Owners and dependencies remain in the governing
[52-row matrix](../../email-first-completion.md#requirement-matrix).
“Local” below means the evidence above, not hosted/provider/device acceptance.

| ID  | Finding and remaining acceptance                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Checkout, fetched-main comparison, existing branch/PR and preserved work established. Current changes still need exact CI and release. The preflight's d6 staging revision is historical relative to this source.                                                                                                                                                                                   |
| R02 | PRD, implementation/security/financial/Redis/A4/operations guides and dated evidence were read. Latest approved wallet and financial overrides govern; historical play/token documents retain explicit authority notes.                                                                                                                                                                             |
| R03 | Owner/dependency/acceptance matrix and decision log exist and cover 52 rows. Final local counts and pending external gates must be kept current as CI/release proceeds.                                                                                                                                                                                                                             |
| R04 | Existing theme/header/public watching and discovery are preserved in source and local core/SDK images. Final wallet before/after screenshots show the corrected single status. Genuine hosted signed-in acceptance remains open.                                                                                                                                                                    |
| R05 | Genuine initial email signup is recorded historically. Current hosted returning login remains required; synthetic SDK success is not genuine provider authentication.                                                                                                                                                                                                                               |
| R06 | Provider-owned OTP lifecycle is preserved; SDK fixtures cover sending, code entry, cancellation, resend, delayed/error and network behavior. Genuine delivery/expired/used-code, OS autofill and provider limits remain separately unverified.                                                                                                                                                      |
| R07 | Initialization/refresh/back/multi-tab and duplicate-submit handling pass local tests. Settings actor changes, late replies and cookie header ordering are fenced. Genuine interrupted cross-tab provider ceremonies and other browser/device behavior remain open.                                                                                                                                  |
| R08 | Free development Google/passkey settings are verified. One genuine saved key and readable COSE do not establish completed activation or returning login. Genuine Google link and current passkey activation/returning proof remain open.                                                                                                                                                            |
| R09 | Safe page/action return preserves guest/same-account context and requires a new explicit confirmation; local delayed actor/draft tests pass. No automatic stake/payment/provider change is introduced by auth return. Genuine hosted action acceptance remains open.                                                                                                                                |
| R10 | Transactional DID/account mapping, stable IDs, callbacks/SID fences and exactly-once provisioning pass current PG. Wallet enqueue shares the verified provisioning transaction. Genuine hosted callback races remain separate.                                                                                                                                                                      |
| R11 | Email/method changes, same-Privy-key activation, restricted first-key restart and retained-key legacy recovery pass local PG/native tests. Asset-bearing/uncertain wallet creation blocks DID replacement under the final account lock. All-strong-lost recovery service and genuine hosted flows remain open.                                                                                      |
| R12 | No email-only merge; retained legacy linking requires deliberate dual ownership and permanently retires the replaced binding. Local cross-account/tombstone/replay cases pass; genuine retained-account ceremony remains open.                                                                                                                                                                      |
| R13 | New external-wallet linking and unknown-wallet signup are disabled in configured Privy mode. Retained sign-in/unlink/final-method guards pass PG and strict retained-wallet browser checks. Genuine hosted/physical wallet ceremony remains unverified.                                                                                                                                             |
| R14 | Actual Free DEV settings and 150-user cap are recorded. Production domain/sender branding, numeric API capacity, rate allowance and entitlements remain unverified; no paid feature or purchase is approved by passing local tests.                                                                                                                                                                 |
| R15 | Earlier embedded-off policy is superseded by the approved one user-controlled EVM wallet/default recovery/no app signer contract, also tracked by R51. Durable source and local tests pass; genuine creation/recovery and final staging release remain open.                                                                                                                                        |
| R16 | Expiring exact-term one-use proofs, session/generation binding, fresh UV and current trusted provider key checks pass local PG/native acceptance. Token refresh or recent issuance is not used as fresh proof. Genuine hosted proof remains open.                                                                                                                                                   |
| R17 | Default Sign out revokes all; advanced current/others APIs retain their scopes. SID/generation fences, suspension, credential revocation and durable acknowledged provider phases pass PG, including crash/lag/owner-lease cases. Reset-only repair is not credential adoption. Genuine current hosted logout/reset acceptance remains open.                                                        |
| R18 | Protected cookies are checked against current trusted provider credentials without positive authorization caching. Owned pending reset phases produce temporary denial; real credential changes revoke. Production API budget and genuine hosted provider-change acceptance remain open.                                                                                                            |
| R19 | Local HTTP/PG and earlier actual Cloud trials establish their recorded exact speaker/token revocation boundaries, including refreshed-token replay and public viewer preservation. Those results are not current genuine-user hosted logout or physical media acceptance.                                                                                                                           |
| R20 | No current financial rule mismatch found: internal YC, 100 YC/USDC, five requested deposit networks remain requested, purchases have no profit target, 5-USDC gross minimum, fee deducted inside gross, no daily cap, USDC-only completed-purchase withdrawals, no original-route purchase refund promise. Live eligibility remains separate.                                                       |
| R21 | Custody/signing and all five actual provider routes remain unresolved/unapproved. No native USDC or bridged substitute is silently assumed. The empty user-owned EVM wallet does not select a deposit/conversion/custody route.                                                                                                                                                                     |
| R22 | Deterministic quote/expiry/fees plus prior actual finalized canonical Base Sepolia receipt/finality acceptance are recorded. All live multichain quote, fee, settlement and reversal/finality contracts remain pending provider selection.                                                                                                                                                          |
| R23 | Canada is conditional on actual activity/province/age/identity/retention review. No written provider/activity eligibility acceptance exists; live province permissions remain disabled.                                                                                                                                                                                                             |
| R24 | Finite source-specific treasury admission, worst-case reserve and concurrency checks pass local PG. The approved 50-USDC promotional budget remains unfunded/unallocated; purchased backing cannot fund promotional profit or virtual principal.                                                                                                                                                    |
| R25 | YES/NO integration, two Toronto business-day manual review target and no-cutoff evidence-based error rules are approved. The target is not an automatic holiday/deadline engine and never automatically releases reserves. Provider-specific recovery execution and live staffing remain open.                                                                                                      |
| R26 | Confirmed simulation funding and exactly-once funded issuance pass current local gates; prior real 6-test-USDC app-ledger deposit is separately recorded. No live five-network funding acceptance is inferred.                                                                                                                                                                                      |
| R27 | Welcome 2,500 YC and explicit 500-YC Toronto-day claims/independent grant IDs pass exactly-once concurrency tests. No retained hosted account was automatically initialized, and no real grant backing was allocated.                                                                                                                                                                               |
| R28 | Grant FIFO/principal-first spending, actual-cost allocation, proportional source profit/loss, profit-first intra-grant losses, largest-remainder residuals, independent net targets and permanent qualification pass source/PG review. Closing-time then UUID order prevents request-timing qualification changes. Losses/spending are never restored by qualification.                             |
| R29 | Virtual YC_PROMO principal is separate from funded USDC profits and cannot replenish cash collateral. Available/reserved/pending/promotional/withdrawable projections and backing/reserve tests pass locally. Hosted financial initialization/proof and real backing remain open.                                                                                                                   |
| R30 | Withdrawal proof binds stored request/rail/asset/gross/fee/net/destination/quote; account locks and owner-only review/reservation pass local PG/native gates. Gross 5 with fee 0.1 yields recipient 4.9; there is no daily cap. Genuine hosted and live manual operations remain open.                                                                                                              |
| R31 | Scoped idempotency, immutable external identity, reserved nonce/signed bytes and pending/completed/failed/uncertain states pass local tests. Prior testnet payout reconciled once. Live-provider identity/retry/reconciliation contract remains unaccepted.                                                                                                                                         |
| R32 | Private request-linked reports, append-only evidence review, exact expiring cost consent and funded original-source restoration pass PG/browser review. Consent does not charge or execute recovery. Ordinary losses are final; new compensation categories and completed-purchase refund promises are absent. Outside-app costs/provider recovery remain live-disabled and unresolved, not waived. |
| R33 | Authenticated deterministic inbox, duplicate/conflicting/out-of-order events and reconciliation pass locally; actual prior canonical chain receipts are distinct. Selected multichain provider sandbox acceptance remains open.                                                                                                                                                                     |
| R34 | Account/book/journal locks, one-use proof, nonce/receipt uniqueness, race tests and reconciliation-before-release pass local gates. Uncertain/failed external outcomes never free funds merely by time or retry. Live provider outcome acceptance remains open.                                                                                                                                     |
| R35 | Historical nonredeemable play, simulation, physically isolated Base testnet and live namespaces remain separated; runtime live writes are denied. Wallet provisioning creates neither YC nor redeemable liability. Latest hosted zero-live inventory remains its dated preflight, to be repeated after release.                                                                                     |
| R36 | Deterministic UI, separate testnet adapter and live-disabled routes are clearly distinguished. No mocked adapter or new wallet address is claimed as financial/provider acceptance. All live release gates remain open.                                                                                                                                                                             |
| R37 | Real two-process Redis tests pass three purpose/account/environment budgets, exact atomic throttling and HMAC privacy. Hosted single-instance checks do not prove hosted multi-instance capacity. PostgreSQL remains authoritative.                                                                                                                                                                 |
| R38 | Real local connection/command timeouts, outage/OOM and fail-closed purpose scopes pass; logout/revocation independence is separately covered by app tests. No hosted outage drill is claimed.                                                                                                                                                                                                       |
| R39 | Real local noeviction, restart, bounded queues and aggregate latency/error/throttle metrics pass. Resets still erase abuse counters and cannot secure financial history. Hosted raw INFO/capacity remains unavailable; the earlier hosted Lua/policy probe is its own limited evidence.                                                                                                             |
| R40 | Four selected account deletions and retained/manual preservation remain scoped. Current read-only preflight records four accounts, three retained, zero live history and two pending migrations. No additional deletion is authorized. New release needs encrypted backup/rehearsal/postflight.                                                                                                     |
| R41 | Disposable signed stale-password/wallet/cookie/delayed-callback reproduction passes. Original pre-reset hosted credentials are unavailable, so original hosted replay remains an explicit limitation.                                                                                                                                                                                               |
| R42 | Current automated clusters use synthetic identities and clean up disposable environments. This reviewer created no hosted identity. Future genuine trial identities must be tracked before any narrowly authorized cleanup.                                                                                                                                                                         |
| R43 | Final current local quality/isolation/core browser gates pass854/235/17/5 with zero skips. Exact-source CI and final guarded deployment remain pending; no old CI result is inherited.                                                                                                                                                                                                              |
| R44 | Current SDK111/native18/coin22/cookie7 plus provider phase11/wallet12/recovery4 PG cases establish their explicit local boundaries. Genuine provider behavior, all five routes and devices remain open.                                                                                                                                                                                             |
| R45 | Keyboard, cancellation focus, announcements, mobile, axe tags and 200% layout zoom pass scoped automation. The actual wallet retry Tab test did not justify forced focus. Full WCAG2.2AA, screen-reader and physical-device acceptance are unverified.                                                                                                                                              |
| R46 | Automated/native virtual tests are explicitly separate from screen-reader/device evidence. The earlier screen-reader attempt was incomplete; a reported physical prompt is partial evidence, not a full device journey.                                                                                                                                                                             |
| R47 | Signup/auth/resend/provider/recovery metrics use bounded labels; private headers/provider bodies/credentials are excluded. Real delivery, latency and population completion/recovery outcomes require genuine hosted measurement.                                                                                                                                                                   |
| R48 | Runtime/owner credentials, TLS, private config/output, explicit operator commands and logging boundaries are preserved. New helper20 offline/strict review passes. Final source/artifact scan, encrypted backup/rehearsal and release postflight remain required; advisor access remains unavailable.                                                                                               |
| R49 | Focused commits and existing PR42 are preserved; current source/evidence still needs final commit/PR refresh, exact CI, deployment and release archive. Matching images and operational instructions exist.                                                                                                                                                                                         |
| R50 | This new52-row independent audit preserves the old audit, corrects unsupported inheritance and links dedicated reviews. No remaining independently actionable product defect was identified in this pass; final CI/release and external acceptance prevent task completion.                                                                                                                         |
| R51 | Transactional one-user EVM enqueue, immutable subject/external ID, explicit user-only ownership, finite leases, reconcile-before-retry and private status/retry UI pass transport8/PG12/SDK111. The read-only provider verifier is reviewed/offline-tested only. Genuine wallet creation/default recovery and final hosted release remain pending.                                                  |
| R52 | New external wallet UI/backend linking and unknown registration are disabled while retained sign-in/removal/final-method protections pass real PG/strict browser tests. Genuine hosted/physical retained-wallet acceptance remains open.                                                                                                                                                            |

## Claims corrected or still actionable

The earlier source findings—asset-bearing DID recovery, owner-retry selector
lock ordering, stale Settings continuations and duplicate SSR wallet status—now
have corrected source and actual scoped local regressions. No further product
change is requested by this audit. The governing matrix still had old92/198/798
counts and pending-final-SDK wording when first read; the lead is refreshing
those to the actual current evidence rather than treating old results as new.

The remaining independently actionable work is final PR/commit hygiene,
exact-source CI, the guarded staging backup/rehearsal/migration/release and its
read-only/provider/public postflight, followed by genuine credential/key/wallet
and device acceptance where access allows. External live activity/custody,
five-network provider, Canadian eligibility, funding/treasury, all-strong-lost
recovery and provider-specific cost recovery cannot be manufactured from local
PASS results. They must stay visibly open. No live money movement, additional
account deletion, paid plan or transaction signing is authorized by this audit.

## Same-day post-a970 finding

After this pre-release audit and the a970 CI launch, the lead identified a wallet
retry-budget gap: waiting for accepted credentials could exhaust attempts before
first-key setup completed. Release was paused; no staged provider/migration
mutation was performed for that release. The earlier no-finding statement above
remains the observation at its recorded source, not a claim that this later
finding never existed.

The correction and the central confirmed-reset wake hook were independently
reviewed, with exact new hashes and source/test reasoning appended to the
[wallet review](embedded-wallet-review/README.md) and
[phase review](provider-control-phase-review/README.md). No blocking issue was
found in that narrow source pass; new PG/integrated execution and exact-source
CI are pending at this addendum. R10/R15/R17/R43/R44/R50/R51 must use those new
results before their next release claim. Unchanged served frontend assets retain
their earlier UI evidence; changed backend fingerprints cannot inherit an old
executed-backend PASS without appropriate new verification. Genuine provider,
device, live eligibility and funding gates remain open throughout.

## Dated post-correction local acceptance — 2026-10-21

The reviewer has now inspected actual [new combined/native evidence](wallet-verification-pause/README.md):
**858/858**, zero skips, coverage **95.32/91.22/95.35%**; **239/17/5** on each
fresh and upgrade path, **15 wallet** and **12 phase** cases, and a new
**18-group native** pass. The 62 archive hashes, eight supplementary
source/compiled hashes, 35 native hashes and all five raw/formatted JSON semantic
pairs were independently verified. The previous 23-file native leaf remains
byte-identical to its earlier a970 snapshot.

Commit `2efc95cff5f112653a392ba4e8edbaf9ef2ec557` matches the exact three
backend/two-test correction files. Commit
`ce85b4abf9487f28147f2036cd801c6c8d4ea420` matches the new retained-wallet
verifier tested separately by this reviewer in controlled RED/GREEN isolated
clusters. The original failing assertion assumption is deterministically false
while account refresh is held; the corrected verifier passes its unchanged four
groups after actual refresh. The integrated run's earlier verifier hash is
explicitly retained rather than attributed to that focused result.

The previous **a970 CI failed integration** while its other four jobs passed;
[its exact merge/branch tree and failure evidence](wallet-phase-ci/a9706cc/README.md)
are preserved. The suppressed original error line is not invented. A new
exact-tree five-job CI run, guarded staging release and provider/public
postflight are still required. The SDK111 and coin22 frontend assets remain
unchanged; their original records are not relabelled as new runs. No open genuine
provider, device, eligibility, custody, route, funding or live-release criterion
is closed by this local addendum. R10/R15/R17/R43/R44/R50/R51 now have the new
local correction evidence; their external and release boundaries remain open.
