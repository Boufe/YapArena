# Embedded-wallet and provider-reset staging release

Status: **migration and hosted guest acceptance passed; overall task
incomplete**. Source: `eba1dc5cfe6680a9a41e98482b64d3c725163a1b`,
2026-10-21. This release preserves the prior Privy-only and selected-reset
evidence. It enables no live financial activity.

## Required checks and source review

All five required [CI checks](../wallet-phase-ci/eba1dc5/README.md) passed on
the exact source tree: 858 tests without skips, 239 account/security/ledger,
17 A4 and five treasury cases on each fresh/upgrade path, plus browser,
database-isolation, community, replay and backup/restore gates. The revised
retained-wallet refresh fixture passed four groups, including the forced
post-unlink refresh barrier. Separate SDK/native/coin/cookie trials retain
their own source and provider/device limitations.

The [helper and migration review](auth-release-source-review.md) hashes still
match this release. The [final transition review](final-transition-review.md)
records its author-review boundaries and the separate independent reviews.
The [credential-wait correction](../wallet-verification-pause/README.md) parks
wallet jobs while human credential verification is unfinished, without consuming
provider-creation retries; accepted synchronized credentials safely rearm them.

## Actual database release

Both named Render writers were [suspended](render-account-suspend.json), and
the web readiness route returned 503. Auto-deploy remained off. Runtime-role
non-idle peer count was zero before backup and migration; this point-in-time
sample supplements the independently checked stopped services.

The new [encrypted backup and rehearsal](staging-release-prepare.json) passed:
85 application tables, 15 sequences, exact isolated restored fingerprints and
both additive migrations rehearsed under a non-superuser local owner. The
private AES-GCM backup remains outside Git. This is an application-scoped
backup, not a Supabase/provider/global-role disaster-recovery image.

The [owner-only migration](staging-release-migrate.json) applied only:

- `1792426014000_add-embedded-wallet-provisioning`
- `1792426015000_add-provider-control-phases`

The [postflight](staging-database-postflight.json) confirms **45 applied,
zero pending**, all four accounts including three retained and the genuine
manual signup, the four selected deleted IDs still absent, zero live journals
and grant lots, synchronized mapping generations and no unfinished provider
reset. Browser roles have no application schema/relation/sequence/routine
access; runtime cannot assume owner, create schema objects or write migrations.

The [security comparison](security-preservation.json) verified all 14 unchanged
security projections after migration and before either writer resumed: accounts,
provider mappings, accepted keys, sessions, SID exchanges, wallet identities,
recovery and operation/setup/control records. Only aggregate counts and equality
are exported; hashes and rows stay private. Initial read-only attempts stopped
at an inappropriate backend SSL assertion. The corrected frozen inspector
verifies client libpq TLS with forced `verify-full` and the reviewed CA;
`pg_stat_ssl` describes the separate pooler-to-database hop. No TLS requirement
was disabled and those attempts mutated nothing.

The separate [runtime credential inspection](runtime-credential-separation/README.md)
checked both configured services, secret files and linked-group inventory:
six read-only requests, no owner/admin credential matches, known runtime
database credentials matched, zero mutations. Its pattern/configuration scope
does not claim process or container-filesystem forensics.

The [repository text scan](repository-privacy.json) checked 897 text files
against five privately loaded current secrets and selected encoded forms:
zero matches, two read-only configuration requests, no database connection or
mutation. Its binary/unknown-secret/history limitations remain explicit.

## Deployment and hosted acceptance

Both services were [resumed](render-account-resume.json). The worker resumes
its unchanged `fd60543` source. The web's exact
[deployment request](render-account-deploy.json) targets `eba1dc5`; the subsequent
[control-plane inspection](render-account-inspect.json) confirms both services
terminally live at those exact revisions. Acceptance of the request alone was
not used as live-revision evidence.
The deterministic sandbox was already enabled only on the web; no configuration,
paid plan, provider credential, account or financial source was reset.

The [hosted guest trial](../account-hosted-browser/wallet-phase-eba1dc5/acceptance.json)
passed seven groups: all 14 served assets match, health/readiness return 200,
the real SDK initializes on desktop/mobile, dialog/focus/CSP/private-route checks
pass, and one retired-registration 410 request exercises the real Redis limiter.
The [wallet endpoint supplement](../account-hosted-browser/wallet-phase-eba1dc5/embedded-wallet-anonymous.json)
confirms anonymous 401, private/no-store, no cookie and no leaked wallet state.
No OTP, OAuth, passkey ceremony, account creation or financial action was run by
these guest checks. Dashboard automatic creation remains off because durable
application jobs own provisioning.

The actual read-only provider wallet result is **PENDING**, requiring credential
verification; no user-only wallet creation/ownership acceptance is claimed.
The observed job is in `retry_wait`, with synchronized local generations and
different current-provider versus accepted credential digests. The inspector
does not expose the job's attempt counter or claim proof of a completed setup.
Genuine same-key setup,
returning login, sensitive proof and wallet recovery remain human/provider
acceptance gates. Current [provider capability facts](provider-capability-followup.md)
distinguish free core features from unused paid sender/webhook services and
unestablished production numeric API capacity. Canadian activity eligibility,
five-network custody/conversion approval and funded promotional backing remain
open. Live funding/redemption remains disabled.

## Remaining acceptance and resumption

- **Saved passkey and automatic wallet:** the founder is testing the existing
  account's Finish passkey setup action. A genuine successful device assertion
  must precede accepting that key. After a reported state change, rerun the
  maintained read-only wallet verifier against exact `eba1dc5`; never repair,
  adopt, retry creation or unfreeze through an inspection command. An isolated
  copy of that revision is retained for later evidence-only PR updates. Its
  shell selected Node 25 and was correctly rejected; explicit existing Node 24
  passed the unchanged verifier's 20 offline checks. This is an environment
  correction, not another genuine-provider PASS.
- **Other genuine and device journeys:** email delivery/error/autofill, Google,
  linking/recovery, retained methods, sensitive proofs and physical/screen-reader
  trials need real provider/device participation. Synthetic tests cannot supply
  those results. No extra hosted identity has been created for this release;
  scope future disposable identities before cleanup.
- **Financial provider and eligibility:** obtain written review for the actual
  operator/activity and all five routes using the prepared
  [provider questions](../../../nowpayments-eligibility-questions.md), plus
  Canadian province/age/identity/retention review. The draft has not been sent;
  no external contact or paid review is authorized by this record. Only after
  provider/security/legal approval should an explicitly authorized funding and
  allocation establish the separate real promotional reserve.
- **Hosted operations:** the
  [Redis read-only attempt](../redis-hosted-readonly.json) records unavailable
  external INFO/SSH paths and the safe behavioral alternative, now passed by
  the guest probe. Local multi-instance/outage/OOM/restart tests retain their
  scope. A hosted topology/outage/capacity drill needs an approved maintenance
  path within budget; do not change access rules, buy a plan or repeatedly retry
  unavailable access. Production domain/OAuth/cookie configuration and numeric
  provider API capacity remain separate from the free development app.

The [52-row checklist](../../../email-first-requirement-checklist.json) remains
the resumable owner/dependency/acceptance/evidence record. No remaining external
gate is treated as completed merely because code, local tests, CI and this
staging release passed.
