# F04 verification record

Date: **2026-10-05 UTC**. Repository work: `fix/f04-database-isolation`, additive migration
`1791158400000_isolate_server_database`. Status: **local implementation verified; hosted SQL boundary
NOT HARDENED; hosted API exposure UNVERIFIED; F04 remains open as a P0 deployment gate**. No hosted configuration, credential rotation,
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

During coordinated F02/F03 review, local HTTP tests intermittently reached an unexpected service;
one response was an SSH banner. Installed Supertest binds an IPv6 listener by default but builds
an IPv4 URL. A controlled regression with separate IPv6 and IPv4 servers on the same port proved
the unadapted client reached the foreign server. The shared `scripts/test-http-request.js` adapter
uses the actual listener's address family while preserving cookie-jar origins. The regression
verifies both ordinary and agent requests. With this adapter, the F04 full gate passed **234 tests,
zero skips**, retaining the coverage above. This establishes the transport condition and fix;
it does not retrospectively prove the cause of every earlier unexpected 401.

## Hosted observations

The operator confirmed the staging project reference, and Render's actual database pooler username
maps to that same project. Read-only `get_project` confirmed **ACTIVE_HEALTHY** and PostgreSQL
`17.6.1.171` (engine 17). The earlier inactive connector candidate was unrelated; its timeout is not
evidence about staging. Identifying account/project metadata is retained in controlled local
evidence rather than this public-repository record. No connection string was exported.

The read-only catalog snapshot at **2026-10-05 16:13:18 UTC** covers all eight non-system schemas,
role attributes/memberships, ownership, effective privileges, creator defaults, routines, RLS and
publications. It confirms the existing deployment has not adopted the repository hardening:

- Render is configured to connect as `postgres`. This login has BYPASSRLS, CREATEDB, CREATEROLE and REPLICATION,
  inherits `pg_read_all_data`, and owns all 32 application tables plus `public.pgmigrations`.
- Both browser roles have broad effective application-table privileges. Nineteen application
  tables and migration metadata lack RLS; thirteen community/measurement tables enable RLS with
  no policies. No application table has FORCE RLS.
- Both browser roles have USAGE/SELECT/UPDATE on all twelve public sequences and EXECUTE on all
  three application trigger routines. Two routines also grant PUBLIC EXECUTE; their search paths
  are not fixed. Public-schema creator defaults continue granting browser table/sequence/routine
  privileges. Catalog grants do not establish HTTP reachability or direct trigger-call capability.
- The private application/migration schemas and dedicated owner/runtime roles are absent. The
  latest recorded application migration predates F04.
- No public application views or catalog-recorded external view/parsed-routine dependencies on
  application tables were found. Dynamic routine bodies and alternate provider access still need
  a separate review.
- `pg_graphql` is not installed, the Realtime publication has no relations and is not FOR ALL
  TABLES, and no Edge Functions are deployed. These observations do not establish every service's
  routing, broadcast/presence, Storage or administrative access configuration.

Actual Render metadata still identifies the measurement branch with automatic deployment enabled
and the pre-hardening application commit. Of sixteen direct service environment entries, only
`DATABASE_URL` is the only `DATABASE_` variable, and its login is the privileged `postgres` role.
Read-only Render metadata at **16:23:32 UTC** found no workspace/linked environment groups, service
secret files or persistent disks, with no remaining pagination. This does not inspect the running
container filesystem, image layers, historical secrets or credentials under unrelated variable
names. No real hosted login using the configured credential was attempted, and no separate
owner/runtime credential deployment has been verified.

The inventory also covers provider schemas without changing them. No policies or FORCE RLS tables
were present in any inspected schema. All eight Storage tables enable RLS; Realtime messages enable
RLS while its subscription/migration tables do not. Sixteen of twenty-seven provider Auth tables
enable RLS. Browser roles have no inherited memberships or schema CREATE; they have schema USAGE
on seven inspected schemas but not `vault`. The two provider SECURITY DEFINER routines are in
`vault`, with empty search paths and no browser EXECUTE grant. Provider service access and dynamic
routine paths still require review; these catalog observations do not prove HTTP isolation.

Sanitized artifacts, containing catalog metadata rather than application rows or credentials, are:

- `/tmp/yaparena-f04-hosted-evidence.eBMNQf/catalog-inventory.json`
- `/tmp/yaparena-f04-hosted-evidence.eBMNQf/safe-settings.json`
- `/tmp/yaparena-f04-hosted-evidence.eBMNQf/inspection-summary.json`
- `/tmp/yaparena-f04-hosted-evidence.eBMNQf/render-credential-metadata.json`
- `/tmp/yaparena-f04-hosted-evidence.eBMNQf/schema-summary.json`
- `/tmp/yaparena-f04-hosted-evidence.eBMNQf/operator-reported-data-api.json`

The operator subsequently reported that **Enable Data API is OFF** in the confirmed project's
dashboard, while the integration is marked installed. This is operator-reported dashboard evidence;
the connector has no Data API configuration-read method, and no management token or usable dashboard
browser is available for independent inspection. Exposed schemas and automatic table exposure
remain unrecorded. No `authenticator` schema override was found in SQL settings; this does not
prove the hosted Data API toggle or exposed-schema configuration. No hosted API keys, user JWTs,
application rows or mutation probes were requested or used. No disposable hosted branch exists.

| Hosted fact                                                                      | Status                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Correct staging project mapping                                                  | VERIFIED: operator reference and actual Render pooler mapping agree                             |
| Actual Data API enabled/disabled state                                           | OFF: operator-reported dashboard confirmation; independent inspection/HTTP verification pending |
| Exposed schemas and automatic table exposure                                     | UNRECORDED: dashboard evidence still required                                                   |
| Hosted privilege/RLS inventory before hardening                                  | COLLECTED; FAIL: broad browser grants and privileged runtime remain                             |
| Dedicated runtime/migration identities and private schemas                       | FAIL: absent from the deployed database                                                         |
| GraphQL extension, Realtime publication and Edge Functions                       | Catalog/config inventory collected; complete alternate-path review PENDING                      |
| Render runtime-only secrets, linked groups/mounts and separate migration process | FAIL: privileged configured login; groups/secret files/disks absent; cutover/process unverified |
| Real hardened runtime session-pooler login/TLS                                   | NOT RUN: hardening has not been deployed                                                        |
| Valid anonymous and authenticated HTTP identity access probes                    | NOT RUN; require authorized disposable staging clone with synthetic data                        |
| Hosted migration/privilege changes or credential rotation                        | NOT PERFORMED; require separate authorization                                                   |

## Required operator actions

Follow the exact [hosted checklist](database-isolation.md#hosted-operator-checklist--required-to-close-f04)
and [Render Free release sequence](../render-staging.md#deploy-the-web-service). Retain the confirmed
project mapping and pre-change inventory, collect Dashboard API/schema evidence, review indirect provider access,
authorize a disposable clone, and test valid anonymous/authenticated API identities and actual
runtime pooler/backend flows. Then authorize the separate provisioning/migration/deployment and
old-credential rotation sequence. Keep owner/admin secrets outside all web/worker environments.

Local PostgreSQL results do not prove Supabase hosted API isolation, LiveKit/device/replay quality,
production concurrency or provider restore readiness. F04 cannot be marked closed while the hosted
items above are pending.
