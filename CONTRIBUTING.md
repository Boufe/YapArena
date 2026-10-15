# Contributing

These instructions assume that you already cloned the repository, changed into its root directory,
and installed the tools listed in the [README](README.md#requirements). Cloning initializes Git; do not
run `git init` inside the clone. YapArena product changes belong in this repository.

For product behavior, follow the [YAP Arena product PRD](docs/product-prd.md) and its
[specification outlines](docs/product-specification-outlines.md). The
[template PRD](docs/template-prd.md) documents the reusable service foundation, not the current
product's financial rules or release scope. Keep confirmed decisions intact, identify proposals
and open decisions explicitly, and resolve financial behavior in reviewed specifications before
implementing it. Do not treat a passing backend quality gate as permission to accept real funds.

## Development workflow

1. Inspect the checkout before choosing a branch:

   ```sh
   git status --short
   git branch -vv
   git worktree list
   git fetch origin
   git rev-list --left-right --count HEAD...origin/main
   ```

   Report any mismatch with fetched main. If the checkout contains unrelated edits or an older
   feature branch, preserve it and create a separate worktree:

   ```sh
   git worktree add -b short-description-of-change /tmp/yaparena-change origin/main
   cd /tmp/yaparena-change
   ```

   Choose an unused branch and directory. Do not stash, reset, or overwrite someone else's work
   as a setup step. For a clean checkout where `main` is available, the ordinary alternative is:

   ```sh
   git switch main
   git pull --ff-only
   git switch -c short-description-of-change
   ```

   `git pull --ff-only` updates reviewed history without creating an accidental merge commit.
   Use a short branch name describing one change and the
   [current implementation and evidence](docs/nonfinancial-implementation-plan.md#current-implementation-and-evidence)
   to distinguish completed packages from remaining acceptance work.

2. Install locked dependencies:

   ```sh
   npm ci
   ```

   This creates a clean `node_modules/` directory from the exact versions in `package-lock.json`. It
   does not install a CI service or modify the lockfile. Run `npm install PACKAGE_NAME` only when the
   change intentionally adds or updates a dependency, and review both `package.json` and
   `package-lock.json` afterward.

3. Make the change in strict TypeScript under `src/` and add or update tests for changed behavior. Tests belong under `tests/`; database
   structure changes also require a new migration rather than an edit to migration history.

4. Run the local quality gate:

   ```sh
   npm run check
   ```

   This checks lint rules, formatting, and types, then runs tests with coverage thresholds. If the change
   affects containers or Compose configuration, also render and start the relevant stack as described
   in the [operations runbook](docs/operations.md).

5. Review and commit only the intended files:

   ```sh
   git status
   git diff
   git add PATHS-TO-CHANGED-FILES
   git commit -m "Describe the change"
   git push --set-upstream origin short-description-of-change
   ```

   Replace `PATHS-TO-CHANGED-FILES` with the actual files; it is not a literal path. The first push
   connects the local branch to the branch on GitHub. Then open a pull request and complete the
   repository's pull-request template.

Focused branches make review and rollback smaller. Locked installs and the local quality gate keep
developer results aligned with CI, while migration and deployment checks catch changes that unit tests
cannot exercise.

Keep platform behavior under `src/platform` and product behavior under `src/features`. Database
changes require an additive migration; never rewrite a migration that may have been applied.

This boundary keeps reusable infrastructure independent from product domains. Additive migrations
preserve a trustworthy history across developer, staging, and production databases.

Do not commit `.env`, credentials, production data, generated coverage, or registry tokens. Report
security problems using [SECURITY.md](SECURITY.md), not a public issue.

Dependency install scripts are reviewed and pinned in the `allowScripts` policy in `package.json`.
Review the package, exact version, published provenance, and required lifecycle behavior before
changing that policy. Supported npm versions report or enforce unreviewed scripts during install.

See the [glossary](docs/glossary.md) for terms such as branch, pull request, migration, image, and CI.

## Documentation changes

Verify claims against the reviewed branch's source, scripts, migrations, workflows and saved trial
evidence. Update the authoritative runbook and implementation status together when behavior changes.
Preserve dated reports and decisions; add a current-state note or superseding link when a finding,
handoff, command or acceptance status is obsolete. Keep implemented, locally tested, hosted-tested
and planned behavior distinct. Check relative links, anchors, referenced paths and formatting, and
run `npm run check` before opening a documentation PR. List integration suites skipped locally;
the five required CI checks are `quality / check`, `container`, `integration`, `monitoring` and
`deployment` (active ruleset inspected 2026-10-15). Recheck GitHub rules if they change.

When using a separate worktree, report its branch and PR and the state of the original checkout.
Reconcile Markdown only where local edits can be preserved, and identify conflicts explicitly.
Never leave a dirty old checkout appearing to represent current main. Merge only within the user's
authorized scope; opening a PR does not authorize merging it when approval has been reserved.
