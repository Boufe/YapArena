# Operations runbook

This runbook covers the local production-like stack. Adapt commands, credentials, storage, and
approval procedures before using them in a hosted environment.

It covers the current service and local reference deployment. Starting or deploying it does not activate either
planned financial market. Follow the [product PRD](product-prd.md) and the
[pre-funds evidence checklist](product-specification-outlines.md#e-evidence-required-before-accepting-real-funds)
before any real-fund release; the Compose health check and migrations below are only part of that
evidence.

For local live debate and replay, use the optional [media prototype runbook](decisions/0004-live-debate-replay.md).
For event chat, reports, case review, appeals, share assets, and retention, use the
[community operations runbook](community-operations.md).
During an incident, inspect the event's media state and history, pause the clock, and verify Egress
and object storage before resuming or publishing replay. Recording stop failures are retried by the
server worker and surfaced as an incident in media state.
The [playback runbook](media-playback-operations.md), [delivery controls](media-delivery-controls.md)
and [automatic replay guide](replay-automation.md) supersede the prototype's routine manual
packaging/publication requirement when packaging is enabled. The separate encoder publishes only
after verifying the package; recording readiness alone is not adaptive readiness. The
[hosted trial](replay-starter-trial-2026-10-07.md) records the existing encoder and staging rollout.

Run local commands from the repository root, where `compose.yaml` is located. The setup requires
Docker with Compose and an active Docker daemon. Commands containing values such as
`/secure/location/yaparena.dump`, `OWNER`, `REPOSITORY`, `USER`, or `DATABASE_HOST` use placeholders;
replace them with real values before running the command. The [glossary](glossary.md) defines the
container, migration, image, digest, and deployment terms used below.

For A4 Yap Coins, use [financial operations](financial-operations.md) for explicit play-only
activation, reconciliation, durable settlement recovery and future adapter dependencies.
Stopping admission must preserve recovery of existing obligations. The replay encoder remains separate.

## Start and verify

```sh
cp .env.example .env
docker compose up --detach --wait db
docker compose --profile release run --rm --build provision
docker compose --profile release run --rm migrate
docker compose up --detach --build --wait app
docker compose ps
```

- `cp .env.example .env` creates the local configuration file from development defaults. If `.env`
  already exists, inspect it instead of overwriting local ports, passwords, or other changes.
- `docker compose up --detach --wait db` starts PostgreSQL and waits until it is healthy.
- `provision` is the separate administrative operator container that creates/adopts the private
  schemas and identities. `migrate` applies node-pg-migrate changes using only the owner login.
  The app receives only runtime credentials. `--rm` removes these one-off containers, not data.
- `docker compose up --detach --build --wait app` builds and starts the API, then waits for health.
- `docker compose ps` shows service state and health.

Expected state: both `app` and `db` are healthy.

```sh
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/ready
```

The `--fail` option makes either check return an error for unsuccessful HTTP responses.

- `/health` confirms the HTTP process is alive.
- `/ready` confirms PostgreSQL is reachable.

### Monitoring checks

Start the optional local monitoring profile:

```sh
docker compose --profile monitoring up --detach --build --wait
```

A Compose profile is an optional group of services. The `monitoring` profile starts Prometheus and
Grafana in addition to the API and database; it is not required for ordinary application development.

Confirm that Prometheus sees the application target as healthy:

```sh
curl --fail http://localhost:9090/api/v1/targets
```

Grafana is available at <http://localhost:3001>. Its Prometheus data source and
the **YapArena overview** dashboard are provisioned from version-controlled files
under `monitoring/grafana/`.

Review alert state at <http://localhost:9090/alerts>. The local rules detect an
unavailable API, a 5xx rate above 5%, and p95 latency above 500 ms. Connect
Prometheus to an Alertmanager in a deployed environment to route notifications;
the local stack intentionally does not send them.

## Local verification

The in-progress [email-first account operating contract](email-first-accounts.md)
lists Privy/Redis runtime variables, provider-session fences, financial gates and
the explicit guarded staging-reset command. Provision/migrate as a separate owner
process; web and worker processes must keep runtime credentials only. The narrowed
four-account staging reset was executed after backup and rehearsal; retained
accounts and the later manual signup must remain. The guarded reset command must
never run at startup or from a migration. Do not repeat the reset for acceptance.

Current state (2026-10-22): the founder decided on 2026-10-22 to reset, not repair,
the frozen staging accounts. This supersedes the retention rule above. The guarded
command ran on 2026-10-22 at 04:54:25 UTC with `--user-ids=72,73,134,135,136`
(every account; `--all-users` fails its own post-delete check while an unowned
wallet challenge exists). It removed five users, one session and one linked
wallet after an encrypted backup and a passing local restore rehearsal, with both
Render services suspended. Play runs, journals, media and subject IDs remain. The
two linked Privy users were deleted in the Privy dashboard. Staging then had no accounts.
Readiness returned 200 after resume and a fresh email signup succeeded; passkey,
wallet and other journeys were not retested after this reset.

Use Node.js 24 and locked dependencies. The complete source quality gate needs explicit
disposable A4, wallet and revocation PostgreSQL identities; without them those suites skip
and the unchanged 90% coverage thresholds can fail. The supported isolation harness creates
the identities, applies migrations, runs runtime-role journeys, and supplies all six test URLs:

```sh
A4_QUALITY=true npm run verify:database-isolation
# Native alternative: PostgreSQL 17/18 tools on PATH, non-root user:
LC_ALL=C LANG=C DATABASE_TEST_MODE=host A4_QUALITY=true npm run verify:database-isolation
# Include the expanded account/security/coin/media PostgreSQL regression suites:
LC_ALL=C LANG=C DATABASE_TEST_MODE=host ACCOUNT_SECURITY_VERIFY=true A4_QUALITY=true npm run verify:database-isolation
```

`A4_QUALITY=true` runs the full `npm run check` once against the fresh database.
Add `A4_VERIFY=true` to run the focused A4 PostgreSQL suite separately in both fresh and
upgrade scenarios. Native initdb explicitly uses UTF-8; the harness verifies server/client
encoding and C locale when requested. Account-security verification runs its focused
suites on fresh and upgrade paths. The account-security and full-quality modes also
create separate Base Sepolia treasury fixture databases; these never change the
simulation rail used by the general suites. Every run removes its disposable cluster on exit.
No application process should load the combined operator `.env` or receive owner credentials.

For browser changes, `npm run verify:browser` coordinates the full database-backed quality
gate and account/A4, workspace, shared-data, homepage and preview journeys. Set
`DATABASE_TEST_MODE=host` for its native alternative. See
[browser prerequisites and fixture isolation](browser-release-checks.md).
The native Unicode smoke (`npm run verify:community-native-setup`), full community delivery,
replay pipeline and media packaging checks retain their separate scopes.

GitHub requires `quality / check`, `container`, `integration`, `monitoring` and `deployment`
on an up-to-date PR head. `integration` includes the native C-locale smoke, Docker database,
browser, community, replay and backup/restore checks. `deployment` validates production
Compose configuration; passing it does not deploy a hosted service. The active main ruleset
was rechecked on 2026-10-19. [Current merge/CI evidence](evidence/ci-integration/2026-10-19.md#completed-integration--2026-10-19)
is separate from hosted acceptance.

## Account credential and session incidents

Use the [account session revocation procedure](security/account-session-revocation.md) for
owner session sign-out, wallet compromise and operator password credential updates.
It defines account-first transaction locks, audit and generation checks. By founder
decision on 2026-10-22, **Sign out** ends only this device's session, without a
generation change or Privy call; the browser ends its own Privy session. Sign out
all sessions and Sign out other sessions were removed. The account page's Active
sessions list signs out one chosen device. To end every session for an incident,
use a credential update or suspension. These operations allow a fresh sign-in
with a retained credential; they are not account suspension. The integrated media
revocation queue disconnects tracked speakers separately and retries provider failures.
Cloud token rejection, legacy-grant drainage and hosted acceptance retain the
separate gates documented in that procedure.

Signed-in requests no longer call Privy ([Decision 0008](decisions/0008-auth-simplification.md)
step 9). A request whose last Privy read is over 15 minutes old schedules an asynchronous
re-check, described in the [revocation procedure](security/account-session-revocation.md).
`yaparena_auth_journey_total` counts its outcomes as `provider_recheck_unchanged`,
`_recorded`, `_revoked`, `_deferred`, `_unavailable`, `_skipped` and `_error`; errors
are also logged as `provider re-check failed`. A Privy outage now blocks only new
sign-ins and step-up approvals, not signed-in browsing. `GET /api/auth/provider`
serves Privy's sign-in settings from a five-minute cache (after a failed refresh it
serves the last good answer and retries after 15 seconds), and the server refuses
Privy apps that enable any sign-in method other than email codes, Google and passkeys.

New passkeys are enrolled through Privy in Account settings. Sensitive operations
verify the same key using an application-issued, expiring, one-use WebAuthn
challenge. Previously enrolled independent application keys remain retained
credentials. Do not repair a failed first setup by deleting credential history,
changing its provenance or clearing session-generation fences. The approved
restart applies only to an account with no financial or prior strong-method
history and requires fresh provider login plus native passkey verification.
See [the current passkey contract](security/account-session-revocation.md#one-privy-passkey).

Normal provider reset jobs persist intent before the single mutation. Only an
acknowledged freeze/unfreeze response enables GET-only confirmation across web
instances and restarts. Each phase permits at most eight reads or 120 seconds,
scheduled ten seconds apart. Unknown mutation outcomes, independent freezes and
exhausted budgets remain fenced for review; do not reset their state to pending.
Sign out no longer queues these jobs; incidents, key triggers, wallet removal,
password changes and suspension still do. A job overtaken by a newer generation
stops for manual review once it has requested a freeze, and a newer job behind
an unfinished older one stops as `inherited_manual`. The older job cannot advance
the mapping's generation/token cutoff or wake wallet provisioning. The `92f11b4`
drain for resets superseded by sign-out-all/others was removed with those actions
on 2026-10-22. Read-only propagation checks release database connections. The bounded mutation
window retains account ordering. These authentication jobs run every ten seconds with
the other background jobs: on the web service while `RUN_BACKGROUND_JOBS` is true,
and in the maintenance worker (`npm run start:worker`). Since
[Decision 0009](decisions/0009-auth0.md) neither process starts these Privy jobs; the
code remains until prompt 12 deletes it.
See [the staging cut-over](render-staging.md#move-background-jobs-to-the-worker).

An uncertain provider freeze/unfreeze requires evidence review. The explicit
owner-only `scripts/retry-account-provider-reset.ts` modes separate an ordinary
retry, a single reviewed delayed-freeze reconciliation and read-only-provider
finalization after a delayed unfreeze confirmation. Finalization can make only
provider GET requests and requires the exact audit event, review-file hash,
generation, unchanged credential digest and explicit null freeze timestamp.
Never repeat an unfreeze merely because its immediate read lagged. The
[recorded repair](evidence/account-completion-baseline/provider-reset-repair/README.md)
documents the concrete evidence and limitations. The operator inspection and
repair processes must not run in the web or worker process.

The owner repository methods `prepareAcknowledgedLogoutReset` and
`resumeAcknowledgedLogoutReset`, which rearmed the stopped first-key/logout
overlap pair, were removed on 2026-10-22 together with sign-out-all/others; no
owner rearm procedure exists. Uncertain or independently imposed freezes use the
modes above or separate investigation. Before deploying that change, confirm
read-only that no `provider_revocation_jobs` row is unfinished and no linked
Privy user is frozen ([Decision 0008](decisions/0008-auth-simplification.md#rollout-prompts-912)).

The separate `repair-first-passkey` / `finalize-first-passkey` modes cover only
the reviewed unfinished first-key case: an unchanged valid accepted baseline,
exactly one trusted new key, no financial or prior strong-method history, exact
generation/attempt and an independently reviewed own-freeze window. A durable
review marker precedes the one unfreeze; finalization is GET-only. Neither mode
adopts the key or creates a session. `ACCOUNT_STAGING_PROVIDER_ACTION` must match
the explicit mode, and `ACCOUNT_STAGING_CA_PATH` selects the trusted CA file.
The [actual first-key repair](evidence/account-completion-baseline/first-passkey-reset-repair/README.md)
is complete and must not be repeated as a routine login workaround.

The [embedded-wallet runbook](embedded-wallets.md) describes the separate durable
empty-wallet queue, user-only ownership verification, bounded retry/review states
and original-DID recovery restriction. Its creation job uses existing runtime
`PRIVY_APP_ID` / `PRIVY_APP_SECRET`, no application signing key or owner database
credential. Dashboard creation-on-login remains off because the explicit server
job handles headless email login and survives browser navigation. Creating an
empty address does not enable crypto funding, signing or redemption.
After the exact release, use the [read-only wallet verifier](embedded-wallet-verification.md)
to distinguish actual provider ownership acceptance from pending setup or a
synthetic transport result. It performs no creation or repair.

Staging migration release uses `scripts/release-account-staging.ts` explicitly:
stop and independently verify all writers, pass the exact-revision release gates,
then run `prepare` for encrypted backup/restore rehearsal before `migrate`.
`ACCOUNT_STAGING_WRITERS_STOPPED` and
`ACCOUNT_STAGING_RELEASE_GATES_PASSED` are operator assertions, not proof. Its
reviewed pending migration list is exact. Preserve earlier release evidence and
verify retained/manual account counts, runtime-role grants and zero live history
afterward. Web runtime configuration uses `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`,
`AUTH0_CLIENT_SECRET` and the optional `REDIS_SECURITY_URL`, `REDIS_NAMESPACE` and
`REDIS_KEY_SECRET` ([Decision 0009](decisions/0009-auth0.md)); the jobs worker needs none of
them. Owner credentials and private backup material are never runtime variables.

Deploy the auth fixes with a coordinated restart. The additive F03 migration signs out all
legacy sessions and consumes pending challenges. Its schema guards must stay installed
through application rollback; restored session rows must be retired before reopening traffic.

## Diagnose an incident

1. Check container state and health: `docker compose ps`.
2. Read recent logs: `docker compose logs --tail=100 app db`.
3. Follow application logs: `docker compose logs --follow app`.
4. Call `/health`; failure suggests a process or network problem.
5. Call `/ready`; `503` suggests a database problem.
6. Correlate a request using its `X-Request-Id`:

   ```sh
   docker compose logs app | grep 'REQUEST_ID'
   ```

   Replace `REQUEST_ID` with the identifier from the failed HTTP response or log entry. This filters
   application logs for that one request so its events can be followed together.

Logs redact incoming Authorization/Cookie headers and the entire outgoing Set-Cookie field.
Keep log access restricted. Error fields (`error`, `err`, `permissionError`, `pauseError`,
`stopError`) contain a fixed redacted summary: raw messages, stacks, nested causes and provider
diagnostics can include credentials. Diagnose using fixed event messages, request IDs, status,
timing and safe structured context. Field redaction does not sanitize arbitrary free-text log
messages; do not interpolate credentials or raw errors into messages or other context fields.

### Credential logging follow-up (F01)

Before this fix, successful registration, password login, SIWE login and measurement consent
responses could write bearer cookies into HTTP completion logs. Hosted log permissions and
historical access have not been inspected; this finding does not establish a production compromise.
Local regressions verify the code with real Pino 10.3.1 / pino-http 11.0.0 output, isolated streams
and synthetic accounts. The registration regression failed against the original logging configuration
(with destination injection only) and passed after redaction. Deployed verification is separate.

**Pending operator actions; none performed by this local fix:**

1. Restrict read/export access to affected application logs and connected log drains; review who
   could access them.
2. Establish the historical exposure period from deployed versions and log retention. Inventory
   retained copies, exports, drains and backups; assess access using restricted incident procedures.
   Do not paste bearer values into tickets or diagnostics. Historical-log changes require separate
   authorization.
3. Determine the affected session scope and actual expiry configuration. Obtain separate authorization
   and execute session revocation; consider revoking all outstanding sessions if exposure cannot be
   bounded. Review exposed measurement credentials as well. Record the scope and counts without tokens.
   Deploying this patch alone does not invalidate previously issued credentials.
4. Obtain deployment authorization, release the fix, then verify the deployed application and every
   logging destination/drain with synthetic registration, password/SIWE login, logout and consent
   grant/withdrawal. Check incoming headers, multiple cookies and explicit/automatic errors. Compare
   returned bearer values to captured output in memory, reporting only pass/fail; never print cookies,
   signatures, passwords or provider secrets. Confirm usable client cookies, redacted Set-Cookie,
   correlated request IDs, status, timing, levels and monitoring exclusions.
5. Record the deployed commit/image, UTC verification time, reviewer, exposure assessment and
   revocation decision as sanitized incident evidence. Retain access restrictions until follow-up is complete.

## Apply migrations

The Work Package 6 measurement release adds two additive migrations. Its deploy, smoke,
consent/retention review, and rollback sequence is in
[measurement operations](measurement-operations.md#release-and-rollback-sequence). CI runs an
isolated backup/restore check against disposable local PostgreSQL; repeat a provider restore
verification in staging before treating backups as operational evidence.

Back up the database before a risky schema change. Apply migrations once as a release step, before
sending traffic to code that requires the new schema:

```sh
docker compose --profile release run --rm --build migrate
```

This starts a one-off migration container with the owner identity; it does not give that credential
to the running app. See [database isolation](security/database-isolation.md) for fresh/upgrade
provisioning, grants/RLS maintenance, inventory, hosted checks and recovery. Keep migration/admin
secrets out of web and worker environments, mounts and shared secret groups.

“Pending” means migration files present in the application image that are not yet recorded as applied
in that database. Do not run two release migration jobs concurrently. The advisory lock protects this
project's migration execution, but the release process should still have one clear owner and outcome.

Migrations are transactional by default and protected by an advisory lock. Review both `up` and
`down` code. Prefer a forward-fix in production; rollback can be destructive after new code has
written data in a new format.

## Create a backup

Store real backups in encrypted, access-controlled storage outside the host running PostgreSQL.

```sh
docker compose up --detach --wait db
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > /secure/location/yaparena.dump
```

- The first command starts PostgreSQL and waits until it is healthy.
- The second creates a custom-format database backup at the specified secure location. Replace
  `/secure/location/yaparena.dump` with an existing, writable path on the host computer. The `>` is
  performed by the host shell, so the backup file is written on the host, not inside the container.

Validate that PostgreSQL can read the archive:

```sh
docker compose exec -T db pg_restore --list \
  < /secure/location/yaparena.dump | head
```

Lists the beginning of the archive contents to confirm PostgreSQL can read it.

A backup is not proven until a restore test succeeds.

## Test a restore

Restore into a new database first. Never overwrite the live database as an initial test.

The commands below use `restore_test` as a disposable database name and assume the backup path was
replaced with the same real host path used above. The underscore keeps this name valid as an unquoted
PostgreSQL identifier even when the project slug contains hyphens.

```sh
docker compose exec db sh -c \
  'createdb -U "$POSTGRES_USER" restore_test'

docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner --no-privileges' \
  < /secure/location/yaparena.dump

docker compose exec db sh -c \
  'psql -U "$POSTGRES_USER" -d restore_test -c "SELECT count(*) FROM yaparena.messages;"'
```

- `createdb` creates an isolated database for the restore test.
- `pg_restore` loads data without restoring ownership or privileges. This checks data restoration
  only; it does not restore the server-only database boundary. Before any runtime promotion,
  restore reviewed owners/ACLs/policies and repeat the database isolation checks. See the
  [isolation recovery instructions](security/database-isolation.md#future-migrations-and-recovery).
- `psql ... SELECT count(*)` verifies that restored message data is queryable.

After verification, remove only the throwaway database:

```sh
docker compose exec db sh -c \
  'dropdb -U "$POSTGRES_USER" restore_test'
```

Deletes only the temporary restore-test database.

## Stop and clean up

Stop containers and preserve data:

```sh
docker compose down
```

Stops containers while retaining their persistent volumes.

Danger: the following command deletes the local PostgreSQL volume and all of its data:

```sh
docker compose down --volumes
```

Stops containers and permanently deletes their local volumes.

Use it only when intentionally resetting the local database and after confirming that no needed data
exists solely in that volume. A normal `docker compose down` is sufficient when you only want to stop
the project.

## Rollback principles

1. Stop sending traffic to the failing release.
2. Preserve logs, request IDs, image digest, and migration state.
3. Prefer deploying the last known-good immutable image.
4. Verify schema compatibility before rolling application code backward.
5. Restore data only for corruption or loss—not as a routine code rollback.
6. Document the timeline and follow-up actions after recovery.

An image tag can move; record and deploy the immutable image digest for an actual release.

## Release and deploy an image

Create releases from a clean, reviewed `main` commit using a strict semantic version tag:

```sh
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

- The annotated `vMAJOR.MINOR.PATCH` tag identifies the reviewed release and triggers publication.
- Semantic versions communicate compatibility; the resulting digest identifies the exact bytes to
  deploy.

Replace `v1.0.0` with the intended release version. `git tag` creates the tag locally; `git push
origin v1.0.0` sends that specific tag to GitHub, where the release workflow starts. Confirm
`git status` is clean and that the checked-out commit is the reviewed `main` commit before tagging.
The workflow accepts only a `vMAJOR.MINOR.PATCH` tag whose commit is in `main` history. Protect
release tags in GitHub when that setting is available, since anyone allowed to create one can start
a publication run. Make sure the release workflow has reached `main` before tagging.

The `Release container` workflow publishes Linux AMD64 and ARM64 images to GHCR with OCI build
provenance and an SBOM. Copy the `image@sha256:...` reference from the workflow summary. Version
and commit tags are convenient discovery pointers, but deployments must use the digest.
After the first release, verify the registry manifest lists both platforms, the provenance and SBOM
are attached to the published image, and the summary digest resolves to that manifest. Confirm the
deployment host has read access to the package if GHCR keeps it private.

Releases and the `CI` workflow's `main`-only `publish` jobs share `reusable-publish.yml`. Each
push to `main` publishes `linux/amd64` web and encoder images tagged `sha-<full commit SHA>`, which
the [Render staging runbook](render-staging.md#deploy-the-ci-published-images) deploys. The shared
workflow pushes by digest without a tag, scans every platform of that pushed digest with the
`container` job's Trivy settings, and tags it only after the scan passes. It never moves an
existing tag; if the first requested tag exists, the run reports its digest and publishes nothing.

On the deployment host, provide the immutable image reference and production database URL through
an access-controlled environment file. Apply migrations as a separate release step:

```dotenv
APP_IMAGE=ghcr.io/OWNER/REPOSITORY@sha256:IMMUTABLE_DIGEST
DATABASE_URL=postgresql://yaparena_runtime:RUNTIME_PASSWORD@DATABASE_HOST:5432/DATABASE
APP_ORIGIN=https://service.example.com
TRUST_PROXY=1
LOG_LEVEL=info
HOST_PORT=3000
METRICS_TOKEN=RANDOM_SCRAPER_TOKEN
```

This block is an example of the file's contents, not a command to paste into the shell. Create the
protected file using the deployment host's secret-management procedure, replace every placeholder,
and restrict who can read it. It is separate from the local `.env` file and must never be committed.

- `APP_IMAGE` pins the exact reviewed artifact so a moving tag cannot change the deployment.
- `DATABASE_URL` grants runtime database access and must be secret-managed and rotated.
- `APP_ORIGIN` is the exact public HTTPS origin used to validate browser mutations.
- `TRUST_PROXY` is the number of trusted proxy hops; set it to the real topology, not an arbitrary
  large value.
- `LOG_LEVEL` controls operational detail, while `HOST_PORT` selects the loopback port used by the
  host reverse proxy.
- `METRICS_TOKEN` is the bearer token the metrics collector sends to `/metrics`; without it the
  production endpoint returns 404.

```sh
docker compose --env-file /secure/yaparena.env \
  --env-file /secure/yaparena-migration.env \
  --file compose.production.yaml --profile release run --rm migrate
```

The separate protected `/secure/yaparena-migration.env` supplies `DATABASE_MIGRATION_URL` with the
owner identity to the one-off service. Do not mount either operator file in app/worker containers;
the Compose environment mapping passes only the runtime URL to `app`. Do not print full Compose
configuration containing secrets; use `config --quiet` for validation.

The `release` profile enables only the one-off `migrate` service. A zero exit status means the schema
update completed; any nonzero status must stop the deployment until the failure is understood.

Only after migrations succeed, update the application:

```sh
docker compose --env-file /secure/yaparena.env \
  --file compose.production.yaml up --detach --wait app
```

This replaces or recreates the application container from the exact `APP_IMAGE` digest and waits for
its readiness check. It does not publish an image; publication happened in GitHub Actions when the
version tag was pushed.

The production port binds to loopback and should sit behind a TLS-terminating reverse proxy. Do not
store `DATABASE_URL`, registry tokens, or other production secrets in the repository.

This Compose flow is a single-host reference, not universal CD. A hosted product should translate the
same contract—digest, migration, health gate, and rollback digest—into its platform's deployment
mechanism and protect production with environment approvals or an equivalent control.

## Wallet credential-change gate

Apply F04 private-schema isolation, then F03 account revocation migrations, then F02
`1791158600000_wallet_operation_authorization.js` with the owner identity. Stop old instances
before migrating; deploy compatible authentication code and account assets together. Existing
sessions are retired by F03. Keep its generation guards if rolling back application code.

The [wallet authorization design](security/wallet-authorization.md) defines lock order,
operation expiry, notifications and containment. The original auth audit is a historical local
artifact, not a tracked repository document. Use the linked security contracts and their dated
evidence for the merged implementation; remaining incident and hosted-isolation checks require
their own evidence.
A successful wallet change creates identity activity and an in-app account notification in the
same transaction. Inspect those records by account using the supported owner process; never
capture passwords, signatures, cookies or operation proofs in incident artifacts.

Run the regression gate against a **disposable local** database provisioned as owner/runtime:

```sh
WALLET_TEST_DATABASE_URL="$AUTH_TEST_RUNTIME_URL" \
WALLET_TEST_OWNER_DATABASE_URL="$AUTH_TEST_OWNER_URL" \
REVOCATION_TEST_DATABASE_URL="$AUTH_TEST_OWNER_URL" \
REVOCATION_TEST_RUNTIME_URL="$AUTH_TEST_RUNTIME_URL" npm run check
```

Use a database named `yaparena_f02...` or `revocation_test...` and loopback URLs. Keep operator
connection values in the local shell/secret store. PostgreSQL tests create unique synthetic
accounts; do not point them at shared development, staging or production data. Without the
explicit URLs those integration suites are skipped; that is not race-safety evidence. CI's
quality job provisions a disposable PostgreSQL service and includes both suites under coverage.
The retained-wallet browser trial is `node scripts/verify-wallet-browser.ts` with `BROWSER_BASE_URL` and
`WALLET_TEST_OWNER_DATABASE_URL` for the same isolated instance. It uses synthetic wallets,
seeds disposable retained credentials, cleans only its own fixtures and writes PNG evidence
to `BROWSER_ARTIFACT_DIR`. It checks retained sign-in/removal, wrong proofs/account/chain,
rejected signatures, expiry, outage, replay and last-method protection. New external-wallet
linking is no longer a product control; existing backend link-authorization regression
tests remain. Embedded-wallet provisioning has separate [contracts and acceptance gates](embedded-wallets.md).

The [operational TypeScript guide](operational-typescript.md) lists the maintained database,
release and security sources, direct Node 24 commands and explicit quality-gate coverage.
