# Render Starter replay trial — 2026-10-07

The existing $7/month replay worker successfully converted and automatically published a
LiveKit recording without captions. A separate two-minute synthetic recording recovered
after actual worker cancellation and process replacement, then played at all three
qualities. This documents the hosted staging trial on application commit
`89d7a6a1787bb7fdf7ecefbd364698d5bbc42695`.

## Configuration and deployment

The worker's original failed-service condition was missing `DATABASE_URL`. It now uses
the existing restricted `yaparena_runtime` database identity through the Supabase session
pooler on port 5432, certificate-verified TLS and the public CA secret file. Database-owner
and migration credentials are absent from both deployed services. The additive automatic
replay migration was already applied before the computer crash and was verified again.

The web and worker initially deployed together at the commit above. The worker runs
`node dist/replay-worker.js`, with FFmpeg tools, concurrency one, private LiveKit/R2
configuration and the authenticated replay edge. Its plan remains `0.5c-512mb`: 0.5 CPU,
512 MB. No additional paid service or compute-plan change was made. Original web settings
were preserved and an encrypted pre-change configuration snapshot was retained privately.

Automatic packaging and adaptive delivery are restricted to the two synthetic trial room
IDs. This trial does not expand conversion to the existing staging catalog. The complete
source checkout was built with Node 24.19.0; no application source changes were needed.

## Hosted conversion and recovery

| Measurement                           | Provider recording                                                        | Controlled recovery recording                                    |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Source provenance                     | Two fake-camera speakers, actual LiveKit recording and completion webhook | Separate source made by looping the synthetic provider recording |
| Packaged duration                     | 62.253 s                                                                  | 120.219 s                                                        |
| Automatic job attempts                | 1                                                                         | 2                                                                |
| Job creation to ready publication     | 102.132 s                                                                 | 278.293 s, including interruption and retry                      |
| Successful retry claim to publication | —                                                                         | 191.341 s                                                        |
| Package files, excluding ready marker | 100                                                                       | 187                                                              |
| Package bytes, excluding ready marker | 19,466,715                                                                | 38,106,301                                                       |
| Sampled container memory peak         | 140.63 MiB                                                                | 159.76 MiB                                                       |

The provider recording became ready at approximately 18:55:44 UTC; automatic publication
completed at 18:57:30 UTC. There was no manual packaging or Publish replay action. Both
recordings had no caption text. Each publication recorded exactly one actorless
`automatic_replay` transition, with unchanged live-end/financial fields and source binding.
The private ready marker matched the current durable pointer and contained 240p, 480p
and 720p renditions.

The recovery trial used a two-minute source, within the user's five-minute limit. At
20:00:09 UTC the coordinator requested stop/resume of the existing worker while the first
source-bound attempt was processing and its package prefix contained no uploaded objects.
The old instance logged `replay_failed` with `cancelled`, then `replay_worker_stopped`, at
20:01:09 UTC. The replacement claimed attempt 2 with a different lease and immutable
package prefix, retaining the same source ETag. The abandoned attempt reached `cleaned`.
Attempt 2 published at 20:04:23 UTC.

Render's later CPU samples showed the old instance using the full 0.5 CPU near shutdown.
Encoding at interruption is inferred from sustained CPU, absent initial uploads and the
worker's conversion-before-upload ordering; FFmpeg's process ID was not inspected. This
was a graceful process cancellation/replacement trial. Abrupt host loss and OOM recovery
remain separate checks. Resource samples have 30-second resolution and can miss brief
peaks; these short recordings do not establish full-duration throughput or capacity.

## Browser and access checks

Unmodified Chrome 154 native HLS decoded advancing frames at 240p, 480p and 720p. The
recovered replay also passed keyboard start, seek to 20 seconds, pause, 1.25× playback rate
and resumed advancement. Its measured keyboard-to-playback time was 27.364 seconds on
this uncontrolled desktop connection; this is not a replay-start latency acceptance result.

A separate uninstrumented native-player run started in 1.574 seconds, waited for the real
270-second authorization renewal, and preserved paused position at 20 seconds and 1.25×
speed across fresh metadata. Playback resumed at the saved position with advancing frames.

The recovered replay passed CORS, HEAD, byte ranges and repeated segment-byte checks.
Unsigned, tampered, cross-room and wrong-origin requests returned 403. Hiding the fixture
immediately denied fresh grants with 404. The product then stopped playback, removed its
source, reset readiness and hid the video; its status was `event not found`. An already
issued capability remained usable before expiry. At 20:25:36 UTC, its unchanged five-minute
signature had expired and both the master playlist and the previously fetched segment
returned 403. Repeated bytes do not establish a cache-hit ratio.

## Trial limitations and retained failure evidence

Initial playback harness runs failed cold-start or paused-renewal deadlines while intercepting
grant responses or accelerating the application's timer. The subsequent uninstrumented
real-renewal run passed. These failed runs remain in private evidence; they were not
converted into passing results. Browser request traces for the successful native run had
no relevant media failures. Anonymous authorization probes and absent captions produced
expected 401/404 responses.

An earlier removal assertion also required the literal grant-denial status `no longer
available`. The application's regular event poll can stop the player first and display
`event not found`. The recovered-fixture repeat checked the actual cleared video and denied
grant, accepting both legitimate status paths, and passed.

Cleanup initially refused an unrecognized extra object instead of deleting a room-wide
prefix. Inspection verified it as LiveKit's generated JSON metadata for the exact Egress ID,
room and source filename. The cleanup helper was extended to validate and remove only that
owned sidecar. A later cleanup request timed out while the free web service was inactive;
readiness returned 200 on retry and the scoped cleanup was rerun.

A controlled-fixture setup initially hit the participant-role uniqueness constraint because
user creation already assigns that role. The setup transaction rolled back and the helper
was corrected to tolerate the existing role. A queue observation connection also ended
during the retry; a new observer verified the saved first-attempt evidence and unchanged
baselines before checking the final ready state. Neither operation reset a lease or retry
budget. SSH inspection was unavailable because no account key was configured.

This headless desktop trial does not assess audible output, physical mobile devices,
independent networks, sustained viewer load, cache-hit ratios or a full-duration encoder soak.
The recorded playback timings do not establish the product's percentile latency targets.

## Final state and cleanup

Final verification passed at **2026-10-08 01:37:22 UTC**. The web returned readiness 200;
both deployments were live on `89d7a6a1787bb7fdf7ecefbd364698d5bbc42695`. The worker's new
instance logged successful application startup at 01:37:17 UTC and was running and ready
on the same `0.5c-512mb` plan.

The worker was actually drained before cleanup. Both synthetic fixtures had zero remaining
R2 objects, including provider metadata, and no remaining LiveKit room. Their temporary
debates, media rows, topics, participant accounts, sessions and scoped community rows were
removed. Two cancelled jobs and three attempt tombstones were retained for the queue's
normal cleanup/retention policy. The original 12 debates, 12 media rows, 12 topics and eight
chat messages exactly matched the saved pre-trial fingerprints.

At this trial's closure, the worker retained the two-room synthetic canary allowlist.
The fixtures were removed and the existing staging catalog had not been processed.
The subsequent rollout below supersedes that configuration.

See the [sanitized machine-readable evidence](evidence/replay-starter-2026-10-07.json).
Credentials, signed URLs, private recordings and raw provider evidence remain in ignored
local storage and are excluded from the report and portable evidence.

## All-eligible staging rollout — 2026-10-08

The user approved conversion of eligible staging recordings and later requested deletion
of the unfinished remainder. The room allowlist was removed from both services; all other
environment settings were preserved, and both services redeployed application commit
`89d7a6a1787bb7fdf7ecefbd364698d5bbc42695`. The existing worker remains on its `0.5c-512mb` plan with
concurrency one. Future eligible recordings remain on the automatic conversion path.
No new recording was created for this rollout.

**9 of 10 audited recordings** converted
successfully, with 0 retries among retained recordings.
**1 unfinished recording** was removed at the
user's request: its recording reference was cleared, and its source and verified provider
metadata were deleted. The worker detected the revoked lease (`lease_lost`) and cleaned
the cancelled attempt. The debate/event was retained. All event and live-end/financial fields matched the
baseline apart from the authorized automatic replay status transitions; retained media
rows and original source objects remained unchanged. The removed media row matched the
coordinator's removal snapshot, its source returned 404, fresh replay access returned 404,
and it had no non-cancelled replay jobs. Its original event status and automatic history
count were preserved.

The pending-package path retained the existing MP4 fallback; one representative replay's
MP4 grant was explicitly checked before worker rollout. The
7 retained existing replay events now receive HLS
grants. 2 retained ended events transitioned
to replay exactly once, with actorless automatic history entries.

Every retained ready marker matched its current durable pointer and caption digest.
Every retained replay returned a five-minute HLS grant and a master playlist advertising
240p, 480p and 720p renditions. One converted existing replay also passed unmodified desktop
Chrome decoding at all three qualities, keyboard start, seeking, pause, 1.25× speed and
resume; its measured start was
1.883 seconds.
The read-only browser check preserved event and recording fingerprints.

The retained packages totaled 1002.541
seconds of media; the longest retained recording was
187.060 seconds. The retained queue
elapsed 45.07 minutes from its first job
creation to its last ready package. Those duration and elapsed-time aggregates cover the
retained packages, and do not imply successful conversion of the deleted source. Sampled
peak container memory was 231.76
MiB and sampled CPU reached 0.50 cores across
the rollout window, including processing of the subsequently removed recording. These
are staging-recording and 30-second sampling measurements, not two-hour or 4K capacity
acceptance. Physical devices, acoustic output and percentile startup targets remain
unverified.

Final verification completed at **2026-10-08T03:30:33.999Z** with web readiness 200, matching
live builds and one running, ready worker. The 9 retained original
sources and adaptive packages remain available; the user's requested unfinished recording
was removed without removing its event. See the
[sanitized rollout evidence](evidence/replay-rollout-2026-10-08.json).

## Automatic publication interface — 2026-10-15

The recording worker already published eligible replays after verified package completion,
but the page still told operators to publish while conversion was pending.
[PR #28](https://github.com/Boufe/YapArena/pull/28) corrected that guidance and hid the manual
Publish replay action for the automatic path. Viewers still click Play replay to watch.

Matching web and worker builds at `b11a11b917f3e166154a633d0bf8effc12ac9963`
were verified live at **2026-10-15 16:03:04 UTC**. All 393 tests and five CI checks passed.
Twenty read-only PostgreSQL cases checked publication eligibility, and 13 staging
snapshots confirmed the server-owned policy without exposing storage keys. Ten ready
recordings qualified; three failed recordings remained excluded. Existing event and media
fingerprints and service configuration were preserved. The worker kept its existing plan
and concurrency one.

A local synthetic Chrome check used the rendered media panel and built browser bundle
with mocked endpoints. It verified automatic-preparation guidance, a hidden Publish
replay action, and an available Play replay button with the video paused and hidden,
`autoplay` false, and zero playback calls. This interface check did not assess real media
decoding or create a new staging recording. The earlier hosted conversion and recovery
evidence above remains the basis for those behaviors. See the
[sanitized publication evidence](evidence/replay-publication-2026-10-15.json).
