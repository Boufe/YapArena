# Low cost staging

The staging stack uses one Render web service, Supabase Postgres, LiveKit Cloud, and Cloudflare R2.
Render runs the existing Node app and its background clock in one process. Supabase only hosts
PostgreSQL; the application continues to own accounts, sessions, and authorization. LiveKit carries
the live video and records it to a private R2 bucket. The browser reads replays through short-lived
signed URLs created by the app.

`render.yaml` creates **one Free Render web service**. It does not create a Render database or
worker. Its Docker start command applies pending database migrations before starting the server;
Render's separate pre-deploy command is unavailable on Free web services. Keep this deployment to
one instance. Review each provider's current free allowances and billing settings before use.

This is a small trial environment. Render Free sleeps after 15 minutes without inbound traffic and
can take about a minute to wake. A live debate page polls the app every three seconds, but an
instance restart can still interrupt the turn clock. Supabase Free can pause after a week of low
activity. Do not use this environment for promised live events or real user data.

## Create the database

1. Create a Supabase Free project in a region close to Render's Ohio region.
2. Disable Supabase's **Data API** for the project in the Data API integration settings. This app
   uses its own Express API and direct PostgreSQL queries; its tables are not designed for public
   access through Supabase REST or GraphQL.
3. In the project's **Connect** dialog, copy the **Session pooler** PostgreSQL URL (port 5432).
   This supports the app's persistent `pg` pool on an IPv4 network. Do not use the transaction
   pooler URL (port 6543) for this deployment. Keep the URL and password out of Git and chat.

## Deploy the web service

1. Commit and push the intended staging branch. Validate `render.yaml` with
   `render blueprints validate render.yaml`.
2. In Render, use **New → Blueprint**, connect `Boufe/YapArena`, and select the staging branch.
   Review the preview: it should create only `yaparena-staging-web` on the Free plan.
3. When prompted for `DATABASE_URL`, paste the Supabase Session pooler URL in Render's secret field.
   Render generates `STAGING_ACCESS_SECRET` for the web service. Deploy the Blueprint.
4. Confirm migrations succeeded in the deploy logs and `/ready` passes. Open the HTTPS Render URL
   with username `staging` and the generated `STAGING_ACCESS_SECRET` as password. Do not put the
   secret in Git or a message. `/health`, `/ready`, and the signed LiveKit webhook endpoint are
   exempt from this staging gate.

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

| Variable                                        | Source                                      |
| ----------------------------------------------- | ------------------------------------------- |
| `LIVEKIT_URL`                                   | LiveKit Cloud HTTPS API URL                 |
| `LIVEKIT_PUBLIC_URL`                            | LiveKit Cloud WSS browser URL               |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`         | LiveKit project credentials                 |
| `MEDIA_S3_ENDPOINT`, `MEDIA_S3_PUBLIC_ENDPOINT` | R2 HTTPS S3 endpoint (same value for both) |
| `MEDIA_S3_REGION`                               | `auto`                                      |
| `MEDIA_S3_BUCKET`                               | Private R2 bucket name                      |
| `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`    | R2 bucket-scoped S3 credentials             |

The current media provider sends the same S3 key to LiveKit Egress and uses it for playback. A
single bucket-scoped key therefore needs write and read permissions. Split those permissions and
rotate staging credentials before a public launch. A new event under `prototype-media-1` is needed
for a live media trial. Use two test speakers on separate networks and verify join, turn changes,
pause/resume, recording completion, replay playback, captions, and reconnects.

## Later scale-up

The Free setup is for functional trials. For reliable scheduled events, first upgrade the Render
web service so it stays awake; then separate the clock into a worker with leader election and
monitoring. Move to a paid database with restore-tested backups before accepting real users. Add
alert delivery, load and media trials, and a shared rate limiter before scaling web instances.
Keep production in separate provider projects and credentials. See
[decision 0004](decisions/0004-live-debate-replay.md) for open production media decisions.
