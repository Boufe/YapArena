# Independent requirement audit — deployed correction and remaining acceptance

Reviewed on 2026-10-20 through exact release `d6e2d355da255e03c257802c890c036c4d572a62`,
its five successful CI checks, guarded corrective staging release and guest browser
acceptance. This covers all 50 rows in [the completion contract](../../email-first-completion.md);
it does not establish genuine signed-in provider or live-financial acceptance. The latest founder instruction supersedes new enrollment
of an independent YapArena key: enroll once through Privy and use that same
credential for fresh application assertions. Retained legacy keys are preserved.

The task remains **incomplete**. Distinguish these evidence boundaries:

- The first full local/CI release and guarded staging deployment at `9395242`
  passed before the Privy-only changes. Its artifacts remain separately dated.
  The named staging web service now serves exact `d6e2d35`; the independent
  Render observation and matching hosted assets establish their separate scopes.
- The new same-key implementation passes the R2 complete local gate: **798/798**,
  zero failures/skips, coverage **95.29% lines / 91.24% branches / 95.19%
  functions**, unchanged 90% thresholds; **198/198** account cases on both
  fresh/upgrade paths, **17/17** A4 and **5/5** separate treasury cases each.
  Later focus/copy refinements passed the final build, 92 SDK groups, 18 native
  groups, 22 finance groups and seven cookie-coordination groups at their recorded
  hashes. Final CI passed all five checks at `d6e2d35`, also 798/zero-skips; its
  branch coverage was **91.23%**, distinct from the local **91.24%**.
- The corrective release encrypted/restored 83 tables and 15 sequences, rehearsed
  then applied only migrations 12000/13000. Postflight found **43 applied / 0
  pending**, four preserved accounts, three retained accounts, zero live history
  and matching provider generations. The new hosted guest run passed **7/7**
  with 14 matching assets; it sent no OTP and exercised no signed-in operation.
- Actual Privy enrollment, exported-key/RP compatibility, returning login and
  recovery remain unverified. Intercepted provider responses are not provider
  acceptance. Physical-device and screen-reader acceptance are also open.

A post-deployment independent review confirmed an additional **P2 Settings actor
race**: a held provider-change response for account A could invoke the provider
SDK after the browser had changed to account B. Stale private-email state and an
unscoped OAuth marker also require correction. These flows were not covered by
the passing 92-group fixture. The follow-up frontend fix, new regressions,
integrated checks and exact-revision redeployment remain actionable; the deployed
`d6e2d35` correction is not final acceptance of account management.

The reviewer inspected source, actual structured results and raw logs rather
than accepting worker reports as evidence. Each artifact's source, generated
asset and runtime hashes govern its scope; counts from different runs are not
combined into a new result. The reviewer authored the provider adapter and key
bridge; separate lead/Redis review covers those modules. This checklist audit is
not their sole independent security sign-off.

## Requirement-by-requirement findings

“Local” means disposable environments and synthetic identities unless a row
expressly identifies actual chain, Cloud or named staging evidence. The lead's
matrix retains owners, dependencies and acceptance criteria; this table records
the independent finding and remaining gate.

| Item | Independent finding and remaining acceptance boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R01  | Existing branch/PR #42 work and fetched-main baseline were preserved. Exact final `d6e2d35` passed all five CI checks; independent Render GET observed that web revision LIVE. Fourteen served asset hashes match the selected local build. Server revision and served-byte evidence are distinct.                                                                                                                                                                                                     |
| R02  | Governing PRD, A4, financial, auth/security, Redis and operating requirements were reviewed. Historical reports remain revision-specific; the new credential policy supersedes separate-key enrollment UI.                                                                                                                                                                                                                                                                                             |
| R03  | Lead-maintained owner/dependency/criteria/evidence matrix and categorized decision log exist. The first release and deployed Privy-only correction remain separately recorded; genuine provider/device and live-financial acceptance remain incomplete.                                                                                                                                                                                                                                                |
| R04  | Shared theme/header and public discovery/watching remain. Historical matched SDK/component/hosted screenshots and final full-page SDK settings screenshots exist. Six current hosted guest screenshots were inspected; genuine signed-in hosted acceptance remains open.                                                                                                                                                                                                                               |
| R05  | Genuine manual email signup was preserved. The real returning attempt exposed a reset-state failure; guarded repair completed, but successful genuine returning login has not been observed.                                                                                                                                                                                                                                                                                                           |
| R06  | Privy owns email codes; no duplicate OTP lifecycle exists. Fixtures cover send/wait/submit/resend/error/cancel/paste and interrupted responses. Genuine delayed/expired/used-code behavior and OS autofill remain unverified.                                                                                                                                                                                                                                                                          |
| R07  | Installed-SDK and actual two-tab HTTP/Web Locks tests cover initialization, no signed-out flash, duplicate submit, refresh/back, delayed replies and cookie ordering. The current 14-issuer coordinator and 92-group SDK run passed at their recorded hashes. Later independent review found an uncovered Settings actor race; follow-up controller/regression acceptance is required.                                                                                                                 |
| R08  | Actual Free DEV Google/passkey settings are enabled, confirmed by genuine public provider metadata and current hosted flags; merging and embedded wallets remain off. Local settings register or activate the same Privy credential. Genuine enrollment, exported-key availability, RP compatibility and returning Google/passkey login remain open.                                                                                                                                                   |
| R09  | Local page/query/fragment return, drafts and fresh mutation confirmation have SDK evidence, including matching/inline actor races. A later confirmed Settings provider-change response can cross a browser account change; stale email/OAuth intent also needs an actor fence. Correct that flow and rerun the new assertions before claiming safe integrated return/action acceptance.                                                                                                                |
| R10  | Transactional DID provisioning, stable IDs, one-use SID and generation fences passed PostgreSQL races. New bootstrap passed the R2 suite. Browser IDs/email text never establish ownership or merge accounts.                                                                                                                                                                                                                                                                                          |
| R11  | Retained-proof email/method changes and legacy new-DID recovery exist; Privy-origin keys cannot authorize legacy replacement or independent app-key login. Narrow interrupted-first-setup restart passed R2. A newly found Settings actor race requires frontend correction and regression tests; genuine hosted management/recovery and provider-approved all-strong-lost service remain open.                                                                                                        |
| R12  | Retained reconciliation requires independent retained proof and verified provider evidence; matching email never merges. Real PG covers bound/retired replacement DIDs and permanent old-DID tombstones. Genuine hosted retained-account linking remains open.                                                                                                                                                                                                                                         |
| R13  | Purpose-specific SIWE, exact target-wallet ownership, final/retained-method checks and revocation races remain. Provider-first wallet integration preserves these guards. Hosted/physical wallet ceremonies remain unverified.                                                                                                                                                                                                                                                                         |
| R14  | Free DEV mode, 150-user cap, public flags, default development Google credentials and provider settings were inspected. Official production domain/cookie/sender/pricing requirements are documented. Production-owned Google setup, sender entitlement and numeric production rate capacity remain unverified.                                                                                                                                                                                        |
| R15  | Actual public metadata confirms automatic Ethereum/Solana wallets off. Ordinary signup does not depend on provisioning. No embedded-wallet custody/recovery capability was enabled.                                                                                                                                                                                                                                                                                                                    |
| R16  | Proof binds account, original cookie/generation, purpose, nonce, expiry and terms. The same trusted Privy COSE key signs a separate UV assertion; token refresh/iat/frontend flags do not authorize it. Real cryptographic/PG/native results exist; final native browser proof passed; genuine hosted proof acceptance remains open.                                                                                                                                                                   |
| R17  | Current/other/specific/all-session revocation, suspension and stale-token fences passed SQL/HTTP races. Genuine uncertain reset was finalized without deleting history or bypassing cutoff. Successful genuine login/current hosted revocation remain separate.                                                                                                                                                                                                                                        |
| R18  | Protected requests inspect provider credentials/key fingerprints outside pool/locks and fail closed. Exact pending additions deny ordinary access; other deltas still revoke. R2 passed own-reset inspection-failure regressions without false cookie revocation. Production rate capacity and actual hosted credential-change acceptance remain open.                                                                                                                                                 |
| R19  | Actual local HTTP logout queued PG revocation; separate worker pool removed a real Cloud speaker and denied original/server-refreshed tokens while viewing remained available. First staging rollout completed a conservative drain and zero seat/room observations. Neither is a genuine named-staging logout or physical media trial.                                                                                                                                                                |
| R20  | Source/copy review follows later approved terms: no daily cap, fee inside gross, completed purchases exit through USDC withdrawal, no purchased-fund qualification. These supersede original cap/refund terms. Live approval remains absent.                                                                                                                                                                                                                                                           |
| R21  | All five requested networks remain tracked. NOWPayments is an investigation candidate, not an approved custodian. Written acceptance for the personal operator, activity, custody/signing and account-specific routes is required.                                                                                                                                                                                                                                                                     |
| R22  | Simulated conversion quotes and real canonical finalized Base Sepolia USDC receipts exist. Live multichain quotes, expiry, fees, settlement/reversal guarantees remain unverified. Native USDC was not assumed on Bitcoin/BNB.                                                                                                                                                                                                                                                                         |
| R23  | No Canadian activity/province/age/KYC/retention approval exists; live eligibility remains empty. Written structure-specific review and provider acceptance are required; another platform's policy cannot substitute.                                                                                                                                                                                                                                                                                  |
| R24  | Separate worst-case promotional exposure is reserved before admission; solvency races passed. The 50-USDC real budget is unfunded/unallocated. Purchased backing cannot finance promotions or erase earned claims.                                                                                                                                                                                                                                                                                     |
| R25  | Two Toronto-business-day manual review target, no-cutoff reports, evidence-based corrections and YES/NO sandbox integration are approved. Network time is separate; no automatic holiday deadline is claimed. Provider recovery execution/live staffing remain open.                                                                                                                                                                                                                                   |
| R26  | Complete simulated funding/quote/issuance workflows passed. A new actual 6-test-USDC receipt funded a separate app ledger once. No live five-network conversion/funding acceptance exists.                                                                                                                                                                                                                                                                                                             |
| R27  | Exactly-once welcome/explicit Toronto-day grants and source lots passed races/native checks. No retained hosted account was seeded. Real backing is unfunded; final 22-group financial UI/proof rerun passed.                                                                                                                                                                                                                                                                                          |
| R28  | Exact source spending, principal-first grant stake, profit-first loss, proportional mixed results, residual allocation and sticky qualification passed local tests/review. Closing-time/UUID ordering prevents earlier profit qualifying later lots.                                                                                                                                                                                                                                                   |
| R29  | Available/reserved/pending/purchased/promotional/withdrawable projections are separate; grant principal is not cash collateral. Real treasury admission is distinct from simulation seeding. The current 22-group finance run and matching screenshots pass at final source/asset hashes.                                                                                                                                                                                                              |
| R30  | Exact gross/fee/net/destination/asset proofs, transactional reservation and owner-only review have local and actual-testnet app-ledger evidence. Updated coin browser retains 22 assertions. Genuine hosted proof/live operations remain open.                                                                                                                                                                                                                                                         |
| R31  | Scoped idempotency, immutable signing identity and pending/completed/failed/uncertain states exist. Unknown outcomes keep reserves. Selected live-provider duplicate/reconciliation guarantees remain unverified.                                                                                                                                                                                                                                                                                      |
| R32  | Append-only receipts/reports/reviews, original-source correction, funded operator restoration and consent-only proof passed SQL/browser checks. Consent causes no charge/recovery execution. No original-route completed-purchase refund is promised; live recovery ability is unverified.                                                                                                                                                                                                             |
| R33  | Authenticated deterministic inbox, duplicate/out-of-order events and owner reconciliation passed. Real finalized testnet logs are separate evidence. No maintained multichain conversion-provider sandbox acceptance exists.                                                                                                                                                                                                                                                                           |
| R34  | Account/book locks, one-use proofs and unique nonce/hash/bytes/receipts prevent tested duplicate issuance/reservation/payouts. Actual uncertain payout kept its original hash/reserve until finality; no replacement was signed. Live-provider uncertainty remains separate.                                                                                                                                                                                                                           |
| R35  | Historical YAP, simulation, separate testnet DB, live environment and purchased/promo/fee/operator backing are isolated. Runtime SQL cannot approve/sign withdrawals or create live history. Corrective 43-migration staging postflight found zero live journals/lots and no browser private-table grants.                                                                                                                                                                                             |
| R36  | Simulation, actual valueless chain, provider and live labels are explicit. No paid plan, live transaction, funding or live liability was enabled. Combined pre-funds/provider/legal/security gates stay open.                                                                                                                                                                                                                                                                                          |
| R37  | The new actual 10-group Redis trial uses two Node processes sharing atomic IP/account/operation limits and the two Privy-passkey purposes, with private HMAC namespaces. One staging web service does not establish hosted multi-instance topology/capacity.                                                                                                                                                                                                                                           |
| R38  | The new 10-group Redis run retained closed-port/stalled/paused/OOM/retry/restart faults; both new attempt purposes returned 503 during outage. Logout/revocation stays independent. No hosted outage drill occurred. PostgreSQL remains authoritative; no auth cache or duplicate OTP state was added.                                                                                                                                                                                                 |
| R39  | Current hosted guest probe at `d6e2d35` returned the fixed retired-register 410 and increased Redis success/latency aggregates 0→1. One cold aggregate observation was 0.53876 s. This proves the code-enforced noeviction/Lua path behavior, not per-request tracing/raw INFO or hosted restart/outage/multi-instance acceptance. Local new-scope tests passed separately.                                                                                                                            |
| R40  | Both staging releases preserved three retained accounts plus the manual signup, selected reset IDs absent and live activity zero. Reset remains an explicit guarded command, never startup behavior. No additional account deletion occurred.                                                                                                                                                                                                                                                          |
| R41  | Disposable signed delayed-callback/password/wallet/cookie reproduction rejects deleted identities and preserves a retained fixture. Original hosted credentials are unavailable; reproduction remains correctly labelled.                                                                                                                                                                                                                                                                              |
| R42  | Local browser/PG fixtures self-clean. Reconciled actual-chain cluster is stopped with private history retained. These verifiers created no hosted identities; future genuine acceptance identities require tracking/scoped cleanup.                                                                                                                                                                                                                                                                    |
| R43  | Final exact-head CI passed all five required checks: 798 tests, zero failures/skips, 198 account PG cases fresh/upgrade, 17 A4 and 5 separate treasury cases each, plus actual community/replay/container and core browser gates. GitHub tested merge tree equals the pushed `d6e2d35` tree. Local R2 and CI coverage remain separately recorded.                                                                                                                                                      |
| R44  | Meaningful failures/races remain asserted; 90% thresholds unchanged. Challenge encoding, numeric report order, owner SQL boundary, cookie sequencing and own-reset monitor defects have regressions. R2 executed new bootstrap/monitor cases, not merely static test authorship.                                                                                                                                                                                                                       |
| R45  | Historical finance/recovery and new 18-group native exercise real WebAuthn, focus/replay/cross-account checks. SDK tests separately cover UI/a11y. New minimal SDK screenshots are scaffolds, not whole-product parity. Final 18 native, 22 finance, 92 SDK and 7 cookie groups passed at current recorded hashes; CSS zoom is not native-menu zoom/full conformance.                                                                                                                                  |
| R46  | No physical-device or successful screen-reader trial exists. VoiceOver attempt disturbed OS state; native OS/CUA work stopped as instructed. Human/device acceptance remains incomplete.                                                                                                                                                                                                                                                                                                               |
| R47  | Bounded auth/resend/provider/recovery metrics and log redaction exist. Fixture timing is not genuine conversion/delivery/error rates. Genuine hosted journeys are required for those measurements; credentials/signatures/private terms stay out of metrics.                                                                                                                                                                                                                                           |
| R48  | Fixed-target strict TLS owner/runtime helpers actually suspended both writers, verified public 503/runtime quiescence, encrypted 83 tables/15 sequences, restored exact fingerprints and rehearsed only 12000/13000 before owner application. Postflight found 43 applied / 0 pending, four accounts/three retained, zero live journals/lots, matching generation and no manual/pending reset jobs. Supabase security/performance advisors were permission denied; no clean advisor report is claimed. |
| R49  | Focused commits and reviewable PR #42 are preserved. Exact `d6e2d35` passed CI, backup/rehearsal/migrations, deployment and seven guest checks; original939 evidence is separately dated. A newly confirmed Settings actor race requires a subsequent tested corrective revision and redeployment. Genuine selected-app and external production/live-financial gates remain open.                                                                                                                      |
| R50  | All 50 rows were audited against source and actual evidence. Separate reviews cover security/financial transitions. Local, CI, named-hosted guest, actual testnet and Cloud boundaries are explicit; neither the deployed correction nor this audit declares overall task completion.                                                                                                                                                                                                                  |

## Evidence inspected and its limits

The [archived R2 gate](privy-passkey-integrated/README.md) matches the actual raw log byte-for-byte. All **233** archived backend/migration/test source hashes still match the current checkout. The R2 actual raw log is
`/private/tmp/yaparena-privy-only-core-release-r2.log`; its terminal result is
`/private/tmp/yaparena-privy-only-core-release-r2/result.json`. Direct inspection
confirmed the quality 798/zero-skips/coverage summary, both 198-case fresh/upgrade
blocks, 17 A4 and 5 separate treasury cases each, and final `Browser release gate
PASS`. New 10-case first-setup restart and own-reset failure/valid-change monitor
groups actually passed. This is local PostgreSQL 17.10 and synthetic browser/media
evidence. The archive identifies its uncommitted worktree boundary rather than claiming a clean-commit run.
Later copy/focus changes are outside this result until their separate build/tests.

The [earlier full local gate](final-integrated-release-gate/README.md) passed 739
at `63eada6`, and [five required CI checks](ci-release/README.md) passed at `9395242`.
The [guarded first staging release](staging-release.md) actually suspended both
writers, encrypted 62 tables/13 sequences, restored exact fingerprints and rehearsed
the then 13 pending migrations before owner application. Postflight recorded 41
applied, four preserved users and zero live financial history. Full conservative
token drain was followed by zero seats/rooms. The
[dated hosted guest result](account-hosted-browser/9395242/acceptance.json) passed 7
groups with matching served assets and aggregate Redis observation; it sent no
OTP and created no identity.

The [final five-check CI archive](privy-passkey-ci/README.md) identifies exact
head `d6e2d35`, run 39483112893 and terminal success at 19:45:38 UTC. Actual raw
quality/integration logs were inspected: 798 tests, zero failures/skips, coverage
95.29% lines / 91.23% branches / 95.19% functions, 198 account cases on each path,
17 A4 and 5 treasury cases each. Community delivery, replay, container and browser
steps succeeded. GitHub's tested merge commit `1b515f3` has the same tree as the
pushed head; this is not an unsupported claim that its checkout SHA was the head.

The corrective release evidence is separate from the first release:
[suspension](privy-passkey-release/render-account-suspend.json) and an
[independent public 503](privy-passkey-release/stopped-health.json) preceded the
[new prepare](privy-passkey-release/staging-release-prepare.json) and
[owner migration](privy-passkey-release/staging-release-migrate.json).
The encrypted 83-table/15-sequence snapshot restored exact fingerprints and
rehearsed the two additive migrations before hosted application. Runtime nonidle
sessions were zero. [Immediate post-migration inventory](privy-passkey-release/staging-database-post-migrate.json)
recorded 43 applied / 0 pending, four accounts/three retained, selected-reset identities
absent, no live journals/grant lots, no runtime ownership/browser private grants,
and provider generation match with one completed reset and no manual/pending job.
The [independent Render observation](privy-passkey-release/render-first-live.json)
then confirmed exact `d6e2d35` web LIVE; replay remained unchanged `fd60543`.
The [post-live PostgreSQL inventory](privy-passkey-release/staging-database-postflight.json)
again confirmed 43 applied / 0 pending, four accounts / three retained, zero live
history, matching generations and a completed reset.

The [frozen hosted guest result at `d6e2d35`](account-hosted-browser/d6e2d35/acceptance.json) passed
seven groups at 20:05:57.404 UTC in 11.694 s. All eight source/runtime and 14 served
asset hashes were recomputed against the current tree with no mismatch. Actual
public provider metadata confirms email/Google/passkeys enabled, automatic wallets
and email merging off. Both guest account navigations returned 200 through the
service worker without redirects; five protected routes returned 401/no-store and
no application-auth cookie. All six desktop/mobile screenshots were inspected;
the existing measurement prompt is visible on home/account captures. The guarded
retired-register request returned 410 and Redis success aggregates rose 0→1 with
one 0.538760864 s cold observation. These are aggregate/code-path facts, not a
per-request trace or hosted fault/multi-instance drill. No OTP, OAuth/passkey
ceremony, identity creation, signed-in action or media join was attempted.

The [Supabase advisor attempt](privy-passkey-release/advisor-check.json) was
read-only but both security/performance requests were permission denied
(MCP-32600/INVALID_ARGUMENT). Direct strict-TLS catalog checks are alternative
limited evidence, not provider advisor clearance; no additional access was sought.

The genuine returning-user failure was not a changed email: accepted/current
methods matched, but reset generations were fenced. [The repair record](provider-reset-repair/README.md)
preserves Activity-log review, one guarded unfreeze and delayed confirmation,
followed by GET-only database finalization. [The independent postflight](provider-reset-repair/after-finalize.json)
shows matching generations, preserved cutoff, explicit unfrozen provider state
and completed job. That repair is not a successful genuine login/passkey trial.

The [same-key protocol/PG result](privy-passkey-bridge/README.md) passes 179 each
path with synthetic provider evidence, real signatures and actual role-backed PG.
The later reset-focused 185-case result is distinct from R2. The
[18-group native run](security-passkey-browser/privy-only/README.md) uses installed Privy
React SDK, native WebAuthn virtual CTAP2, registration-derived COSE, actual router
and PG. Desktop registers one fixture key; mobile activates an existing one;
the exact same key signs a consumed operation proof. All 18 passed again at
19:12:17.153 UTC after the final focus/copy build, with exact source/asset/dist
hashes. The stale load notice is gone and empty/provider-only legacy controls
are hidden. Provider/token responses are intercepted;
minimal scaffolds do not establish full-page parity or real provider acceptance.

The [actual chain ledger trial](../coin-testnet/ledger/README.md) reconciled 6 new
test USDC in, 5 out, 1 app liability and separate old 4 unallocated custody float.
Finalized canonical logs and immutable pre-broadcast signing identity were checked;
unknown finality did not release reserves or replace the payment. This is Base
Sepolia evidence, not conversion, live custody or Canadian eligibility.

The [application-to-Cloud report](media-app-cloud-revocation/acceptance.json)
passed local HTTP logout, durable PG outbox, separate worker pool and actual
Cloud original/refreshed-token denial with public viewing preserved. Automatic
expiry took 51.406 seconds; combined conservative usage 180,000 participant-ms stayed
under founder-confirmed five included minutes. [Independent review](media-app-cloud-review.md)
records corrected cleanup/timing boundaries. No AV/egress/recording was used;
this is not a genuine hosted Privy logout or physical-media trial.

The [new isolated Redis 10-group result](../redis-acceptance/privy-passkey-scopes/README.md) uses Redis 7.4.11 in a verifier-owned Docker container and two independent Node HTTP workers. Both `provider.passkey.link` and `provider.passkey.restart` yield exactly 2 allowed/18 throttled from 20 concurrent attempts, with account/purpose/environment separation and opaque expiring keys. Both scopes fail 503 during outage. All ten check groups and both current source hashes were inspected; this is nonhosted behavior with synthetic principals, not PostgreSQL-session or provider acceptance.

The [final 92-group SDK result](single-privy-passkey-browser/browser-results.json) completed at 19:21:29.650 UTC with zero errors or requirement failures. All 17 served-asset and 4 source/compiled-renderer hashes match the current tree. The [final 22-group finance result](coin-sandbox-browser/results.json) completed at 19:12:34.149 UTC; all 31 recorded source/asset/runtime hashes match, with no browser/accessibility errors. The [seven-group cookie trial](single-privy-passkey-bootstrap-cookie-browser/results.json) includes the 14 current cookie issuers; its actual helper source/asset hashes are unchanged. Full mobile settings and desktop first-setup restart confirmation/completion screenshots were inspected: one ready Privy key, no second enrollment section, clear new-key review and usable controls. Provider/application responses remain synthetic in the SDK fixture; the finance fixture uses actual runtime PostgreSQL and labelled deterministic balances. None establishes genuine hosted identity or financial acceptance.

The [separate independent bridge/policy/restart review](single-privy-passkey-review/README.md) covers the authored bridge with all six current source hashes verified. Its static review is distinct from actual protocol/PG/native execution. The recorded SDK dependency-advisory scope in [the authentication review](auth-independent-review.md) is not cleared by functional test success.

## Remaining actionable acceptance and handoff

1. Finish the confirmed Settings actor-fence correction, cover held previous-account
   provider responses, private-email clearing and account-bound OAuth intent, then
   run appropriate integrated/SDK checks, CI and exact-revision staging acceptance.
   Preserve the current passing evidence at its historical hashes.
2. Complete a founder-authorized genuine existing-account login and same-Privy-key
   setup/returning-login/fresh-proof ceremony directly in provider UI. Never request
   credentials, OTPs or assertions in chat. If unavailable key export or incompatible
   RP prevents verification, preserve the failure and keep the capability disabled.
3. Finish the lead's final status/runbook/PR #42 evidence update and integrated
   secret/private-data review. Keep the corrected release and original 939 records
   separate; do not turn guest acceptance into a signed-in completion claim.
4. Resolve the provider/legal/production/device dependencies below before their
   corresponding acceptance or live-release gates can close. Earlier CI and
   browser evidence remains valid at its recorded source boundary; it does not
   include the newly required Settings correction.

## Verified external gaps and smallest next action

| Gap                                     | Evidence and smallest action                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genuine selected-app credential support | GET-user documents optional public keys; actual selected-app key export/RP/returning ceremony has not passed. The corrective deployment is now live; perform a founder-authorized genuine existing-account or tracked disposable ceremony directly in provider UI. Missing export/RP support must fail closed. |
| Live custody/five-network conversion    | No written activity/operator/custody approval or authenticated accepted-route trial exists. Founder can send the prepared [NOWPayments packet](../../nowpayments-eligibility-questions.md); obtain written terms before selecting integration. Unmaintained sandbox cannot substitute for live acceptance.     |
| Canadian age/province/KYC/retention     | No qualified activity-specific review exists; live allowlist remains empty. Obtain written activity/province/age/identity/retention decisions and provider acceptance. Generic 18+ or competitor rules are insufficient.                                                                                       |
| Promotional treasury                    | 50 USDC is approved budget but unfunded/unallocated. No live reward liability may be promised before separate backing and pre-funds gates. No live funding is requested or performed here.                                                                                                                     |
| All stronger methods lost               | Physical loss is not detected or converted automatically to a hold. Ordinary email access may remain; retained-proof actions are inaccessible and email cannot reset keys. A selected provider-approved identity-review recovery service remains unimplemented.                                                |
| Provider reset authority                | No conditional freeze/unfreeze ownership API is established. Application jobs are fenced, but an independent dashboard mutation can race provider control. Production must resolve/enforce the documented single-writer/operator policy; no automatic account-merge or generation bypass is an alternative.    |
| Production auth setup                   | Own-domain/cookie setup, owned Google client, sender entitlement and numeric rate capacity are separate from staging Free DEV settings. Complete necessary secure provider setup without unapproved paid upgrades.                                                                                             |
| Hosted Redis topology/outage            | One hosted web service plus behavioral Lua probe does not establish hosted multi-instance/outage capacity. Local two-process/fault evidence remains valid; an additional hosted drill needs isolated scope/topology.                                                                                           |
| Physical/assistive acceptance           | Virtual CTAP2, viewport emulation, axe and CSS zoom are not physical-device or screen-reader output. Human/device trials remain needed; native OS automation is not authorized.                                                                                                                                |
| Original pre-reset credentials          | Original browser credentials are unavailable. Approved disposable signed replay reproduction remains the available correctly labelled evidence.                                                                                                                                                                |

Live money stays disabled. The overall task remains explicitly incomplete.
