# Shared SSE/media integration handoff

For “Create worktree and follow plan”: media commit `1bc118f` is integrated as `095e997`
in `/private/tmp/yaparena-sse-release`, branch `feature/community-delivery`,
[PR #27](https://github.com/Boufe/YapArena/pull/27). The base is reviewed main `78d72ef`,
including concurrent account/session/wallet/container/database security fixes and optimistic
chat prerequisites. Shared conflicts preserve stream admission and media telemetry controls.
The original dirty checkout and the media agent's checkout remain preserved.

Final application code is `3e27b2ababa79c3f614963e7ea8046a6aae1a5d2`. All five jobs in
[CI run 37573539274](https://github.com/Boufe/YapArena/actions/runs/37573539274) passed:
365 tests, 97.92% lines/91.80% branches/96.51% functions. Local Node 24.19.0 quality passed
332 tests, 94.33%/91.70%/95.28%. Native PostgreSQL 17.10 isolation passed fresh and upgrade
with 19 membership cases each. The default local Docker attempt failed; native execution
passed and CI separately exercised PostgreSQL 18.4/container checks.

Direct Codex-thread communication became available at 04:34 UTC. The media agent audited
the four requested steps and contributed `24a0974`, integrated as `d582a99`, to bound retry
exhaustion. It reproduced cached-page, renewal and suspension races; failing-before/passing-
after regressions accompany `2fb30d6` and `3e27b2a`. It explicitly accepted the final code
integration after independently passing 29 focused tests. This is code-review acknowledgment,
not production approval. Final trial and cleanup results were sent directly to that discussion.

## Original community scope

Durable ordered room events, current-visibility recovery, HTTPS writes, one stream per page,
shared fanout, runtime LISTEN reconnect/reconciliation, client revision protection, bounded
admission/backpressure/resources and operating documentation are implemented. Captured
subscriber cohorts fix an older-resume/in-flight-read race (`0450dbc`), with unit and real
PostgreSQL barrier regressions. All public-state writers are integrated without claiming
whole-app multi-instance readiness.

Separate prerequisite follow-up `d8ebbc1` preserves canonical sender/room idempotency after
365-day body retention with private immutable body-free receipts. Real PostgreSQL verifies
purged/concurrent retries, conflicts, direct duplicate rollback and no extra allowance/cursor
consumption. Portability correction `9f32a62` handles optional provider roles before staging
migration; applied migrations were not edited. A separate verified owner applied the additive
migration at 04:29 UTC: eight original projections unchanged, two receipts backfilled,
browser access denied, runtime binding/hash mutation and DELETE denied. Encrypted backup
passed authenticated decryption/archive listing; full restore was not repeated. Runtime TLS/
session-pooler 5432 LISTEN identity is verified. Owner credentials never entered the service.

The five-minute native trial on `72e41b5` before the optional-role correction passed 500 SSE
viewers/50 rooms, 3,000 HTTP writes/30,000 samples, 157ms p95, 471ms reconnect, 872ms local
restart, 53.69MiB RSS growth and zero final resources. Current `9f32a62` portability repeat
passed. Latest hosted `9f32a62` 60-second trial: 500/50, 600 separate-owner SQL mutations/
6,000 samples, p95 314ms, reconnect 5,592ms, RSS growth 24.89MiB, ten runtime sessions
including observer and zero final streams/rooms. CPU averaged 0.0431 cores, observed loop p99
maximum 87.36ms, average pool wait 0.15ms. This is not hosted HTTP-write/media capacity or
proof of provider throttling/paid-plan equivalence. Render Free restart took 28,740ms,
failing the provisional 10-second target.

Deployed `3e27b2a` actual Chrome HTTP/2 readiness/SSE passed at 05:00 UTC (128ms first frame,
5,895ms next heartbeat, no durable heartbeat ID). Independent community journeys passed
pending reconciliation, delayed history, moderation/restoration, pagination, drafts, reconnect,
pause/resume, ending and visibility revocation. Emulated phone coverage is not physical-device
acceptance. Actual runtime is Node 24.21.0/PostgreSQL 17.6.

## Media steps and staging cleanup

Actual `9f32a62` cloud Chrome trial passed two synthetic speakers, two rendered viewer videos
(736ms), deliberate provider-track mute before/after refresh (1,571ms), operator resume after
pause, authorized second-turn audio, ending and real recording webhook completion. Earlier
refresh failures isolated SDK beforeunload clearing intent; `72e41b5` and its regression fix
this. The real 61.18458-second recording was packaged/decode-checked in all three renditions
and uploaded privately: 98 files, ready marker last. Reviewed synthetic cue labels do not
establish transcription accuracy.

The private Worker is deployed at
`https://yaparena-replay-staging.yaparena-staging.workers.dev`. Private R2 probing passed,
unsigned access is 403 and deployment credentials stay in ignored `.env.deploy`, outside
Render. A custom HTTPS domain remains a production gate. The one-room app/edge canary
preserved eight published ready legacy replays with their signed-MP4 path.

Two full `3e27b2a` HLS trials passed at 05:10 and 05:16 UTC, the latter with the reusable
operator module: 858/991ms video startup, captions, keyboard, seek/rate/pause preservation
through renewal, CORS/HEAD/range and signature denial. Removal denied fresh grants and
stopped/cleared the player. Issued access worked before expiry; both runs waited for actual
300-second expiry and observed 403. First application renewal alone was accelerated to
45 seconds; signature lifetime stayed unchanged. Cache-hit provenance was unobserved;
global purge was not performed. Earlier disabled-caption/wrong-status-phrase harness
attempts remain failures rather than retrospective passes.

At 05:20 UTC all 101 owned R2 objects, fixture event/topic and two accounts were deleted;
zero owned LiveKit rooms/active egress remained. At 05:21 UTC all eight protected existing
chat projections matched the backup and zero synthetic accounts remained. An earlier fixture
changed a pre-existing moderation case; authenticated-backup compensation restored its
semantic projection through a newer revision. Later selectors use exact synthetic scope.

Three canary settings were removed using full provider pagination (22 entries to 19).
Cleanup deployment `dep-db2tioajnfac73803v80` reached live at 05:32:46 UTC with `3e27b2a`.
Readiness was 200 at 05:34 UTC, zero streams/rooms remained, and one idle runtime LISTEN
connection was verified. All remaining settings are preserved; the private Worker remains
available and legacy MP4 delivery continues. No billing change was made.

| Requested step                                                       | Current status                                                                                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrate `1bc118f` with security/SSE and rerun required checks      | Integrated; full local quality, native isolation and five CI jobs passed                                                                        |
| Deploy private edge, record/package/play replay and validate removal | Actual Worker/R2, provider recording, HLS/captions/seek/renewal/removal/expiry passed; canary cleaned                                           |
| Browser sound, disconnect, mute and foreground recovery              | Actual Chrome rendering/mute/refresh/end observed; recovery regressions pass; acoustic/controlled-network/real foreground acceptance unverified |
| iPhone SE 2, Pixel 4a, 500 media viewers/five debates                | Unperformed; physical hardware and confirmed provider quotas remain release gates                                                               |

## Remaining release decisions

Reliable promised events require paid Render compute (current entry tier $7/month), then a
matched capacity/restart trial; upgrading alone does not establish the 10-second target.
SSE needs no LiveKit upgrade. If currently on Build, 510 participants/five recordings exceed
100-participant/two-egress caps; Ship or approved limits are needed. Workers Free's 100k
requests/day cannot cover an hour of 500 two-second-segment replay viewers; adequate paid
allowance is required. Actual LiveKit/Workers subscriptions remain unverified.

Physical devices, Safari/Firefox/native HLS, acoustic/live-delay and controlled-network
cohorts, long hosted soak, paid-plan comparison, custom replay domain, hosted Data API
isolation, receipt privacy review and existing project/financial gates remain open. Media GET
600/min/IP cannot support 500 viewers sharing a NAT polling every three seconds; that code/
abuse-control gate and whole-app clock ownership are not solved by plan upgrades or SSE
fanout. Follow dated trials and sanitized evidence for commands, commits, measurements,
failures and cleanup. Measured targets remain provisional, not approved production limits.
