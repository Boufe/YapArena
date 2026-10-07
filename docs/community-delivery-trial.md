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
