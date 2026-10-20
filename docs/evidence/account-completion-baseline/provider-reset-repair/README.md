# Guarded staging provider-reset repair

This records the genuine manual-signup account's repair without publishing its
account ID, email, provider ID, credentials or private provider response.

The first owner-only retry stopped at `freeze_confirmation` after a successful
freeze request. A later trusted GET returned a positive integer freeze timestamp.
The lead inspected the actual authenticated Privy organization Activity log,
including a fresh page reload at approximately 18:15 UTC on 2026-10-20. Its four
rows contained one `app/users/freeze` for the selected account at 13:49 Toronto
time and no independent/later freeze or unfreeze. The other three rows concerned
app creation, disabled email merging and CAPTCHA configuration.

The restricted review report's SHA-256 is
`9b6d1c5dc41d6b45e5f69b53d068d18bd4204d1971afc216c2da3162812e61c6`.
The report is an operator observation, not a provider-signed audit export.
The read-only database/provider inspection independently matched the original
retry audit, subject, credentials, generation, attempt and freeze/lease window.

The reviewed helper (`8123de071cbbb06dc642131603a5e6b3605c5a1070f846de5e17b310669e91f2`)
then made **one** guarded unfreeze request. It returned successfully, but the
bounded immediate confirmation stopped at `unfreeze_confirmation`. Its durable
review audit and confirmed freeze survived; the application fence stayed closed.
No second unfreeze request was made. The [subsequent read-only diagnostic](after-single-unfreeze.json)
returned an explicit null `frozen_at`, unchanged verified credentials, active
account and the expected still-fenced mapping/manual job. This establishes
delayed confirmation for this unfreeze; it does not prove every earlier unknown
response had the same cause.

The service/CLI transport self-test used the installed SDK, with zero network
calls: ordinary retry allowed selected-user GET/POST/DELETE, reviewed reconcile
allowed GET/DELETE only, and eight malformed/out-of-scope requests were rejected.
The owner repair and bridge ran together in disposable PostgreSQL: 179/179 tests
passed for fresh and upgraded databases, plus five treasury tests on each. See
[the exact local evidence](../privy-passkey-bridge/README.md).

The separately guarded **database-only finalization completed**. Before its
hosted execution, the lead reran the combined disposable isolation gate:
185/185 tests passed on fresh and upgraded databases, zero skips, plus five
treasury tests on each. The finalization transport's installed-SDK self-test
allowed GET only and rejected both provider mutations; ten total out-of-scope
requests were rejected without network access. The reviewed final helper hash is
`04b7ddf7b6fc4b403b8179e5fddfd599df3e9a44abea4e9a0dc38c291d698f48`.

Actual hosted execution returned `complete` for `finalize-reviewed`. The
[independent subsequent read-only check](after-finalize.json) confirms matching
account/mapping generation, the confirmed-freeze-plus-one token cutoff,
unchanged verified credentials, an explicit null freeze timestamp and a complete
job with zero manual jobs. No account, retained credential or financial history
was deleted, and no further provider mutation was sent.

This repairs the reset state. It is **not** a successful genuine returning-login
claim, provider passkey acceptance or approval for live financial activity.
