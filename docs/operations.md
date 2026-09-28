# Operations runbook

This runbook covers the local production-like stack. Adapt commands, credentials, storage, and
approval procedures before using them in a hosted environment.

Run local commands from the repository root, where `compose.yaml` is located. The setup requires
Docker with Compose and an active Docker daemon. Commands containing values such as
`/secure/location/yaparena.dump`, `OWNER`, `REPOSITORY`, `USER`, or `DATABASE_HOST` use placeholders;
replace them with real values before running the command. The [glossary](glossary.md) defines the
container, migration, image, digest, and deployment terms used below.

## Start and verify

```sh
cp .env.example .env
docker compose up --detach --wait db
docker compose run --rm --build app \
  node node_modules/node-pg-migrate/bin/node-pg-migrate.js up
docker compose up --detach --build --wait app
docker compose ps
```

- `cp .env.example .env` creates the local configuration file from development defaults. If `.env`
  already exists, inspect it instead of overwriting local ports, passwords, or other changes.
- `docker compose up --detach --wait db` starts PostgreSQL and waits until it is healthy.
- `docker compose run ... up` builds a temporary app container and applies pending migrations, which
  are versioned changes to the database schema. `--rm` removes the temporary container afterward, not
  the PostgreSQL data volume.
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

Logs redact authorization and cookie headers, but should still be access-controlled.

## Apply migrations

Back up the database before a risky schema change. Apply migrations once as a release step, before
sending traffic to code that requires the new schema:

```sh
docker compose run --rm --build app \
  node node_modules/node-pg-migrate/bin/node-pg-migrate.js up
```

This builds a temporary app container and applies pending schema changes.

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
  'psql -U "$POSTGRES_USER" -d restore_test -c "SELECT count(*) FROM messages;"'
```

- `createdb` creates an isolated database for the restore test.
- `pg_restore` loads the backup without restoring ownership or privileges.
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

On the deployment host, provide the immutable image reference and production database URL through
an access-controlled environment file. Apply migrations as a separate release step:

```dotenv
APP_IMAGE=ghcr.io/OWNER/REPOSITORY@sha256:IMMUTABLE_DIGEST
DATABASE_URL=postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE
APP_ORIGIN=https://service.example.com
TRUST_PROXY=1
LOG_LEVEL=info
HOST_PORT=3000
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

```sh
docker compose --env-file /secure/yaparena.env \
  --file compose.production.yaml --profile release run --rm migrate
```

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
