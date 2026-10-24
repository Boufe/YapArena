# Replay hosting options

Status: research and cost comparison, 2026-10-23. No code or provider settings changed.
Recommendation: keep the current pipeline and fix its long-recording limits (see the end).

## Question

Should a hosted video service replace the self-built replay pipeline? Today LiveKit Egress
records a room-composite MP4 to R2. A durable PostgreSQL job queue hands it to FFmpeg in a
separate Render worker (Starter, 0.5 CPU, 512 MB), which writes 240p, 480p and 720p HLS back
to R2. A Cloudflare Worker checks a signed token on every playlist and segment request.
See [automatic replay packaging](replay-automation.md) and the
[hosted Starter trial](replay-starter-trial-2026-10-07.md).

Options compared:

1. Keep the current pipeline.
2. LiveKit Egress writes segmented HLS directly, with no transcoding worker.
3. Mux Video.
4. Cloudflare Stream.

## Prices used

All read on 2026-10-23. List prices, USD, before tax or negotiated discounts.

| Source                                                                                                | Price used                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Mux pricing](https://www.mux.com/pricing), [Mux video rates](https://www.mux.com/docs/pricing/video) | Basic quality: encoding free. Storage up to 720p $0.0024/min-month (lower above 50,000 min; 40% off after 30 days unplayed, 60% after 90). Delivery: first 100,000 min/month free, then $0.0008/min up to 720p. $20 monthly usage credit on pay as you go. No platform fee. |
| [Cloudflare Stream pricing](https://developers.cloudflare.com/stream/pricing/)                        | Storage prepaid at $5 per 1,000 min of capacity. Delivery $1 per 1,000 min. Ingest and encoding free. Renditions are not counted separately.                                                                                                                                |
| [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)                                | $0.015/GB-month after 10 GB free. Class A $4.50/million after 1 million, Class B $0.36/million after 10 million. Egress free.                                                                                                                                               |
| [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)             | $5/month minimum with 10 million requests and 30 million CPU ms. Then $0.30/million requests. Cache hits count as requests.                                                                                                                                                 |
| [LiveKit Cloud pricing](https://livekit.com/pricing)                                                  | Room-composite egress is "transcode minutes": Ship ($50/month) includes 600, then $0.02/min; Scale ($500/month) includes 8,000, then $0.015/min.                                                                                                                            |
| Render Starter worker                                                                                 | $7/month, 0.5 CPU, 512 MB. Render's pricing page did not render for automated reading; the figure is the billed plan in [the hosted trial evidence](evidence/replay-starter-2026-10-07.json) and matches third-party 2026 summaries. Standard is $25 (1 CPU, 2 GB).         |

## Assumptions

- Recorded volume: 10, 100 and 1,000 hours per month (600, 6,000 and 60,000 minutes).
- Each recording is watched ten times in full during its first month: 6,000, 60,000 and
  600,000 delivered minutes. No retention policy exists yet, so two storage cases are shown:
  **month one** (only that month's recordings) and **steady state** with 12 months retained.
- The source is LiveKit's default `H264_720P_30` preset (3,000 kbps video). This repository
  sets no preset, so audio is assumed at 128 kbps: about 1.41 GB per recorded hour. Every
  option keeps that MP4 in R2 as the portable archive.
- Current HLS package: nominal ceiling of the three renditions at their `maxrate`, about
  1.93 GB per recorded hour. The hosted trial measured 1.13 GB/hour on simple synthetic
  content, so storage figures are conservative.
- Current encoder speed: the hosted trial took 102 s for 62 s of media and 191 s for 120 s,
  about 1.6 times real time on Starter. Worker count adds 40% headroom for queueing.
- Delivery from the edge: one request per 2-second segment plus playlists, about 1,850
  requests per viewer-hour, all counted as R2 reads (worst case: no cache hits).
- Mux and Stream bill these recordings at the "up to 720p" tier, because the source is
  720p. Mux steady state is shown with and without its automatic cold-storage discount.
- LiveKit's recording charge is the same in every option and is shown separately.
- Engineering and on-call time is not priced.

## Monthly cost

Totals exclude the common LiveKit recording charge. Steady state assumes 12 months retained.

| Option                              | 10 h: month one | 10 h: steady | 100 h: month one | 100 h: steady | 1,000 h: month one | 1,000 h: steady |
| ----------------------------------- | --------------: | -----------: | ---------------: | ------------: | -----------------: | --------------: |
| 1. Current pipeline                 |             $12 |          $18 |              $17 |           $72 |               $110 |            $660 |
| 2a. LiveKit HLS, one 720p rendition |              $5 |          $10 |               $9 |           $56 |                $56 |            $521 |
| 2b. LiveKit HLS, three egress jobs  |             $29 |          $35 |             $250 |          $305 |             $2,480 |          $3,030 |
| 3. Mux (basic), no cold discount    |              $0 |           $2 |               $2 |          $176 |               $544 |          $2,266 |
| 3. Mux (basic), with cold discount  |              $0 |           $2 |               $2 |           $89 |               $544 |          $1,468 |
| 4. Cloudflare Stream                |             $11 |          $48 |              $92 |          $445 |               $921 |          $4,453 |

Common LiveKit recording charge (overage only): $0 at 10 hours (within Ship's 600 minutes),
$108 at 100 hours and $1,188 at 1,000 hours on Ship ($780 plus the $500 fee on Scale).

How the main figures break down:

- **Current pipeline.** Render workers: one Starter at 10 and 100 hours ($7); four at 1,000
  hours ($28, 1,600 worker-hours of encoding). Workers: $5 minimum, $7.55 at 1,000 hours.
  R2 writes are inside the free tier until 1,000 hours ($20). R2 storage is the growing line:
  3.3 GB per recorded hour, $600 at the 1,000-hour steady state. Delivery bandwidth is free.
- **LiveKit HLS, one rendition.** No encoder. Storage is the MP4 plus one 720p HLS copy.
- **LiveKit HLS, three egress jobs.** Two extra egress jobs per recording at $0.02/min
  dominate: $240 at 100 hours, $2,400 at 1,000 hours.
- **Mux.** Storage is the main cost; delivery is free up to 100,000 minutes, so 10 and 100
  hours fit within the free delivery and the $20 credit. At 1,000 hours delivery is $400.
  The R2 MP4 archive ($0.06 to $253) is included.
- **Cloudflare Stream.** Every stored minute costs $0.005/month with no cold discount, so
  storage reaches $3,600 at the 1,000-hour steady state, plus $600 delivery.

Viewing ten times is light. Delivery is free in options 1 and 2 (R2 has no egress fee), but
Mux and Stream charge per delivered minute, so more viewing widens the gap in favour of R2.

## Signed or private playback

| Option     | Mechanism                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Current | HMAC token checked by our edge Worker on every playlist and segment ([edge/replay-worker.ts](../edge/replay-worker.ts)); the Worker rewrites playlist URIs with signed paths. Grants last five minutes and the application refuses new ones once a replay is removed or hidden. Full control.                                                                                            |
| 2. LiveKit | Same edge Worker and token; only the path pattern changes. LiveKit adds no playback security of its own.                                                                                                                                                                                                                                                                                 |
| 3. Mux     | [Signed playback IDs](https://www.mux.com/docs/guides/secure-video-playback): RS256 JWT signed by our server, `exp` required, separate tokens for thumbnails and storyboards. Mux advises an expiry at least as long as the asset, so a grant would live at least as long as the replay instead of five minutes. Removal means deleting the playback ID or asset. Included in the price. |
| 4. Stream  | [Signed URLs](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/) with `requireSignedURLs`: RS256 JWT from a signing key, created locally without an API call, `exp` up to 24 hours, optional IP and country rules, allowed origins. Included in the price.                                                                                                   |

Both hosted services can match the current privacy level, but with longer-lived grants
unless the player renews tokens during playback. Whether a short expiry stops a viewer
mid-replay was not tested for either service.

## Code removed

Current replay code (lines, 2026-10-23): production 2,114 (`replay-packaging.ts` 545,
`replay-storage.ts` 399, `replay-jobs.ts` 347, `replay-worker.ts` 243, `replay-thumbnail.ts`
236, `src/replay-worker.ts` 86, `replay.ts` 36, `edge/replay-worker.ts` 222), scripts 1,584
(`verify-replay-pipeline.ts` 866 and three others), tests about 2,000, plus the FFmpeg
encoder image in the Dockerfile and CI. The hls.js player (`frontend/media-replay.ts`, 374)
stays in every option because Mux and Stream also serve HLS.

| Option     | Removes                                                                                                                                                                                              | Adds                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Current | Nothing.                                                                                                                                                                                             | Nothing.                                                                                                                               |
| 2. LiveKit | Packaging, upload, worker and FFmpeg image, most of the job queue and its verifiers: roughly 1,500 production lines and 2,500 script and test lines. Thumbnails could come from Egress image output. | A segment output in the egress request and publication on the `egress_ended` webhook.                                                  |
| 3. Mux     | All of option 2 plus the edge Worker and replay token signing: roughly 1,800 production lines and most replay scripts and tests.                                                                     | Mux client, webhook verification, JWT signing, asset IDs in a new migration, asset deletion on removal. An estimated 300 to 500 lines. |
| 4. Stream  | Same as Mux.                                                                                                                                                                                         | Same as Mux; the Workers binding can sign tokens and copy from R2. An estimated 300 to 500 lines.                                      |

The queue tables cannot be removed by editing the applied migration
`1791385198189_automatic-replay-packaging.js`; a new migration would drop or retire them.

## Lock-in

- **Current:** low. Standard HLS and MP4 in R2, FFmpeg, and a worker that runs on any host.
- **LiveKit HLS:** low. Output is still standard HLS in R2; the recording already depends on
  LiveKit.
- **Mux:** medium. Packages live in Mux and URLs are Mux playback IDs. Keeping the MP4
  archive in R2 means leaving only requires re-encoding elsewhere and re-issuing URLs.
- **Stream:** medium, same as Mux. It also concentrates storage, edge and video with one
  vendor that already holds R2 and the edge Worker.

## Migration effort

Estimates for one engineer, plus the staging playback trial that AGENTS.md requires for any
replay change. Existing replays would be re-ingested from the R2 MP4 archive.

- **Current:** none, but long recordings need fixes (below). About one day.
- **LiveKit HLS:** three to five days. One rendition loses the adaptive 240p and 480p
  qualities chosen for weak networks and older devices. Three parallel egress jobs keep
  them but cost much more and need failure coordination. The [Egress API](https://docs.livekit.io/reference/other/egress/api/)
  allows one segment output and one encoding per request, and the
  [output docs](https://docs.livekit.io/transport/media/ingress-egress/egress/outputs/)
  document no master playlist or rendition ladder.
- **Mux:** five to eight days: client and webhooks, signing, data migration, removal and
  revocation paths, backfill, and playback trials against the
  [playback targets](media-playback-requirements.md).
- **Stream:** five to eight days, similar to Mux.

## Limits found in the current pipeline

These apply whatever is decided and are not fixed by this document:

- The default whole-job deadline is 30 minutes (`maxJobMs` in
  [replay-worker.ts](../src/features/media/replay-worker.ts)). At 1.6 times real time on
  Starter, a recording longer than about 18 minutes would time out and exhaust its five
  attempts. The bound allows up to two hours.
- The 2 GiB source limit (`maxInputBytes`) is about 90 minutes at LiveKit's default preset.
- The 7,200-second duration limit caps a debate at two hours. The PRD's maximum debate
  duration is still an open decision.

These rest on short-recording measurements; a full-duration soak is still a release gate.

## Recommendation

Keep the current pipeline.

- It is the cheapest option that keeps the adaptive ladder once a library builds up,
  because R2 delivery is free. At 1,000 hours Mux costs two to five times as much and
  Stream seven to eight times. At 100 hours Mux is cheaper for the first two months (six
  with its cold-storage discount) and then costs more each month; at 10 hours
  Mux saves about $10 to $16 a month, which is small.
- It is built, verified in staging and keeps five-minute revocable grants.
- LiveKit direct HLS cannot produce the adaptive ladder without paying for extra egress
  jobs; one rendition fails the weak-network and older-device goals.
- Cloudflare Stream is the most expensive option at every volume above 10 hours.

Next steps: raise `maxJobMs` and the input limit to match the maximum debate length once
it is decided, and run a full-duration encoder soak on Starter. Revisit Mux if replay
maintenance becomes a recurring cost, if viewers need automatic captions (included with Mux
Video) or quality analytics, or if retention stays short, which shrinks Mux's main cost.
