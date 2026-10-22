# Account and coin sandbox staging release

This runbook operates only the named YapArena staging web service and replay
worker. It does not authorize live money, a paid plan, account deletion or a
production release. The [completion matrix](email-first-completion.md) and
[independent helper review](evidence/account-completion-baseline/release-helper-review/README.md)
record the acceptance boundaries.

The recorded schema release below is the additive **43 → 45** update from web
`d6e2d35` to the reviewed `eba1dc5` source, not a repeat of the original account
release. The [current release evidence](evidence/account-completion-baseline/embedded-wallet-release/README.md)
and [hash-scoped source review](evidence/account-completion-baseline/embedded-wallet-release/auth-release-source-review.md)
record its scope and outstanding gates. The encrypted backup, isolated restore,
rehearsal and both migrations passed on 2026-10-21; all 14 security projections
were unchanged before writers resumed. Exact web deployment and its acceptance
are recorded in that evidence directory. This is a record of the release
procedure, not a command to repeat the already-applied migrations. If a correction changes the selected source, refresh its
review and exact-revision CI evidence before proceeding.

The later code-only `3096ca7` release is verified LIVE with the same 45 applied
migrations. `819421d` includes the reset-overlap/replay and visible setup corrections. Its combined local gate passed870 tests/all four core browser stages; all five exact-tree CI checks passed. It is now verified LIVE at deployment `dep-dbcmpbbncjis73cvs9pg`, with seven guest groups/14 matching assets/readiness200. The separate old-instance containment and reviewed account repair remain open in the [current release record](evidence/account-completion-baseline/account-repair-release-819421d-20261022/README.md). Do not repeat schema preparation,
writer suspension or migrations for this code-only correction. Deploy only its
exact tested pushed SHA, inspect until LIVE, and verify the served assets.

The approved disposable genuine signup increased the current account count to
five: the original four protected accounts plus one privately attributed test
identity. Historical database helpers deliberately guard their older inventory
and may reject this state. Do not delete that account or loosen those guards to
make a preflight pass. Use a separately reviewed read-only inspection bound to
the exact attribution. The stopped acknowledged-reset repair is a distinct
owner operation, performed only after the corrected engine is live; see
[provider-reset operations](operations.md#local-verification). It does not reset
accounts, adopt credentials or authorize financial activity.

Use Node 24 and local PostgreSQL 17/18 tools. Keep the existing private operator
configuration and backup key outside the repository. The commands load neither
`.env` nor owner credentials into a runtime process. `ACCOUNT_STAGING_CA_PATH`
names the verified public CA file. Private release directories and backup keys
remain in restricted operator storage; never paste their contents into reports.

## Before stopping writers

Fetch origin, preserve shared edits, and verify the intended existing PR branch.
Run the complete disposable database/browser release gate and obtain all five
required CI successes for the exact pushed revision. Inspect the integrated diff
and independent security/financial review. Do not change source or commit between
backup preparation and migration application.

```sh
node scripts/release-account-render.ts inspect
node scripts/verify-account-staging.ts preflight
node scripts/verify-media-cloud-revocation.ts --inspect
```

The read-only database inspection requires verified TLS, separate owner/runtime
roles, preserved retained/manual accounts and no live financial history. The
[current preflight](evidence/account-completion-baseline/embedded-wallet-release/staging-database-preflight.json)
found all four expected accounts, including three retained accounts and the
genuine manual signup, zero live financial history, 43 applied migrations and
exactly these two pending migrations:

- `1792426014000_add-embedded-wallet-provisioning`
- `1792426015000_add-provider-control-phases`

The [current Render inspection](evidence/account-completion-baseline/embedded-wallet-release/render-account-inspect.json)
found automatic deployment disabled for both services, web revision `d6e2d35`
and unchanged replay-worker revision `fd60543`. The separate
[room inspection](evidence/account-completion-baseline/embedded-wallet-release/media-room-inspect.json)
found zero rooms without creating a room or participant. These are point-in-time
observations, not proof that writers are stopped.

The original `f942dc6` legacy issuer's 15-minute JWT drain and separate room/seat
checks were [completed during the earlier release](evidence/account-completion-baseline/staging-release.md#acceptance-boundaries).
The current `d6e2d35` update does not repeat that completed drain merely because
the current web process resumes. If a genuinely legacy issuer runs again, record
its last possible issuance and drain its full token lifetime after stopping it.
If rooms exist, review their speaker inventory before proceeding; do not delete
rooms or disconnect viewers. Existing connected speakers require explicit
containment because token expiry alone does not disconnect a connection.

## Backup, rehearsal and additive migration

```sh
ACCOUNT_STAGING_RENDER_ACTION=suspend \
  node scripts/release-account-render.ts suspend
```

Verify both named services are actually suspended. No unrelated writer may remain.
Keep them suspended throughout preparation and migration. The helper's runtime
activity sample supplements that control; it does not prevent future connections.

```sh
ACCOUNT_STAGING_WRITERS_STOPPED=true \
  ACCOUNT_STAGING_RELEASE_GATES_PASSED=true \
  node scripts/release-account-staging.ts prepare
```

Preparation uses one verified session connection on port 5432, exports a
consistent application-schema snapshot under table locks, encrypts it, restores
it into a disposable local cluster, compares rows/sequences and rehearses the
two pending migrations listed above, taking the schema from 43 to 45 applied
migrations. It is not a full Supabase/provider disaster-recovery backup. Require
terminal success and preserve the returned private directory.

On macOS, use `LC_ALL=C LANG=C` for the local native PostgreSQL rehearsal.
Set `ACCOUNT_STAGING_CA_PATH` to the reviewed public CA file when the private
configuration's previous path is unavailable. Client certificate/hostname
verification remains required. PostgreSQL's `pg_stat_ssl` observes the pooler's
separate backend connection; it does not attest the external libpq TLS connection.

Reinspect suspension and unchanged HEAD. Supply that exact directory through
`ACCOUNT_STAGING_RELEASE_DIRECTORY`; it contains no secret in its name.

```sh
ACCOUNT_STAGING_WRITERS_STOPPED=true \
  ACCOUNT_STAGING_RELEASE_GATES_PASSED=true \
  ACCOUNT_STAGING_APPLY_MIGRATIONS=approved \
  node scripts/release-account-staging.ts migrate
```

The owner-only command rejects mismatched source, migration history, backup or
database fingerprints and rechecks quiescence. It preserves all retained/manual
accounts. Migrations are forward-only. After any uncertain failure, inspect the
actual applied history before taking another action.

## Deploy and verify

The deterministic web sandbox is already enabled, and remains disabled on the
replay worker. Preserve that configuration for this additive release. Only if a
fresh inspection establishes that the intended deterministic configuration is
missing, configure it while both writers remain suspended:

```sh
ACCOUNT_STAGING_RENDER_ACTION=configure-sandbox \
  node scripts/release-account-render.ts configure-sandbox
```

Set `ACCOUNT_STAGING_RENDER_COMMIT` to the exact current 40-character pushed SHA.
The release helper targets the web service only and requires background jobs
enabled so provider/media revocation work runs. The replay encoder remains on
its recorded revision; it does not process the account outbox.

```sh
ACCOUNT_STAGING_RENDER_ACTION=resume \
  node scripts/release-account-render.ts resume
ACCOUNT_STAGING_RENDER_ACTION=deploy \
  node scripts/release-account-render.ts deploy
node scripts/release-account-render.ts inspect
```

Render's [deploy-hook documentation](https://render.com/docs/deploy-hooks)
reports a conflict while suspended; the API does not document a suspended-deploy
bypass. Resume, then deploy the exact SHA. Deployment acceptance alone is
insufficient: inspect until the exact web SHA is terminally live, verify
readiness, and check that the worker's revision and runtime role remain correct.
If a genuinely legacy issuer resumes before replacement, restart its token-drain
clock from its final stop. Render's [shutdown sequence](https://render.com/docs/deploys#zero-downtime-deploys)
allows old-instance overlap plus a shutdown grace period after the new instance
is ready. Account for the actual configured bound, or the documented maximum of
60 seconds plus 300 seconds on this free service, before beginning the
15-minute JWT drain when that legacy condition applies. Record eligible-speaker
and room inventories before and after rollout; zero rooms alone does not rule
out an issued token.
Do not claim containment of a legacy issuer until its process has stopped, its
token lifetime has elapsed and no legacy speaker connection remains. Preserve
the current speaker authorization and revocation checks throughout rollout.
This procedure does not itself install a temporary runtime speaker-issuance switch.

Build the exact deployed revision locally. Set
`ACCOUNT_HOSTED_EXPECTED_REVISION` to its SHA, then run:

```sh
node scripts/verify-account-staging.ts postflight
ACCOUNT_HOSTED_REDIS_PROBE=approved \
  node scripts/verify-account-hosted-browser.ts
```

The guest browser verifier checks real served asset hashes, provider method
configuration, protected anonymous responses, dialog loading, focus and mobile
layout. Its optional single retired-registration request verifies the deployed
Redis limiter path through aggregate metrics without creating an account.
It sends no email code, performs no OAuth/credential ceremony and joins no room.
It cannot establish hosted multi-instance outage or genuine user acceptance.

Record applied migrations, retained-account counts, zero live activity, runtime
privileges, exact deployed SHA, readiness, outbox outcomes and bounded errors.
Keep screenshots and provider/browser evidence separate from local fixtures.
Genuine email/Google/passkey/recovery and physical/screen-reader acceptance still
need their own trials. Initialize no retained account's financial history before
its first strong credential; sandbox allocation is separate from the unfunded
50 USDC live promotional budget.

On failure, preserve the encrypted backup and inspection output. Do not run down
migrations, reset accounts or automatically restore over the shared database.
Assess compatibility before resuming an older application; prefer a reviewed
forward fix. Update the PR and completion matrix with the actual result.
