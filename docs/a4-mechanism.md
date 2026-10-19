# A4 adjusted FTM contract — a4-v1

[Decision 0007](decisions/0007-a4-adjusted-ftm.md) selects this mechanism for nonredeemable
Yap Coins. No external truth judge, money-weighted vote, pair matching, partial fills,
optimizer, event winner or sponsor payout is involved.

## Terms and arithmetic

One authenticated account submits YES or NO, a binding limit on the YES scale, and an integer
quantity 1–100. For the purchase UI, YES ceiling c means l=c; NO ceiling c means l=1−c.
Prices accept decimal strings with at most six places. Multiple linked wallets do not create
additional submissions. The first commitment is final, including before cutoff; identical
idempotency retries return the same receipt and conflicting payloads fail.

Each contract has face value one Yap Coin (1,000,000 atomic units). Asset identity and precision
are separate from symbols. Authoritative amounts use BigInt/rational arithmetic and decimal
integer JSON strings. The engine can calculate other face precisions; only YAP is enabled.
Premium is rounded upward to an atomic unit; fee is rounded upward on that actually charged
premium; payout is rounded downward. Exact premium, fee and payout fractions plus dust are
retained. Premium and payout dust accrue explicitly to the funded center, never silently
change the acceptance comparison. The browser's displayed six-place offer is explanatory only;
acceptance uses the complete rational price. Center trading result equals charged premiums
minus payouts, the negative aggregate participant gross profit. Earned fees are separate.

At lock, freeze the sorted submission snapshot, rule/configuration, reserved funds and seed
commitment. Ordinary unweighted medians are a=median(NO limits), b=median(YES limits);
even medians average the two exact middle values. With both groups and a<b, choose the
full-range exploratory branch with epsilon probability and otherwise a targeted uniform on
(a,b). Missing groups or a>=b use the full-range fallback with a recorded reason. Empty
rounds have undefined settlement and no offer. No swapping bounds, target execution rate,
redraw or post-draw change is allowed.

Secure server seeds are chosen before ordinary rounds open. Each bot period derives an
independent price seed from the run seed; mixed-run seeds cannot be client-selected and stay
private until the entire run completes. Only bot-only observers can select a replay seed.
HMAC-SHA256 domain-separated 64-bit words determine branch and price. A word k maps to
(2k+1)/2^65, the midpoint of one of 2^64 cells: endpoints excluded, no modulo operation,
clipping or zero-cost endpoint. The targeted rational affine transform preserves precision.
The committed seed survives retries before and after pricing; every worker recovers the same
draw. Hashes use SHA-256 of recursively key-sorted canonical JSON (including JSON quotes for a string
seed). Snapshot hashes bind terms, round ID, commitment and orders. This does not prove an
honest operator chose its seed fairly.

YES accepts if p<=l; NO accepts if p>=l, including equality. If both accepting groups exist,
every accepted committed quantity executes in full. Otherwise nothing executes. Exploratory
prices outside the medians still execute against actual accepting limits. Locked refusals
still count toward v=YES endorsement count / all locked endorsement count.

An executed YES order pays qFp and receives qFv. NO pays qF(1−p) and receives qF(1−v).
Net profit=payout−premium−fee. Nonexecution has zero trading profit and zero fee. A 50% share
is normal settlement. There is no draw refund. Zero fees are default; the experimental fee
is 5% of executed purchase premium, with pre-reserved allowance.

## Accounting and admission

Append-only journal headers and postings have unique business references, balanced deferred
checks, same-asset/scope checks and transaction sealing. Projection changes and postings commit
atomically. Runtime cannot update/delete journal history or append to a previously committed
journal. Accounts other than the explicitly labeled play issuer cannot become negative.
Projection reconciliation compares every account against the sum of its postings.

A participant reserves qF plus the maximum fee; the center separately moves qF to that round's
collateral account at admission. This is more conservative than max(0,F max(QY,QN)−premiums).
Each run's capacity, maximum quantity and period count determine recorded initial play-center
issuance. Pending rounds have separate vaults. Collected premiums augment their vault; fees
remain in separate pending accounts. Execution releases unused participant reservation. At
finality, vaults pay exact rounded claims, then return residual backing to the center and move
pending fees to earned fees. No later issuance is needed to rescue an admitted obligation.

## Lifecycle, clocks and visibility

Sessions reference the existing debate/topic and preserve the proposition as an immutable
YES endorsement / NO rejection mapping. Debate/media status does not imply A4 finality.
Rounds move scheduled → open → locked → priced → pending → settled. Each transition commits
separately; settlement of all periods and publication commit together. A cutoff clock check
runs after account/session/run/round and ledger-lock waits. Open/cutoff/reveal eligibility is
compared inside PostgreSQL, preserving its microsecond precision; serialized JavaScript dates
serve display only. HTTP arrival time does not qualify.
The engine and bots share validation, reservations, execution and ledger code.

Ordinary human rounds use 300 seconds by default. Bot runs default to 60 seconds per period;
initial acceleration divides duration with a ten-second floor, before schedules open. All
period cutoffs and final T are recorded at creation. Delayed mode has 2–10 periods and each
period settles against its own v at final T. Bot controls can open/lock the next window early
explicitly, never revise a locked window or draw. Pause stops automatic opening of future
windows; current deadlines still lock and pending obligations still settle. Runtime speed
controls transition processing, not prices or recorded deadlines. A missed unopened window
records an empty round rather than admitting bots after cutoff. These play schedules do not
resolve the future five-day event schedule.

Before T, participant schemas expose only own terms, offer, acceptance/execution, premium,
fee, released reservation and pending status. They omit medians, counts, books, seed, provisional
payout and profit. Own available funds can change only by pre-funded issuance, reservation,
execution cost/release or revealed settlement; release depends on price and own execution,
not v. History omits all internal journal metadata. Unrevealed A4 data never enters public
bootstrap or caches. Private participation/receipt APIs are authenticated and no-store;
community SSE, adoption metrics and ongoing prices receive no A4 participation data.
The later [shared-discovery contract](shared-bot-discovery.md) separately permits final,
revealed mixed/observer aggregates in public HTML/JSON after the creator opts in. It excludes
individual orders, receipts and balances, and rechecks publication and consent on each read.
The permitted offer and own execution necessarily disclose some information.

Private bot-only observer diagnostics are authorized by stored creator and mode, and read access
is audited. Such a run permanently rejects human orders. Arbitrary request flags grant nothing.
Other bot sandboxes are invisible. Revealed books paginate up to 100 records and pseudonymize
human identities without wallets. Observer diagnostics remain isolated from bot decision inputs.

Archive/reset preserves all audit history and balances. It explicitly voids only scheduled/open
sandbox rounds, refunding reservations and center backing; locked/priced obligations settle
normally. A new run has a new scope and recorded funding. Void does not publish sealed books
early. No post-settlement reversal policy or ordinary-user cancellation API is implied.

The [live/replay workspace](debate-workspace.md) supports inline round selection,
balance/refill, labeled 500-bot creation and the same exact review/commit flow while
media/chat remain mounted. Its authenticated timeline charts only final, revealed
settlements; human activity and the creator's own bot sandboxes stay separate.
The full `/coins` page supplies advanced run controls and paginated diagnostics in a separate tab.

## Bots and research

The default population is 500, maximum 1,000; each bot has one distinct simulation identity per
run. Human-only sessions never insert bots. Heterogeneous mode samples a fresh latent center
uniformly from [0.15,0.85) per period, private beliefs over a broad range using independent
samples, and sides with the center's probability. See `bots.ts` and the reproducible report.
It is a behavioral UX stress fixture, not a coherent Bayesian model. Fee-adjusted break-even
limits are m/(1+lambda) for YES and (m+lambda)/(1+lambda) for NO. Research randomness uses
separate domains from pricing and is independent of rendering or polling speed.

The homogeneous reference is the coherent two-state fixture: a fair latent state gives YES
signal probability 0.4 or 0.1, then each bot independently endorses its own signal. Its ideal
nonpivotal conditional beliefs are 0.34 after YES and 0.22 after NO; bot limits depend on that
signal and any fee adjustment, not the realized settlement or latent state. Finite cohorts
include their own influence and need not exactly realize those ideal expectations. These
anchors are confined to the explicit reference preset; heterogeneous mode uses fresh broad beliefs.
`npm run research:a4` preserves a two-person pivotal shading example, recomputes endogenous
medians/acceptance/settlement, holds quantity fixed, searches both sides and 21 limits, includes
nonexecution zeros, uses paired draws and independently confirms the chosen candidate. The
[report](../public/a4-research.json) records uncertainty. A separate 500-participant audit
uses the default heterogeneous fixture and epsilon 0.05, searches both sides and 21 limits,
then independently confirms the selected candidate with paired draws. It conditions on an
observed behavioral cohort and does not establish an ex ante Bayesian strategy. It is not a generalized honesty proof.
