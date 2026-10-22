# Scoped owner pooler compatibility and simulated withdrawal acceptance

The maintained owner command now accepts Supabase's documented custom-role
pooler username, while PostgreSQL must still report both `current_user` and
`session_user` as `yaparena_owner`. The URL guard permits the scoped owner only
on the documented `aws-[index]-[region].pooler.supabase.com` host shape. Runtime,
administrator, malformed-project and lookalike-domain usernames remain rejected.
No pool, TLS, rail, ledger or application authorization check was relaxed.

The change and its focused test are committed as
`e8fcdffb6e4e7a857cf761b136b40fc99807d1a4`. Current official
[connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres#endpoints-and-ip-versions)
and the [Supavisor FAQ](https://supabase.com/kb/troubleshooting/supavisor-faq-YyP5tI)
were checked on 2026-10-21. They describe custom-role `[ROLE].[PROJECT-REF]`
usernames. A matching URL is a routing prerequisite; it is never database
identity or authorization evidence by itself.

## Actual hosted deterministic simulation

At **2026-10-21 23:55:48.527 UTC**, the lead's single guarded owner invocation
completed the existing, user-requested simulated withdrawal. The
[sanitized result](simulation/result.json) records one owner approval and one
completed deterministic outcome using the maintained `review` and `simulate`
commands. It created no quote, account, grant or funding credit, and made no
provider, service or chain request.

The preflight required the fixed staging project, verified client TLS with the
reviewed CA, the non-superuser owner role, 45 exact migrations, simulation rail,
four existing accounts, one mapped account, no unresolved same-identity reset
and zero live journals/grants. It selected exactly one still-reviewing request
with the previously consumed genuine Privy-passkey proof and matching success
audit, exact immutable terms/digests and exact same-account two-posting source
reservation. Prior approval/outcome/receipt/signed-nonce history would stop the
trial. The [earlier proof inspection](../embedded-wallet-release/genuine-passkey-wallet-20261021/README.md#persisted-sandbox-authorization-match)
remains a separate observation rather than a new native ceremony here.

The maintained command produced the original request's deterministic transfer
identity and receipt. Its public report exports no identifiers, amounts,
destinations, credentials, signatures or individual financial timestamps. The
postflight matched exactly one approval and one completed outcome/receipt,
preserved the original terms and source reservation, and checked balanced
journals and balances against postings. Accounts, accepted keys and full source
book JSON remained unchanged; the book version advanced by exactly two events.
The withdrawal had already removed its sources at reservation, so approval and
completion preserve that source book while changing the ledger buckets.
Grant lots remained unchanged. This is **not** hosted grant-issuance acceptance.

The private helper was reviewed by the lead and a separate wallet reviewer
before execution. Its SHA256 is
`6b049c8f61ac4f50e640be1450ad68df2dc7d5691a83ad807aaf8790357ef938`.
The account-security reviewer authored the helper and independently inspected
the actual result afterward; that is an authorship limitation and not a second
execution. A private single-use marker preceded financial writes; partial or
unknown outcomes stop without automatic retry or reserve release. That private
marker, scoped identifiers and operator configuration are not archived here.

## Revision boundaries

- **Deployed web:** `3096ca776a04f3cf38ad835d7348329791c0385b`. The helper pinned
  the [reviewed LIVE report](../passkey-signin-errors-20261021/release/render-live.json),
  SHA256 `193358b8a5833a371e8946fa7d72bcd7db05a60135ab2676b662f9c4bcabede1`,
  including automatic deploy off and deterministic sandbox enabled. The replay
  worker remained at `fd60543b5f6d8f0b65fe1f93807252064d9317f2`.
- **Financial source baseline:** `eba1dc5cfe6680a9a41e98482b64d3c725163a1b`.
  The relevant backend/migration bytes remained identical in the deployed web.
- **Owner-process source:** `e8fcdffb6e4e7a857cf761b136b40fc99807d1a4`.
  The result confirms the reviewed CLI source matched this checkout. It does
  not claim this operator-only correction was deployed into the web image.

## Local quality and isolation

The successful third local run is preserved as [terminal log](local/run.log)
and [full quality output](local/quality.log), with a [count summary](local/result.json).
It ran the frozen CLI/test correction based on `3096ca7`, subsequently committed
unchanged as `e8fcdff`. The [manifest](manifest.json) pins exact source,
compiled-module and artifact hashes.

- **859 tests passed, zero failed or skipped.** Local coverage was **95.32%
  lines / 91.23% branches / 95.35% functions**, with the existing thresholds.
- **240 focused account/security/ledger tests**, including the offline URL
  guard case, passed on each fresh and upgrade path. The new case accepts four
  routing shapes and rejects 13 invalid shapes before pool construction.
- **17 A4 tests and five dedicated treasury tests** passed on each path.
- PostgreSQL **17.10 (Homebrew)**, UTF8 client/server and `C` locale are recorded
  in the raw output. Fresh/upgrade catalog, runtime/browser-role denial, creator
  membership, triggers and future-default checks passed in disposable databases.

These command counts overlap and are not an additive total of unique tests.
The disposable catalogs contain schema/role metadata, not hosted user rows.
Formatted JSON copies preserve the same parsed values as adjacent `.json.raw`
files; both hashes are recorded. Earlier local attempts stopped at formatting
of newly archived evidence, before completing the full gate: their
[first](local/format-failure-r1.log) and [second](local/format-failure-r2.log)
logs remain labeled as failures. They are not passing application acceptance.

Remote CI is separately reviewed under `ci/` and `ci-review.md`; this local
coverage and terminal result must not be substituted for its actual result.
This archive reruns neither the installed-SDK125 browser suite nor the separate
native18, coin22 or cookie-ordering gates.

## Limits

The completed transfer is **valueless deterministic simulation**, not provider
or chain settlement, a live payment, external backing or a refund. There is no
new browser receipt/focus, native proof, device, recovery or grant-qualification
acceptance. The reviewer inspected existing artifacts and performed no database,
provider, browser or service execution for this archive. The broader task stays
incomplete at its separately recorded genuine and external gates.
