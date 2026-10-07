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
limits are not exposed by those APIs. The Render web service currently has media disabled and
no replay edge. R2 storage credentials are present; Workers deployment credentials are absent
from the web service and will be loaded only by a separate authorized operator. No provider
recording, adaptive edge playback or physical-device acceptance has been performed in this phase.
