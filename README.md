# YapArena

YapArena is a live debate platform in development. It currently provides a Node.js 24,
strict TypeScript, Express, and PostgreSQL service with authentication, migrations, tests,
monitoring, container releases, public discovery, wallet sign-in, profiles, follows, topics,
nonfinancial debate matching, and a local live debate and replay prototype. The messages API remains
an example feature. Voting, incentives, and markets have not been implemented yet.

## Product direction and document authority

The [YAP Arena product PRD](docs/product-prd.md) defines the planned product. Its
[specification outlines and release evidence](docs/product-specification-outlines.md) identify
the financial, privacy, instrument, and eligibility decisions that still require approved
specifications and proof. When product guidance differs from the older
[service template PRD](docs/template-prd.md), follow the product PRD for YapArena behavior.

The planned first paid release includes two real-money crypto markets together: a debate-event
market and a continuing ideas market. Wallet sign-in and linked identities support this
nonfinancial preview. The existing email/password flow remains available for earlier accounts;
neither sign-in flow authorizes financial activity.
The PRD does not authorize accepting funds. Prototypes and simulations may precede launch, while
real-fund activation depends on the companion document's evidence checklist and qualified
jurisdiction-specific review.

The companion document is an outline, not an approved technical design. The next product work is
to settle the PRD's proposed and open decisions, then produce reviewable specifications for event
economics, hidden-tally protection, the ongoing instrument, and launch eligibility. Use the
worked examples and evidence requirements in those outlines to test each design. Both markets
must pass the combined release gate before the first paid launch.

The [nonfinancial implementation plan](docs/nonfinancial-implementation-plan.md) orders the
discovery, debate, replay, community, moderation, and operating work that can proceed while
financial specifications are resolved.
The [public discovery decision](docs/decisions/0001-public-discovery.md) records the initial
HTML/API architecture and its release checks.
The [identity and social decision](docs/decisions/0002-identity-and-social.md) records account
ownership, wallet recovery limits, audit retention, and export/deletion behavior.
The [topic and event decision](docs/decisions/0003-topics-matching-events.md) records the
preview's challenge, scheduling, no-show, audit, and lifecycle rules.
The [live media decision](docs/decisions/0004-live-debate-replay.md) records prototype timings,
recording gates, incident behavior, and the validation still needed before a production media choice.
The [low cost staging runbook](docs/render-staging.md) describes the Render app, Supabase database,
access gate, and LiveKit/R2 media integration steps.

To work on YapArena, follow [Local development](#local-development). The original
[service template guide](docs/getting-started.md) remains available if you want to create a separate
project from this foundation.

Cloning a repository already creates its local Git metadata and configures the GitHub repository as
the `origin` remote. Do not run `git init` after `git clone`.

See the [operations runbook](docs/operations.md) for health diagnosis, migrations, backup, restore,
and rollback procedures. The [glossary](docs/glossary.md) explains recurring Git, npm, Docker,
database, CI, and release terms.

## Requirements

- Git
- Node.js 24
- npm
- Docker with Compose

Git downloads the repository and records source changes. Node.js runs the application and development
tools, npm installs JavaScript packages, and Docker provides PostgreSQL and a production-like runtime.
Node 24 is required so local and CI behavior match.

Confirm the tools are available before running the setup commands:

```sh
git --version
node --version
npm --version
docker --version
docker compose version
```

`node --version` must report a version beginning with `v24`. The other commands should print versions
without errors, and the Docker application or daemon must be running before any `docker compose`
command can start a service.

## Local development

Run these commands from the repository root: the directory containing `package.json`,
`package-lock.json`, and `compose.yaml`. If this is a newly generated project, run its initializer
first because the initializer updates `.env.example` with the new project and database names.

Create local configuration:

```sh
cp .env.example .env
```

This copies the committed example settings into a new `.env` file used only on this computer. It
contains development ports, a local-only database password, and the database connection URL. The
application reads it when started with `npm run dev`, and Docker Compose reads it automatically. The
file is excluded by `.gitignore`; do not commit it or put production secrets in it. If `.env` already
exists, inspect it instead of overwriting custom local values.

Install the locked dependencies:

```sh
npm ci
```

Here, `ci` means **clean install**; it does not download or run the GitHub CI workflow. The command
downloads the exact package versions and integrity-checked files recorded in `package-lock.json` into
the generated `node_modules/` directory. It fails if `package.json` and the lockfile disagree, which
prevents this computer and automated CI from silently choosing different dependency versions. Unlike
`npm install`, it does not update the lockfile and it replaces an existing `node_modules/` directory
with a clean installation.

Start PostgreSQL and apply pending migrations:

```sh
docker compose up --detach --wait db
docker compose --profile release run --rm --build provision
docker compose --profile release run --rm migrate
```

- `docker compose up --detach --wait db` downloads the PostgreSQL image if needed, creates the local
  database container, leaves it running in the background, and waits until its health check passes.
  Its data remains in a Docker volume between restarts.
- `provision` creates/adopts separate owner and runtime identities in a one-off administrative
  container. `migrate` applies pending migrations in a different container using only the owner login. A migration is a
  versioned code change that creates or alters database tables. `--rm` removes only the temporary
  migration container after it exits; it does not remove the database or its stored data.

Start the API with automatic reload:

```sh
npm run dev
```

Create a separate ignored `.env.runtime` file with only the runtime `DATABASE_URL` and application
settings from `.env.example`; omit all operator passwords, fixture and migration URLs.
`npm run dev` starts the TypeScript API directly with Node.js, loads `.env.runtime`, and automatically restarts when source files
change. `npm run build` compiles production JavaScript into the ignored `dist/` directory. PostgreSQL must still be running in Docker. Open <http://localhost:3000/ready> to confirm the
API can reach the database. Press `Ctrl-C` to stop the API; the database container keeps running until
you run `docker compose down`.

### Public discovery preview

Open <http://localhost:3000/> for the public home page, or visit `/debates` and `/topics`.
Anonymous visitors can search and browse published debates, topics, and speaker profiles.
The read-only JSON API lives under `/api/public`. It supports bounded `q`, `status`, `topic`,
`profile`, `limit`, and `offset` query parameters as applicable. Debate pages show only public
event fields; they never infer a winner or expose a hidden tally.

The database starts with no public records. To add fictional, clearly marked examples in local
development after migrating, run:

```sh
npm run seed:discovery
```

The seed is idempotent and refuses `NODE_ENV=production`. It creates sample topics, speakers,
and listings only. A demo replay listing has no video. In Docker development, run the seed from
the host against the published database port, then refresh the pages. The old messages migration
and API remain for existing clients.
After a first successful visit, the public shell caches a short offline explanation. It does
not cache debate records; reconnect to see current content.

### Identity and social preview

Open <http://localhost:3000/account> to sign in with an EVM wallet and a one-time
Sign-In with Ethereum message. You can also use an existing email account, then link a wallet.
Creating a profile starts a private draft; choose Public and save to publish it. Public people
and topic pages have follow controls. The account page shows linked wallets, follows, and
recent identity activity and account notifications. Linking or unlinking requires your current
password or a fresh signature from an existing wallet that remains linked. Linking also requires
a separate signature from the new wallet. Approval expires after five minutes, and a successful
change renews the current session. Signing never authorizes a transaction. See the
[wallet authorization design](docs/security/wallet-authorization.md) for API and rollout details.

`APP_ORIGIN` must exactly match the browser origin, including the port, for SIWE challenges and
cookie-authenticated writes. EOA wallets work without RPC configuration. To verify contract
wallets, set `SIWE_RPC_URLS` to a JSON object mapping supported chain IDs to trusted RPC URLs,
for example `{"1":"https://rpc.example"}`. Production accepts only HTTPS RPC URLs.
Accounts with one wallet and no email cannot unlink their last sign-in method. Review the
[identity decision](docs/decisions/0002-identity-and-social.md) before collecting user data:
automated export and deletion are not yet available.

### Topics and debate matching preview

Open <http://localhost:3000/match> after signing in and publishing a profile. Create a topic
draft, review its side mapping, and publish it. You can then issue a direct challenge or open a
queue request. A second speaker accepts or joins on the opposite side. The match page shows
requests, scheduled events, readiness, and account notifications. Speakers complete a camera and
microphone check on the public event page before readiness. An operator can record reschedules,
cancellations, and no-shows through the matching API, and control live, pause, end, and replay through
the media API or the event page. The [event decision](docs/decisions/0003-topics-matching-events.md)
states the preview policies.

Every created event stores an immutable snapshot of its platform rules version. No event in
this preview accepts funds, computes a paid cutoff, or publishes a winner. Historical demo replay
listings have no recording. New events use prototype media timings until product rules are approved.

### Local live debate and replay prototype

The optional media stack uses LiveKit, an Egress recording worker, Redis, and S3-compatible local
storage. Start it with `docker compose -f compose.yaml -f compose.media.yaml` and apply migrations
before starting the app; see the [media decision](docs/decisions/0004-live-debate-replay.md) for the
exact commands, controls, and validation limits. Local keys in the Compose override are development
only. A recording must be complete and verified in object storage before an operator can publish
replay. Captions are reviewed WebVTT text uploaded by an operator. Extensions remain disabled.

Run the quality gate:

```sh
npm run check
```

This runs lint rules, verifies formatting and strict types, and executes the test suite with its coverage thresholds.
It is the same main quality gate used by CI, so run it before committing or opening a pull request.
CI means **continuous integration**: GitHub automatically runs checks on pushed changes.

## Runtime configuration

Copy `.env.example` for safe local defaults. Production values belong in a secret manager or a
protected environment file, never in Git.

An environment variable is a named setting read when a process starts. Changing `.env` does not edit
source code, and a running process or container must be restarted before it sees a changed value.

| Setting                              | Local default                      | Meaning                                                                                                                                  |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                           | `development`                      | Selects development or production security and error behavior.                                                                           |
| `HOST` / `PORT`                      | `0.0.0.0` / `3000`                 | Select the network interface and port used by `npm run dev`; normally keep the local defaults.                                           |
| `HOST_PORT`                          | `3000`                             | Selects the host port used to reach the API when it runs through Docker Compose.                                                         |
| `LOG_LEVEL`                          | `debug`                            | Controls how much structured log detail the application emits.                                                                           |
| `APP_ORIGIN`                         | `http://localhost:3000`            | Identifies the browser origin allowed to make cookie-authenticated write requests.                                                       |
| `SIWE_RPC_URLS`                      | `{}`                               | Maps EVM chain IDs to trusted RPC URLs for contract-wallet signature verification.                                                       |
| `TRUST_PROXY`                        | `false`                            | Trusts no reverse proxy locally; production must use the exact trusted proxy-hop count.                                                  |
| `REQUEST_BODY_LIMIT`                 | `10kb`                             | Rejects JSON request bodies larger than this amount.                                                                                     |
| `API_RATE_LIMIT`                     | `300`                              | Limits general API requests from one client during each rate-limit window.                                                               |
| `AUTH_RATE_LIMIT`                    | `10`                               | Applies a stricter limit to registration and login attempts during the same window.                                                      |
| `RATE_LIMIT_WINDOW_MS`               | `900000` (15 minutes)              | Defines the time window, in milliseconds, for both request limits.                                                                       |
| `SESSION_DURATION_MS`                | `604800000` (7 days)               | Defines how long a signed-in server-side session remains valid.                                                                          |
| `POSTGRES_DB` / `POSTGRES_USER`      | project-specific                   | Name the local PostgreSQL database and its bootstrap administrator, separate from runtime.                                               |
| `POSTGRES_PASSWORD`                  | `local-development-only`           | Authenticates the local PostgreSQL user; never reuse this example password outside local development.                                    |
| `POSTGRES_PORT`                      | `5433`                             | Exposes PostgreSQL on this host port while PostgreSQL continues to use port `5432` in its container.                                     |
| `DATABASE_URL`                       | project-specific PostgreSQL URL    | Gives Node.js a complete database connection string; it must use the dedicated `yaparena_runtime` login, never the owner/admin identity. |
| `PROMETHEUS_PORT` / `GRAFANA_PORT`   | `9090` / `3001`                    | Expose the optional local monitoring interfaces on these host ports.                                                                     |
| `GRAFANA_ADMIN_USER` / `...PASSWORD` | `admin` / `local-development-only` | Provide local Grafana sign-in credentials; replace them in every nonlocal environment.                                                   |

See `.env.example` for local ports and monitoring settings, and the
[operations runbook](docs/operations.md#release-and-deploy-an-image) for production values.

## Logging

Logs are JSON and include an `X-Request-Id` for correlation. Supply that header when tracing a
request across services; otherwise the API generates a UUID. Authorization and cookie headers are
redacted. Set `LOG_LEVEL` in `.env` to control verbosity.

```sh
docker compose logs --follow app
```

Streams application-container logs continuously for debugging; press `Ctrl-C` to stop following the
logs without stopping the container. If the API is running through `npm run dev` instead, its logs
already appear in that terminal.

## API

Check liveness and readiness:

```sh
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

- `/health` checks whether the API process is alive.
- `/ready` checks whether the API and PostgreSQL are ready.

Inspect Prometheus metrics:

```sh
curl http://localhost:3000/metrics
```

The endpoint exposes Node.js process metrics and bounded HTTP request count and
duration metrics. In a deployed environment, expose `/metrics` only to the
monitoring network or collector rather than the public internet.

### Local monitoring stack

Start the application with Prometheus and Grafana:

```sh
docker compose --profile monitoring up --detach --build --wait
```

- Prometheus: <http://localhost:9090>
- Prometheus alerts: <http://localhost:9090/alerts>
- Grafana: <http://localhost:3001>
- Dashboard: **YapArena / YapArena overview**

Grafana uses `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` from `.env`.
The example development credentials are `admin` / `local-development-only` and
must not be reused outside local development. Prometheus retains seven days of
metrics in a named volume; Grafana stores its local state in a separate named
volume.

Prometheus evaluates version-controlled alerts for API availability, HTTP 5xx
rate, and p95 request latency. The local stack has no Alertmanager, so it shows
alert state but does not send notifications.

Stop the stack while preserving its data:

```sh
docker compose --profile monitoring down
```

Register and save the session cookie:

```sh
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -c /tmp/yaparena.cookies \
  -d '{"email":"user@example.com","password":"a secure passphrase"}'
```

`curl` is a command-line HTTP client. `-X POST` selects the HTTP method, `-H` declares a JSON request,
`-d` supplies the JSON body, and `-c` saves the returned session cookie to a temporary file. The
example cookie path is under `/tmp`, so it is local and disposable; it is not a production session
store.

Create and persist a message as the authenticated user:

```sh
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -b /tmp/yaparena.cookies \
  -d '{"name":"Example User"}'
```

`-b` reads the saved cookie, authenticating this request as the registered user. The JSON body creates
and persists one example message owned by that user.

List messages with bounded pagination:

```sh
curl -b /tmp/yaparena.cookies \
  "http://localhost:3000/api/messages?limit=20&offset=0"
```

This sends an authenticated `GET` request. `limit=20` asks for at most 20 records and `offset=0` starts
at the first record. The response contains only the authenticated user's messages.

## Docker

Build and start the production service:

```sh
docker compose up --build
```

Builds images and starts the production-like stack in the foreground, where the combined logs remain
visible. Press `Ctrl-C` to stop those containers. Add `--detach` if you want the stack to remain in the
background and return control to the terminal.

Tagged releases publish multi-architecture images to `ghcr.io/OWNER/REPOSITORY`.
See [the operations runbook](docs/operations.md#release-and-deploy-an-image) for
the immutable-digest release and deployment procedure.

The template automates continuous delivery of a verified container artifact, but not deployment to a
particular cloud. Each product adds provider-specific continuous deployment because credentials,
approval gates, migration orchestration, health checks, and rollback mechanisms differ by runtime.

Check status and follow application logs:

```sh
docker compose ps
docker compose logs --follow app
```

- `docker compose ps` shows container state and health.
- `docker compose logs --follow app` streams application logs.

Stop containers while preserving database data:

```sh
docker compose down
```

Stops containers without deleting database volumes.

Change the HTTP host port when necessary:

```sh
HOST_PORT=8080 APP_ORIGIN=http://localhost:8080 docker compose up
```

Starts the stack with port `8080` exposed on the host and keeps browser-origin validation aligned with
the new URL. Put these values in `.env` if the change should apply to future Compose commands instead
of this one command only.

## Image security

Build and scan the production image for actionable high and critical vulnerabilities:

```sh
docker build --pull --target production --tag yaparena:local .
trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed yaparena:local
```

- `docker build --pull ...` refreshes base-image metadata, builds the Dockerfile's production stage,
  and gives the result the local name `yaparena:local`.
- `trivy image ...` requires the separately installed Trivy scanner. It reports high and critical
  vulnerabilities for which a fix is available; it does not modify the image.

The production stage removes npm, Yarn, and Corepack after installing dependencies. Development and
test stages retain those tools.

Database provisioning, privilege inventory, backend RLS policies, fresh/upgrade verification and
hosted isolation gates are documented in the [F04 database runbook](docs/security/database-isolation.md).
Run `npm run verify:database-isolation` separately from `npm run check` with Docker available.
