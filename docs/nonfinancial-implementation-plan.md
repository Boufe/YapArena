# YAP Arena nonfinancial implementation plan

This plan turns the [product PRD](product-prd.md) into buildable work for the product experience
outside money-linked code. The [specification outlines](product-specification-outlines.md) govern
the separate event-market, hidden-tally, ongoing-market, and eligibility work. This document is an
implementation plan, not a new product decision. Its milestones are development increments; the
confirmed first **paid** release still includes both markets together.

## Scope and boundaries

Build public discovery, identity for nonfinancial actions, topics and profiles, matchmaking and
challenges, hostless live debates, replay, follows, chat, likes, moderation, sponsor presentation,
sharing, nonfinancial analytics, and the supporting operations. The current Express/PostgreSQL
service, email/password sessions, migrations, CI, metrics, and example messages API are the starting
point. No product frontend or debate feature exists yet.

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
| Wallet-first sign-in and account migration design      | Profiles and permissions    | Can an existing account move to or link a wallet without losing history or granting spend authority?          |
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
Keep public browsing anonymous. Design the transition from current email/password sessions to
wallet-first product access explicitly; do not conflate wallet connection, login, and a financial
authorization. Prevent duplicate profile ownership when credentials are linked or changed.

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
The [media trial gate](media-trial-report.md#work-package-5-readiness-gate) remains open until a
measured desktop and mobile trial is recorded. Community development can proceed while it is
open; passing code checks alone does not approve a production rollout.

## Work package 6 — Measurement and operating readiness

Implementation is in progress on `feature/measurement-operating-readiness`. The
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
