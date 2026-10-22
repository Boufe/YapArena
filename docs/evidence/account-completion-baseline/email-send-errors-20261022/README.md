# Email-send error guidance — 2026-10-22

Source **7e5c0a38b9b474f1712d5d87454842c0c8a7f7ae** was committed locally after
these runs with the same tested bytes. This archive does not assert a push, CI
result or hosted deployment for that commit. The overall authentication and
financial task remains incomplete.

The correction gives bounded guidance for failures before Privy sends an email
code: CAPTCHA rejection or timeout, provider throttling, outage, initialization,
configuration and interrupted connections. It does not expose provider messages,
change OTP/CAPTCHA behavior, or diagnose the genuine user's returning-login
failure. That account state is investigated separately.

## Controlled before/after trial

The [before diagnostic](sdk/before-captcha-failure-desktop.json) records the exact
old behavior for the first synthetic CAPTCHA-failure case: zero email-init,
authenticate and application-exchange requests; the notice blamed the email,
while the expected CAPTCHA guidance was absent. The
[raw failure log](sdk/before-run.log) retains that expected assertion failure.

| Before                                                                                                                                                                                                                                               | After                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Before: CAPTCHA failure described as email send failure](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/email-send-errors-20261022/sdk/before-captcha-failure-desktop.png) | ![After: bounded CAPTCHA guidance](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/email-send-errors-20261022/sdk/after-captcha-failure-desktop.png) |

The before run used verifier `dc1fa01d…` with baseline frontend `554f8bff…` and
bundle `e739af3b…`. It stopped at the first scenario. The final verifier
`b484baa7…` subsequently corrected an **unreached** timeout stub to return
`undefined`: the installed SDK treats any non-null response, including an empty
string, as completed. The final fixture exercises the real 20-second SDK polling
timeout without overriding its clock. Its scope text also now distinguishes the
enabled synthetic Turnstile cases from the remaining CAPTCHA-disabled fixtures.
The RED diagnostic has counts/booleans rather than an embedded build manifest;
its baseline provenance is the recorded old-build run and checked Git/source
and bundle receipt. GREEN's manifest is not presented as RED's.

The [final SDK result](sdk/browser-results.json) passed **145 unique checks**:
all 125 retained checks plus ten new cases in each viewport, with no page errors
or requirement failures. The cases cover CAPTCHA failure/timeout/rejection,
provider rate limits/unavailability/network/configuration/disabled/denied/unknown
responses. Each preserves explicit retries, hidden private state, zero
authenticate/exchange calls and no leaked provider detail. The installed
transport's three retries mean exactly four init requests per explicit attempt
for 503/network failures, and one for the other API cases. CAPTCHA failure and
timeout make zero init requests.

The [mobile failure guidance](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/email-send-errors-20261022/sdk/after-captcha-failure-mobile.png) and
[mobile timeout guidance](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-completion-baseline/email-send-errors-20261022/sdk/after-captcha-timeout-mobile.png) were visually
inspected. The shared theme, header and authentication card layout remain intact. All eight
source hashes and 17 asset hashes in the result were independently checked:
tracked sources against Git7e5c0a3 and generated files against the frozen build.
The frontend hash is `78cceda3…`; final verifier `b484baa7…`; bundle `bf7b2337…`.

These are installed-SDK tests with synthetic provider, OTP and application
responses. Two cases use a synthetic Turnstile API to reach actual installed
SDK callback/timeout logic. Other retained cases include real Chromium virtual
authenticator ceremonies. This does not establish genuine CAPTCHA validation,
email delivery, provider login/linking, hosted sessions, wallet creation,
physical-device testing or complete WCAG conformance.

## Combined local repository gate

The [coordinator result](integrated/result.json), [raw run log](integrated/run.log)
and [summary](summary.json) record an independent root-run gate using Node24 and
disposable host PostgreSQL. Its four steps passed: build; fresh/upgrade database
isolation and account/A4/arena/shared-data browsers; homepage; Live/replay preview.
The exact command and root session 58972 are recorded in the summary.

Quality passed **859 tests, zero failures/skips**, with line/branch/function
coverage **95.32/91.22/95.35%**. Both fresh and upgrade paths passed **240 account
and financial/security cases, 17 A4 cases and five separate Base-rail treasury
cases**. The [quality log](integrated/database/quality.log),
[fresh log](integrated/database/fresh-account-security.log),
[upgrade log](integrated/database/upgrade-account-security.log) and original
catalog inventories retain the actual results and role-isolation evidence.

The [retained-wallet browser](integrated/retained-wallet.json) passed four
groups, including the held account-refresh barrier and last-method protection.
The [A4 result](integrated/a4.json), [arena](integrated/arena.json),
[shared discovery](integrated/shared-bots.json), [homepage](integrated/homepage.json)
and [Live/replay preview](integrated/live.json) retain their narrower scopes.
The A4 result has no top-level PASS field; the completed parent coordinator,
its assertions and empty errors establish the child completion. These are local
database/browser and synthetic-media trials, not hosted media acceptance.

The combined coordinator does not invoke the separate 145-check SDK harness.
Both ran with frozen source later committed as7e5c0a3; the SDK report records
base e8fcdff plus the exact changed hashes. Subsequent frontend UX/backend work
is not covered by these runs. No older native, coin, cookie, Redis, hosted or
physical-device result is promoted or rerun by this archive.

[manifest.json](manifest.json) records artifact hashes. `.json.raw` files retain
original JSON bytes; the adjacent formatted JSON has equal parsed values.
Copied logs were checked for database URLs, JWT-shaped values, private-key
blocks and secret assignments, with no matches. This bounded review is not a
claim of a full current-secret, repository-history or pixel privacy scan.
