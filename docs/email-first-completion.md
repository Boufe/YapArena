# Email-first completion contract and decision log

Execution baseline: `feat/email-first-accounts` at `03ecffb`, clean on inspection,
15 commits ahead / zero behind fetched `origin/main` (`fd60543`). PR #42 is the
existing draft; all five required checks passed for that baseline. Preserve its
implementation, retained accounts and genuine manual signup. Recorded staging
revision `f942dc6` needs independent current verification. No live financial
activation, external costs, fund movement or additional account reset authorized.

This is a working requirement matrix. **Open** is incomplete, even when an
earlier foundation exists. Agent reports require independent integration checks.
Owners: lead = integration/financial implementation; auth = account security;
provider = provider/eligibility research; Redis = shared-abuse acceptance;
review = independent reviewer assigned after integration.

## Shared engineering contracts

- PostgreSQL owns stable account IDs, session digest/generation, revocation and
  financial history. Sensitive commits lock account, recheck session, then lock
  operation and relevant financial rows in stable order.
- Fresh proof must bind account, session generation/digest, operation UUID,
  nonce, expiry and immutable terms; consume in the mutation transaction.
  Provider access-token refresh/issuance time and frontend MFA flags do not qualify.
- Existing wallet proof remains purpose-specific SIWE and retained-credential
  approval. No implicit email matching or provider/browser ownership claim.
- Financial identifiers: historical `YAP` stays separate; new accounting uses
  `USDC`, precision 6, atomic integer strings, `sandbox` / `live` environments.
  One YC = 10,000 USDC atomic units. No floating-point authoritative amounts.
- Status vocabulary: pending, completed, failed, uncertain; uncertain payment
  retains its reserve until external reconciliation establishes no payment.
  Idempotency is scoped by environment, owner, operation and immutable terms.
- Logs/metrics contain bounded outcomes and timings, no credentials, signatures,
  raw email/IP, webhook bodies or private financial data. HMAC identifiers only
  where a privacy-reviewed operational purpose requires them.

## Requirement matrix

| ID  | Requirement / acceptance criteria                                                    | Owner         | Dependencies                                    | Status / evidence                                                                                                            | Remaining blocker                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Establish checkout, fetch, PR and deployed revision; preserve existing work          | lead          | access                                          | Verified baseline + fetched main; Render/public readiness independently checked                                              | None for baseline; recheck final hosted revision                                                                                                     |
| R02 | Read governing PRD, plans, security, operations and recorded evidence                | all           | repository                                      | Governing PRD/plans, A4, financial/security/Redis/operations guides read                                                     | Keep later changes consistent with governing sources                                                                                                 |
| R03 | Maintain checklist, decision log, coordinated contracts and ownership                | lead          | none                                            | This document; three parallel workstreams assigned                                                                           | Update throughout execution                                                                                                                          |
| R04 | Preserve public discovery/watch, theme/header and signed-in controls                 | lead          | UI baseline                                     | Theme/header preserved; matched local fixture before/after screenshots recorded                                              | Rerun after new coin/recovery UI and hosted deployment                                                                                               |
| R05 | Genuine Privy primary email-code signup and returning login                          | auth/lead     | provider app                                    | Prior genuine signup report; existing UI                                                                                     | Current hosted returning journey                                                                                                                     |
| R06 | Code lifecycle, paste/autofill, resend, cancellation, errors, delayed delivery       | lead          | Privy capabilities                              | Expanded desktop/mobile fixture verifier passed code/resend/cancel/network states                                            | Genuine hosted delayed/expired code and delivery acceptance                                                                                          |
| R07 | Refresh/back/multi-tab/network/initialization and duplicate-submit handling          | lead          | browser                                         | Fixed document-bound history marker; fixture refresh/back/no-flash/duplicate checks passed                                   | Final combined browser revision and multiple-tab regression                                                                                          |
| R08 | Optional Google and passkey enrollment/returning authentication                      | auth/lead     | provider settings and proof                     | Actual free development app Google/passkey enabled; hosted config confirms both                                              | Genuine hosted OAuth/passkey returning/linking trial                                                                                                 |
| R09 | Minimal onboarding and exact safe local return/action                                | lead          | browser                                         | Existing implementation                                                                                                      | Approved return to initiating action for confirmation; implementation/integration in progress                                                        |
| R10 | Stable transactional identity provisioning, races and callback replay                | auth          | PostgreSQL                                      | DID advisory lock, immutable mapping and SID fences preserved; focused PG exercised                                          | Final combined fresh/upgrade gate                                                                                                                    |
| R11 | Recovery/email changes/method linking/removal                                        | auth          | supported fresh proof, policy                   | Implemented retained-proof exact provider delta reconciliation and discoverable-key recovery; independent source review      | Hosted journey; approved sole-email/Google replacement with retained security passkey in progress; all-strong-lost recovery awaits provider approval |
| R12 | Retained legacy dual-ownership reconciliation, no email-only merge                   | auth          | fresh proofs                                    | Explicit dual-ownership legacy link implemented; already-owned DID rejects manual                                            | Final PG/browser/hosted acceptance; no automatic account merge                                                                                       |
| R13 | Linked-wallet management preserves retained and final-method protections             | auth          | existing F02                                    | Provider-only first wallet uses strong approval plus target SIWE; legacy flow retained                                       | Final combined wallet/security/browser gates                                                                                                         |
| R14 | Cookie/domain/sender/branding/provider limits/pricing verified                       | auth/provider | official docs/settings                          | Actual Free DEV app inspected; 150-user cap; pricing/domain/sender sources recorded                                          | Production app numeric rate capacity/custom sender entitlement unverified                                                                            |
| R15 | Embedded wallets off; ordinary signup independent of provisioning                    | auth          | provider settings                               | Actual app automatic Ethereum/Solana wallets OFF; signup independent                                                         | Recheck final config; no embedded-wallet enablement authorized                                                                                       |
| R16 | Expiring replay-resistant operation proofs bound to exact sensitive terms            | auth/lead     | supported authenticators                        | One-use five-minute operation proofs with exact terms/UV/passkey/password/wallet implemented                                 | Final integrated expiry/replay/concurrency and independent review                                                                                    |
| R17 | Logout current/others/all, suspension, credential revocation and stale-token fence   | auth          | PostgreSQL/provider                             | Owned session listing/revoke, local fences, outbox and uncertain manual fences implemented                                   | Final cross-instance/hosted provider revocation drill                                                                                                |
| R18 | Provider-side credential changes invalidate existing application cookies             | auth          | supported affordable mechanism                  | Server Privy GET per protected request, digest comparison and fail-closed outage behavior                                    | Free production rate allowance and hosted credential-change trial                                                                                    |
| R19 | Open connections, in-flight operations and media grant revocation boundaries         | auth/lead     | media provider                                  | Tracked speaker grants, durable disconnect/retry, takeover/departure fences; actual Cloud original/refreshed token rejection | Final new-revision hosted outbox trial and legacy outstanding-token drain                                                                            |
| R20 | Preserve approved financial terms exactly                                            | lead          | founder prompt                                  | Latest founder overrides recorded: fee inside gross; no daily cap; no purchase refunds                                       | Final code/docs audit for stale financial terms                                                                                                      |
| R21 | Custody/signing/provider routes including all five requested networks                | provider      | actual activity approval                        | Current official NOWPayments/Circle research; all five route candidates tracked                                              | Written actual-activity approval, custody/signing and route selection                                                                                |
| R22 | Quotes/expiry/conversion/fees/settlement/finality/reorg handling                     | provider/lead | chosen routes                                   | Simulation quotes plus finalized canonical Base Sepolia receipts; actual app-ledger funding/payout reconciled                | Approved live provider multichain quotes, routes, fees and finality                                                                                  |
| R23 | Canadian age/province/identity/retention eligibility                                 | provider      | qualified/provider review                       | Founder confirms no review; every live province remains disabled                                                             | Written activity/province/age/identity/retention review and provider acceptance                                                                      |
| R24 | Approved solvent finite promotional allocation and reserve caps                      | lead/provider | founder decision                                | Approved separate worst-case pre-admission reserve implemented and concurrency exercised                                     | Final combined gate; real 50 USDC remains unfunded/unallocated                                                                                       |
| R25 | Payout timing, refund/correction/dispute rules and instrument integration            | lead/provider | founder decisions                               | YES/NO integration; two-business-day review and no-cutoff error/correction rules approved                                    | Provider-specific recovery execution and live operational acceptance                                                                                 |
| R26 | Confirmed funding, conversion quotes and exactly-once funded issuance                | lead          | external contract                               | Confirmed simulation funding and finalized actual 6 test-USDC app-ledger credit; exactly-once receipts                       | Final integrated PG/browser; live five-network provider acceptance separate                                                                          |
| R27 | Exactly-once welcome/daily Toronto-day grants and grant lots                         | lead          | claim timing decision                           | Exactly-once welcome/explicit Toronto-day claim with grant lots implemented                                                  | Final combined fresh/upgrade concurrency and browser acceptance                                                                                      |
| R28 | Source spending, proportional profit/loss, fees/rounding and permanent qualification | lead          | examples approved                               | Exact source engine and A4 actual-cost bridge implemented; approved profit-first loss rule                                   | Integrated source-book/cash/virtual ledger acceptance and review                                                                                     |
| R29 | Promotional backing and available/reserved/pending/promo/withdrawable projections    | lead          | R24/R28                                         | Separate YC_PROMO principal and funded USDC profit; transactional projections implemented                                    | Final solvency, reserve/backing and browser evidence                                                                                                 |
| R30 | Withdrawal request, specific proof, manual review and transactional reservation      | lead/auth     | R16/R25                                         | Operation-specific gross/fee/net proof, reservation/manual review and strict owner-only CLI implemented                      | Final combined expiry, concurrency and browser acceptance                                                                                            |
| R31 | Scoped idempotency and pending/completed/failed/uncertain external outcomes          | lead          | provider contract                               | Scoped immutable external states, persisted nonce/signed identity before broadcast; actual payout reconciled                 | Final combined gate; selected live provider external idempotency unverified                                                                          |
| R32 | Receipts, refunds, corrections and append-only auditable reversals                   | lead          | approved policy                                 | Append-only reports/reviews/consent, funded original-source restoration and reviewed reversals implemented                   | Report PostgreSQL acceptance passed; final browser and combined operator/security review remain                                                      |
| R33 | Authenticated webhooks, duplicate/out-of-order events and reconciliation             | lead          | provider sandbox                                | Authenticated notification inbox, duplicate/out-of-order handling and canonical chain reconciliation implemented             | Final combined gate; selected multichain provider sandbox unavailable                                                                                |
| R34 | Prevent duplicate payout, overspend, double reserve and premature release            | lead/review   | transactional workflows                         | Account/book locks and one-use proof; actual persisted payout identity replayed without replacement payout                   | Final combined concurrency and independent integrated review                                                                                         |
| R35 | Historical/sandbox/live and purchased/promo/fees/operating isolation                 | lead          | asset contracts                                 | Physical DB rail lock plus sandbox-only RLS, USDC/YC_PROMO journal separation                                                | Final negative privilege, rail race and historical-isolation tests                                                                                   |
| R36 | Clearly label deterministic/provider sandbox/live evidence; keep live disabled       | all           | release gates                                   | Live routes absent; simulation UI explicitly labelled; fixed testnet adapter separate                                        | Final config/PR/evidence audit; live release gates remain open                                                                                       |
| R37 | Redis multi-instance atomic IP/account/operation limits and privacy namespaces       | Redis         | isolated Redis                                  | Real Redis two-process atomic/privacy/namespace acceptance recorded                                                          | Hosted actual topology check after deployment                                                                                                        |
| R38 | Redis timeout/retry/outage and logout/revocation availability                        | Redis/auth    | isolated instances                              | Real closed-port/blackhole/pause/OOM/restart checks; provider inspection outside DB locks; local revocation bypass           | Final routes/UI combined check; hosted outage drill unavailable on current topology                                                                  |
| R39 | Redis restart/eviction/memory/availability and latency/error/throttle metrics        | Redis         | isolated Redis                                  | Isolated noeviction/restart/latency evidence; current hosted Valkey/control-plane configuration inspected                    | Direct hosted INFO denied from workstation; verify code-enforced policy after deploy, no hosted outage claim                                         |
| R40 | Preserve narrowed four-account reset, retained/manual accounts and guarded tooling   | lead          | reset reports                                   | Narrowed four-account reset preserved; read-only hosted preflight confirms three retained plus manual signup                 | Disposable reset-regression passed; no further deletion authorized                                                                                   |
| R41 | Reject pre-reset credentials and delayed callbacks                                   | auth/lead     | original credentials or disposable reproduction | Disposable real-signed delayed-callback/password/wallet/cookie reproduction implemented; latest focused run passed           | Original hosted browser credentials unavailable; reproduction is not original hosted replay                                                          |
| R42 | Clean only explicitly created automated acceptance identities                        | lead          | exact identity ledger                           | No new hosted identities created; disposable local clusters self-clean                                                       | Track any future genuine acceptance identities before scoped cleanup                                                                                 |
| R43 | Combined quality, coverage, database isolation and browser release gates             | lead          | merged implementation                           | Combined gate at `9490446` passed 726/726, 144/144 fresh/upgrade, separate 5/5 treasury and core browsers                    | New recovery and return-flow changes require a new combined run; community/replay checks passed                                                      |
| R44 | Auth/financial/security/concurrency/provider failure acceptance coverage             | lead/review   | workflows                                       | Real-crypto PG, HTTP and finance/concurrency cases passed focused runs; final combined gate remains                          | Latest combined revision must pass, no skipped acceptance claims                                                                                     |
| R45 | WCAG 2.2 AA checks, keyboard/focus/announcements/mobile/200% zoom                    | lead          | changed journeys                                | Desktop/mobile 200%/keyboard/focus/Axe fixture acceptance recorded                                                           | Final changed security/coin/recovery journey verification                                                                                            |
| R46 | Screen-reader and physical-device trials distinct from automation                    | lead          | human/device access                             | Automated checks recorded separately; screen-reader attempt explicitly incomplete and physical-device trial unverified       | Native screen-reader test blocked; physical device/human acceptance needed                                                                           |
| R47 | Privacy-preserving signup/auth/resend/provider/recovery measurement                  | lead/auth     | journeys                                        | Aggregate authentication/recovery outcomes and latency; HMAC attempt scopes implemented                                      | Final event privacy and outcome assertions                                                                                                           |
| R48 | Runtime vs owner separation; no secret/private-data exposure                         | all/review    | deployment/config                               | Runtime-only web/worker, separate owner operator; no keys in evidence                                                        | Independent privilege/log/source/secret scan and final deployment review                                                                             |
| R49 | Focused commits, PR #42 update, screenshots, results/config/docs/status              | lead          | integration                                     | Focused agent commits retained; PR42 preserved; implementation/evidence docs maintained                                      | Complete final evidence/docs, push/update PR and staging                                                                                             |
| R50 | Independent security/financial and full-prompt completion audit                      | review/lead   | integrated revision                             | Independent early security and financial reviews identified concrete fixes                                                   | Full final requirement audit against tested integrated revision                                                                                      |

## Approved decisions (do not ask again)

The current task and [financial decision sheet](email-first-accounts.md#financial-decision-sheet)
approve internal YC, 100 YC/USDC, Canada subject to eligibility, crypto purchases
only, all five requested input networks, USDC external withdrawals, 2,500 YC
welcome and 500 YC Toronto-daily grants, permanent independent qualification,
spend-only principal, oldest grants before purchased coins and proportional
mixed-source results. Purchased funds have no profit condition. The promotional
budget is 50 USDC, unfunded/unallocated; user backing cannot fund it. **The founder
superseded the original daily cap: there is no daily withdrawal limit.** The minimum
is a 5 USDC gross debit. A 5 USDC request with a displayed 0.10 USDC network fee
deducts 5 and delivers 4.90; the fee is explicit before authorization. Manual review
remains required. No user transfers. **Completed purchases use USDC withdrawals
only; original-route unused-purchase refunds were superseded.** Failed/incorrect
deposits require reconciliation and auditable corrections. Uncertain reserves
release only after reconciliation proves no payment. Purchased balances and their
remaining profits never need grant qualification. Historical play money is never
redeemable. No paid plan/live financial
activity/additional retained-account deletion is approved.

## Routine engineering decisions

- Extend this branch and existing draft rather than dropping existing changes.
- Use additive migrations, strict TS, exact integers and isolated local fixtures.
- Deterministic simulation must be visibly labelled and cannot establish provider
  sandbox acceptance. No real account receives fabricated funded balances.
- Reuse agents in later review/browser waves; keep migrations/shared routing under
  lead ownership. Shared files require explicit coordination.

## Approved accounting examples

These examples incorporate the founder's answers, including the later removal of
completed-purchase refunds and the daily withdrawal cap.

1. **Spending inside one grant:** spend its remaining principal first,
   then its earned profit, then the next-oldest grant, then purchased funds. With
   welcome principal 1,000 YC + profit 400 YC, a 1,200 YC stake uses 1,000 principal
   and 200 profit; the remaining 200 profit stays tied to that grant. A qualified
   daily grant remains qualified if it later loses money. Within the same grant,
   losses consume earlier profit first: a stake of 1,000 principal + 200 earlier
   profit returning 1,100 restores 1,000 principal and 100 profit. The full 100
   loss reduces current qualifying net profit; it does not erase past qualification.
2. **Mixed source:** 600 granted + 400 purchased YC earning 100 YC net
   credits 60 to that grant's profit and 40 to the purchased source. The purchased
   profit is immediately withdrawal-eligible; the grant's qualification rule
   applies only to its own profit. A 100 YC net loss leaves 360 purchased YC
   eligible, with no target. Fees count in net result on the same source weights.
   Two different grant lots split results proportionally too; earlier welcome
   profit never qualifies a later daily lot.
3. **Precision:** compute each proportional share in USDC atomic
   integers, allocating floors, then remaining atoms by largest fractional
   remainder with stable source-order ties. Three equal sources sharing 2 atoms
   receive 1,1,0; totals remain exact. Store inputs and allocation in receipts.
4. **Multiple grants:** welcome profit peak 2,500 YC qualifies welcome permanently;
   a newer daily with 100/500 YC profit stays unqualified. If welcome profit falls
   from 2,500 to 700, only its remaining 700 can be withdrawn, subject to backing;
   its principal never becomes withdrawable.
5. **Partial withdrawal:** with purchased 1,000 YC + qualified backed grant profit
   500 YC, a 600 YC gross withdrawal leaves 900 YC withdrawable. Use purchased
   principal, then purchased profit, then qualified promotional profit. Stake
   spending still follows grants first. A 5 USDC gross request with a 0.10 USDC
   fee deducts 500 YC and delivers 4.90 USDC. There is no daily withdrawal cap.
6. **Refund/reversal:** completed purchases use ordinary USDC withdrawals only.
   A never-executed stake releases
   its exact sources without qualification profit. A correction records a new
   linked reversal; if value has already left, freeze the affected financial
   account for review rather than invent negative available funds or silently
   debit unrelated purchases. Approved compensation uses funded operator reserves
   and restores only the original missing source, without creating grant
   qualification profit or cash from grant principal. Error reports have no
   arbitrary submission cutoff; ordinary trading losses remain final.
7. **Finite treasury:** reserve the maximum possible redeemable
   promotional profit _before accepting_ any redeemable promotional stake. Reject
   admission with a clear unavailable message when that independently funded
   treasury cannot cover it. Never promise profit first then impose a hidden cap.
   The 50 USDC may cover very little exposure; exact A4 maximums and purchased
   counterparty collateral require separate reserves. No budget is treated as
   funded. Already-earned backed profit is not capped after the fact.
8. **Grant timing:** welcome issuance occurs once at initial eligible account
   entry and an explicit Claim daily action, once per Toronto calendar day,
   including signup day. No automatic retroactive accumulation.

## Material decisions and external approvals still outstanding

- No remaining ambiguity in the approved grant/purchased qualification, fee debit,
  daily cap removal, completed-purchase refund removal or YES/NO sandbox scope.
- The approved all-strong-methods-lost boundary permits ordinary email access but
  locks financial access until a recovery procedure is approved with the selected
  identity provider. No complete manual identity-recovery service is claimed.
- Provider/custody/signing, input assets on each requested route, permitted USDC
  payout networks, fees/finality, legal/provider eligibility and retention.
- The two-business-day review target and error/correction rules below are approved.
  Provider-specific external recovery execution and live operational staffing are
  still unverified. Treasury admission policy is approved; the real budget remains unfunded.
  No unapproved proposal may reach production.

## Decisions received during this execution

These record the founder's clarifications and supersede earlier proposals.

| Decision                                 | Founder answer / consequence                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate security passkey                | Approved. YapArena verifies its own WebAuthn operation challenge; Privy email login remains primary.                                                                                                                                                                                                                                                                                                     |
| First key                                | Approved after email signup before funding. Existing trusted wallet/password approves enrollment; a revoked/lost previous key does not reopen first-key setup.                                                                                                                                                                                                                                           |
| Provider credential changes              | Approved server-side Privy inspection on every authenticated protected request; fail closed on provider outage, preserve local logout/revocation. No paid production webhooks approved.                                                                                                                                                                                                                  |
| Accounting examples 1,3,4,5,6,8          | Approved: principal-first stake selection within oldest grant; exact largest-remainder allocation; permanent independent qualification; purchased sources first for withdrawals; auditable corrections; explicit Toronto daily claims including signup day. The initially approved unused-purchase refund option was later superseded by USDC withdrawals only.                                          |
| Mixed sources                            | Clarified and approved: 600 grant / 400 purchased stake with 100 net profit allocates 60 grant / 40 purchased profit. Purchased-source remaining funds/profit have no grant target. A 100 loss leaves 540 / 360; no loss restoration.                                                                                                                                                                    |
| Loss within one grant                    | Founder selected **lose earlier profit first**. A stake of 1,000 principal + 200 earlier profit returning 1,100 restores 1,000 principal and 100 profit. Full net loss still reduces that lot's qualifying net profit; qualification never relocks.                                                                                                                                                      |
| Finite promotional backing               | Approved internal backing check before admitting new grant-funded exposure; pause new exposure if separate treasury cannot cover it. Previously earned backed profit remains eligible. The 50 USDC budget remains unfunded/unallocated.                                                                                                                                                                  |
| Instrument scope                         | Approved connect sandbox balances to existing YES/NO debate participation; separate future longer-lived idea trading stays gated pending its ownership/redemption rules.                                                                                                                                                                                                                                 |
| External testing                         | Approved free Base Sepolia test USDC / disposable test-only operator keys. No live custody decision or multichain acceptance inferred. NOWPayments remains an investigation candidate, not approved provider.                                                                                                                                                                                            |
| Eligibility                              | Founder confirms no existing written review/provider acceptance. Every live province remains disabled pending review.                                                                                                                                                                                                                                                                                    |
| Withdrawal amount and fee                | Founder chose receive 4.90 / deduct 5 for a 5 USDC request with an explicit 0.10 fee. Minimum applies to gross debit; fee is inside that debit and must leave a positive net amount. No daily withdrawal cap; Toronto calendar days apply to grants only.                                                                                                                                                |
| Completed purchase refunds               | Founder chose USDC withdrawals only after completed purchases. Earlier original-route unused-purchase refund exception is removed. Failed/incorrect deposits still require support, reconciliation and auditable correction.                                                                                                                                                                             |
| Purchased coin eligibility               | Founder reiterated qualification restrictions concern grants only. All unspent purchased-source principal and profit remain withdrawal-eligible; losses do not create a target or restore spent funds.                                                                                                                                                                                                   |
| Review target                            | Approved two Toronto business days, excluding Canadian federal holidays. Show network confirmation separately; delays keep reserves and never authorize another payout.                                                                                                                                                                                                                                  |
| Errors and disputes                      | Approved reports whenever submitted, transaction-evidence review and append-only corrections. Operator-caused shortfalls and costs use separate operator funds. Recovery costs require a disclosed quote and consent; ordinary trading losses remain final.                                                                                                                                              |
| Compensation source                      | Restore only the original balance source. No new withdrawable compensation category, grant-principal conversion or qualification profit.                                                                                                                                                                                                                                                                 |
| Qualification ordering                   | Approved round-closing time then stable UUID tie-break, regardless of result arrival order. Earlier losses must precede later gains for permanent qualification.                                                                                                                                                                                                                                         |
| All strong methods lost                  | Ordinary email access remains possible; financial access stays locked pending recovery approval with the selected identity provider. A complete manual recovery service is not implemented or implied.                                                                                                                                                                                                   |
| Return after authentication              | Approved returning to the initiating page/action with context preserved for final confirmation. Signing in never automatically submits a stake, payment, wallet change or other initiating mutation.                                                                                                                                                                                                     |
| Lost sole email/Google with retained key | Approved for loss of the sole email or Google login: verify a new email through Privy and authorizing replacement with the retained YapArena security passkey. Preserve internal account/profile/balances; permanently retire the old provider identity. Reject already-bound replacement identities for review; never merge accounts automatically. This does not recover or mutate the old Privy user. |
| Sign out and speaking                    | Normal Sign out revokes all YapArena sessions. Assigned active speakers alone receive publishing access; logout/suspension disconnect speakers through a durable retry queue. Public watching remains available.                                                                                                                                                                                         |

The current branch includes fetched `origin/main` (`fd60543`) without dropping
the existing PR. The independently inspected hosted revision remains `f942dc6`
until a new deployment is explicitly verified. Actual free development-app
settings and public staging flags now enable optional Google and provider
passkeys; email remains enabled, automatic account merging and embedded wallets
remain off. This configuration evidence is separate from genuine hosted journey
acceptance.

The founder approved using the same email inbox when replacing a lost sole
Google login. The new email still requires Privy verification and a retained
YapArena security passkey; the old Google identity is retired, and identities
are never merged by matching email. The additional bounded application-to-Cloud
logout trial was also approved within the previously confirmed five included
participant-minutes. Its outcome must be recorded separately from this approval.

The [read-only staging preflight](evidence/account-completion-baseline/staging-database-preflight.json)
verified all three retained accounts plus the one genuine manual signup, absence
of the four selected reset accounts, zero live journals/grants, separate owner
and runtime authority, and no private-schema browser grants. It found 28 applied
and 12 pending migrations at that preflight revision. The new provider-recovery
migration raises the pending count to 13; release requires another preflight.
No additional hosted identity deletion or financial
mutation occurred.

Implemented workflows include operation-bound security passkeys and retained
credentials, deliberate provider-method reconciliation, recovery boundaries,
per-request provider inspection, session/media revocation, exact source books,
funded sandbox issuance, grant qualification, YES/NO settlement, withdrawals,
external reconciliation and evidence-reviewed original-source corrections.
The latest combined gate is still being completed; implementation is not a
claim of hosted or production acceptance.

The [Base Sepolia application-ledger trial](evidence/coin-testnet/ledger/README.md)
verified actual finalized 6 test-USDC funding and 5 test-USDC payout, persisted
signing identity before broadcast, exactly-once ledger settlement and final
external reconciliation. This uses valueless test assets and does not establish
live custody, conversion or five-network provider acceptance. The separate
[LiveKit Cloud trial](evidence/account-completion-baseline/media-cloud-revocation/README.md)
verified disconnect and rejection of original/refreshed speaking tokens while
watch-only access remained. Its original cleanup deadline failure and successful
bounded postflight are retained separately.

## Provider facts and production assumptions

Current official sources and actual configuration observations are recorded in the
[provider review](email-first-provider-review.md). Dated observations in older
trial documents apply to their recorded revisions. Actual activity eligibility, sender entitlement,
paid features, custody, production webhooks, network assets and provider-sandbox
access must be checked before reliance. A listed chain or authentication feature
does not establish business approval or financial-route support.

## Evidence and completion rule

Every new report must identify tested source revision, environment, command,
outcome and limitations. Distinguish implemented, locally tested, hosted-tested,
provider-sandbox tested, physical-device tested, external-input pending and
disabled awaiting live release. This task remains **incomplete** until every
in-scope acceptance requirement passes or a verified external dependency is
handed off explicitly after all independent work is exhausted.
