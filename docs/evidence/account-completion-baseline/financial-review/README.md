# Financial transition review and focused acceptance

Reviewed the integrated financial sources at
`58e7b2749b644aeac4695cd2bacb2826cd61c20a` against the founder decisions in
[the completion contract](../../../email-first-completion.md). The
[source hashes](source-hashes.json), [structured results](results.json) and
[complete focused output](focused-postgres.txt) identify the boundary of this
review. The reviewer authored parts of the grant/repository/report foundation;
those portions also received the separate auth review. This is not a claim that
self-review substitutes for independent arithmetic or security acceptance.

## Findings and corrections

1. **Older review selected as current:** the `sequence::text` output alias made
   unqualified descending order lexical. Commit `bbd87c6` qualifies the numeric
   table column in latest-review and public-history queries. The real PostgreSQL
   regression creates twelve reviews, then crosses a digit boundary under a
   disposable owner-only table fence without rewinding the identity counter. It
   verifies numeric display order, rejection of the superseded quote and one
   exact fresh consent to the current quote.
2. **Manual review insufficiently separated in database privileges:** the runtime
   could update withdrawal status and insert signing reservations directly,
   although the supported operator API rejected it. Commit `c5de858` adds
   migration `1792426010000` without editing an applied migration. Runtime may
   insert only a quoted withdrawal and change it only from quoted to review.
   Owner approval, rejection, signing/external event evidence and nonce insertion
   remain separate. Tests use actual runtime SQL denials, supported fresh-proof
   reservation/owner approval, offline signed identity admission, exact retries
   and duplicate sender-nonce rejection. The auth reviewer independently checked
   the guard against existing immutability and role privileges.

The complete raw log records **143/143 focused tests on both fresh and upgraded
simulation databases**, plus **5/5 on each physically separate fresh/upgraded
Base treasury database**, with zero failures or skips. The lead executed the
command below; this reviewer inspected the actual output and matched all 23
recorded financial source/test/migration files to the tested revision.

```sh
LC_ALL=C LANG=C DATABASE_TEST_MODE=host ACCOUNT_SECURITY_VERIFY=true A4_QUALITY=false node scripts/verify-database-isolation.ts
```

## Approved terms and transition inspection

| Area                   | Reviewed behavior and acceptance boundary                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership and proofs   | Current account/session guards, comparison-only observed session context and exact one-use withdrawal authorization remain server-controlled. Proof consumption, source reservation, cash journal and request status share a transaction. Quote expiry is rechecked after waits/writes.                                                                                                   |
| Grant sources          | Welcome 2,500 YC and daily 500 YC use independent lots and Toronto claim keys. Principal is permanently spend-only `YC_PROMO`; real purchased/earned cash is USDC. Atom equivalence never allows virtual principal to fund cash collateral, fees or withdrawals.                                                                                                                          |
| Actual-cost allocation | A4 releases the unused admission reservation to its exact sources. Actual paid premium plus fee supplies proportional settlement weights. Within one grant, returned value restores staked principal before earlier profit, implementing the approved profit-first loss rule.                                                                                                             |
| Qualification          | Each lot's net result and permanent peak stay independent. Global due batches settle by closing time and UUID, prelocking the complete account/book/cash/promo union before journals. The API cannot select a later profitable round ahead of an earlier loss.                                                                                                                            |
| Purchased eligibility  | Remaining purchased principal and profit require no qualification. Source ordering retains original principal before purchased profit. Losses do not restore spent balances or create new grant targets.                                                                                                                                                                                  |
| Solvency               | Separate center and promotional operating buckets remain nonnegative. Admission reserves conservative exposure before a commitment. New grant profit is transferred from promotional backing; virtual stake premiums never replenish center cash. The approved live 50 USDC budget remains unfunded.                                                                                      |
| Withdrawal terms       | Minimum is gross 5 USDC; displayed fee is inside gross, with positive net. No obsolete 100-USDC daily cap remains. Immutable terms bind request, rail/network, asset, gross/fee/net and destination. Owner review follows current account/strong-method/financial-hold guards.                                                                                                            |
| External outcomes      | Pending/uncertain outcomes retain reserves. Completion needs reconciled transfer evidence. Failed release needs authoritative original-operation no-transfer proof. Terminal contradictions require manual reconciliation. Rejection before submission restores exact reserved sources.                                                                                                   |
| Testnet identity       | The adapter pins Base Sepolia and the exact test-USDC token, validates signed bytes/from/to/amount/chain/nonce/hash, and checks canonical finalized receipt plus the exact log. The configured operator reconciles persisted identity, never caller status. Shared receipt serialization is stable across advancing finalized height.                                                     |
| Duplicate protection   | Immutable request/receipt/nonce mappings, global network/transaction/log uniqueness, one receipt per request, account locks and scoped idempotency prevent repeated cash issuance, source reservations and payout settlement. Conflicting nonce or receipt assignment rolls back.                                                                                                         |
| Corrections            | Completed purchases expose USDC withdrawal only, with no original-route purchase refund product. Reviewed erroneous credits use append-only reversal. Operator shortfall restoration uses independently funded correction cash, original persisted categories/IDs and cumulative per-source/original-debit caps across every report. Qualification and virtual principal do not increase. |
| Error reporting        | Owned deposit/payout reports have no filing deadline or automatic hold/debit. Private evidence stays out of projections. Exact expiring retained-proof cost consent authorizes neither a charge nor recovery execution. Provider-specific expenses beyond the original internal debit remain live-disabled and unresolved.                                                                |
| Operating target       | Two Toronto business days excluding federal holidays is a manual review target with an official calendar reference, not an implemented automatic deadline, payout approval or reserve-release timer. Network confirmation is additional.                                                                                                                                                  |
| Isolation              | Historical A4/YAP is not a funding source. Application persistence hardcodes sandbox; the database rail is immutable after history and simulation/testnet use physically separate databases. Runtime live writes remain denied. Owner configuration/signing material is absent from the web/worker processes.                                                                             |

No further source accounting/conservation defect was identified within this
scope. Direct owner functions remain trusted internal operator interfaces;
configured correction commands require exact reviewed evidence. A compromised
owner is outside the runtime-role boundary.

## Evidence limits and remaining release work

These are focused local role/concurrency tests, not the final full repository
coverage, browser-release or hosted acceptance. The new Base database test signs
only locally with a generated key and synthetic authoritative incoming receipts;
it never calls RPC or broadcasts. The separate
[actual Base ledger trial](../../../evidence/coin-testnet/ledger/README.md) has its
own tested revision and finalized transfer evidence. It does not establish
multichain conversion, live custody, Canadian eligibility or promotional funding.

Live financial activity remains disabled. The older read-only live wallet
projection is not completed source-qualified live withdrawal implementation.
The separate pending cookie issuance/logout race, genuine provider recovery,
all-strong-methods-lost service, hosted configuration and physical/screen-reader
acceptance cannot be closed by these financial results.

An added-line text scan of the `origin/main` diff found no genuine private-key,
token or credential candidate. Its sole candidate was an inert unused storage
configuration in `scripts/verify-media-cloud-revocation.ts:293`; no secret value
was printed. No private `.env`, key/certificate, dump, encrypted backup or operator
state file was tracked. This pattern scan is not exhaustive and does not inspect
screenshot pixels. Current runtime logs omit request bodies and redact credentials,
cookies, webhook signatures and private provider error objects; metric labels use
bounded events/phases and route templates.

## Independent continuation after retained-key recovery

The authentication worker independently rechecked the integrated financial
boundary at `64d9ad0553d45a32ec711a7301dfd9c783463c9d`. Recomputing every
SHA-256 entry in `source-hashes.json` found **22 of 23 files unchanged** from
this review's recorded revision. The sole difference is the addition of
`provider_identity_recoveries` to the database-isolation verifier's private
application-table inventory. All recorded financial engines, router, webhook,
operator, financial migrations and financial PostgreSQL tests remain
byte-identical.

This continuation re-read migration `1792426010000` with the existing immutable
request guards: runtime withdrawals begin as quotes and may only advance to
review; owner approval/submission/external evidence and nonce insertion remain
separate. Sandbox-only ledger write policies and the report owner/session/quote
guards remain unchanged. The new recovery migration `1792426011000` has static
SQL, a fixed search path and a narrowly granted definer entry point; it adds no
financial-table writes or financial-role grants. No new financial privilege,
source-accounting or conservation finding was identified in this continuation.
The worker authored parts of the recovery implementation, so this statement is
an independent financial integration review, not an independent sign-off on its
own authentication code.

The lead's subsequent focused local run records **151/151** tests on each fresh
and upgraded simulation database and **5/5** on each separate fresh/upgraded Base
treasury database, with no skips. That run includes the new recovery transaction
preserving the same funded source book, cash projection, funding request records
and profile.
Its source-identical backend result does not cover the later storage-message
frontend adjustment; the final combined gate and browser rerun remain required.
None of these results establishes genuine hosted Privy email verification,
physical-device or screen-reader acceptance, live financial eligibility, funding
or release approval. Live funding and redemption remain disabled.
