# Adaptive playback and recovery

The original media checkpoint `1bc118f` was isolated on `feat/media-playback-reliability`.
It is now integrated as `095e997` in `feature/community-delivery`, after the reviewed main
security fixes and SSE checkpoint `ab59ebb`. Shared-file conflicts preserve community
stream admission, media telemetry abuse limits, database isolation and both browser bundles.
There are no media schema changes. Combined checks and actual deployed validation are recorded
in the trial documents; integration does not close the physical-device or hosting gates.
Do not copy provider credentials between worktrees.

See [acceptance requirements](media-playback-requirements.md) for the proposed envelope
and targets, and [trial evidence](media-playback-trial.md) for performed checks.

## Live preparation and recovery

On a live page, GET media state supplies the configured public LiveKit URL; the browser
calls `Room.prepareConnection(url)` without requesting a grant, joining, or capturing
devices. Viewer tap starts diagnostics before authorization and calls `startAudio` in
the gesture. If the browser still requires activation, **Enable sound** remains available.
Preparation is best effort; a failed warmup leaves cold joining available.

The SDK owns transport recovery while reconnecting. Only after a terminal recoverable
disconnect does the application request a fresh token, for viewers and speakers. Five
retries use 250/750/1500/3000/5000 ms bases with 25% jitter. Retries suspend while offline
or hidden. Online/foreground return schedules eligible recovery; each grant rechecks
current server authorization. Authorization refusal, permission denial, voluntary leave,
duplicate identity, participant removal, deleted/closed room, cancellation and debate end
stop retries. A generation guard rejects late grants after cancellation. Leave also
clears speaker autojoin intent for subsequent refreshes.

Transport success does not replenish the five-retry budget. A captured connection
generation must observe ten seconds of progressing remote video before resetting it.
Reconnect, offline return, a stall, hidden/disabled media or a new user intent invalidates
the evidence. Exhaustion stops automatic intent once; a deliberate Join starts a new budget.

Speaker choices and deliberate mute are remembered in tab session storage, scoped to
event and authenticated seat. A muted rejoin captures only camera and relies on the
existing recent server device check; an expired check requires a deliberate new check.
Publishing requires user microphone intent, running state, the current side and current
LiveKit microphone permission. Permission/state changes re-evaluate the gate. Late
publish completion rechecks intent and permission before enabling the checked track.
No camera/microphone capture happens during connection preparation.

For a persisted browser history page, pagehide releases the LiveKit connection and capture,
suspends replay, and keeps the frozen DOM and listeners. This preserves chat drafts and scroll.
Pageshow requires a successful current eligibility response before a fresh viewer/speaker
join. Denied or failed refreshes cannot reuse cached eligibility. A page generation rejects
responses arriving after another navigation. Ordinary page exit disposes all resources.

Replay source renewal retains its pending position, rate, caption mode and play/pause intent
until metadata applies them. A second renewal during loading cannot replace that state with
the source's reset DOM. Replay stability requires ten successive one-second media-time
advances; pause, seek, end, offline or error cancels the window. This is playback progress
evidence, not acoustic onset or capture-to-display delay.

The application owns pagehide cleanup with SDK `disconnectOnPageLeave: false`. The SDK's
default beforeunload disconnect otherwise arrives as a voluntary leave and clears speaker
autojoin before pagehide, which was reproduced in real Chrome and a failing regression.
Refresh retains joined/mute/device intent; pagehide still stops capture, disconnects the room,
and releases timers. Explicit Leave, terminal removal and event end still clear joined intent.

Connection messages are independent from periodic event presentation so polling does
not announce healthy playback during a known disconnect. Room closure stops capture
and detaches media elements. Pagehide releases timers and observers. Existing server
clock ownership, webhook delivery and permission reconciliation remain deployment gates;
browser recovery does not repair a failed server permission change or resume a paused
debate. The operator still owns deliberate incident resume.

## Produce and publish replay

Egress continues producing the verified private MP4 source. An operator runs the explicit
packaging command for a completed recording before publishing adaptive replay. Packaging
is not yet a managed transcoding queue: assign an operator/worker owner and do not put
FFmpeg in the web request path. Inspect/repair a failed package before another upload;
conditional writes reject overwriting an existing rendition. Use a new recording/package
identity for re-encoding, or remove only a failed unpublished package through reviewed
storage operations. Never overwrite segments that may be cached.

1. Download the verified synthetic/staging MP4 to a private local working directory
   using scoped storage access. Match its key to the event's recording key.
2. Produce captions manually or with a transcription service outside this change.
   A human reviews timing, speaker attribution, punctuation and accuracy, especially
   proper names and sensitive claims, against the entire recording. Do not upload
   unreviewed text. Record reviewer, language, source revision and review date in the
   private operating record. The current player supports English captions.
3. With FFmpeg on PATH, encode locally:

   ```sh
   node scripts/package-replay.js /private/path/source.mp4 /private/path/new-hls /private/path/reviewed.vtt
   ```

4. Repeat with a **new output directory** and the verified recording key to upload to
   the configured private bucket (load staging variables through your approved secret
   mechanism):

   ```sh
   node --env-file=.env.media scripts/package-replay.js /private/path/source.mp4 /private/path/new-upload-hls /private/path/reviewed.vtt debates/EVENT_UUID/RECORDING_UUID.mp4
   ```

The ladder is H.264 baseline/AAC, 30 fps, 240p ~348 kbps including audio, 480p ~1064 kbps
and 720p ~2496 kbps, with aligned two-second independently decodable MPEG-TS segments.
Bandwidth declarations include configured peak video rate and audio. Validate perceived
quality, loudness, source aspect ratio and codec compatibility in the trial device set.
The low rendition is first in the master. FFmpeg packaging checks nonempty segment
references; upload writes `ready.json` last. Access and operator Publish replay require
that completion marker when edge delivery is enabled. Legacy MP4 recordings must be
packaged before enabling adaptive replay for their catalog.

Use `MEDIA_REPLAY_EDGE_ROOMS` (at most 100 comma-separated lower-case event UUIDs) for
an incremental rollout. Only selected rooms use HLS and the completion marker; other
recordings retain their existing signed-MP4 path and database captions. The CSP admits
both configured delivery origins during this transition. Start with the synthetic trial
room; remove the allowlist only after the whole eligible catalog is packaged and validated.
An absent/empty allowlist selects the whole catalog when the paired edge variables are set.
The allowlist is an operator rollout control, not an authorization bypass: every grant
still checks current public eligibility. Roll back the edge variables together; retain
the private packages for investigation until their separately approved storage cleanup.

The [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2) produces the ladder;
[HLS.js](https://hlsjs.video-dev.org/api-docs/hls.js.hls) supplies browser adaptation.
Native HLS is preferred where supported; other supported browsers load the separate
HLS.js bundle on demand. It starts at the low rendition and then selects quality
automatically, bounded by player dimensions and bandwidth. HLS.js demuxing uses a worker.

Only the main event replay is prepared, while visible and without browser Data Saver.
Native preparation requests metadata only; that is a browser hint without a hard byte
guarantee. HLS.js preparation uses a 2 MB buffer budget and stops after the first low
rendition fragment. No other recordings are prefetched. Tap enables the larger bounded
playback buffer. Source renewal preserves time, playback rate, caption mode and deliberate
pause. Renewals are coalesced; technical recovery has five bounded retries, suspended
offline. Retries reset only after ten seconds without a waiting event.

## Authenticated edge deployment

Deploy `edge/replay-worker.js` separately with an R2 binding to the private recording
bucket. Adapt `edge/wrangler.example.toml`; provision a HTTPS custom domain, disable public
bucket URLs and set `APP_ORIGIN` to the exact application origin. Install a high-entropy
`REPLAY_SIGNING_SECRET` in the worker secret store, and the identical value as
`MEDIA_REPLAY_SIGNING_SECRET` in the service secret store. Set `MEDIA_REPLAY_EDGE_URL`
to the exact HTTPS origin. Both application variables are required together. Never put
the secret in TOML, a client bundle, logs, a signed-URL example, or a trial artifact.

The app issues a five-minute HMAC capability scoped to one recording's HLS prefix.
Anonymous eligible public replay viewers can receive it; public availability is still
server-authorized. All playlists, segments and captions go through the worker. Playlist
rewriting propagates the capability to allowlisted children. Every GET/HEAD verifies
method, path, signature, expiry and scope **before** consulting a shared segment cache.
Only immutable segments use a token-independent edge cache key; playlists and mutable
reviewed captions bypass shared cache. Responses to viewers use `private, no-store` so
the edge cache cannot bypass the credential check. CORS permits only the application
origin; ranges support seeking. The app CSP admits the configured edge origin and
media/worker blob URLs. No S3 credential reaches the browser.

Access renews 30 seconds before expiry. Each renewal checks publication, replay state,
recording readiness and key. Removed recordings refuse renewal. Already issued
credentials can fetch remaining objects until expiry: **at most five minutes from
issuance**, including through the edge cache. Already downloaded/decoded data cannot
be recalled; buffered media can play longer and screenshots/downloads cannot be revoked.
For urgent removal delete the private package and purge the segment cache; that operation
is outside this implementation. Rotate the signing secret to revoke all capabilities.
Clock synchronization between app and edge is required.

Caption corrections use the existing authenticated operator endpoint; it writes plain
WebVTT to the edge prefix before updating the reviewed database copy. Failure is surfaced;
retry and reconcile the storage/database copy if the database update fails after upload.
The edge never caches captions. New capability renewal updates the caption URL.

Roll out first with synthetic staging recordings, check deny/tamper/expiry/cross-recording
requests, CORS, seeking, captions, segment-cache hits and removal/renewal. Then test the
physical-device/load envelope. With edge variables absent, the existing signed-MP4 path
remains a staging fallback with a one-hour remaining credential window; it does **not**
satisfy the adaptive replay acceptance scope. Roll back both edge variables together to
that fallback only after recording the degraded release gate. HLS/browser assets must
deploy together; the existing Docker build produces both bundles.

## Operational measurement

The browser holds a bounded 10,000-record diagnostic ring in memory, accessible for
synthetic trials as `window.yapMediaDiagnostics.export()`. It contains no account/room IDs,
device IDs, private captions, URLs, grants or raw user-agent. It records every attempted
start, authorization, failure, abandonment, first rendered video, advancing audible-element
proxy, sound activation, interruptions, restoration, and available allowlisted WebRTC
statistics. Missing statistics are recorded; disabled tracks and deliberate pauses are
not technical failures. Diagnostics disappear when the page is closed unless exported.

A bounded reporter submits anonymous, allowlisted health counters/durations in batches
to the origin-protected media API under a dedicated 1,500-request/minute/IP
health-report limit. Reports do not consume the ordinary write allowance. The existing
600-request/minute/IP live-state polling limit remains; many viewers sharing one IP can
exceed it, so shared-IP admission and polling budgets require the load trial. No browser identifier is added
or persisted and no product watch-consent behavior is changed. These operational counters
are separate from consented product usage measurement. Raw user-agent and room/session
identifiers are not metric labels. Supported browser/device family labels are finite.
Prometheus exposes `yaparena_playback_events_total`, `yaparena_playback_duration_seconds`
and `yaparena_playback_active_seconds_total`. Aggregate deployments/geographies using
scrape metadata; exact OS/browser versions and controlled network/load belong in trial
artifacts. Client reports are untrusted and can be lost or duplicated: use them to diagnose
health, not as proof of failure denominators or release acceptance. In-flight batches
are not retried without a deduplication protocol. Queue overflow/loss is counted locally.

Active-viewing time is sampled at one-second intervals and capped to avoid background
timer inflation. Audio timing is explicitly a proxy. Use external synchronized/acoustic
measurements for audio onset and capture-to-playback delay. Export before the diagnostic
ring wraps; the report command rejects dropped records and always returns `releaseReady:
false` pending reviewed release evidence. Never infer a 0.1% failure objective from a
small successful trial. At least 3,840 zero-failure independent eligible attempts are needed
even for a Wilson 95% upper bound below 0.1%; cohort dependence still requires analysis.

## Deployment credentials and plan limits

Keep the Cloudflare Workers deployment token in a separate operator secret environment.
The web service needs its existing bucket-scoped R2 keys and the replay signing secret only.
R2 S3 access keys cannot deploy a Worker. Verify token permissions against the current
[Workers authorization requirements](https://developers.cloudflare.com/workers/authorization/workers/):
creating a Worker requires Workers Admin; changing its domain also requires Workers Routes
Write for that zone. After provisioning, scope ongoing deployment access to the existing Worker.

For the proposed 500 concurrent replay viewers, two-second segments imply about 250 segment
requests/second, or 900,000 requests/hour, before playlists, captions and retries. This is a
planning estimate, not measured edge traffic. The Workers Free 100,000-request daily quota
would be consumed in roughly 6 minutes 40 seconds at that steady rate. A 60-minute replay
capacity trial therefore needs adequate paid Workers allowance (currently $5/month base)
or approved higher limits. Check actual subscription, remaining usage, CPU and R2 operation
budgets before running it. See [limits](https://developers.cloudflare.com/workers/platform/limits/)
and [pricing](https://developers.cloudflare.com/workers/platform/pricing/). No billing change
is part of the implementation. Cloudflare zone Pro is separate from Workers Paid.

## Repeatable synthetic hosted operators

`scripts/verify-media-hosted-browser.js` runs only against the existing HTTPS staging origin
and a separate certificate-validated owner connection. Before running it, load approved
staging provider settings into that one-off process, set `DATABASE_OWNER_URL`,
`DATABASE_CA_FILE` and `BROWSER_EXECUTABLE_PATH`, then run:

```sh
node scripts/verify-media-hosted-browser.js /private/ignored/trial-artifacts DEPLOYED_FULL_COMMIT_SHA
```

It asserts the actual browser asset version, creates only tagged synthetic accounts/event,
uses independent Chrome contexts with fake capture against actual LiveKit, verifies rendered
video and provider mute/turn state, and requires real recording webhook completion. Failed
trials clean scoped provider/storage/database state. Successful ended fixtures remain for
packaging; `media-fixture.json` contains a synthetic session cookie, so keep its mode 600
and never publish it. Retain the private cleanup manifest until the final provider, R2 and
database cleanup has been verified. The headless sound control is not an acoustic test.

After packaging/upload and enabling only that room's edge allowlist, an authorized operator
runner calls `verifyHostedMediaReplay` from `scripts/verify-media-hosted-replay.js` with the
verified owner connection, approved service environment, fixed staging base, private fixture,
full deployed SHA, ignored artifact directory, Chrome executable and reviewed caption file.
The operator obtains credentials through its approved authenticated connection; this module
does not discover or print secrets. Its fixed stage/owner/tag guards may restore only its own
hidden synthetic fixture through a newer publication change for a repeat. It checks actual
HLS decoding, loaded WebVTT cues, keyboard startup, paused seek/rate/caption preservation
through renewal, CORS/HEAD/ranges and scoped signature refusal. It hides only that fixture,
requires fresh-grant denial/player cleanup, then waits for the actual issued 300-second
capability to expire and verifies 403. Caption tracks are explicitly enabled before checking
cues; do not require an invented status phrase when asserting player cleanup.

The first application renewal timer is shortened to 45 seconds; the signed capability and
its actual 300-second expiry are unchanged. Repeated segment bytes do not establish which
request hit an edge cache, so report cache-hit provenance as unobserved unless independently
measured. The caller owns final fixture cleanup and its database connection. A completed
run is not physical/native-HLS, acoustic, controlled-network or 510-participant acceptance.

Provider environment listing is paginated. Render defaults to 20 entries; the canary has 22. Read every page before comparing/preserving settings, or update individual authorized
keys. Never replace a service's configuration using the first page alone. Verify the pair
and canary allowlist after a change. Remove both edge variables and the allowlist together
after the disposable trial, retaining legacy playback and the privately deployed Worker.
