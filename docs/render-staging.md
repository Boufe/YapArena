# Low cost staging

The staging stack uses one Render web service, a separately configured replay encoder, Supabase
Postgres, LiveKit Cloud, and Cloudflare R2.
Until the [worker cut-over](#move-background-jobs-to-the-worker), the Render web process also runs
every background job: clocks, revocation, wallet provisioning and cleanup. Supabase only hosts
PostgreSQL; the application continues to own accounts, sessions, and authorization. LiveKit carries
the live video and records it to a private R2 bucket. The browser reads verified adaptive replays
through the authenticated private edge; eligible recordings without a ready adaptive package retain
the signed-MP4 fallback. Playback starts on the viewer's click.

Latest saved web release: [PR #34](https://github.com/Boufe/YapArena/pull/34) records
`fc241e1` live on October 17 at 01:47:54 UTC, with read-only HTTP postflight at 01:48:24 UTC
and no worker change. The [hosted replay report](replay-starter-trial-2026-10-07.md) separately
records the existing paid `0.5c-512mb` encoder, October 8 all-eligible rollout and matching
web/worker builds at `b11a11b` on October 15. Those historical checks supersede no-encoder/
deleted-canary notes; they do not establish today's live versions or a matching build pair.
The October 19 documentation audit did not inspect live providers or deploy current main.

`render.yaml` defines **one Free Render web service** and the paid `yaparena-staging-jobs`
background worker, which the operator creates manually for the
[cut-over](#move-background-jobs-to-the-worker). It does not create a Render database or the replay
encoder. Its start commands only start runtime processes; migrations run in a separate
operator process. Render Free has no pre-deploy command, so `render.yaml` disables automatic
deployment and the operator completes migrations before manually deploying the same reviewed
commit. A second migration URL in the web service environment would expose that privilege to a
compromised app and is prohibited. Keep each service to one instance. Review current provider
allowances and billing settings before use.

This is a small trial environment. Render Free sleeps after 15 minutes without inbound traffic and
can take about a minute to wake. A live debate page polls the app every three seconds, but an
instance restart can still interrupt the turn clock. While web runs the background jobs, they stop
while it sleeps; the paid jobs worker does not sleep. Supabase Free can pause after a week of low
activity. Do not use this environment for promised live events or real user data.

## Create the database

1. Create a Supabase Free project in a region close to Render's Ohio region.
2. Disable Supabase's **Data API** for the project in the Data API integration settings. This app
   uses its own Express API and direct PostgreSQL queries; its tables are not designed for public
   access through Supabase REST or GraphQL.
3. Follow the [database isolation runbook](security/database-isolation.md) to inventory the project
   and provision distinct `yaparena_owner` and `yaparena_runtime` identities in an administrative
   operator process. Keep that process and its secrets outside Render web/worker environments.
4. In the project's **Connect** dialog, construct a **Session pooler** PostgreSQL URL (port 5432)
   for each custom login. Verify the custom-role username/project suffix supported by the actual
   pooler using a real connection; do not assume the default `postgres` URL authenticates the new role.
   This supports the app's persistent `pg` pool on an IPv4 network. Do not use the transaction
   pooler URL (port 6543) for this deployment. Replace the password placeholder without its square
   brackets, URL-encode reserved password characters, and use certificate-verified TLS with
   `sslmode=verify-full` and the provider CA configured through the approved secret/file mechanism. Keep
   the URL and password out of Git and chat.

## Deploy the web service

The historical Work Package 6 trial record does not establish the currently deployed branch,
credentials or API settings. Verify those in the provider dashboards and keep the
[measurement release sequence](measurement-operations.md#release-and-rollback-sequence) and
[operating trial record](operating-readiness-trial.md) as separate evidence.

1. Obtain the separate hosted-change/deployment authorization. Select the reviewed commit/image,
   run CI (including database isolation checks), and validate `render.yaml` with
   `render blueprints validate render.yaml`. Inventory and back up the target first. For an upgrade,
   stop traffic/background jobs while provisioning moves the existing public schema objects.
2. In a secured operator container or release runner, run `scripts/provision-database.ts` as the
   administrator using a provisioning-only secret environment. Next run the **same reviewed image**
   with the owner URL as `DATABASE_URL`, in a separate one-off process:

   ```sh
   docker run --rm --env-file /secure/yaparena-migration.env \
     ghcr.io/OWNER/REPOSITORY@sha256:REVIEWED_DIGEST \
     node scripts/migrate-database.ts
   ```

   The protected file contains only the migration process's `DATABASE_URL`. Do not mount it in the
   web service or put it in a shared Render environment group. A nonzero result stops the release.
   For a source-built trial image, build the reviewed checkout and record its image ID/commit before
   using it for this step; confirm the web build uses that exact commit as well.

3. In Render, create/update the Free web Blueprint for that reviewed commit. Confirm automatic
   deployments are off in the **actual service**, including existing services whose settings may
   differ from the file. Set `DATABASE_URL` to the **runtime** Session pooler URL. Remove all
   migration/admin secrets and combined operator files from web/worker environments. Replacing the
   URL does not rotate the old shared owner password; handle old credentials/deployment copies under
   separately authorized credential rotation.
4. Manually deploy only after the owner migration job succeeds. Startup verifies the runtime
   database identity and applied migration list before serving traffic. Confirm `/ready`, sign-in,
   account roles, matching, notifications, moderation and measurement with synthetic staging data.
   Keep public HTTP checks separate from the hosted API-isolation checklist.
5. Record Dashboard Data API/exposed-schema facts and real anonymous/authenticated access probes
   in an authorized disposable clone as specified by the [F04 checklist](security/database-isolation.md#hosted-operator-checklist--required-to-close-f04).
   Keep F04 **UNVERIFIED** until these hosted checks are complete.

The first deploy has no media configuration and says so on debate pages. Seeded demo debates use
the older `preview-1` rules and cannot be used for a real media trial.

## Enable live video and replay

Public community streaming is a separate rollout gate. `COMMUNITY_STREAM_ENABLED=false` remains in
the Blueprint; enabling it requires an authorized hosted trial following the
[delivery guide](community-delivery.md#rollout-compatibility-and-rollback). Reserve one persistent
runtime LISTEN session per web process in addition to its ordinary ten-connection pool, verify its
actual direct/session-pooler identity, and measure Chrome's HTTP/2 protocol and timely frames on the
real SSE route with `scripts/verify-community-edge.js`. A file's port/settings do not establish these
facts. [Delivery controls](media-delivery-controls.md) now coordinate media clocks and shared-network
read admission, but process-local abuse limits and unverified whole-app scaling still require one instance.
The Free hosting plan does not become an approved live-event plan by enabling SSE.

1. Create a LiveKit Cloud Build project. Copy its HTTPS API URL, WSS browser URL, API key, and API
   secret. Create a private Cloudflare R2 **Standard** bucket and a bucket-scoped S3 key that can
   write, read, and HEAD replay objects. Keep all keys in the provider dashboards and Render.
2. Configure R2 CORS for browser GET requests from the exact Render HTTPS origin. Set LiveKit's
   webhook URL to `https://<staging-host>/api/media/webhook`; the app verifies webhook signatures.
3. Add **all** variables below to the Render web service together. Partial media configuration
   prevents the app from starting. Save and redeploy after all values are present.

| Variable                                        | Source                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LIVEKIT_URL`                                   | LiveKit Cloud HTTPS API URL                                                                                   |
| `LIVEKIT_PUBLIC_URL`                            | LiveKit Cloud WSS browser URL                                                                                 |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`         | LiveKit project credentials                                                                                   |
| `MEDIA_S3_ENDPOINT`, `MEDIA_S3_PUBLIC_ENDPOINT` | R2 HTTPS S3 endpoint (same value for both)                                                                    |
| `MEDIA_S3_REGION`                               | `auto` for R2 S3; do not enter the bucket location hint such as ENAM. The app forces `auto` for R2 endpoints. |
| `MEDIA_S3_BUCKET`                               | Private R2 bucket name                                                                                        |
| `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`    | R2 bucket-scoped S3 credentials                                                                               |

The current media provider sends the same S3 key to LiveKit Egress and uses it for playback. A
single bucket-scoped key therefore needs write and read permissions. Split those permissions and
rotate staging credentials before a public launch. A new event under `prototype-media-1` is needed
for a live media trial. Use two test speakers on separate networks and verify join, turn changes,
pause/resume, recording completion, replay playback, captions, and reconnects.

If LiveKit Egress reports `CreateMultipartUpload` with HTTP 401, verify that
`MEDIA_S3_ACCESS_KEY` and `MEDIA_S3_SECRET_KEY` are the S3 credentials from an active R2 API token
with **Object Read & Write** access to `MEDIA_S3_BUCKET`. Confirm the S3 endpoint belongs to the
same Cloudflare account. Replace both Render secrets together and redeploy before starting a new
trial. [Cloudflare identifies 401 as missing or invalid credentials](https://developers.cloudflare.com/r2/api/error-codes/).

## Move background jobs to the worker

While `RUN_BACKGROUND_JOBS` is true (the default), the web process runs the one-second A4/coin
debate, media clock/recording-stop and speaker-revocation jobs, the ten-second Privy revocation and
embedded-wallet jobs, and the hourly cleanup. `node dist/worker.js` builds the same jobs from the
same factory (`src/services.ts`) and always runs them, whatever `RUN_BACKGROUND_JOBS` says. It
serves no HTTP and starts no community stream. The worker is paid compute and needs the separate
hosted-change/deployment authorization.

`scripts/release-account-render.ts` finds the jobs worker by exact name, type and workspace.
It suspends and resumes it with web and the replay encoder, requires the same runtime database
URL, and deploys the release SHA to it after web. Its `deploy` mode accepts
`RUN_BACKGROUND_JOBS=false` on web only while the jobs worker is running.

1. Create the worker from the `yaparena-staging-jobs` Blueprint entry (Starter or larger) and deploy
   the same reviewed commit as web, after its migrations. Give it the runtime `DATABASE_URL` and DB
   TLS settings used by web, never an owner/migration URL, plus web's `A4_MODE`/`A4_*`,
   `COIN_SANDBOX_ENABLED`, all `LIVEKIT_*`/`MEDIA_*` media and replay variables and, when web uses
   Privy, `PRIVY_*` and `REDIS_*`. The worker validates but never connects to Redis. Keep
   `LOG_LEVEL` at `info` or more verbose, and leave web's `RUN_BACKGROUND_JOBS=true`.
2. Confirm the worker ticks. Its Render logs show `background worker started` with `media` and
   `privy` matching web, then one `background job ran` line per job: `a4-recovery` within a second,
   `media-clock` and `speaker-revocation` with media, `provider-revocation` and `embedded-wallet`
   with Privy, and `cleanup` after the first hour. Repeating errors block the cut-over, for example
   `A4 recovery tick failed`, `media clock failed`, `recording stop queue failed`,
   `speaker access revocation failed` or `... cleanup failed`. Render's metrics for the worker
   should show steady CPU/memory and no restarts. The worker has no `/metrics` endpoint, so its
   Prometheus counters (`yaparena_auth_journey_total`, `yaparena_media_control_total`) are not
   scraped.
3. Set `RUN_BACKGROUND_JOBS=false` on the web service in the dashboard. `render.yaml` still says
   `true`, so a Blueprint sync can restore it until a follow-up change updates the file.
4. Manually redeploy web. Its `server started` log shows `backgroundJobs: false` and no
   `background job ran` lines follow; `/ready` returns 200. Check the worker log for new errors.

Rollback: set web `RUN_BACKGROUND_JOBS` back to `true` and redeploy web. Both processes then run
the jobs, as during steps 1–3; suspend the worker afterwards to return to a single process.

Both processes may run every job at once. PostgreSQL coordinates them: row locks and leases for
A4, recording stops, speaker revocation, Privy revocation and wallet provisioning, advisory locks
for the coin-debate and media clocks, and idempotent cleanup deletes. A second process can wait on
an account lock or skip an A4 session for 30 seconds after a lock timeout; it does not repeat
the settlement, clock step or provider freeze. Two caveats remain:

- **Media permission repair.** Each process repairs speaker permissions under a per-room advisory
  try-lock and gives up after about 12 attempts (1.2–2.4 seconds). When LiveKit is slower than
  that, the other process fails closed and pauses a running debate ("Speaker permissions
  unavailable"). One process used to deduplicate this work in memory. The risk stays after the
  cut-over because web API and webhook routes still reconcile permissions while the worker repairs
  rooms. Avoid live events during the cut-over and resume an affected debate as operator.
- **Embedded-wallet creation.** A process that stalls past its 90-second lease while a Privy
  create is in flight lets the other process send a second create with the same permanent
  external ID. Privy's external-ID uniqueness (not verified here) and the review state are the
  fence, as with two web instances.

## Later scale-up

The Free setup is for functional trials. For reliable scheduled events, first upgrade the Render
web service so it stays awake. Database-backed clock ownership and canonical permission repair
now coordinate clock work across processes, but reliable compute and hosted recovery still need
validation. Move to a paid database with restore-tested backups before accepting real users. Add
alert delivery, load and media trials, and a shared rate limiter before scaling web instances.
Keep production in separate provider projects and credentials. See
[decision 0004](decisions/0004-live-debate-replay.md) for open production media decisions.

## Deploy the automatic replay encoder

This is a separate service; the existing Free blueprint does not provision it. Creating a
Render background worker incurs paid compute. Select resources only after measuring representative
recordings; the local six-second test does not approve the smallest tier for two-hour/4K inputs.
An encoder already exists in the saved staging evidence; inspect that service before creating
another. The steps below describe fresh provisioning or a reviewed reconfiguration, not pending
per-recording operations or evidence that the Blueprint creates a worker.

1. Back up and apply `1791385198189_automatic-replay-packaging.js` through the isolated migration
   operator, then run the runtime database identity/isolation checks. Deploy the reviewed web
   commit with packaging disabled first. Keep the additive migration on rollback.
2. Create a Docker background worker from the same reviewed commit, set Docker Command to
   `node dist/replay-worker.js`, and set `MEDIA_WORKER_TOOLS=true` so the image installs FFmpeg
   and ffprobe. Render maps that non-secret environment flag to a Docker build argument.
   Web images keep the default `false`. Never reference secrets in Docker build arguments.
3. Give the worker only runtime database credentials, strict DB TLS/search-path settings,
   LiveKit credentials and private bucket credentials. Match `MEDIA_REPLAY_EDGE_URL`,
   `MEDIA_REPLAY_SIGNING_SECRET` and canary `MEDIA_REPLAY_EDGE_ROOMS` with the web service.
   No owner/migration/admin URL or Cloudflare deployment token belongs in either service.
4. Enable `MEDIA_REPLAY_PACKAGING_ENABLED=true` on worker and web for the synthetic canary.
   Start with `MEDIA_REPLAY_CONCURRENCY=1` and the bounded defaults in `.env.example`.
   The worker checks tools/codecs and runtime identity before claiming jobs.
5. Complete a synthetic recording and observe automatic verification, durable claim, conversion,
   immutable upload, validation and ended-to-replay publication. Kill/restart the encoder during
   a second job; confirm automatic lease recovery, no duplicate publication and cleanup of
   abandoned attempts. Test topic/event removal, renewal, seeking and optional/no-caption paths.
6. Record exact commits/images, worker plan, CPU/RSS/disk/queue age, conversion time and failures.
   Evaluate the remaining capacity gates before approving a production envelope; alert on exhausted
   jobs. Scope changes require explicit deployment review. The recorded October 8 staging rollout
   already removed the room allowlist on both services; it did not establish full-duration capacity.

After deployment, new eligible recordings are converted and published automatically. Initial
service configuration and incident response remain deployment operations, not a per-recording
approval step. Existing eligible MP4 replay remains the fallback until a verified package is ready.
See [replay automation](replay-automation.md) and [delivery controls](media-delivery-controls.md)
for queue invariants, limits, rollback and the unverified hosting/physical-device acceptance gates.
