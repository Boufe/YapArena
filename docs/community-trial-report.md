# Community local trial — 2026-10-01

The Work Package 5 implementation was exercised against local PostgreSQL and the local Docker
app. Synthetic accounts and event records were removed after the browser run. The test event
had no media provider, so this record verifies media-independent community behavior only.

- PostgreSQL integration: concurrent posts allowed one message under the ten-second account
  limit; repeated likes stayed at one per account; duplicate and sixth reports were blocked;
  chat removal hid the public message while private evidence retained its text; independent
  appeal review restored it; restriction and event chat pause blocked only the intended
  community writes. The event remained `live` with its original rules snapshot.
- Headless Chrome desktop: registered and published profiles, posted chat, received a rate-limit
  message, liked an event, reported chat and the event, reviewed the case as a moderator,
  removed the message, submitted an appeal, and restored the message through a different
  moderator. The QR SVG and overlay routes loaded from the canonical event URL.
- Phone-sized Chrome viewport (390 × 844): the event page had no horizontal overflow and the
  community controls stacked into one column. axe-core WCAG 2/2.1 A and AA checks found no
  violations in the community section at desktop or phone width, or in the moderator main
  content. This is an automated scan, not a physical-device or screen-reader review.

Visual evidence: [desktop event](evidence/community-desktop.png),
[phone-sized event](evidence/community-mobile.png), and
[moderation queue](evidence/community-moderation.png). Screenshots contain only synthetic text.

Still open: documented staging checks on desktop and physical mobile browsers, keyboard and
screen-reader review, a documented QR scan with a phone, link previews in sharing apps,
overlay compositor checks, moderation volume/latency, the privacy retention review, and the
separate measured media trial in
[the media report](media-trial-report.md#work-package-5-readiness-gate). No production
readiness claim follows from this local trial.

## Live chat follow-up — 2026-10-01

The watch page now places chat beside video on desktop and directly below it at phone width.
In a local two-viewer browser run, a sent message appeared in the other desktop session and
the phone viewport without either page refreshing. The sender saw an inline rate-limit error
and retained the unsent draft. After one viewer went offline, messages arrived in order on
reconnect without duplicate IDs. A 55-message backlog was drained across two sync pages;
the reader could stay scrolled up and use **Jump to latest**. A fresh viewer loaded older
messages, kept them while new ones arrived, and saw an older message removed by moderation
without refreshing. Moderator removal, appeal restoration, chat pause, and resume were
reflected in both open viewers. The watch and chat
area and the community section passed axe-core WCAG 2/2.1 A/AA checks at both sizes, with no
horizontal overflow at 390 × 844.

The first run found that the general API limit was consumed by live polling and that the
chat form remained visually displayed during a pause because of a CSS rule. Both were fixed
before the successful repeat. The screenshots above now show the updated watch/chat layout.
This remains a local Chrome trial; physical mobile, screen-reader, and staging multi-viewer
checks are still open.

## Staging tester feedback — 2026-10-01

The tester reported that event chat and the QR code worked on staging, then confirmed a
suggested follow-up check also worked. The specific follow-up action, devices, browsers, and
timings were not recorded, so this is qualitative feedback rather than evidence for each of
the separate multi-viewer, reconnect, moderation, mobile, or phone-scanning checks above.
The measured desktop and mobile media trial remains open.

## Immediate feedback and compact chat — 2026-10-06

Implementation and validation used the existing working tree, preserving its independent F04
configuration/database changes and browser fixture URL support. No hosted deployment, schema change,
real audience test or production data was used. Fixtures, bodies and screenshot content are synthetic.

The baseline full `npm run check` failed with 235 pre-existing ESLint errors in ignored local
`.env.f02-*`, `.env.f03-*` and `.env.f04-*` trial artifacts that ESLint still traverses. Those files
were left untouched. Baseline formatting and type checks passed. An isolated baseline copy under
Node.js 24.21.0 passed all 233 tests with 97.45% line, 90.28% branch and 98.03% function coverage.
The default host Node was 25.6.1; the final suite used the repository-required Node 24. The sandbox
also blocked local Supertest sockets; the actual successful suites ran with local socket access.

Follow-up clarified that F04 had already merged in PR #20 on 2026-10-06. The shared working tree
was still on the older `coordination/preserved-shared-work` branch; the migration dependency does
not require repeating F04. ESLint now excludes ignored `.env.*/` trial directories, consistent with
the existing Git exclusions, without changing their contents. The full check subsequently passed.
The chat-only patch was also applied to an isolated copy of current `main` at `2ff8b868d56b`,
preserving the merged F02/F03 account code, F04 provisioning fixes and newer account styles.
That copy passed the full check with 262 tests, zero failures and 92.80% line, 90.95% branch and
96.41% function coverage. The disposable PostgreSQL 17.10/runtime/browser trial also passed there,
including concurrency, expiry, history, moderation, draft recovery and automated accessibility.
The shared checkout was not switched or reset, and no commit, PR or hosted change was made.

Final checks completed:

- Full `npm run check` passed after the local-trial exclusion fix. The initial 235 lint errors
  were baseline tooling failures, not chat regressions; the trial artifacts remain untouched.
  Formatting, strict types and build passed. All 248 tests passed under Node 24.21.0,
  with 97.59% line, 90.84% branch and 98.14% function coverage, exceeding all 90% thresholds.
- The isolated PostgreSQL/runtime/browser harness passed on PostgreSQL 17.10. Docker could not
  create or execute containers because its VM temporary storage returned I/O errors. The host
  fallback created a separate SCRAM-authenticated cluster, used distinct administrator, owner and
  runtime logins, then stopped and removed it. Existing databases and Docker services were unchanged.
  PostgreSQL 18.4 Docker verification and the independent full F04 harness were not completed here.
- SQL verification passed eight concurrent identical posts producing one stored acceptance,
  concurrent distinct keys respecting the interval, competing payload conflicts, owner-only feed
  correlation, both posting windows, accepted retries after restriction/profile/role/pause/close
  changes, current event/topic access denial, removal redaction and restoration revisions.
  The normal runtime retention job purged a synthetic acceptance older than 365 days; reusing its
  key afterward created a new eligible message, as documented. A pre-migration keyless message
  survived unchanged, and the new trigger had no callable browser or runtime EXECUTE privilege.
- Real local API/browser journeys passed sign-in/profile publication, chat, likes, reports,
  independent moderator removal/appeal/restoration, pause/resume, older history, reconnect,
  multi-page backlog, unread counts and Jump to latest. One observed desktop delivery took 2,204ms,
  phone-viewport delivery 2,208ms, reconnect catch-up 25ms and moderation reflection 1,685ms. These
  are individual local observations, not latency percentiles or a capacity result.
- Deterministic Chrome transport interception passed response-first/feed-first acknowledgment,
  repeated delivery, a lost acknowledgment after synthetic commit, unchanged-key retry through both the retry action and an unchanged recovered draft,
  rejected/ambiguous errors, recovery appended to later typing, edited text receiving a new key,
  removal before a stale acknowledgment, legitimate restoration, and no automatic send on reconnect.
  It checked decimal IDs above JavaScript's safe integer range and a preceding message that would
  be skipped if POST advanced the cursor. Confirmation reused the original DOM row, preserved reader
  position, added no unread count and announced each confirmation once in DOM mutation checks.
  State tests also verified that an outstanding response retains moderation tombstones and that a
  stale owner acknowledgment binds to the newer removed state without republishing text.
- Keyboard tests passed Enter, Shift+Enter, composition events/229 handling, composer focus on send
  and focus remaining on another control after acknowledgment. A 550-message catch-up retained a
  reader's history position with at most 500 visible server rows; Jump to latest reloaded the
  retained tail. Reduced-height/width changes preserved a reader following the latest row.
- axe-core WCAG 2/2.1/2.2 A/AA scans found no violations in the changed chat panel at 1280×900,
  390×844, 320×640 and 390×400, and at 200% CSS zoom. The real phone emulation used touch and checked
  44px message actions. Long author names, unbroken long text and multiline plain text were tested.
  Composer containment and a usable feed height were asserted. The shared header now wraps at
  zoom/narrow widths. A pre-existing small community link target found by the expanded scan was
  enlarged. The optional measurement prompt was dismissed for screenshot review.

Visual evidence: [desktop feedback](evidence/chat-feedback-desktop.png) and
[phone viewport feedback](evidence/chat-feedback-mobile.png). These were visually inspected; they
show synthetic sending, rejection, recovery and cooldown feedback with the composer in the panel.

| Acceptance area                                    | Assessment from this change                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediate feedback and draft safety                | Implemented; held requests and failure/retry races exercised in a real browser. Recoverable text remains in page memory only.                                                                                           |
| Idempotency and posting allowances                 | Implemented; UUID validation/API tests and real PostgreSQL concurrency/expiry checks passed. Legacy keyless requests retain transitional limitations.                                                                   |
| Reconciliation, moderation and cursor safety       | Implemented; both arrival orders, late responses, versioned removals/restoration, large IDs and cursor gaps exercised.                                                                                                  |
| History, reconnect, retention and reading position | Implemented; real polling and deterministic 550-message retention/Jump tests passed.                                                                                                                                    |
| Compact, accessible interaction                    | Local keyboard/focus, touch-emulation sizing, viewport/zoom and automated WCAG scans passed. Physical-device and assistive-technology review remain open.                                                               |
| Migration, isolation and rollback                  | Additive migration/legacy-row/runtime privilege behavior verified locally. Migration-first coordinated rollout and chat pause before a legacy-server rollback are documented. Hosted promotion remains a separate gate. |

Still unverified: native browser zoom across supported browsers, physical iOS/Android keyboards and
touch, IME behavior on physical devices, screen-reader speech/focus behavior, staging multi-viewer
quality, audience/shared-network load, hosted migration-lock duration, hosted isolation and the
repository's separate media, privacy and operating readiness gates. CSS zoom, DOM announcement
checks and reduced viewport height are automated approximations, not replacements for those
reviews. Reload/navigation recovery is outside this change. No production-readiness gate is closed
by this local feature assessment.
