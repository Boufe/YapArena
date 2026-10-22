# Privy-only staging release — 2026-10-20

The named staging web service is live at
`d6e2d355da255e03c257802c890c036c4d572a62`. The replay worker remains at
`fd60543b5f6d8f0b65fe1f93807252064d9317f2`. Automatic deployments remain off;
service plans and runtime/owner separation were preserved. This is staging
acceptance, with only the deterministic coin sandbox enabled. Live funding,
redemption and provincial eligibility remain disabled.

All five [required CI checks](../privy-passkey-ci/README.md) passed for the exact
selected source tree. The [first observed live inventory](render-first-live.json)
records the accepted web deployment `dep-dbbshb0473hc73ccs24g` as live. The
earlier [9395242 release](../staging-release.md) and its evidence are preserved.

## Guarded database release

- Separate GET evidence confirms [both writers stopped](render-stopped-independent.json),
  with the public health endpoint [returning 503](stopped-health.json).
- [Preparation](staging-release-prepare.json) encrypted the private application
  snapshot and restored all 83 table fingerprints and 15 sequences exactly in
  an isolated local environment. Both new migrations passed the restored-data
  rehearsal. The encrypted backup and its key remain private and separate.
- [Owner-only migration](staging-release-migrate.json) applied only
  `1792426012000_add-provider-passkey-provenance` and
  `1792426013000_add-provider-passkey-bootstrap`, after a second stopped-writer
  check and exact backup/source/catalog validation.
- [Immediate post-migration](staging-database-post-migrate.json) and
  [post-deployment](staging-database-postflight.json) read-only checks confirm
  43 applied / zero pending migrations, three retained accounts plus the genuine
  manual signup, the four selected reset IDs absent, zero live journals/grants,
  no private browser grants and no runtime ownership or owner-role assumption.
  The earlier reviewed provider reset remains complete with matching generations.
- [Suspend](render-account-suspend.json), [resume](render-account-resume.json)
  and [exact-commit deployment](render-account-deploy.json) results record the
  bounded control-plane actions. No account deletion, provider mutation or
  financial initialization occurred during this release.

These are additive, forward-only schema changes. Do not run down migrations or
reset accounts for rollback. Reassess application compatibility before changing
the deployed source; the retained encrypted snapshot is emergency recovery
evidence, not authorization to overwrite later work.

## Hosted browser and Redis result

The [actual guest report](../account-hosted-browser/d6e2d35/acceptance.json) passed all
seven groups at 20:05:57.404 UTC. All 14 served authentication, header, security
and style assets exactly match the selected local build. Public health and
PostgreSQL-backed readiness return 200. Actual public Privy metadata and app
flags agree: email, Google and passkeys enabled; automatic Ethereum/Solana
wallets and email-based merging off.

Desktop and mobile checks cover the real installed SDK, one passkey login
option, guest controls, Escape/focus restoration, private account sections,
layout/CSP and no unintended media join or account mutation. Matched old/new
screenshots include [old mobile login](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-hosted-browser/9395242/login-mobile.png)
and [new mobile login](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-hosted-browser/d6e2d35/login-mobile.png), plus
[desktop login](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-hosted-browser/d6e2d35/login-desktop.png) and
[mobile account](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/account-hosted-browser/d6e2d35/account-mobile.png).

A guarded retired-register request returned 410 without an identity or cookie
and increased successful Redis operations and latency observations from zero
to one. The single observed latency was 0.538760864 seconds. This checks the
application-enforced noeviction/Lua path; it is not raw hosted INFO, a load
measurement, hosted multi-instance acceptance or an outage drill.

## Limits and subsequent work

No email code, OAuth or provider-passkey ceremony was submitted. These guest
screenshots do not establish genuine signed-in account management, financial
access, recovery, device or screen-reader acceptance. A genuine account trial
is requested separately; codes and credentials must be entered only on the site.

The Supabase [advisor check](advisor-check.json) was attempted; both security
and performance tools denied access. No clean advisor result is claimed.
Strict TLS, role/catalog checks and actual fresh/upgrade tests are separate
evidence. The snapshot is application-schema backup evidence, not full
Supabase/provider/global-role disaster recovery.

The independent review subsequently identified an additional browser
account-switch race in ordinary provider-method settings. Its correction and
acceptance require a later source revision; the successful release recorded
here does not establish acceptance of that follow-up. The overall task remains
incomplete; see the [completion matrix](../../../email-first-completion.md).
