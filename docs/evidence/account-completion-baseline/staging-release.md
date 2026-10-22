# Account security and coin sandbox staging release

On 2026-10-20 the named staging web service deployed
`93952425100d15bde110a0b1b38b04e35d653b9b`. The [first live observation](render-account-first-live.json)
is at **17:10:25.767 UTC**; the lead independently confirmed that exact revision.
The replay worker resumed on its unchanged `fd60543` revision. Automatic
deployment remains disabled for both services.

The [five required CI checks](ci-release/README.md) passed for the exact web
revision before either service was stopped. The branch contained fetched
`origin/main` (`fd60543`), with 96 commits ahead and none behind.

## Backup, migration and configuration

Both named writers were [suspended](render-account-suspend.json) and independently
rechecked before preparation and migration. The
[preparation report](staging-release-prepare.json) records a consistent encrypted
snapshot of 62 application tables and 13 sequences, matching isolated restore
fingerprints and a successful rehearsal of all 13 pending migrations. The
encrypted backup and its key remain in restricted operator storage outside the
repository. This was an application-schema backup, not a full provider backup.

The [owner-only migration report](staging-release-migrate.json) records all
13 additive migrations applied with zero non-idle runtime sessions. The
[postflight](staging-database-postflight.json) confirms 41 applied migrations,
none pending, all three retained accounts plus the genuine manual signup,
the four selected reset accounts still absent, and zero live journals/grant lots.
No account was deleted or financial balance initialized during this release.

Only the web service's deterministic coin sandbox was
[enabled](render-account-configure-sandbox.json). Live financial routes remain
absent, the real 50-USDC promotional budget remains unfunded/unallocated, and no
testnet signer or sandbox webhook secret was added to the runtime. Browser roles
have no private-schema access; the runtime owns no database objects and cannot
assume the owner, create schema objects or modify migration history.

The services were [resumed](render-account-resume.json), then the web service
[deployed the exact SHA](render-account-deploy.json). Both are live with the
expected runtime database role, project and verified-TLS configuration. Actual
read-only SQL independently verified TLS with hostname checking and the
provider CA. No owner credential was loaded into a web or worker process.

## Acceptance boundaries

The deployed guest browser and Redis check is recorded separately from genuine
email, Google, passkey and recovery ceremonies. It sends no email or OAuth
request, creates no identity and performs no financial operation. Public
readiness alone is not authenticated journey acceptance.

Legacy speaker containment requires the full conservative drain after the first
observed live revision: 60 seconds of old-instance overlap, 300 seconds of
maximum shutdown grace, then the old 15-minute token lifetime. Its earliest
completion was **17:31:25.767 UTC**. Pre-release inventory found no assigned or
device-ready speaker seats and no Cloud rooms. The read-only
[Cloud inspection](staging-media-after.json) at 17:35:45.838 UTC again found
zero rooms; the [database postflight](staging-database-postflight.json) at
17:36:18.947 UTC found zero assigned, active-participant or device-ready speaker
seats and zero live-viewer-eligible events. Both observations followed the full
bound. Token expiry alone does not disconnect existing participants; the room
and seat observations are separate evidence. The postflight's `revision`
identifies the helper checkout (`180a004`), while the web still served `9395242`.

The separate [application-to-Cloud trial](media-app-cloud-revocation/README.md)
used actual local HTTP sessions, a disposable PostgreSQL outbox and the real
Cloud service. Sign out disconnected the speaker, rejected original and
server-refreshed tokens, and preserved public watching. Together with the
earlier provider-only trial it stayed below the five included participant-minutes
approved by the founder. The release inspections create no additional rooms.

The [anonymous hosted browser result](account-hosted-browser/9395242/acceptance.json)
passed seven groups with the exact deployed assets. It is separate from
genuine identity acceptance: the returning manual-signup account encountered
an uncertain provider-session reset, and the browser incorrectly labelled
the exchange rejection as changed sign-in methods. The accepted and current
server-verified methods were unchanged. The subsequent
[reviewed reset repair](provider-reset-repair/README.md) completed without
deleting history or weakening the token cutoff. Its corrective UI and genuine
returning-login acceptance are tracked separately; this first-release report
does not claim that the repair itself establishes a successful login.

This deployment does not establish genuine hosted identity acceptance,
physical-device or screen-reader usability, hosted multi-instance Redis outage
acceptance, provider eligibility, live custody or multichain settlement.
The [completion matrix](../../email-first-completion.md) records those remaining
boundaries. The task remains explicitly incomplete.
