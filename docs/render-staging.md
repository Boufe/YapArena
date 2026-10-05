# Low cost staging

The staging stack uses one Render web service, Supabase Postgres, LiveKit Cloud, and Cloudflare R2.
Render runs the existing Node app and its background clock in one process. Supabase only hosts
PostgreSQL; the application continues to own accounts, sessions, and authorization. LiveKit carries
the live video and records it to a private R2 bucket. The browser reads replays through short-lived
signed URLs created by the app.

`render.yaml` creates **one Free Render web service**. It does not create a Render database or
worker. Its start command only starts the runtime application; migrations run in a separate
operator process. Render Free has no pre-deploy command, so `render.yaml` disables automatic
deployment and the operator completes migrations before manually deploying the same reviewed
commit. A second migration URL in the web service environment would expose that privilege to a
compromised app and is prohibited. Keep this deployment to one instance. Review current provider
allowances and billing settings before use.

This is a small trial environment. Render Free sleeps after 15 minutes without inbound traffic and
can take about a minute to wake. A live debate page polls the app every three seconds, but an
instance restart can still interrupt the turn clock. Supabase Free can pause after a week of low
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
   brackets, URL-encode reserved password characters, and require SSL with `sslmode=require`. Keep
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
2. In a secured operator container or release runner, run `scripts/provision-database.js` as the
   administrator using a provisioning-only secret environment. Next run the **same reviewed image**
   with the owner URL as `DATABASE_URL`, in a separate one-off process:

   ```sh
   docker run --rm --env-file /secure/yaparena-migration.env \
     ghcr.io/OWNER/REPOSITORY@sha256:REVIEWED_DIGEST \
     node scripts/migrate-database.js
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

## Later scale-up

The Free setup is for functional trials. For reliable scheduled events, first upgrade the Render
web service so it stays awake; then separate the clock into a worker with leader election and
monitoring. Move to a paid database with restore-tested backups before accepting real users. Add
alert delivery, load and media trials, and a shared rate limiter before scaling web instances.
Keep production in separate provider projects and credentials. See
[decision 0004](decisions/0004-live-debate-replay.md) for open production media decisions.
