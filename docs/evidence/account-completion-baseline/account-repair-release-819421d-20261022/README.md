# Staging account repair release — 22 October 2026 UTC

Exact application `819421d30b10acb29b38a0f75ed46360af373870` passed all five
[exact-tree CI checks](../ci-819421d-20261022/README.md) and was deployed to the
named free staging web service. [Acceptance](deploy-accepted.json) was followed
by an actual [LIVE inspection](render-live.json). The replay worker stays at
`fd60543`; automatic deployment is off for both services. There are no schema,
plan, provider setting or live-financial configuration changes.

The [guest check](guest/acceptance.json) passed all seven groups,14 served-asset
hashes and PostgreSQL-backed readiness, with no account/provider mutations. Its
aggregate Redis probe is a bounded use of the retired registration endpoint;
it does not establish hosted multi-instance/outage/ACL acceptance. The operator
selected revision plus asset hashes is distinct from independent server-commit
attestation; Render supplies the separate exact LIVE control-plane observation.

The first GET-only [containment attempt](drain-first-attempt.json) stopped before
its snapshot after three requests, with zero mutations. A worker configuration
shape mismatch is under investigation. No owner prepare/rearm or provider repair
has run. This failed attempt is preserved; no automatic retry is authorized.

The actual new disposable signup journey remains failed/incomplete pending
reviewed containment, scoped queue rearm, exact read-only postflight and genuine
returning email/passkey acceptance. This code-only release does not repeat the
already-applied45 migrations or authorize account cleanup, key replacement,
financial funding, signature or payout. The original four accounts stay protected.

Further actual containment/repair results will be appended with their own scope.
This archive is in progress and has no frozen final manifest yet.
