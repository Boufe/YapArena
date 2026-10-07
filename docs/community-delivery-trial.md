# Durable community delivery trial — 2026-10-07 UTC

The initial phase below covers local implementation evidence and read-only hosting observations.
It is not production release approval. The service flag remains false in the Blueprint. The
authorized release follow-up at the end records later staging actions separately.

Environment: macOS 15.7.5 (24G624), Node 24.19.0, PostgreSQL 17.10 Homebrew using disposable
SCRAM-authenticated loopback clusters, and headless Chrome 154.0.8037.98. Runtime, owner and admin
logins were distinct. All trial data was synthetic. The browser used independent contexts plus
390×844 phone emulation; physical devices, Firefox and Safari were not exercised.

Base commit: `bc3e92f42aa067c08e4834301a99602323db395a`, branch
`coordination/preserved-shared-work`, with pre-existing uncommitted changes preserved. This is a
dirty-tree trial, not evidence of a released commit. The
[source manifest](evidence/community-delivery-source.json) records SHA-256 hashes of implementation
and harness files. The prerequisite checkpoint is separately documented in the
[delivery guide](community-delivery.md#prerequisite-checkpoint).

## Executed checks

| Check                                                                                      | Actual result                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                                            | PASS, 271 tests; 97.28% lines, 90.50% branches, 96.29% functions, with lint/format/typecheck                                                         |
| `DATABASE_TEST_MODE=host npm run verify:database-isolation`                                | PASS for fresh and upgraded schemas, new runtime log grants/RLS/trigger access, unsafe/browser roles, backend journeys and worker                    |
| `docker compose --env-file .env.example config --quiet`                                    | PASS; validation only, no services started                                                                                                           |
| `COMMUNITY_POSTGRES_MODE=host COMMUNITY_SOAK_SECONDS=60 npm run verify:community-delivery` | PASS for SQL, independent browsers, two Node processes, 500-viewer load, storm/restart, actual paused TCP clients and cleanup                        |
| Default five-minute durable trial                                                          | PASS; 500 viewers, 50 rooms, 3,000 writes, 30,000 samples; 97ms p95 and 49.75MiB RSS growth                                                          |
| `node scripts/verify-community-edge.js`                                                    | FAILED hosted readiness: Chrome negotiated h2 for `/ready`, which returned 503; anonymous stream probe returned 404; no SSE frame/heartbeat evidence |

Sanitized local logs: `/tmp/yaparena-sse-check-final.log`, `/tmp/yaparena-sse-isolation-host.log`,
`/tmp/yaparena-durable-memory-tuned.log`, `/tmp/yaparena-durable-final.log`,
`/tmp/yaparena-edge-check.log`. Isolation catalog snapshots:
`/tmp/yaparena-isolation-726fa02c-evidence`. Temporary logs are machine-local; the repository's
sanitized measurement artifact and source manifest provide portable evidence without credentials.

Portable [measurements](evidence/community-delivery-measurements.json) include the five-minute PASS,
the sixty-second repeat, the failed default-GC run, and the read-only hosted probe. The final client
loading-label correction and clearer screenshot capture were verified by a ten-second full rerun
after the five-minute capacity run: SQL, browser races, 500-stream admission, 100 authenticated writes,
restart/storm/backpressure and cleanup all passed. The manifest identifies the two file versions
which differed from the five-minute browser phase; the server/fanout implementation was unchanged.
Its local screenshots were visually inspected:
[desktop](evidence/community-delivery-desktop.png) and
[phone viewport](evidence/community-delivery-mobile.png). They contain synthetic public chat only.

## Measurements and failure corrections

The full five-minute run passed at 2026-10-07 approximately 02:26 UTC with the same declared
500-stream/50-room/ten-write-per-second budgets. It measured 3,000 authenticated writes and 30,000
client samples: p50 38ms, p95 97ms. The second independent process received all 600 hot-room
mutations. A 500-viewer reconnect storm recovered in 446ms; SIGTERM/restart recovery was 982ms,
including a mutation committed while the process was down. Maximum observed runtime sessions
across the two processes were eight. Baseline RSS was 80.16MiB, peak 129.91MiB and growth 49.75MiB;
peak used/total heap was 47.22/55.48MiB and external memory 5.50MiB. Ten paused TCP clients were
disconnected after 460 stress mutations; final streams and room resources were zero.

The same run's real-PostgreSQL ordering test measured 114ms wait for a concurrent allocation behind
an intentionally held 100ms transaction. Fifty uncontended counter mutations measured p50 0.29ms
and p95 0.79ms, including round trips. Default no-hint active-room reconciliation recovered in
5,007ms. These small local samples are contention evidence, not a claim of unlimited hot-room rate.
Browser observations were 603ms desktop message delivery, 605ms phone viewport delivery, 78ms
reconnect catch-up and 1,172ms moderator-action reflection. They are individual workflow timings,
separate from the 30,000-sample load latency distribution.

The successful 60-second capacity run used `NODE_OPTIONS=--max-semi-space-size=4`, 500 streams,
50 rooms, 600 authenticated writes, 6,000 client delivery samples, and a second independent web
process receiving 120 hot-room changes. Delivery p50 was 38ms and p95 170ms. Reconnecting 500 clients
took 427ms; graceful process restart and durable recovery took 989ms. Baseline RSS was 75.13MiB,
peak 130.59MiB and growth 55.47MiB; peak V8 used/total heap was 47.06/55.98MiB and external memory
5.55MiB. At most eight runtime database sessions were observed across both processes, against the
22-session ceiling. Ten TCP clients stopped reading; 460 synthetic stress mutations caused ten
bounded buffer-pressure disconnects. Final active stream count was zero and room cleanup passed.
Those stress writes deliberately exceed the steady mutation budget to test backpressure.

Real PostgreSQL controls establish rollback without durable events/notifications, concurrent
commit-safe room allocation, eight duplicate sends resolving once, conflicting UUID rejection,
quota preservation, current removal redaction during historical replay, scoped owner lookup,
authorized appeal restoration, pause/resume, retention gaps, topic revocation, and snapshot/read
barriers. They call both actual matching `operatorTransition` and automatic media `tick` ending.
Two persistent runtime listeners are terminated and reconnect/re-LISTEN; active streams recover.
A separate test with no listening or hints uses the production five-second repair interval.
These observations are local transaction evidence, not Supabase pooler evidence.

Browser journeys cover independent author/reporter/moderators/anonymous phone viewers, disconnect
and reconnect, moderation/restoration, older history, preserved anchors, pending reconciliation,
drafts, event ending and topic revocation. The healthy-stream race accepts a real write but drops
its HTTP response, then verifies one canonical DOM row and one stored message. Another holds a
history response containing pre-removal text until the stream has received the removal, then
verifies it cannot resurrect that text. Deterministic interception additionally tests failed and
ambiguous writes, unchanged retries, newer drafts, IME/focus, large decimal IDs, 550-message recovery,
500-row retention, Jump to latest, viewport/zoom and axe WCAG 2.2 checks.

Failures were retained rather than relabeled:

- Initial sandbox trials could not open PostgreSQL/local sockets. The recorded successful trials
  used local-process permission. Docker-backed attempts then failed because the local VM reported
  input/output errors. PostgreSQL 18.4 Docker execution and CI itself remain unperformed here;
  host PostgreSQL 17.10 was used for repeatable real-database validation.
- An early load exceeded the RSS budget; sharing immutable encoded fanout Buffers corrected
  redundant per-viewer encoding. A 60-second default-GC run then passed (102.67MiB growth).
- The first five-minute default-GC run still failed RSS: baseline 70.25MiB, peak 226.03MiB,
  growth 155.78MiB. Storm/restart were 427/883ms and ten pressure disconnects occurred; the p95
  assertion was after the failed memory assertion, so that run is not a capacity PASS.
  Log: `/tmp/yaparena-durable-300-memory-failure.log`. The explicit semi-space setting is now
  present in the image/Compose/Blueprint and the harness; targets were not relaxed.
- New test fixtures initially failed a lifecycle timestamp constraint, asserted before private
  pending reconciliation settled, and placed a heartbeat ahead of initial fanout. Those fixtures
  were corrected and rerun. A repository mock reference and formatting failure were also corrected;
  the final full check passed. None of these failed runs is recorded as passing acceptance.
- A full check running alongside other local trials encountered `ECONNRESET` in an existing
  matching HTTP test and an unexpected 401 in an existing media HTTP fixture. A final `npm run check`
  after the load processes stopped passed all 271 tests. Their production behavior was not changed
  to bypass those failures; the isolated repeat is the quality result recorded above.

## Hosted observations and remaining acceptance

Read-only Render CLI metadata identified `yaparena-staging-web`, plan **Free**, automatic deployments
off, not suspended, at `https://yaparena-staging-web.onrender.com`. The read-only Chrome edge probe
at 2026-10-07 02:12:48 UTC recorded HTTP/2 on readiness, HTTP 503 readiness and HTTP 404 for an
anonymous synthetic stream-route probe. This does not establish a healthy SSE route, timely
proxy delivery or the deployed stream flag. No deployment was attempted to make the check pass.

Still unverified: hosted runtime LISTEN identity and direct/session-pooler behavior, healthy SSE
HTTP/2/frame/heartbeat delivery through the actual proxy/custom domain, deployment drain/recovery,
hosted load/long soak and storage/IO/connection budgets, physical mobile and Firefox/Safari behavior,
and broader concurrent media/account capacity under the Node memory setting. Existing project
product/privacy/accessibility and media release criteria remain separate; this task does not
reverify hosted F04/Data API isolation or supersede its dated prior evidence. Render Free is a
staging plan, not an approved live-event plan. Only public community cross-process fanout is
established locally; existing media-clock and IP abuse-control constraints prevent a whole-app
multi-instance readiness claim. The [operating guide](community-delivery.md) supplies rollout,
rollback, diagnosis and runnable edge/hosted procedures.

## Authorized release follow-up — 2026-10-07

The user authorized review, migration, deployment and synthetic hosted validation. The release was
isolated in `/private/tmp/yaparena-sse-release`, based on reviewed main
`78d72ef2d54fe76090f6755411234b2b63ceaafb`; the shared dirty checkout was preserved. The prerequisites
already exist in merged PR #26 and were retained. Current-main account-session and wallet security
changes and their stricter database-isolation harness were preserved. Only SSE additions, the
synthetic fixtures required by those account-generation invariants, and release evidence are in
the focused branch.

Executed on the isolated release:

- `npm run check`: PASS, 285 tests, 93.24% lines, 90.74% branches, 95.07% functions.
- `DATABASE_TEST_MODE=host npm run verify:database-isolation`: PASS, fresh and upgrade, including
  19 creator/API-mediator membership cases for each scenario. This extends current-main tests;
  the earlier dirty-tree harness result does not substitute for these checks.
- `COMMUNITY_POSTGRES_MODE=host COMMUNITY_SOAK_SECONDS=30 npm run verify:community-delivery`:
  PASS, real PostgreSQL rollback/order/LISTEN, independent browsers and 500 viewers/50 rooms.
  300 authenticated writes, 3,000 delivery samples, p50 39ms/p95 122ms, reconnect storm 425ms,
  graceful restart recovery 901ms, RSS growth 59.16MiB, peak runtime connections eight,
  second-process changes 60, ten slow-client disconnects and zero final streams/rooms.
- `render blueprints validate render.yaml --output json`: PASS against the current workspace.
- Hosted `/ready`: 200 after wake-up; the earlier 503 does not reproduce while the Free service
  is awake. This is consistent with Free cold start, not proof of a configuration fault.
- Hosted preflight at 02:44:53 UTC verified `yaparena_runtime` current/session identity, private
  search path and committed LISTEN over the actual session-pooler port 5432. Client TLS was
  encrypted and certificate-authorized. `pg_stat_ssl` for the upstream pooler-to-database session
  reported false; that field does not describe the independently verified client-to-pooler TLS.
  The actual web environment contained no owner/admin/migration variable, and SSE/Node memory
  options were initially unset. The owner process had its distinct identity.
- Fresh AES-256-GCM backup at 02:48:30 UTC: 192,057 encrypted bytes, authenticated decryption and
  `pg_restore --list` PASS with 419 entries. Application and migration schemas share an exported
  snapshot. Eight existing chat rows were fingerprinted. A full restore was not repeated.

The first isolated capacity run correctly failed because the fixture inserted sessions without
current `auth_generation`; the fixture now selects the account's generation. The subsequent full
trial passed. An initial hosted TLS assertion inspected the pooler's upstream `pg_stat_ssl`; it
was corrected to verify the actual client TLS socket and retain both facts in operator evidence.
No failed attempt is recorded as passed.

Sanitized release logs are `/private/tmp/yaparena-sse-release-check.log`,
`/private/tmp/yaparena-sse-release-isolation.log`, and
`/private/tmp/yaparena-sse-release-delivery.log`. Encrypted backup and sanitized hosted operator
records are retained in the ignored `.env.community-release-20261007/` directory. The separately
retained recovery key was reused; no plaintext archive or credential was committed.

Render remains Free with auto-deploy off. A short staging trial can run on Free; promised live
events require paid compute to avoid idle spin-down and arbitrary Free restarts. The current
cheapest paid instance is 0.5c-512mb ($7/month compute, previously Starter); workspace subscription
and bandwidth are separate. Review [current pricing](https://render.com/pricing) and
[Free limits](https://render.com/docs/free) at purchase time. A workspace upgrade alone does not
remove Free instance limits. No billing setting was changed.

Community SSE uses Express/PostgreSQL and needs no LiveKit upgrade. For actual media, published
[LiveKit limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/) and
[pricing](https://livekit.com/pricing) list Build at 100 concurrent participants and two concurrent
egress recordings, and Ship from $50/month with 1,000 concurrent connections. All live media
viewers and speakers count toward participants. A 500-media-viewer target would exceed Build;
community viewers who never join media do not count. The account's actual LiveKit subscription
could not be inspected because no connected billing browser or applicable billing API was
available. Project-specific limits and usage remain unverified.

## Deployed SSE and media integration follow-up

Reviewed SSE checkpoint `ab59ebbb4a3d67a13654673ee8f438b0a3656bcf` is PR
[#27](https://github.com/Boufe/YapArena/pull/27). Its five CI checks passed in run
`37564030066`, including 318 tests (97.57% lines, 90.90% branches, 96.57% functions),
PostgreSQL 18.4 isolation/durable delivery/browser checks, container and deployment checks.
This later evidence supersedes the initial phase's unperformed-CI statement for that checkpoint.

The separate owner process applied only additive migration `1791335211412` at 02:57 UTC.
All eight existing chat projections matched their pre-migration fingerprint. Runtime DML/RLS
and unsafe-role denial were checked; direct trigger execution remains denied. Render deployment
`dep-db2rait9fdbs7390c3u0` reached live at 02:59:17 UTC on `ab59ebb`. Only the stream flag and
`NODE_OPTIONS=--max-semi-space-size=4` changed; runtime credentials and other settings were retained.
Auto-deploy remains off and billing remains Free. The actual Chrome edge trial passed at
03:00:27 UTC: readiness and stream both HTTP/2, initial frame 137ms, heartbeat 12,366ms.
The running listener's runtime identity and idle `LISTEN yaparena_community_v1` statement were
verified at 03:16:43 UTC. Supavisor rewrites `application_name` to its own name; a name-only
filter produced a false negative, corrected by inspecting identity and the idle statement.

The hosted browser trial initially selected a pre-existing moderation case because selectors
were not fixture-scoped. That failed trial is not a PASS. The compensating cleanup at 03:08:14 UTC
restored the original case projection from the authenticated backup and the original message's
public state through a newer restoration revision (revision/stream revision 2). It deleted the
single synthetic action audit and fixture actor. All eight original public semantic projections
matched the backup; revision and stream-log history intentionally retain the newer restoration.
No synthetic accounts remained. Selectors now use unique fixture detail and exact case ID.
A later profile-form trial raced its initial hydration; it now waits for the loaded form.

The next hosted run exposed a product fanout race: an older resume joining during an in-flight
read could receive the newer cohort's batch and skip ten messages. A controlled unit test
reproduced the missing first batch before the fix. Each read now captures its subscriber cohort;
new arrivals receive a subsequent read using their cursor. A real-PostgreSQL barrier regression
also requires all twenty intervening messages. Until the fixed commit is checked and deployed,
the earlier staged checkpoint must not be treated as recovery acceptance.

Media commit `1bc118fc0c53faa945b404eb07e8b33687e8f8e0` was integrated as
`095e99713e34ee93479ccceb74e80aa3e7d2f4c6` after the reviewed security/SSE commits. Conflicts
preserve stream admission, origin/abuse controls, telemetry rate limits and both bundles. Before
the newly discovered fanout fix, combined checks passed 316 tests (94.22% lines, 91.54% branches,
95.49% functions), current-main isolation fresh/upgrade cases, and FFmpeg synthetic three-rendition
packaging/decoding. The 30-second combined real-PG/browser/two-process load passed 500 streams,
50 rooms, 300 authenticated writes and 3,000 samples: p50 40ms/p95 125ms, reconnect 495ms,
local restart 876ms, RSS growth 57.11MiB, eight runtime sessions, ten slow-client disconnects,
and zero final streams/rooms. Logs: `/private/tmp/yaparena-combined-{check,isolation,packaging,delivery}.log`.

The existing service's media credentials were inspected safely at 03:25:38 UTC: LiveKit APIs
responded, zero rooms/participants/active egress existed, and R2 HEAD bucket succeeded. Media is configured by the existing credentials; the private replay edge is not configured. Render has R2 storage keys but
no Workers deployment token. This is credential-connectivity evidence, not recording/playback or
plan evidence. The user is supplying the deployment token through an ignored local operator file.
Physical devices, native Safari/Firefox playback, media quality/load, replay edge, regional timings,
long hosted soak and reliable paid hosting remain separate unverified release criteria.

The fixed checkout then passed `npm run check`: 317 tests, 94.23% lines, 91.57% branches,
95.49% functions. The current-main isolation gate passed again with 19 creator/API-mediator
cases in both fresh and upgrade scenarios (catalogs `/tmp/yaparena-isolation-8f15cc1b-evidence`).
The controlled older-resume regression passed both unit and real-PostgreSQL execution.
Postflight at 03:29:38 UTC confirmed the eight protected public message projections unchanged
and zero synthetic browser accounts. Logs are `/private/tmp/yaparena-combined-fixed-*.log`.

A five-minute combined run on the pre-fix server also passed its capacity phase: 3,000 HTTPS
writes, 30,000 samples, p50 40ms/p95 128ms, reconnect 410ms, local restart 905ms, RSS growth
43.84MiB, eight runtime sessions, ten slow-client disconnects and zero final resources. That
capacity observation does not override the separately exposed in-flight reconnect race.
The fixed server's final release soak is recorded separately after completion.

The fixed 30-second full durable trial passed: 500 streams/50 rooms, 300 authenticated writes,
3,000 samples, p50 40ms/p95 97ms, reconnect 433ms, restart 906ms, RSS growth 56.36MiB,
eight runtime sessions, 60 second-process mutations, ten slow-client disconnects and zero
final resources. The final fixed real-PG run measured default no-hint repair at 5,008ms.

The media preflight's initial `MEDIA_ENABLED` inference was incorrect: that variable does not
exist. At 03:32:03 UTC the actual application configuration parser confirmed media is configured.
The stored sanitized preflight was corrected; provider access/zero-activity observations hold.
The saved Cloudflare token allowed Worker enumeration, but the first reviewed-code upload
received HTTP 403. No Worker was created, route enabled, web replay variable changed or plan
upgraded. A deployment-authorized token and staging hostname choice are pending.

## Receipt retention, coordinated media audit and final staging checks

The additional prerequisite checkpoint `d8ebbc1` binds retained and purged submissions in
private body-free receipts. It prevents a retry after retention from becoming a new message.
Native PostgreSQL established existing-row backfill, eight concurrent purged retries, conflict
rejection, direct duplicate rollback without a cursor advance, owner reconciliation, immutable
identity and receipt rollback. The first CI attempts (`37569793779`, `37570397944`) failed because
plain PostgreSQL has no optional Supabase `anon` role. Unreleased migration correction `9f32a62`
conditionally revokes provider roles when present; the native harness now migrates before
creating its later browser-role probes. Existing applied migrations were not edited.

`9f32a6206af6ebf9dd6c3f5a2cebde7bfeeb1897` passed all five CI jobs in run `37570946277`,
including 354 tests. Native isolation fresh/upgrade passed with 19 membership cases per
scenario; the 30-second PostgreSQL/browser/500-stream repeat also passed. A separate verified
owner applied `1791345540042` at 04:29 UTC after a fresh encrypted backup. All eight existing
chat projections were unchanged and two receipts backfilled. Both browser roles have no receipt
access; runtime DELETE and identity/hash updates remain denied. The backup authenticated
decryption/archive listing passed (204,006 bytes, 442 entries); no full restore was repeated.
Render `9f32a62` reached live at 04:36:01 UTC, retaining runtime credentials and other settings.

The five-minute native soak completed at 04:19 UTC on `72e41b5` with the receipt DDL before
the optional-role portability correction: 500 viewers/50 rooms, 3,000 authenticated HTTP
writes, 30,000 samples, p50 39ms/p95 157ms, reconnect 471ms, local restart 872ms, 53.69MiB RSS
growth, nine runtime sessions, 600 second-process mutations, ten slow-client disconnects and
zero final streams/rooms. Counter serialization waited 114ms behind the held 100ms transaction;
uncontended p50/p95 were 0.37/0.79ms; no-hint repair was 5,003ms. This is not a clean-`9f32a62`
five-minute execution; the current-commit portability repeat is separate.

Hosted `9f32a62` trial at 04:53:50 UTC passed the declared steady-delivery/reconnect/resource
budgets: 500 SSE viewers/50 rooms, 600 separate-owner SQL mutations, 6,000 samples, p50 88ms/
p95 314ms, reconnect 5,592ms, baseline/peak RSS 99.57/124.46MiB (24.89MiB growth), ten runtime
sessions including the observer, and zero final streams/rooms. It is not hosted HTTP-send
throughput or media capacity. Process CPU averaged 0.0431 cores over 60.16 seconds; maximum
observed event-loop p99 was 87.36ms and average pool wait 0.15ms. These process measurements
do not establish provider CPU quota, throttling or whole-app capacity. The deployed runtime
idle LISTEN identity was verified.

Controlled Render Free restart again took 28,740ms, exceeding the provisional 10-second total
recovery target. Steady delivery was within its target, while full restart was not. A matched
paid-plan trial is unperformed, so upgrading alone is not claimed to establish capacity or
close the recovery target. Logs: `/private/tmp/yaparena-hosted-capacity-9f32a62.log`,
`/private/tmp/yaparena-receipt-final-soak.log`, and
`/private/tmp/yaparena-receipt-portability-{isolation,delivery}.log`.

Direct Codex-thread coordination with “Create worktree and follow plan” became available at
04:34 UTC. That agent audited the combined implementation and contributed focused recovery
commit `24a0974`, integrated as `d582a99`. Its reproduced browser history, replay renewal and
retry-budget issues received failing-before/passing-after regressions. It acknowledged the
final code integration at `3e27b2a` after independently passing 29 focused tests. The final
local quality check passed 332 tests (94.33% lines, 91.70% branches, 95.28% functions). This
code-review acknowledgment is not production approval; final deployed media checks are recorded
in the media trial. The original checkout and unrelated changes remain preserved.

## Final integrated code, HTTP/2 and cleanup — 2026-10-07 UTC

Combined code `3e27b2ababa79c3f614963e7ea8046a6aae1a5d2` passed all five jobs in
[CI run 37573539274](https://github.com/Boufe/YapArena/actions/runs/37573539274): 365 tests,
97.92% lines, 91.80% branches and 96.51% functions, including real PostgreSQL 18.4 integration,
image/security and synthetic packaging checks. Local Node 24.19.0 passed 332 tests with
94.33% lines, 91.70% branches and 95.28% functions. Native PostgreSQL 17.10 isolation passed
fresh and upgrade scenarios with 19 membership cases each. The default Docker attempt failed
because the local Docker command was unavailable; the supported native execution passed.
Logs: `/private/tmp/yaparena-media-hls-callback-check.log`,
`/private/tmp/yaparena-media-final-native-isolation.log`, and
`/private/tmp/yaparena-media-final-ci-quality.log`. No Docker runtime is required for this
local operator workflow; CI separately validates its container path.

Render deployment `dep-db2t2u8m7kps73c7j2u0` reached live at 04:59:21 UTC. At 05:00:48 UTC,
the actual Chrome browser-to-edge route returned HTTP/2 for readiness and SSE: 128ms first
frame and 5,895ms to the next scheduled heartbeat. The heartbeat has no durable ID. At
05:01 UTC independent browser contexts passed pending/lost-HTTP reconciliation, delayed
history, pagination, drafts, disconnect/reconnect, pause/resume, removal/restoration, event
ending and topic visibility revocation. Desktop/emulated-phone update samples were
1,093/1,095ms and reconnect 180ms; the 1,606ms moderation workflow includes HTTPS mutation
processing and is separate from the steady commit-delivery p95 measurement. Phone emulation
does not establish physical-device acceptance. Logs:
`/private/tmp/yaparena-edge-3e27b2a.log` and
`/private/tmp/yaparena-community-browser-3e27b2a.log`.

The synthetic media recording, HLS renewal/removal and natural capability-expiry trials
completed; their precise scope and earlier failed attempts are in the media trial. Cleanup
at 05:20:50 UTC deleted all 101 owned R2 objects, the synthetic event/topic and two accounts;
no owned provider room or active recording remained. At 05:21:39 UTC all eight protected
pre-existing chat projections still matched the pre-receipt backup and zero synthetic
accounts remained. The one-room canary configuration was removed with all other settings
preserved; the private Worker remains deployed for future staging trials. Deployment `dep-db2tioajnfac73803v80` applied that removal at 05:32:46 UTC.
At 05:34:36 UTC readiness was 200, active streams/rooms were zero and exactly one idle
runtime LISTEN connection remained. All 19 remaining environment entries were preserved.

At 05:21 UTC the actual service reported Node 24.21.0; its certificate-verified session-pooler
connection reported PostgreSQL 17.6 and runtime identity `yaparena_runtime`. Browser/public
API access to hosted Data API isolation remains unverified; catalog and privilege probes
alone do not establish that separate gate. Render Free restart, long hosted soak, paid-plan
comparison, physical-browser coverage, whole-app clock/shared-IP scaling and the existing
privacy/financial gates remain open. The provisional capacity targets are not approved
production limits.

The final documentation/hosted-operator working tree repeated `npm run check`: 332 tests,
94.33% lines/91.70% branches/95.28% functions. The first sandbox execution failed HTTP
server binding with `listen EPERM`; the authorized unrestricted repeat passed. Both logs
are retained as `/private/tmp/yaparena-final-evidence-check{,-unrestricted}.log`.
