# Embedded-wallet and provider-reset staging release

Status: **incomplete; release not applied**. The latest read-only preflight
tested source `a9706ccb55ae342c4f11366145b1896d17656931` on 2026-10-21.
This directory preserves the new additive release separately from the prior
Privy-only release and original account-reset evidence.

The database inspection found 43 applied migrations and exactly two pending:
embedded-wallet provisioning (14000) and durable provider-control phases (15000).
All four expected accounts remain, including the three retained accounts and
the genuine manual signup. The selected four deleted IDs remain absent. There
is no live financial history, no generation mismatch, and no pending, running
or manual provider-reset job. Verified owner/runtime TLS and browser-role
boundaries passed. See [the aggregate preflight](staging-database-preflight.json).

The [Render inspection](render-account-inspect.json) found both named services
running with automatic deployment disabled. The web still serves `d6e2d35`;
the replay worker remains on `fd60543`. Deterministic sandbox configuration is
already enabled only on the web. The separate [room inspection](media-room-inspect.json)
found zero rooms and made no mutation or participant connection. These are
point-in-time observations, not proof of writer shutdown or a new deployment.

The [source review](auth-release-source-review.md) describes the exact helper and
migration hashes and its independent-review limits. The full local combined
gate and separate browser results are recorded in the
[integrated evidence](../wallet-phase-integrated/README.md). CI and hosted
acceptance must identify their own tested revisions; local success does not
establish provider behavior.

Before applying this release, the lead identified a wallet retry-budget edge
case: waiting for unaccepted provider credential changes can exhaust the
provisioning budget before the user finishes first-passkey setup. The
[focused correction](../wallet-verification-pause/README.md) passed the full
858-test local gate and separate native rerun. A deterministic retained-wallet
refresh regression also passed separately; fresh exact-revision CI is still
required before proceeding. No
service suspension, migration, wallet creation, provider repair or financial
activation was performed by this preflight.

Remaining operations: verify the corrected integrated revision and all five CI
checks; stop and independently confirm both writers; create a new encrypted
application backup and verify its isolated restore/migration rehearsal; apply
only the exact reviewed additive migrations; inspect preserved security/account
state; deploy and verify the exact web revision; run guest and actual-provider
read-only acceptance. Genuine passkey and wallet recovery/device acceptance
remain separate, and live funding/redemption stays disabled.
