# Strict TypeScript for operational automation

The production edge replay worker is authored in `edge/replay-worker.ts`. Wrangler
compiles that source using the existing bindings, route and compatibility date.
`tsconfig.edge.json` checks its consumed R2, cache and execution-context interfaces
with WebWorker libraries and no Node or browser DOM globals. No provider dependency
or production setting is added.

## Source inventory

These former JavaScript files retain their names with a `.ts` extension:

| Area                     | Sources under `scripts/`                                                                                                                                                                                    | Reason                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Database and security    | `provision-database`, `migrate-database`, `inventory-database`, `verify-database-isolation`                                                                                                                 | Owner/runtime provisioning, migration execution, privilege inventory and fresh/upgrade isolation.     |
| Core browser release     | `verify-browser-release`, `verify-a4-browser`, `verify-arena-browser`, `verify-public-bots-browser`, `verify-homepage-browser`, `verify-hero-browser`                                                       | The existing PR #36 release coordinator and every browser verifier it invokes.                        |
| Community release        | `verify-community-local`, `verify-community-load`, `verify-community-delivery`, `verify-community`, `verify-community-browser`, `verify-chat-client`, `verify-media-operations`, `verify-media-clock-child` | Durable delivery, browser and independent media-clock checks invoked by the required integration job. |
| Replay release           | `verify-replay-pipeline`, `verify-media-packaging`, `package-replay`                                                                                                                                        | Disposable transaction/recovery checks and shared synthetic packaging CLI.                            |
| Integration smoke checks | `verify-discovery`, `verify-identity-social`, `verify-matching`, `verify-measurement`, `verify-measurement-browser`, `smoke-staging`                                                                        | Existing database, HTTP and browser verification commands in CI.                                      |
| Dependencies             | `test-http-request`, `seed-discovery`, `seed-public-bots`                                                                                                                                                   | Existing HTTP listener adapter and synthetic seed commands invoked by those verifiers.                |

The inventory contains 30 operational scripts, the edge worker and one shared fixture: 32 converted files.
Dated trial transcripts retain command names from their recorded revisions; use this guide
for current paths.

The shared `tests/helpers/replay-storage.ts` fixture is also checked because the
replay pipeline imports it. Existing tests retain JavaScript; only imports of renamed
helpers change. Applied migration names and contents remain JavaScript and unchanged.
`scripts/migration-exports.d.ts` describes only the immutable migration exports used
by provisioning/isolation; it is outside the migration directory and never executed.

Unrelated research, project initialization, diagnostic and hosted-only trial scripts,
shell backup/restore tools, tests, configuration JavaScript and application modules
are outside this language migration. The existing strict server/frontend sources
remain in place. A few server dependency-injection signatures describe the exact
methods consumed by existing fixtures; these changes erase entirely at runtime.

The remaining handwritten JavaScript scripts are intentionally outside the invoked
release/database dependency graph:

| Files under `scripts/`                                                                                                                                           | Why retained                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `a4-research.js`, `measure-local-journeys.js`, `report-playback.js`                                                                                              | Separate research and manual measurement/reporting tools.                                                                              |
| `check-media-storage.js`                                                                                                                                         | Optional startup/hosted storage diagnostic; not a provisioning, migration or required release-verifier dependency.                     |
| `initialize-project.js`                                                                                                                                          | Reusable project initialization utility.                                                                                               |
| `verify-community-edge.js`, `verify-community-hosted-capacity.js`, `verify-replay-storage.js`, `verify-media-hosted-browser.js`, `verify-media-hosted-replay.js` | Separate manual edge/provider/storage/capacity trials, outside the release coordinators.                                               |
| `verify-session-controls-browser.js`, `verify-wallet-browser.js`                                                                                                 | Separate manual account/wallet browser trials; required database authentication/security suites remain enforced by the existing tests. |

Applied `migrations/*.js`, `tests/*.test.js`, other test helpers and `eslint.config.js`
also remain in their existing languages; their conversion was not authorized by this
bounded migration. Served `public/**/*.js` remains ignored generated build output.

## Execution and checks

Use Node.js 24. Node runs the operational `.ts` sources directly using its built-in
type stripping. This requires no TypeScript runtime loader or new dependency. npm
command names, arguments, environment variables and supported operating modes remain
the same. For direct invocations use, for example:

```sh
node scripts/provision-database.ts
npm run migrate
npm run inventory:database
DATABASE_TEST_MODE=host npm run verify:browser
npm run verify:community-native-setup
COMMUNITY_POSTGRES_MODE=host npm run verify:community-delivery
REPLAY_POSTGRES_MODE=host npm run verify:replay-pipeline
npm run verify:media-packaging
```

Provisioning and migration still run in separate owner/admin processes. Web and worker
processes receive runtime credentials only. The release coordinators still create their
own disposable databases and synthetic fixtures; do not supply hosted databases or load
the combined operator `.env` into application processes.

`npm run typecheck:operations` first checks the server and emits ignored declarations
under `dist/`, then checks the explicit source inventories in
`tsconfig.database-tools.json`, `tsconfig.browser-automation.json`,
`tsconfig.community-tools.json`, `tsconfig.replay-tools.json` and `tsconfig.edge.json`.
Declarations let verifiers retain their existing imports of built `dist/*.js` while
using the actual shared server types. This command works before JavaScript is built.
It does not execute the verifiers. Node-only tools use Node libraries; browser
automation additionally uses DOM types for code evaluated inside browser pages.
The edge project is checked separately.

`npm run typecheck`, `npm run build` and the existing `npm run check` quality gate
include these compiler checks. Runtime type stripping is not a substitute for them.
Build output stays under `dist/` and `public/`; do not commit generated JavaScript or
declarations. Docker copies the two operational TypeScript entrypoints needed in its
production image. Compose, CI and maintained runbooks use their new source paths.
The required checks remain `quality / check`, `container`, `integration`, `monitoring`
and `deployment`; thresholds, assertions and separate verification gates are retained.

Types describe existing validation and fixture guarantees; they do not replace input
checks. Deliberately partial HTTP/component fixtures use exact shared method projections
at their invocation boundary, documenting routes whose omitted dependencies are never
used. Database rows, wire responses and subprocess results have specific projections.
Non-null assertions retain existing dereference behavior after known fixture setup;
they do not add runtime guards or repair unrelated failures.

The [migration evidence](evidence/operational-typescript/2026-10-18.md) records the
baseline, executable/behavior comparisons, checks and remaining evidence limits.

The [native PostgreSQL setup correction](evidence/native-postgres-utf8/2026-10-18.md)
supersedes the earlier migration's C-locale SQL_ASCII limitation. The focused setup
check runs native initdb under C with explicit UTF-8, performs real chat-column
roundtrip assertions and cleans up without starting browser/load phases. Follow
[community operations](community-operations.md) for the full gate and evidence limits.
