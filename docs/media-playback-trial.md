# Playback implementation trial — 2026-10-06

Worktree: `/private/tmp/yaparena-media-playback-20261006`.
Branch: `feat/media-playback-reliability`; baseline `bc3e92f`.
Scope: local synthetic encoding, browser orchestration tests, edge authorization/cache
tests and repository quality checks. No provider configuration, deployment, private
recording, financial activity or concurrent SSE files were changed in the original checkout.

## Evidence performed

`npm run verify:media-packaging` passed with FFmpeg 9.0.2 on macOS/ARM64. A six-second
synthetic 1280x720 camera pattern and 440 Hz audio tone encoded into 426x240, 854x480
and 1280x720 renditions. Each produced three aligned two-second segments. FFprobe
verified dimensions and AAC, and FFmpeg decoded all three complete VOD playlists.
The package contained 14 files including master and reviewed synthetic captions.
Temporary synthetic media was removed by the verification script. No upload was performed.
CI includes this packaging/decoding check after installing FFmpeg.

The focused automated trials exercise the actual browser entry with a fake DOM/LiveKit
transport, plus replay, recovery, diagnostics and edge modules. They verify preparation
without capture/join, late grant cancellation, viewer fresh-token recovery, offline
suspension, terminal reason handling, speaker mute/device gates, end cleanup, native/HLS
renewal state, bounded preload/retry and authorization before cached segment reads.
They establish application orchestration, not WebRTC/browser/physical playback quality.

Final `npm run check` passed on Node 24.19.0: **244 tests, 29 suites, 244 passed,
zero failures/skips**. Coverage: **97.98% lines, 91.15% branches, 97.92% functions**.
Lint, format, strict types and both browser bundles passed. `git diff --check` passed. The first sandboxed run
could not create Supertest localhost sockets; it is not a passing run. A subsequent
run identified the CSP expectation requiring the new HLS blob source; the assertion was
updated to match the intended policy.

Browser skill bootstrap returned `No browser is available`; discovery returned an empty
list. No interactive browser or screenshot trial was performed. Staging providers,
physical devices and load were not accessed. The isolated baseline contains `proxy-addr`
2.0.7 with [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h);
integrate the concurrent security fix and repeat dependency/container scans before release.

## Repeatable release trial

Use disposable events/accounts, synthetic media and private trial artifacts. Capture
the deployed commit and measured environment before starting. For each required cohort,
record device model, OS, exact browser/player versions, CA/US geography, measured network,
debate/viewer load, preparation state and clock offset/uncertainty.

1. Complete edge provisioning and package a synthetic completed recording as in
   [operations](media-playback-operations.md). Verify no anonymous bucket access, scoped
   credentials, cache hits only after authorization, expiry, cross-recording denial,
   CORS, HEAD/ranges, seeking and captions. Remove the event while playing; renewal must
   refuse it and the documented remaining credential window must hold.
2. On iPhone SE (2nd generation), Pixel 4a and the required newer/desktop versions,
   capture tap timestamps and rendered-frame callbacks. Test cold starts by disabling
   preparation in the trial harness; for prepared starts allow the page to finish its
   warmup. Keep separate cohorts. Verify sound-activation controls with browser autoplay
   restrictions; record the activation interval and acoustic first sound separately.
3. Use timestamped synthetic source images/audio markers from both speakers. Synchronize
   source/viewer clocks and measure acoustic/display playback externally. Record the
   capture timestamp before WebRTC encoding, marker observations and clock uncertainty.
   Do not substitute RTT or jitter-buffer delay for live playback delay.
4. Run two speakers and 100 actual media-subscribing viewers in each of five simultaneous
   debates. Maintain the load for at least 60 minutes, with repeated ten-minute debates
   under the existing prototype maximum. Observe application/worker/DB CPU, pool wait,
   LiveKit subscriptions, egress/recording completeness, edge traffic and client freezes.
   Token-only clients do not count as media viewers. Verify current hosting/LiveKit quotas
   and a single effective clock owner before the trial; sleeping Free hosting is not an
   established fit for this release envelope.
5. For normal and separately reported weak networks, restore connectivity after outages
   of 1, 5, 30 and 90 seconds. Test Wi-Fi/cellular changes and background/foreground at
   different durations. Time from controlled restoration/foreground to video and audio
   separately. Require ten seconds of stable continued playback and retain total
   interruption duration. SDK reconnect alone is not resumed playback evidence.
6. During interruption test Leave, operator removal, duplicate identity, event end and
   cancellation; none may automatically rejoin. Mute deliberately and select devices,
   disconnect and rejoin; check both capture indicators and published tracks. Delay a
   grant or publish response past Leave/Mute and verify stale completion cannot activate
   the microphone. Repeat camera/microphone revocation and unavailable-device failures.
7. For replay, change bandwidth, seek, set playback speed and captions, pause, and force
   renewal around credential expiry. Check preserved state for native HLS and HLS.js.
   Test keyboard-only use, VoiceOver/TalkBack, focus, sound status, caption accuracy and
   contrast on physical devices. Retain screenshots/video and accessibility findings.
8. Export diagnostics before closure/wrap and attach trial metadata. Add independently
   measured `synchronizedLiveDelayMs` and `acousticStartupMs` arrays. Analyze:

   ```sh
   npm run report:playback -- /private/path/trials.json
   ```

The input is an array of objects with `device`, `os`, `browser`, `geography`, `network`,
`load`, `commit`, and `diagnostics` from the browser export. The report separates live/replay
and cold/prepared startup; shows median/p95/p99 and sample sizes, buffering episodes/time/
longest interruption, restoration and external delay/audio samples, and Wilson failure
intervals. Authorization refusal and abandonment are separate. Review unanswered starts
and missing samples; report recovery failures and stable-window failures alongside the
successful duration distribution. A cohort with missing observations cannot pass.

## Acceptance status

Implementation and local automation are reviewable. All physical-device, deployed edge,
browser compatibility, accessibility, regional media delay, failure-rate confidence,
capacity/soak, recording-provider and controlled-network release targets remain unverified.
The [existing media decision](decisions/0004-live-debate-replay.md), operating readiness
and financial gates are still open. Configuration and passing unit tests do not close them.

## Combined integration follow-up — 2026-10-07 UTC

The original checkpoint `1bc118f` was cherry-picked as `095e997` into the SSE release based on
reviewed main `78d72ef`; the newer account/database/container security fixes are included.
Shared-file conflicts preserve both SSE admission and media telemetry controls. The combined
`npm run check` passed 316 tests with 94.22% line, 91.54% branch and 95.49% function coverage.
Modern database-isolation checks passed fresh and upgrade, and the six-second FFmpeg packaging
trial again produced/decode-verified all three renditions and captions (14 files). This local
result does not establish deployed HLS or WebRTC quality. Later SSE race regression/release
checks are recorded separately in the community trial.

A read-only provider preflight at 03:25:38 UTC reached LiveKit's room/egress APIs (zero active
rooms, participants and recordings) and passed R2 HEAD bucket. Actual LiveKit billing/project
limits are not exposed by those APIs. The Render web service has media configured through its credentials and
no replay edge. R2 storage credentials are present; Workers deployment credentials are absent
from the web service and will be loaded only by a separate authorized operator. No provider
recording, adaptive edge playback or physical-device acceptance has been performed in this phase.

## Actual cloud recording and coordinated recovery fixes — 2026-10-07

Combined `9f32a6206af6ebf9dd6c3f5a2cebde7bfeeb1897` reached staging at 04:36:01 UTC after all
five CI checks passed. Chrome 154.0.8037.98 on macOS 15.7.5 used two independent speaker
contexts and an anonymous viewer with fake camera/microphone capture against actual LiveKit
Cloud. The service was Render Free, one instance. These are synthetic desktop workflow
samples, not acoustic startup, live-delay distributions, physical-device or network acceptance.

The successful recording trial at 04:37:53 UTC measured speaker joins at 1,858/1,834ms, two
rendered viewer videos at 736ms, and deliberately muted refresh/rejoin at 1,571ms. Actual
provider track state verified mute before and after refresh. The server observed a pause
after the speaker disconnected; authorized operator resume restored the clock. Side B's
audio publication was verified, ending stopped the viewer, and the actual provider webhook
made the recording ready. No webhook success was injected. Sound activation was not required
in this headless Chrome sample; audible output and restrictive autoplay cohorts were not proven.
Earlier full cloud attempts failed speaker refresh; a separate no-recording diagnostic and
failing regression isolated SDK beforeunload clearing joined intent. Fix `72e41b5` retained
application pagehide cleanup and passed this subsequent real-provider trial.

The actual 61.18458-second source (7,653,250 bytes, 1280×720 H.264 and AAC) was downloaded only
to ignored private artifacts. At 04:38:51 UTC FFmpeg 9.0.2 packaged all three renditions and
decoded their complete playlists. All 98 package files were uploaded under the unique synthetic
recording prefix, with the ready marker last. Captions are manually reviewed synthetic cue
labels, not transcription accuracy evidence. No private recording was committed.

The Cloudflare Worker was deployed at 03:43:59 UTC, source `0450dbc` (Worker SHA-256
`f52925f6ccb26b02cada8db174ee81e1f590ab7ce2080e2cae57f25d7cfc5c68`), then enabled at
`https://yaparena-replay-staging.yaparena-staging.workers.dev`. This is a synthetic staging
exception; a custom HTTPS domain remains a production gate. Private R2 Put/Get/Delete probing
passed, the probe was deleted, public bucket access is disabled and unsigned Worker access
returns 403. Actual Workers subscription access returned 403, so the plan is unknown.
Worker observability/request logging and preview URLs were disabled. Deployment tokens remain
in ignored `.env.deploy`, outside Render. The paired replay variables and a one-room canary
allowlist reached live at 04:39:37 UTC; eight ready legacy replays retain their signed-MP4 path.

Direct coordination with the media agent became available through Codex thread tools. It
audited the integration and found actual additional recovery bugs: cached history pages
remained disposed; a second renewal could lose pending seek/play state; paused playback could
report stable recovery; transport flapping reset retry limits. Its `24a0974` fix is integrated
as `d582a99`; application fixes are `2fb30d6` and `3e27b2a`. The agent explicitly accepted the
final code integration after independently passing 29 focused tests. The local final full
check passed 332 tests, 94.33% lines/91.70% branches/95.28% functions. Denied cached-page
eligibility and pending old grants/HLS callbacks also have regressions. The focused old
behavior failed before the fixes; those attempts are retained as failures.

Final-commit deployed HLS/renewal/removal is recorded below. Controlled WebRTC interruption,
actual foreground return, acoustic startup and synchronized capture-to-playback delay,
Safari/Firefox/native HLS, physical SE 2/Pixel 4a, accessibility and 510-participant/five-debate
load remain unverified. Existing 600 media GET requests/minute/IP also cannot support 500
viewers behind one NAT polling every three seconds; a provider upgrade does not repair that
application budget. Do not call the 500-viewer SSE trial media-load evidence. Separate
brief/network/foreground recovery cohorts for their 3/5/5-second targets; the current pooled
report restoration field alone cannot establish those targets. Existing project gates remain.

Logs: `/private/tmp/yaparena-media-9f32a62-browser.log`,
`/private/tmp/yaparena-media-package.log`, and
`/private/tmp/yaparena-media-hls-callback-check.log`. Failed cloud refresh logs and the private
fixture/cleanup manifest are retained in ignored operator artifacts; never publish session
cookies, signed playback URLs, owner credentials or source recordings with a trial report.

## Actual private HLS, renewal, removal and expiry — 2026-10-07 UTC

Combined `3e27b2ababa79c3f614963e7ea8046a6aae1a5d2` reached live at 04:59:21 UTC and passed
all five jobs in [CI run 37573539274](https://github.com/Boufe/YapArena/actions/runs/37573539274)
(365 tests). Actual runtime Node 24.21.0/PostgreSQL 17.6 was independently verified. Chrome
154.0.8037.98 on macOS 15.7.5 loaded the real synthetic recording through the privately
deployed Worker and HLS.js. The 05:05:19–05:10:37 UTC sequence passed; keyboard-to-video
progress was 858ms. The portable `verifyHostedMediaReplay` module repeated the complete
sequence at 05:10:55–05:16:13 UTC, passing with 991ms startup. These are two synthetic
desktop samples, not latency distributions or physical/native-HLS acceptance.

Both runs verified actual HLS decoding, three loaded reviewed WebVTT cues, keyboard startup,
20-second seeking, rate 1.25, and preserved pause/seek/rate/caption settings through renewal.
The first application renewal timer was shortened to 45 seconds while the real signed edge
capability retained its issued 300-second lifetime. Exact-origin CORS, HEAD and 206 byte
ranges passed. Valid repeated segment requests passed; unsigned, tampered, cross-recording
and expired requests were denied. Repeated bytes do not independently establish a cache hit.
Worker tests establish authorization before its cache lookup; the hosted denial tests are
reported separately from that implementation evidence.

Hiding only the synthetic event denied fresh grants (404) and left its public player hidden,
paused and with no source (`readyState=0`). An already-issued valid capability still returned
200 before expiry, as documented. Each trial waited for the actual issued five-minute
capability to expire and observed 403. This is bounded capability expiry, not immediate
revocation of every issued URL or a global cache purge. Acoustic output and restrictive
autoplay behavior were not established by headless keyboard startup.

Earlier final-code attempts remain failures: the first caption assertion left the browser
text track disabled and timed out; the next passed playback/renewal but expected an invented
removal status phrase instead of asserting actual player cleanup. The corrected harness
explicitly enables captions and checks hidden/paused/no-source state. These harness failures
did not require another application change and are retained with their original outcomes.

Cleanup at 05:20:50 UTC deleted all 101 objects under the exact synthetic prefix and verified
it empty, with zero owned LiveKit rooms/active egress. The synthetic event/topic and two
accounts were deleted after issued capabilities expired. Global edge cache purge was not
performed; any retained bytes remain behind signature verification and expired trial
capabilities, with fresh grants denied. All eight protected existing chat projections were
unchanged and zero synthetic accounts remained at 05:21:39 UTC. Provider historical recording
metadata is not claimed deleted. Local ignored source recordings remain private operator
artifacts, not repository content.

The three canary variables were removed from the fully paginated Render configuration at
05:21:37 UTC (22 entries to 19, preserving every other setting). The same integrated code
reached live with that cleanup at 05:32:46 UTC (`dep-db2tioajnfac73803v80`). Final readiness
was 200, zero streams/rooms remained, and the runtime LISTEN identity was verified.
The private Worker remains available, and legacy published replays keep their signed-MP4
delivery path. Adaptive replay is therefore implemented and exercised in staging, rather
than globally enabled for existing unpackaged recordings.

Logs: `/private/tmp/yaparena-media-replay-3e27b2a-final.log` and
`/private/tmp/yaparena-media-portable-replay.log`. Sanitized measurements, cleanup and
configuration are in `docs/evidence/community-delivery-release.json`; credentials,
cookies and signed capabilities remain in ignored private operator artifacts. Repeatable
operator procedures are in `docs/media-playback-operations.md`.
