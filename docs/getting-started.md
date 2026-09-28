# Getting started from the template

Use this guide when you want a new project with its own name and GitHub repository while keeping this
template's application, database, tests, containers, and automation. Commands in this guide run in a
terminal. Text such as `YOUR-OWNER` is a placeholder that you must replace; do not type it literally.

## 1. Check the required tools

Install Git, Node.js 24 with npm, and Docker with Compose before creating the project. Confirm that
they are available:

```sh
git --version
node --version
npm --version
docker --version
docker compose version
```

`node --version` must begin with `v24`. Start Docker Desktop or the Docker daemon before using
`docker compose`. You also need a GitHub account with permission to create a repository under the
chosen user or organization.

## 2. Create and clone the new repository

On this template's GitHub page, choose **Use this template**, then **Create a new repository**. Select
your GitHub user or organization as the owner and give the repository the same lowercase,
hyphen-separated name you plan to use for `--slug`, such as `forecast-lab`. GitHub copies the template
files into a separate repository; later changes to the template do not automatically change your new
project.

Clone the new repository and enter its directory, replacing the example URL with the URL GitHub shows
for your repository:

```sh
git clone https://github.com/YOUR-OWNER/forecast-lab.git
cd forecast-lab
```

`git clone` downloads the files, creates the hidden `.git` metadata directory, and configures the new
GitHub repository as the `origin` remote. You do **not** need to run `git init` or `git remote add`
after cloning. The remaining commands must be run from this directory, where `package.json` and
`compose.yaml` are located.

## 3. Initialize the project identity

Run the initializer once, replacing every example value with your project information:

```sh
npm run initialize -- \
  --name "Forecast Lab" \
  --slug forecast-lab \
  --owner example-org \
  --database forecast_lab \
  --description "A collaborative forecasting service"
```

This command works before `npm ci` because the initializer uses only Node.js built-in modules; it has
no downloaded package dependencies. The first `--` tells npm to pass the remaining arguments to the
initializer script.

- `--name` is the human-readable name shown in documentation and dashboards; spaces and capitalization
  are allowed.
- `--slug` is the machine-readable project name used by npm, Docker Compose, local image names, and
  metrics. Use lowercase letters and numbers separated by single hyphens, and normally make it match
  the GitHub repository name.
- `--owner` is the GitHub user or organization that owns the new repository.
- `--database` is the local PostgreSQL database and user name. It must start with a lowercase letter
  and contain only lowercase letters, numbers, or underscores.
- `--description` is a short human-readable summary stored in `package.json`.

The initializer updates project identity throughout the repository, including `package.json`,
`package-lock.json`, `.env.example`, Compose files, monitoring files, and documentation. It then writes
`.template-initialized` as a record of the chosen values and refuses to run a second time, preventing a
partial or ambiguous rename. Run it before copying `.env.example` or making product changes. Commit
`.template-initialized` with the generated project.

Review what changed:

```sh
git status
git diff
```

`git status` lists changed and untracked files. `git diff` shows the edits to tracked files; the new
`.template-initialized` file appears in `git status` but not in a plain `git diff` until it is staged.

## 4. Create local configuration and install packages

```sh
cp .env.example .env
npm ci
```

- `cp .env.example .env` creates this computer's local runtime configuration from safe development
  defaults. Docker Compose and `npm run dev` read `.env`. Git ignores the file, so local passwords and
  overrides are not committed. If the file already exists, inspect it before replacing it.
- `npm ci` means **clean install**. It downloads the exact dependency versions recorded in
  `package-lock.json` into `node_modules/`; it is unrelated to downloading a CI service. The lockfile
  makes local and GitHub CI installations reproducible. This command needs access to the npm registry
  and replaces any existing `node_modules/` directory.

Do not run `git init` here. The clone is already a Git repository. Do not commit `.env` or
`node_modules/`; both are excluded by `.gitignore`.

## 5. Start and verify the generated service

Run each command only after the previous one succeeds:

```sh
docker compose up --detach --wait db
docker compose run --rm --build app node node_modules/node-pg-migrate/bin/node-pg-migrate.js up
npm run check
docker compose up --detach --build --wait app
curl --fail http://localhost:3000/ready
```

- `docker compose up --detach --wait db` downloads PostgreSQL if necessary, starts it in a background
  container, and waits for its health check. `db` is the service name in `compose.yaml`; `--detach`
  returns control to your terminal.
- `docker compose run --rm --build app ... up` builds the application image and runs pending database
  migrations in a temporary container. Migrations are versioned changes that create or alter the
  database schema. `--rm` removes that temporary container when done, not the database or its data.
- `npm run check` runs linting, formatting checks, tests, and coverage thresholds. This is the same main
  source-code quality gate run by GitHub CI.
- `docker compose up --detach --build --wait app` starts the application container in the background;
  Compose also keeps its required database running and waits for the application health check.
- `curl --fail http://localhost:3000/ready` sends an HTTP readiness request. A successful response
  proves both the API and PostgreSQL connection are ready; `--fail` makes `curl` return an error for an
  unsuccessful HTTP status.

Inspect running services or application logs if a command fails:

```sh
docker compose ps
docker compose logs --tail=100 app db
```

The default local ports are API `3000`, PostgreSQL `5433`, Prometheus `9090`, and Grafana `3001`.
Change the corresponding values in `.env` if another program already uses one of them. After changing
database settings, keep `DATABASE_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`POSTGRES_PORT` consistent.

## 6. Commit and push the initialized project

After verification succeeds, record the generated identity in Git and send it to the new GitHub
repository:

```sh
git add .
git commit -m "Initialize project from template"
git push
```

`git add .` stages non-ignored changes, `git commit` creates a local history entry, and `git push`
sends the commit to the `origin` repository created by `git clone`. Check `git status` before
committing to confirm that `.env`, `node_modules/`, and other private or generated files are absent.

## 7. Replace the example feature

Reusable TypeScript capabilities live under `src/platform`. Product behavior lives under `src/features`; the
included messages repository and router are examples. Replace the message routes, repository,
migration, and tests together. Preserve dependency injection in `src/app.ts` and `src/server.ts` so
domain tests do not require a live database.

The example is connected in several places: `src/features/messages/` contains its application code,
`src/app.ts` mounts its routes, `src/server.ts` creates its repository, `tests/messages.test.js` and
parts of `tests/app.test.js` test it, and both existing files under `migrations/` refer to its
`messages` table. Search for `message` before removing it so those references are handled together.

Migration history determines the safe removal path:

- **Before any migration has run in any database:** you may replace the example schema in the existing
  migration files, but the complete chain must still work from an empty database. In particular, the
  authentication migration currently adds `user_id` and an index to `messages`, so deleting only the
  first message migration breaks the next migration. Update the related code and migration tests in
  the same change.
- **After a migration has run anywhere that matters:** never edit or delete that applied migration.
  Add a new migration that changes or removes the old schema, deploy it safely, and then remove code
  that no longer uses the schema. Editing history would make new and existing databases disagree.

If you are not ready to design the product schema yet, leave the example feature in place while you
learn the platform. It can be replaced later through a new migration.

## 8. Configure GitHub

These are GitHub repository settings, not terminal commands, and they are not required merely to run
the service on your computer. Configure them after the first push and before relying on the repository
for team or production work:

1. Protect `main`. Branch protection prevents accidental direct or force pushes and can require a pull
   request, successful CI checks, and resolved review comments before code is merged.
2. Give GitHub Actions read-only repository permissions by default. Actions are automated workflows;
   limiting their token permissions reduces the damage a faulty or compromised workflow could cause.
   Individual workflows can request a narrowly scoped write permission when they genuinely need it.
3. Enable Dependabot and private vulnerability reporting. Dependabot proposes dependency security and
   version updates. Private reporting gives researchers a nonpublic place to report a security flaw.
4. Add `staging` and `production` GitHub environments if those deployments exist. Environments can
   hold separate secrets and require an authorized reviewer before a deployment job proceeds.
5. Keep hosting-provider credentials in environment secrets, or use short-lived workload identity
   where the provider supports it. Never put credentials in source files, `.env.example`, workflow
   text, issues, or pull requests.
6. Enable secret scanning and push protection when available. Secret scanning detects known credential
   formats; push protection attempts to stop a detected credential before it enters Git history.

These controls keep changes reviewable, minimize workflow permissions, and stop credentials from
entering history. Availability varies by repository visibility and GitHub plan, so enable every
control offered to the repository and document any unavailable control.

The release workflow derives its GHCR image name from the generated GitHub repository. Semantic tags
publish an immutable digest, provenance, and SBOM. Review pinned Action updates from Dependabot; do not
replace immutable SHAs with floating branches.

GHCR is GitHub's container registry. A semantic tag such as `v1.2.0` describes a release version; an
image digest identifies the exact published bytes. Provenance records how the image was built, and an
SBOM lists the software components included in it. See the [glossary](glossary.md) for these and other
terms used by the template.

The `reusable-quality.yml` workflow is the repository's reusable boundary for Node installation and
quality checks. Organizations can move it to a central workflow repository later; generated projects
can call the local copy without depending on external infrastructure.

Workflow files live under `.github/workflows/`. GitHub reads them after a push and runs the configured
jobs; you do not download “the CI” locally. `npm run check` is the local equivalent of the main source
checks, while GitHub also performs container and security checks defined by those workflow files.

## 9. Decide product-specific controls

Before production, complete the [enterprise adoption checklist](enterprise-adoption.md). Authorization,
data retention, capacity, recovery objectives, and the threat model cannot be universal defaults.

Continuous deployment is intentionally an extension point. Start from the immutable image digest,
then add a provider workflow that uses an environment-scoped identity, runs migrations once, waits for
health, and can restore the last known-good digest. Keeping that adapter outside the base template
avoids pretending that one cloud's deployment and rollback behavior is universal.
