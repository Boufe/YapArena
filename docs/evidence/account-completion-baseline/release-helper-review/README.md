# Independent release-helper review

Read-only source review on 2026-10-20. The exact reviewed file hashes and repository
HEAD are recorded in [source-hashes.json](source-hashes.json). The two release
helpers were uncommitted when these hashes were captured. This review did not run
`prepare`, `migrate`, suspend, resume, configuration changes or deployment.

No remaining source blocker was identified in the reviewed Render helper. It
pins the two staging service IDs, names and types, verifies their common runtime
database/project configuration, requires an exact action flag, and accepts only
the documented HTTP status codes. Configuration changes require both services to
be suspended and set only the web service's deterministic simulation flag.
Deployment names the current 40-character HEAD explicitly and targets web only.
The private Render key and raw response/environment values stay out of artifacts
and error output. Requests and state polling are bounded. A partial or timed-out
mutation is uncertain and requires a fresh inspection before retrying.

The database helper uses verified TLS, distinct owner/runtime credentials and a
private encrypted application-schema backup. Its preparation path exports a
consistent snapshot under table fences, restores into its own disposable SCRAM
cluster, compares fingerprints/sequences, and rehearses the exact additive
migrations. Applying migrations requires the prepared evidence, unchanged source
and database fingerprints, explicit release flags, and the owner process.

Review identified an incorrect quiescence check that queried runtime activity
through the owner connection. PostgreSQL can hide other roles' activity columns.
The reviewed correction opens a separate verified runtime TLS connection, checks
the exact role/database, excludes its own PID, and rejects every peer state except
`idle`, including null and idle-in-transaction states. The check runs before
snapshot work, again under table fences, and before migration application. It
does not grant administrative statistics privileges.

Actual writer suspension must persist throughout backup and migration. A zero
activity sample is a point-in-time observation; it cannot prevent an idle or
external process from starting future work. The migration runner begins after the
fingerprint transaction releases its fence, so independently verified suspension
of both named Render writers remains a required release step. Running-driver TLS,
live revision/readiness and hosted browser acceptance are separate observations.
No such acceptance is inferred from this source review or deploy HTTP acceptance.

The session ordering change in `7e813e3` was also reviewed independently. Issuers
and all four revokers share the bounded origin lock; native credential ceremonies
stay outside it. The captured account hint is compared only after cookie-derived
authentication and never selects an account. Stale same-account responses refresh
server state without invoking old provider logout or replacing a newer removal
owner. The native HTTP [seven-group trial](../session-coordination-browser/README.md)
uses a synthetic server and is separate from PostgreSQL selected-session
semantics, arbitrary API clients, hosted provider journeys and device acceptance.

Primary references checked during review:

- [PostgreSQL activity visibility](https://www.postgresql.org/docs/current/monitoring-stats.html)
  supports inspecting peer sessions as the same runtime role without a broader
  statistics grant.
- [Render suspend](https://api-docs.render.com/reference/suspend-service-1) and
  [resume](https://api-docs.render.com/reference/resume-service-1) document the
  asynchronous service actions.
- [Render environment update](https://api-docs.render.com/reference/update-env-var)
  documents the single-variable update endpoint.
- [Render deploy](https://api-docs.render.com/reference/create-deploy) documents
  explicit commit deployment. Selecting a commit does not disable auto-deploy;
  the actual release must preserve and inspect the staging auto-deploy settings.
