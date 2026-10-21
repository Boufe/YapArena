# YAP Arena nonfinancial implementation plan

This plan turns the [product PRD](product-prd.md) into buildable work for the product experience
outside money-linked code. The [specification outlines](product-specification-outlines.md) govern
the separate event-market, hidden-tally, ongoing-market, and eligibility work. This document is an
implementation plan, not a new product decision. Its milestones are development increments; the
confirmed first **paid** release still includes both markets together.

The separate [financial implementation plan](financial-implementation-plan.md) and
[A4 operations guide](financial-operations.md) now track Yap Coins, persistent A4 rounds and
Bots mode. These play features do not satisfy paid-release or remaining hosted/device gates.

## Current implementation and evidence

Email-first account work is tracked in the [implementation and financial decision
record](email-first-accounts.md) and the detailed
[completion matrix](email-first-completion.md). Baseline was fetched main
`fd60543`; the existing feature branch preserves the hosted Privy implementation
and adds operation-bound passkey proofs, retained-credential account management,
provider-change monitoring, session controls, speaker revocation and an isolated
coin sandbox with persistent funding, source accounting, manual withdrawals and
YES/NO A4 participation. The current corrective implementation uses one Privy
passkey, enrolled in Account settings and verified again against a server-issued
challenge for sensitive actions. First setup can resume after interruption only
under the approved no-financial-history/no-prior-strong-method policy. The earlier Privy-only
integrated local gate passed 798 tests with no skips, 198 focused PostgreSQL cases
on each fresh and upgraded database, and the core browser journeys. The earlier
[integrated release evidence](evidence/account-completion-baseline/final-integrated-release-gate/README.md)
records 739 tests for its own revision.
All five [required CI checks](evidence/account-completion-baseline/privy-passkey-ci/README.md)
passed for `d6e2d35`. The [Privy-only staging release](evidence/account-completion-baseline/privy-passkey-release/README.md)
applied its two additive migrations after encrypted 83-table/15-sequence backup
and exact isolated rehearsal. The named web service is live at that revision;
seven hosted guest groups and all 14 served asset matches passed. Staging has
43 applied / zero pending migrations. The earlier 13-migration/739-test release
at `9395242` retains its separate historical evidence.
Retained legacy application-key recovery can replace a lost sole email or Google
identity without changing the account or merging by email. New Privy keys sign
into the existing provider identity; retained-proof settings handle its credential
changes. Authentication returns to the initiating
action for confirmation. Source implementation is not hosted or production
acceptance. The selected staging deletion removed IDs
1–4 after encrypted backup and restore/concurrency rehearsal, preserving the
three accounts the founder explicitly retained. The new release preserves those
accounts and the genuine manual signup, with no live financial history.
The web service now enables only the deterministic coin sandbox. The founder completed
genuine hosted email signup; backend inspection confirmed one new account and
provider mapping. The [account visual refresh](evidence/account-refresh/README.md)
adds focused authentication, an account dashboard and clearer withdrawal progress.
The [shared header and authentication popup](evidence/shared-header/README.md)
unify account entry points and navigation, hide member controls until the app
session is verified, and load the provider bundle on demand from public pages.
Current free development-app Google/passkey login options are enabled; genuine
returning/linking/recovery journeys and final account acceptance remain open.
The reviewed delayed provider-reset repair is complete, preserving revocation
cutoffs and all retained accounts. The Privy-only corrections are hosted. Final review then identified an additional
account-switch race in ordinary provider settings; its correction and 99-scenario
local SDK regression passed in `f422dfd`, with release pending. The separate
interrupted first-passkey reset repair completed without adopting a key or creating
a session; [actual evidence](evidence/account-completion-baseline/first-passkey-reset-repair/README.md)
records its one mutation, GET-only finalization and preserved revocation fences.
The founder then approved automatic user-controlled Privy EVM wallets and removal
of new external-wallet linking. The [durable wallet design](embedded-wallets.md)
is implemented locally with no app signing authority; combined acceptance and
staging release remain pending. Unknown external-wallet signup is also disabled
in email-first mode; retained wallet login/removal stays available. See the
completion matrix for exact acceptance status.
The subsequent wallet/reset integration passed **854 tests with zero skips**,
**235 focused PostgreSQL cases on each fresh/upgrade path**, 17 A4 and five
treasury cases on each path, and the complete core browser release gate.
Dedicated final checks passed 111 SDK, 18 native passkey, 22 coin and seven
cookie-coordination groups (14 issuer paths). The
[new combined evidence](evidence/account-completion-baseline/wallet-phase-integrated/README.md)
and individual reports bind those local results to their source and asset hashes.
The current source includes durable user-only wallet provisioning and acknowledged
provider-reset confirmation; the named staging site still serves `d6e2d35` until
its separate guarded release. Genuine provider and physical acceptance remain open.
The next credential-wait correction parks wallet work without spending creation
attempts while verification is unfinished. Its complete local gate passed
**858 tests with zero skips**, **239 focused cases on each fresh/upgrade path**,
17 A4 and five treasury cases per path, all core browser gates and a separate
18-group native passkey rerun. The
[new hash-scoped evidence](evidence/account-completion-baseline/wallet-verification-pause/README.md)
does not inherit a new genuine provider or SDK result. The earlier four-of-five
CI result includes a failed retained-wallet mobile refresh fixture; its
deterministic correction and exact-revision CI must pass before release.
Real Base Sepolia test-USDC receipt evidence is separate from labelled conversion
simulations. No live financial routes are enabled. Existing A4 remains nonredeemable
play money; the new 100 YC/USDC direction does not convert historical grants or
satisfy the combined paid-release gates.

The [application-to-Cloud sign-out trial](evidence/account-completion-baseline/media-app-cloud-revocation/README.md)
passed with actual local HTTP sessions and a disposable PostgreSQL queue:
a separate runtime pool disconnected the Cloud speaker, rejected original and
server-refreshed speaking tokens, and preserved public watching. It does not
establish a genuine hosted Privy journey or physical audiovisual acceptance.

Reviewed 2026-10-19 against fetched `origin/main` at `78d5087`, the PR #38 merge.
PRs #31–39 are merged: the A4/workspace/homepage/shared-data stack, both TypeScript
migrations, core browser gate and follow-up readiness, Unicode and CI corrections
are present on main. All five required checks passed on that exact main revision in
[run 39262775602](https://github.com/Boufe/YapArena/actions/runs/39262775602).
Its quality job passed 502 tests with zero skips; integration exercised native UTF-8
setup and the full Docker browser/community/replay gates. Earlier failed runs remain
failed historical evidence. The [documentation audit](evidence/documentation-audit/2026-10-19.md)
records the complete Markdown inventory and source checks. No hosted inspection or
deployment was performed for this reconciliation.

The [native Unicode test setup fix](evidence/native-postgres-utf8/2026-10-18.md)
explicitly initializes the disposable community, isolation and replay PostgreSQL
clusters as UTF-8. A focused native C-locale setup check is wired into the existing
CI integration job; it uses the actual migrated chat column and retains the full
community workload separately. Product code, schema and hosted settings are unchanged.
Local native and Docker community gates passed with identical 30-second soaks;
the native database-backed quality gate passed 502 tests with zero skips. The new
GitHub-hosted CI results and its package-source setup correction are tracked in
[PR #38](https://github.com/Boufe/YapArena/pull/38). The
[combined integration verification](evidence/native-postgres-utf8/2026-10-19.md)
records its inherited readiness and cancellation corrections, fresh native Unicode
workload and cleanup controls; local results establish no hosted capacity.

The [operational TypeScript migration](operational-typescript.md) checks the production
edge replay worker and critical database/release automation through the existing quality
gate. It retains the merged browser-release workflows and their deterministic fixtures;
applied migrations and product behavior remain unchanged. The
[verification record](evidence/operational-typescript/2026-10-18.md) distinguishes baseline
failures, local converted checks and remaining hosted/device evidence limits.

The [core browser release gate](browser-release-checks.md) runs maintained homepage,
Live preview, account/A4, debate workspace and shared-data journeys from one disposable
local command and the required CI integration job. Its owner-only A4 fixtures cover
exact execution and exploratory nonexecution without changing production randomness.
Original-export visual comparisons remain explicit; hosted media, physical-device
and audience-capacity acceptance remain separate. [Local verification and the
reversible failure proof](evidence/browser-release/2026-10-18.md) record the tested scope.

The [A4 startup readiness fix](evidence/a4-readiness/2026-10-19.md) keeps inline
participation controls disabled while initial account/workspace data loads, then
restores them after the action guard is released. Its maintained browser regression
holds an actual workspace request and checks a single creation request/run/open
round after readiness. PR #39 passed all five required CI checks and was merged
into the operational TypeScript branch before integrating that branch into main.
The separate [CI integration correction](evidence/ci-integration/2026-10-19.md)
foregrounds pages and ends active inspection before observing their intentionally
visibility-dependent polling, isolates shared-history consent from the workspace
creator's still-active fixtures, and handles checked-out delivery-client error events during cancellation. These
authorized corrections follow the behavior-preserving conversion; they do not
change its recorded historical evidence or resolve hosted/device capacity gates.

The [strict frontend migration](evidence/frontend-typescript/2026-10-17.md) moves all 33
handwritten browser/service-worker modules into `frontend/` TypeScript while retaining existing
shared TypeScript. Browser JavaScript is generated at the same URLs; the normal quality gate
checks browser and worker types separately and rejects authored browser JavaScript. Local
before/after screenshots, interactions, emitted-code parity and disposable-database checks are
recorded in that evidence. Follow [the frontend workflow](../CONTRIBUTING.md#frontend-development)
for future work. Hosted/physical-device media acceptance remains separate.

The [shared bot discovery](shared-bot-discovery.md) adds stored heterogeneous
demonstration histories, independent argument endorsements and opt-in aggregate
mixed/observer results. Homepage and debate visuals refresh from the same final-only
feed; Live regains a visible header link. [Local evidence](evidence/shared-bots/2026-10-16.md)
distinguishes disposable browser/database checks from hosted manual acceptance.

The [wide homepage](wide-homepage.md) replaces the temporary root logo with the
supplied idea-discovery design, native SSR and progressive carousel, chart and
inline expansion interactions. Published topics, canonical playable debates,
authenticated follows and the existing Yap Coins header are connected. Real topic
markets and human argument-vote histories remain unavailable; the labeled shared
simulations are described above. A separately gated, labeled local
reference dataset supports visual acceptance. The [local evidence](evidence/homepage/2026-10-16.md)
records comparison viewports and checks. [PR #33](https://github.com/Boufe/YapArena/pull/33)
records the authorized staging deployment of homepage revision `c73822b`; it merged
on October 17. The later shared-discovery release is recorded below.

The [Live discovery preview](homepage-preview.md) moves the former homepage to
`/live`, with video cards in the existing grid and a shared one-preview playback
budget. Replays loop and hover/focus transfers playback. The temporary root logo
is superseded by the wide homepage above. The [Live-page evidence](evidence/homepage-preview/live-feed-2026-10-16.md)
records local verification and the manual staging handoff. The page features a muted live/replay hero,
ranked by revealed human Yap Coins volume, with deferred playback and hover entry.
Its [dated evidence](evidence/homepage-preview/2026-10-16.md) separates local
component checks from the user's staging acceptance.
The [thumbnail update](evidence/homepage-preview/thumbnail-2026-10-16.md) uses each
recording's own image while the preview is inactive and backfills existing replays.
The [live/replay workspace](debate-workspace.md) adds the navy theme, shared
search/balance header, settlement chart, round navigation and video enlargement.
The [October 16 inspector update](evidence/debate-workspace/inspector-2026-10-16.md)
adds right-column participation, median/offered-price inspection, argument labels
and hover markers, and a round countdown bar.
The [hover refinement](evidence/debate-workspace/hover-2026-10-16.md) places the
median scale directly under the X axis and synchronizes it with the numeric badges.
The [motion refinement](evidence/debate-workspace/motion-2026-10-16.md) animates
price/median inspection and moves the inspected argument into the graph heading.
Its [dated evidence](evidence/debate-workspace/acceptance-2026-10-15.md) distinguishes
local UI/database verification from hosted and physical-device media acceptance.

The table includes the foundations reviewed on October 15 and the subsequent merged
features above. This section is the implementation status index; the work-package
criteria below remain requirements, not a list of missing features.
Source, configuration, migrations, tests, CI and committed sanitized evidence were inspected.
Hosted facts below are the latest **saved observations**, not a new provider inspection.

| Area                       | Implemented on main                                                                                                                                                                           | Verification and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — Discovery              | Server-rendered responsive pages, public search/filter/pagination API, profiles/topics/debates, canonical links and offline explanation.                                                      | [Decision 0001](decisions/0001-public-discovery.md); CI covers PostgreSQL fixtures and browser/accessibility journeys. Representative data, approved latency budgets and human accessibility acceptance remain open.                                                                                                                                                                                                                                               |
| 2 — Identity/social        | Password and SIWE login, profiles/follows, in-app activity/notifications, retained-credential wallet changes and account-wide session revocation.                                             | [Wallet authorization](security/wallet-authorization.md) and [session revocation](security/account-session-revocation.md) have local PostgreSQL race/browser evidence and CI. Self-service export/deletion, password recovery/change, account suspension, live contract-wallet and physical-device acceptance remain absent or unverified.                                                                                                                         |
| 3 — Topics/events          | Topic creation/publication, direct challenges, open queue joining, readiness, immutable rule snapshots, operator lifecycle/history and no-show handling.                                      | [Decision 0003](decisions/0003-topics-matching-events.md); database concurrency and CI journeys exist. Queue joining is self-service; opponent ranking/recommendations are not implemented. Preview timing rules remain provisional.                                                                                                                                                                                                                               |
| 4 — Media/replay           | LiveKit speaker/viewer grants, server clock, bounded recovery, canonical permission repair, recording reconciliation, private adaptive HLS and a separate durable automatic encoder.          | [Delivery controls](media-delivery-controls.md) record local shared-network/clock checks. [Hosted replay trials](replay-starter-trial-2026-10-07.md) record real recording/conversion/publication, graceful cancellation/replacement recovery, all-eligible staging rollout and October 15 UI verification. Physical-device/acoustic/network/load targets, abrupt host loss/OOM and full-duration/4K encoder capacity remain unverified.                           |
| 5 — Community              | Chat with immediate feedback and durable idempotent receipts, likes, reports/cases/appeals, restrictions, QR/share metadata/overlays and feature-gated ordered SSE with HTTP recovery.        | [Community operations](community-operations.md) and [delivery trial](community-delivery-trial.md) record local/browser/hosted checks, including a short 500-stream trial. That trial used owner SQL mutations, not hosted authenticated HTTP-write or media load. Physical devices, screen readers, long hosted soak, privacy review and broadcast/share acceptance remain open. Sponsor tools/placements are deferred.                                            |
| 6 — Measurement/operations | Consent/withdrawal, bounded nonfinancial events/watch data, operator dashboard/product metrics, retention, isolated database roles, migrations, CI, image release and backup/restore tooling. | Merged [PR #17](https://github.com/Boufe/YapArena/pull/17); [operating trial](operating-readiness-trial.md) and [measurement contract](measurement-operations.md). The returning-participant definition alone is approved; the cohort rate is not published and 30% is not an approved gate. [Hosted API isolation](security/database-isolation.md#hosted-operator-checklist--required-to-close-f04), provider restore/RPO/RTO and incident follow-up remain open. |
| 7 and paid financial scope | Recaps, richer broadcasts, seasons, ratings, native apps, sponsor workflows and both financial markets remain planned.                                                                        | Preserve the [product PRD](product-prd.md) and its [pre-funds gates](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds). No event winner, paid cutoff, real-fund settlement/receipt, extension mechanism or sponsor payment is implemented. The separate [A4 play feature](financial-implementation-plan.md) provides Yap Coins settlement and private receipts.                                                                   |

Later merged additions include A4 play-only issuance/ledger/settlement, the live/replay
workspace, wide `/` homepage, `/live` video previews, shared consented simulation histories,
strict frontend/operational types and deterministic browser release checks. These do not
implement the real-fund markets or close the table's hosted/device/privacy acceptance gaps.

The latest saved web release is **2026-10-17 01:47:54 UTC**, source `fc241e1`, in
[PR #34](https://github.com/Boufe/YapArena/pull/34); its read-only HTTP postflight ran at
01:48:24 UTC. It records the ticker/shared histories and three requested debate visibility
removals, with no worker change or hosted browser acceptance. The latest separately saved
encoder/build-pair check is **2026-10-15 16:03 UTC** on `b11a11b`: runtime-only credentials,
packaging enabled, concurrency one and the existing `0.5c-512mb` encoder. Do not infer that
today's services match main or each other from these dated observations.
The [October 8 rollout](replay-starter-trial-2026-10-07.md#all-eligible-staging-rollout--2026-10-08)
removed the room allowlist from both services. New eligible recordings therefore follow automatic
conversion/publication; the full watching interface retains Play while Live discovery
supports its separate muted previews. The Free web Blueprint does not provision that
separately configured paid worker or reproduce all deployed settings.

The October 15 audit found an older shared branch 80 commits behind its fetched main.
That is a historical checkout observation; this audit began with a clean, synchronized main.
Follow [the checkout workflow](../CONTRIBUTING.md#development-workflow) before planning or
integrating changes. Historical handoffs must not be replayed as pending work.

## Scope and boundaries

Build public discovery, identity for nonfinancial actions, topics and profiles, matchmaking and
challenges, hostless live debates, replay, follows, chat, likes, moderation, sponsor presentation,
sharing, nonfinancial analytics, and the supporting operations. The current Express/PostgreSQL
service now implements the nonfinancial preview summarized above. The sections below preserve the
intended acceptance scope and remaining requirements; they do not reset completed work to pending.

This plan does **not** implement wallets signing financial actions, deposits, order books, token
issuance, positions, prices, collateral, fees, payouts, refunds, withdrawals, creator payments,
financial receipts, or a hidden-tally mechanism. Do not simulate these as if they were valid
production behavior. A wallet login can be developed as identity work, but transaction approval
and custody belong to the financial specifications.

Financial systems will later need stable identifiers for users, topics, sides, debates, rules, and
the authoritative live end time. Define those identifiers and versioning now. Do not expose
interim money totals, inferred winners, private positions, or financial status through public APIs,
logs, analytics, search indexes, notifications, or sponsor tools. Public final results will be
supplied by the future settlement domain after its own release gates; the nonfinancial code must
not calculate or declare a winner.

## Decisions to record before dependent work

Keep a short decision record for each choice and link it from the relevant pull request. None of
these choices changes a confirmed product rule.

| Decision                                               | Needed for                  | Acceptance question                                                                                           |
| ------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Browser UI framework and API contract style            | All user-facing work        | Can the team render public pages, share types safely, and test critical journeys?                             |
| Live media approach and provider or self-hosting model | Live debate and replay      | Can it handle two speakers, audience viewing, recording, captions, failure recovery, and expected load?       |
| Email-first sign-in and retained-account migration     | Profiles and permissions    | Can verified login methods link to a stable account without losing history or granting spend authority?       |
| Topic/side mapping and duplicate-topic review          | Topics, matching, histories | Can user-created propositions map consistently to persistent topics without silently moving existing records? |
| Universal debate timing and extension rules            | Timers and engagement       | What are the initial time, maximum duration, eligible extension action, and rule-version semantics?           |
| Content, media retention, and appeal policies          | Replay and moderation       | What can be recorded, removed, retained, appealed, and restored?                                              |
| Product accessibility and reliability targets          | Frontend, media, operations | Which user journeys and measurable thresholds must be met before public availability?                         |

The PRD proposes responsive web and WCAG 2.2 AA verification; record approval or an alternative
before treating either as a fixed launch target. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
provides testable criteria, including media accessibility. Select live-media technology through a
prototype and measured requirements rather than assuming that the browser's
[WebRTC API](https://www.w3.org/TR/webrtc/) alone provides recording, broadcast scale, or recovery.

## Engineering and performance standard for every package

Treat each package as production code, even while the combined paid launch remains blocked. Keep
modules and data ownership explicit, prefer the simplest architecture that meets measured needs,
and use migrations that preserve old readers during deployment. A feature is complete when its
user journey, failure states, observability, accessibility, and operating procedure are complete;
an endpoint alone is not the deliverable.

- **Set budgets before implementation:** agree on expected concurrent viewers, active debates,
  messages per second, supported devices/regions, and media-quality expectations. Record budgets
  for page load and interaction, API p95/p99 latency, live join time, end-to-end media delay,
  rebuffering, replay start time, and error rate. Measure from the browser as well as the server.
  Numerical targets remain proposed until approved and tested under realistic conditions.
- **Design for predictable growth:** paginate feeds and histories; index query patterns and inspect
  database plans with representative data; bound work per request and per event; use caching and
  content delivery for public pages and replay where measurements support them. Avoid unbounded
  fan-out, polling, and high-cardinality metrics. Replace process-local abuse counters with a
  shared or edge-enforced design before running multiple API instances. Keep load generation and
  production traffic isolated.
- **Protect the critical paths:** define timeouts, retries, idempotency where actions can repeat,
  backpressure, and degraded behavior for media, chat, search, and notifications. Failures must
  not corrupt event state or silently move authoritative timing. Measure recovery after process,
  database, network, and media-service interruptions.
- **Use layered verification:** fast unit tests for domain rules; real PostgreSQL integration tests
  for migrations, permissions, and concurrency; browser end-to-end tests for the main journeys;
  accessibility checks plus human review; and load/soak tests for live viewing, chat, discovery,
  and replay. Test mobile and slow-network behavior, not only a desktop happy path.
- **Ship through reviewable changes:** short-lived branches, focused pull requests, code review,
  required CI, staging verification, migration compatibility checks, and a recorded rollback path.
  Deploy the same immutable artifact that passed checks. Use feature flags for incomplete journeys
  and remove them when the behavior is stable; do not expose unfinished financial actions.
- **Operate what is shipped:** instrument user-centered success/failure and latency, structured
  logs with correlation IDs, traces across browser/API/media boundaries where useful, alerting
  tied to service objectives, and incident runbooks. Assign an owner to each target and review
  actual performance after release rather than treating a load-test pass as permanent proof.

## Work package 1 — Product shell and public discovery

**Build** a responsive web app and public read API. Create topic, proposition, side, debate,
profile, follow, and sponsor-placement domain boundaries using migrations and feature modules.
Give entities stable IDs and public/private field definitions. Replace the messages example in the
product experience only after the new journey works; preserve its migration history. Establish a
small accessible component system and test page designs with viewers and debaters before expanding
the interface.

- Anonymous users can browse upcoming, live, replay, and finalized debates and open topic,
  participant, and debate pages without an account or wallet.
- Search and filters return accurate public states, with pagination and canonical shareable URLs.
- A debate page identifies the proposition, sides, speakers, applicable rule version, sponsor
  identification, and live/replay state. It never displays an unfinalized winner or private tally.
- Automated tests cover public visibility, unpublished/moderated content, pagination, and stable
  links. A mobile and keyboard walkthrough reaches the same core information.
- Search and feeds meet their agreed browser and API latency budgets with representative topics,
  debates, profiles, and traffic; pagination and indexes prevent growth from slowing all users.
- Loading, empty, offline, and error states are understandable without hiding actions or producing
  a layout that shifts unpredictably during media or data loading.

## Work package 2 — Identity, profiles, and social graph

**Build** account-level permissions for profile editing, follows, challenges, and moderation.
Keep public browsing anonymous. Follow the approved [email-first account design](email-first-accounts.md)
with optional linked wallets and retained-credential reconciliation. Do not conflate wallet
connection, login and financial authorization. Prevent duplicate profile ownership when
credentials are linked or changed.

- Users can create and edit permitted profile fields, follow and unfollow people or topics, and
  see a history of their nonfinancial participation.
- The same account's sessions and linked identity changes are auditable. Losing or switching a
  wallet does not silently change which profile or debate rights are active.
- Roles distinguish participant, moderator, and operator; a sponsor role grants no unpublished
  debate data. Authorization tests cover cross-account edits and privileged actions.
- Account deletion, retention, and export behavior are specified before collecting more user data.

## Work package 3 — Topics, matching, challenges, and event lifecycle

**Build** user-created topics, clear event propositions, explicit side mapping, direct challenges,
and matchmaking. Persist a versioned universal ruleset with each event. Model event lifecycle
separately from future financial states: draft, challenged or queued, accepted, scheduled, ready,
live, ended, replay, cancelled/void review, and finalized-publication eligibility as appropriate.
Do not equate live end, paid cutoff, and financial settlement.

- Two distinct debaters accept the same proposition, opposite sides, scheduled start, and rule
  version. Neither can negotiate custom economic or timing rules in the event record.
- Matchmaking and direct challenges both produce the same validated event structure. Expired,
  declined, duplicate, or conflicting acceptances have deterministic outcomes.
- Readiness, no-show, cancellation, and rescheduling paths produce durable history and clear
  notifications under approved policies.
- The server records one authoritative live start and end with UTC timestamps. The future
  financial cutoff derives from that end under an approved rule; this package does not activate
  paid participation or hard-code the proposed 120-hour interpretation.
- Concurrency tests protect a user's active match constraints and prevent double acceptance.

## Work package 4 — Hostless live debate and replay

**Build** speaker media, audience viewing, turn order, server-authoritative timers, reconnect
behavior, bounded extensions once their trigger is approved, recording, replay, and caption or
transcript workflow. Start with a two-speaker prototype that measures latency, recording quality,
failure recovery, accessibility, and expected audience size before choosing the production media
architecture.

- Both speakers complete device/readiness checks; viewers join without taking a speaker seat.
- Turn changes and timers remain consistent after a client disconnect, reload, or device switch.
  Extension requests cannot exceed the event's versioned maximum or apply after live end.
- A dropped speaker, failed recording, delayed media, or operator pause follows an explicit
  state transition and produces a visible incident record.
- The replay is associated with the original event and can remain part of its persistent history.
  It does not imply that financial participation is open or that a result is final.
- Captions/transcripts, keyboard controls, focus behavior, reduced motion, and mobile playback
  are verified against the approved accessibility target.
- Load and recovery trials measure speaker reconnection, audience join time, media delay,
  recording completeness, and replay startup against the agreed budgets at expected concurrency.

## Work package 5 — Community, moderation, and distribution

**Build** chat, likes, reporting, case review, enforcement, appeals, event links,
QR/share metadata, and basic broadcast overlays. Separate visible engagement from official
event support. **Defer sponsor identification, sponsor tools, placements, and exposure
tracking** to a separately reviewed package. No sponsor or financial workflow is included here.

- Chat and reactions have abuse limits, report flows, and moderation states. Deleting unsafe
  public content preserves the internal audit record and appeal trail under the retention policy.
- Moderators can pause or restrict nonfinancial activity with reason codes and a review trail;
  they cannot publish a winner or alter future market settlement.
- No-show, video interruption, report, removal, and appeal exercises are documented and tested.
- Shared links and overlays display only permitted public fields and do not reveal a hidden
  tally or suggest that visible likes determine the official winner.
- Sponsor identification, placements, delivered-exposure measurement, billing, revenue
  allocation, and winning-debater payments remain out of scope.

The moderation roles, reason codes, content states, retention, and appeal policy for this
package are defined in [decision 0005](decisions/0005-community-moderation-distribution.md).
The [historical media gate](media-trial-report.md#work-package-5-readiness-gate) has later
[playback](media-playback-trial.md) and [hosted replay](replay-starter-trial-2026-10-07.md)
evidence. Those records verify selected paths, while the full physical-device and measured
acceptance envelope remains open. Community development has proceeded; production acceptance
still requires the outstanding checks.

## Work package 6 — Measurement and operating readiness

Implementation merged through [PR #17](https://github.com/Boufe/YapArena/pull/17). The
[measurement contract and proposed metric](measurement-operations.md) records product approval of
the 28-day returning participant **definition only**. The 30% threshold and use as a launch gate
remain unapproved. The [operating trial record](operating-readiness-trial.md) distinguishes CI and local evidence
from open staging, provider, physical-device, and media/community release gates.

**Build** consent-aware, low-cardinality product events for public discovery, watch time,
matching, debate completion, replay, follows, reports, and return visits. Segment founder and
independent activity. Do not equate wallets with unique people or count market activity before
the markets exist. Approve the PRD's proposed primary metric and thresholds before using them
as success gates.

- Dashboards answer whether users can discover, watch, match, finish, and return to a different
  debate or topic; definitions and consent/retention are documented.
- Staging deploys the web app, API, database, and chosen media system with reproducible
  migrations, smoke tests, backups, restore checks, and rollback instructions.
- CI runs the relevant unit, database integration, browser, accessibility, and contract checks;
  release candidates additionally pass measured load and failure exercises. Protect `main`
  with required checks and review the results before promotion.
- Measure the critical user journeys end to end, including media and replay. Set initial service
  objectives from observed user needs and load tests; [Google's SRE guidance](https://sre.google/workbook/implementing-slos/)
  recommends user-centered objectives rather than relying only on component health.
- Run accessibility review, moderation drills, media failure drills, and privacy checks against
  actual browser and mobile behavior. Record unresolved failures and owners.

## Work package 7 — Recaps and later nonfinancial features

After the P0 journeys operate together, add the PRD's P1 recap-production workflow and richer
broadcast overlays. Recaps may use a finalized result supplied by the future settlement domain;
they must never infer one from chat, likes, watch activity, or an unfinished event. Editorial
tools need media rights, caption review, source-event links, correction history, and publication
permissions. Verify that clips and overlays cannot expose protected data before official reveal.

Seasons, complex ratings, and native apps remain later work. Define their product rules and demand
first; do not invent ranking formulas or duplicate an unproven browser experience on another
platform. Each later feature inherits the same security, accessibility, performance, and release
gates as the core.

## Integration and completion criteria

Deliver these work packages as reviewed pull requests with migrations, API/UI behavior, meaningful
tests, and updated user-facing docs. Prefer vertical slices that can be demonstrated end to end:
discover an event, challenge an opponent, complete a live debate, watch its replay, and handle a
moderation report. These slices are development milestones, not independent paid launches.

The nonfinancial work is ready for integration when stable IDs, rules, phases, permissions, and
live-end timestamps can be consumed by both future markets without reinterpreting past events;
the public surfaces reveal no protected interim financial data; and the core journeys work in
staging under the agreed accessibility and reliability targets. The product is **not** ready to
accept funds at that point. The two markets still require their approved specifications, tests,
specialist review, and combined [pre-funds evidence](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds).
