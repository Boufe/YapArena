# F04 verification record

Date: **2026-10-05 UTC**. Repository work: `fix/f04-database-isolation`, additive migration
`1791158400000_isolate_server_database`. Status: **local implementation verified; hosted isolation
UNVERIFIED; F04 remains open as a P0 deployment gate**. No hosted configuration, credential rotation,
production privileges or deployment were changed.

## Local observations

The executable `scripts/verify-database-isolation.js` created its own disposable, volume-free
PostgreSQL containers with synthetic data. Runtime connections authenticated over TCP as the actual
`yaparena_runtime` login, independently of admin/owner connections. Browser probes used SET ROLE as
both `anon` and `authenticated`; these are SQL checks, not hosted API checks.

| Check                                                                          | Observed result                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                                | PASS: lint, formatting, strict types and 233 tests; 97.45% lines, 90.28% branches, 98.03% functions                                                                                                                                                 |
| `npm run verify:database-isolation`                                            | PASS on PostgreSQL 18.4: fresh install and legacy-public-schema upgrade                                                                                                                                                                             |
| `DATABASE_TEST_IMAGE=postgres:17.6-bookworm npm run verify:database-isolation` | PASS on PostgreSQL 17.6: fresh install and upgrade                                                                                                                                                                                                  |
| Inventory                                                                      | 19 sanitized evidence sections; 32 application tables, 33 backend policies; owners, defaults, role attributes/memberships, effective/column ACLs, views/materialized views, sequences, routines and RLS/FORCE inspected                             |
| Browser identities                                                             | Every application data category denied SELECT/INSERT/UPDATE/DELETE; sequences and trigger/SECURITY DEFINER routines denied, including supplemental schema-USAGE probes                                                                              |
| Indirect and future access                                                     | Legacy inherited, column and PUBLIC grants/defaults removed; unsafe PUBLIC policy replaced; views/materialized views denied; future tables/sequences/routines fail closed until explicit runtime grants/policies                                    |
| Runtime restrictions                                                           | CREATE/ALTER/DROP, role grant/assumption, user email updates, operator role insertion, metadata writes/sequence use and sequence `setval` denied; unauthorized table GRANT gave no effective grant                                                  |
| Real backend queries                                                           | PASS: Express registration/password login/session/logout/account roles, signed wallet login/link/unlink, messages, profiles/follows/activity, matching/history/notifications, media state, moderation/appeals and consent/watch/affiliation/summary |
| Triggers and jobs                                                              | Participant assignment, identity audit and measurement completion writes succeeded; expired sessions/challenges/requests/audit/likes/affiliation audit processed under runtime; worker startup and scheduled callbacks passed                       |
| Administrative adoption                                                        | Ambiguous external access is not silently changed: external view and parsed-routine dependencies blocked provisioning; unsafe inherited browser owner membership and equal new passwords rejected                                                   |
| Provider fixture                                                               | Grants and creator defaults in the unrelated `provider_fixture` schema remained intact                                                                                                                                                              |
| Repetition and data                                                            | Repeated provisioning/migration steps passed; existing synthetic legacy account and migration history preserved                                                                                                                                     |
| Compose                                                                        | Local and production configuration validation passed; production image built; separate provision/migrate containers completed; production staging startup script reached healthy `/ready` with runtime-only credentials                             |
| Actual worker                                                                  | `dist/worker.js` started successfully in a distinct runtime-only container                                                                                                                                                                          |
| Environment isolation                                                          | Inside the web container, only `DATABASE_URL` was present among database variables, its login was runtime, and `/app/.env` was absent; no operator files were mounted                                                                               |
| Existing CI fixture workflow                                                   | Seed, discovery, identity/SIWE, matching, community and measurement scripts all passed through the one-off owner job; these fixture checks supplement the separate runtime harness                                                                  |
| Backup/restore                                                                 | Updated helper passed on the separate synthetic Compose database; measurement consent counts and migration record matched. This was a data restore with `--no-owner --no-privileges`, not an isolation-preserving promotion                         |

PostgreSQL 18.4 snapshot times were 15:36:16–15:36:17 UTC; PostgreSQL 17.6 snapshot times were
15:31:31–15:31:32 UTC. Full sanitized local catalog snapshots were written to:

- `/tmp/yaparena-isolation-30d04987-evidence/fresh-inventory.json`
- `/tmp/yaparena-isolation-30d04987-evidence/upgrade-inventory.json`
- `/tmp/yaparena-isolation-2a9ea979-evidence/fresh-inventory.json`
- `/tmp/yaparena-isolation-2a9ea979-evidence/upgrade-inventory.json`

These temporary files are local evidence, not durable hosted records. Each harness run emits a new
directory, allowing operators to retain sanitized snapshots in their controlled evidence store.
Application rows, passwords, URLs, bearer values and routine bodies were not exported. Local test
containers were removed after verification. The shared working tree also contains separately owned
F01/audit work; it was preserved. The coordinator independently repeated `npm run check` on the
extracted F04 branch based on F01 commit `b120f1f`: 233 tests passed with the same coverage above.
The PostgreSQL 18.4 fresh-install/upgrade harness also passed on that extracted branch; its sanitized
snapshots are `/tmp/yaparena-isolation-457725f4-evidence/fresh-inventory.json` and
`/tmp/yaparena-isolation-457725f4-evidence/upgrade-inventory.json`.

Initial test attempts encountered sandbox socket restrictions, migration-runner configuration,
empty ACL handling and synthetic fixture expectations. Those issues were corrected; the complete
passing runs above are the evidence. PostgreSQL's warning-only unauthorized GRANT behavior is
tested by inspecting resulting effective privileges. The local migration fixture service initially
inherited production NODE_ENV and correctly rejected demo seeding; its development environment was
made explicit without changing the production migration job.

## Hosted observations

Read-only Supabase connector `list_projects` and `get_project` returned a candidate project
with status **INACTIVE** and PostgreSQL `17.6.1.155` (engine 17), on 2026-10-05. Identifying
account/project metadata is retained in controlled local evidence rather than this public-repository
record. This candidate has not been established as the currently deployed YapArena staging
environment; project mapping remains pending. No connection string was exported.

A read-only query for database/current user/server version timed out with **Connection terminated
due to connection timeout**. No SQL catalog or data result was obtained. The project was not resumed.
No hosted API keys, user JWTs or mutation probes were requested or used.

| Hosted fact                                                                       | Status                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Correct staging/production project mapping                                        | PENDING operator confirmation                                            |
| Actual Data API enabled/disabled state and exposed schemas                        | UNVERIFIED                                                               |
| Actual REST/GraphQL, Realtime, Storage, Edge Function and custom routine surfaces | UNVERIFIED                                                               |
| Hosted role attributes/memberships, owners, ACLs/defaults and RLS evidence        | UNVERIFIED                                                               |
| Real runtime session-pooler login/TLS and separate migration job secrets          | UNVERIFIED                                                               |
| Valid anonymous and authenticated HTTP identity access probes                     | NOT RUN; require authorized disposable staging clone with synthetic data |
| Hosted migration/privilege changes or credential rotation                         | NOT PERFORMED; require separate authorization                            |

## Required operator actions

Follow the exact [hosted checklist](database-isolation.md#hosted-operator-checklist--required-to-close-f04)
and [Render Free release sequence](../render-staging.md#deploy-the-web-service). Confirm the project,
collect Dashboard API/schema evidence and read-only SQL inventory, review indirect provider access,
authorize a disposable clone, and test valid anonymous/authenticated API identities and actual
runtime pooler/backend flows. Then authorize the separate provisioning/migration/deployment and
old-credential rotation sequence. Keep owner/admin secrets outside all web/worker environments.

Local PostgreSQL results do not prove Supabase hosted API isolation, LiveKit/device/replay quality,
production concurrency or provider restore readiness. F04 cannot be marked closed while the hosted
items above are pending.
