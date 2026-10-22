# Genuine disposable email signup continuation

Runtime: **3096ca7**. This is a human-reported journey with separately scoped
native UI and status-only observations, not a synthetic fixture result.

The founder approved a disposable staging account and supplied its email privately.
In the first isolated, headed Playwright-launched Chrome session, they reported
an immediate code-send error and no visible CAPTCHA prompt. The
[first status-only observation](first-observation.json) contains 22 allowlisted
request attempts, no unfinished requests and confirmed cleanup of the owned
browser/profile. It captured no matching provider email-init request, but omitted
CAPTCHA and public-metadata paths: **zero provider activity is not established**.
The generic notice did not identify a cause. No code was requested in chat.

The first command to open normal Chrome did not produce a visible test window.
The lead then used native Chrome controls to open and verify an Incognito window
at the signup page. The founder entered credentials only on the real site and
reported **signup succeeded**. No request instrumentation, screenshots, private
page text or device prompts were captured during that successful attempt.
The [bounded journey report](journey-report.json) preserves these distinctions.
The subsequent [read-only attribution and local-state inspection](identity-and-local-state.json)
at 00:19:44 UTC attributed exactly one new account/mapping within the approved
trial window using the protected four-account baseline, verified-email snapshot
and actual server exchange. All four protected accounts and the original mapping
remain present; selected reset IDs remain absent. The inspector made one verified
client-TLS READ ONLY snapshot and zero provider/service calls or mutations.

The founder then reported **ambiguous passkey confirmation and failed returning
passkey/email login**, and did not observe wallet readiness. The snapshot has
one accepted Privy-origin key, one consumed/captured setup intent and locally
ready wallet state, but zero sessions, mismatched account/mapping generations
and two manual reset jobs. The latest job is preflight/inherited_manual without
an external acknowledgement. This establishes a stalled local reset state,
**not** the preceding job's cause, current provider freeze or incorrect code
entry. Further read-only job-history/provider diagnosis is in progress. The
account journey is **failed/incomplete**, despite initial signup success.
No security fence was relaxed and no repair or cleanup follows from attribution.

The [allowlisted current public metadata projection](public-config-projection.json) selects Turnstile with CAPTCHA enabled, no
custom API URL and the staging domain allowed. The installed SDK waits for
CAPTCHA before email-init. Existing source and served CSP include its script and
frame origins, as required by the official
[Privy CAPTCHA/CSP guidance](https://docs.privy.io/security/implementation-guide/content-security-policy)
and [Cloudflare CSP reference](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).
No demonstrated CSP defect or reason to weaken it was found. Cloudflare's
[testing guidance](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
explains that automated browsers can be blocked. That is a supported possible
environment limitation, **not a proven diagnosis** of the first attempt.

The new email-send notice correction is a separate source change: it distinguishes
known SDK security-check failures from provider/network/configuration failures
without exposing raw messages. A successful ordinary signup does not make those
negative paths or their misleading old notice irrelevant. Its synthetic acceptance
must retain its own source/test boundary. Overall acceptance remains incomplete.

The inspector helper is SHA256
`b1f989987f37cd567676117718f15cb90d7f6030f2a938a1792d101214818f36`.
The account-security reviewer authored it, the lead and Redis reviewer inspected
it, and the lead executed it once. Attribution identifiers remain in a separate
private0600 file, with cleanup explicitly unauthorized by that artifact. Local
wallet ready is not provider ownership, recovery or signing acceptance. The
pooler-to-database SSL flag is false in the report; verified client-to-pooler TLS
is separately checked and is not relabeled end-to-end database encryption.

## Confirmed reset overlap and provider state

The [second local snapshot](reset-history-readonly.json), at 00:26:11 UTC,
records the older job in manual/freeze_confirm after one attempt/read and a
successful freeze acknowledgement, with no unfreeze request or confirmed freeze
read. Its generation has been superseded. The newer job's exact-generation audit
identifies normal logout-all; it is manual/preflight/inherited_manual with zero
attempts. The older cause remains unclassified by that allowlist. The current
engine's generation check sends this overlap to manual review. A new isolated
real-repository regression is reproducing/fixing it without weakening the
existing unaudited-generation-change negative case.

The [actual provider inspection](provider-freeze-readonly.json), at 00:35:55 UTC,
confirms **provider frozen**, unchanged accepted credentials and the exact
accepted passkey match. Two provider reads agree and the frozen timestamp falls
inside the acknowledged local freeze window. Both database snapshots agree;
Render confirms exact LIVE3096. It made three provider GETs, four Render GETs,
two READ ONLY snapshots and zero mutations. The wallet adapter was explicitly
**skipped while frozen**; its ownership is not established by this result.

The founder confirmed they **only used YapArena**, with no separate dashboard
freeze/suspension of this disposable account. That is a recorded review input,
not an invented provider operation ID. Privy's documented idempotent freeze can
retain the same timestamp, so a timestamp/window match alone cannot rule out an
independent intervening administrative action. Any repair must use explicit
owner review, the exact retained key/credential/job evidence, bounded phase
budgets and a preserved token cutoff. No repair has been executed.

The first history extension failed READ ONLY with SQL42703 because it named
`created_at` instead of the audit table's `occurred_at`. The corrected helper
`7e62737f75686da96dfb8b8ecef5cfbf3aa6d054661edafabb57c006608ec894`
produced the successful report; the failed attempt produced no diagnostic state
or mutation. The provider helper first failed before main/network because direct
server TypeScript imports require compilation. Its corrected built-module
imports, source/compiled hashes and disabled SDK logging were reviewed; final
helper `7555be686c6a25a761abc89fd1811a82c0530b44b46a341de25d6311093925fa`
produced the actual GET-only report. Preparation failures are not passing feature
acceptance. The Redis reviewer inspected each final helper and actual output;
these inspections are not second executions.
