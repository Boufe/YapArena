# Render staging

`render.yaml` defines a paid staging web service, a single background worker, and a private
PostgreSQL 18 database in Render's Ohio region. The web service uses Render's temporary HTTPS
`onrender.com` address. It runs database migrations as a pre-deploy step. The web service does not
run maintenance or the one-second debate clock; the worker does. Keep the worker at one instance
until the clock has explicit leader election and recovery monitoring.

The Blueprint uses a 1 CPU / 2 GB web instance, a 0.5 CPU / 512 MB worker, a 0.5 CPU / 1 GB
database, and 5 GB of database storage. Review Render's current estimate in its dashboard before
creating these paid resources. Media, replay storage, network usage, and later scale cost extra.

## Create the base environment

1. Connect the GitHub repository to a Render workspace with a payment method. This Blueprint
   deploys the committed branch, so local uncommitted files do not appear in the deployment.
2. Validate `render.yaml` with `render blueprints validate render.yaml`. Import it as a new Blueprint
   in the Render dashboard and review the resource and monthly cost preview before creating it.
3. Render generates `STAGING_ACCESS_SECRET` for the web service. Open its Environment page to reveal
   the value. Visit the HTTPS staging address using username `staging` and that value as the
   password. Do not put the secret in Git or a message. The app exempts only `/health`, `/ready`,
   and the signed LiveKit webhook endpoint from this gate.
4. Confirm the web service passes `/ready`, the worker stays running, the migration command
   succeeds, and the database has no public inbound IP rules. Use test accounts and test data only.

The first deploy has no media configuration. The debate page will say live media is not configured
for this deployment until the services below are connected. Seeded demo debates use the older
`preview-1` rules and cannot be used for a real media trial.

## Add media for a complete staging trial

Create a separate LiveKit Cloud staging project and a private Cloudflare R2 bucket. Create a
bucket-scoped R2 key for the current prototype's write, read, and HEAD operations. Configure R2
CORS for GET from the Render HTTPS origin. Set the LiveKit webhook
URL to `https://<staging-host>/api/media/webhook`; the application verifies its signature.

Add the following variables to **both** the web service and worker, preferably through a Render
environment group. Supply actual values in Render, never in `render.yaml`:

| Variable                                        | Source                              |
| ----------------------------------------------- | ----------------------------------- |
| `LIVEKIT_URL`                                   | LiveKit Cloud HTTPS API URL         |
| `LIVEKIT_PUBLIC_URL`                            | LiveKit Cloud WSS browser URL       |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`         | LiveKit staging project credentials |
| `MEDIA_S3_ENDPOINT`, `MEDIA_S3_PUBLIC_ENDPOINT` | R2 HTTPS S3 endpoint                |
| `MEDIA_S3_REGION`                               | R2 region value (`auto`)            |
| `MEDIA_S3_BUCKET`                               | Private replay bucket name          |
| `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`    | R2 key scoped to the replay bucket  |

The current media provider sends the same S3 key to LiveKit Egress and uses it for playback. A
single bucket-scoped key therefore needs write and read permissions. Before a public launch,
separate those permissions and rotate staging credentials. Media configuration is all-or-nothing:
setting only some of these variables makes the process refuse to start.

Create a **new** event under `prototype-media-1`. Two real test speakers check devices and join;
an operator starts it after both are connected. Verify turn changes, pause/resume, recording
completion, replay publication, captions, and reconnects from separate networks. The production
media architecture and product timings are still pending review in
[decision 0004](decisions/0004-live-debate-replay.md).

## Before production traffic

Keep production in separate Render and LiveKit environments. Add a restore-tested database backup,
database high availability, alert delivery, load and media trials, and a shared rate limiter before
scaling the web service beyond one instance. `STAGING_ACCESS_SECRET` is a staging gate, not a user
identity or production authorization mechanism. The Render URL is a temporary address; use a
controlled domain and review cookies, SIWE origin, webhook URL, and CORS when changing it.
