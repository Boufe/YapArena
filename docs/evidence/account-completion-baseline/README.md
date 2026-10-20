# Account-completion browser baseline

Later acceptance is recorded separately in the
[739-test integrated gate](final-integrated-release-gate/README.md),
[PostgreSQL 18 compatibility run](pg18-auth-compatibility/README.md),
[70-group return/loading/error browser run](auth-return-browser/README.md),
[14 native security/recovery groups](security-passkey-browser/README.md),
[22 native coin groups](coin-sandbox-browser/README.md) and
[actual application-to-Cloud logout trial](media-app-cloud-revocation/README.md).
Their revision and environment boundaries govern those results; this page
preserves the original visual baseline.

Captured 2026-10-20 against revision
`03ecffb71d20c662350940eef014571a2ac2bf7f`, using a frozen copy of its existing
generated browser assets. [The machine-readable results](before/browser-results.json)
identify every asset by SHA-256. Shared checkout changes and later rebuilds did
not change these served baseline assets.

This is a **local UI fixture**, using the real installed Privy SDK and the public
app ID `cmvfjb3r800vy0hl3heg2cuvv`. Public provider metadata was fetched, with
CAPTCHA explicitly disabled only in the intercepted fixture response. Email
delivery, verification failures, application sessions, profiles and balances
are synthetic. Page and dialog screenshots visibly carry this label. No provider
identity, inbox, hosted account/database, funds or financial liabilities were
created or changed.

## Before and integrated after results

The expanded baseline harness completed both 1440 × 1000 desktop and 390 × 844
mobile viewports. That baseline process exited **1** because a newly covered
requirement failed in both viewports: open the login popup, refresh, reopen it,
then press browser Back.
The popup remains open. Stale `history.state.yapAuthDialog` survives refresh;
Back returns to another auth-marked history entry and the existing popstate
handler did not dismiss the popup. Original failure screenshots remain at
[desktop](before/refresh-back-failure-desktop.png) and
[mobile](before/refresh-back-failure-mobile.png).

The [integrated after result](after/browser-results.json) exits **0** with no
browser errors or requirement failures. It identifies the tested revision,
generated browser assets and compiled page-renderer hashes. The shared checkout
was still being implemented; those exact content hashes delimit this acceptance.
The history fix uses a per-document marker, and the same refresh/reopen/Back
assertions now pass on both viewports. This report does not claim untested later
source changes.

Recorded assertions include:

- Provider readiness and delayed send/verify busy states; duplicate native form
  submissions issue one request while pending.
- Incorrect-code error, six-digit whole-string insertion, numeric input and
  email/one-time-code autocomplete attributes.
- Virtual-clock resend cooldown, old-code clearing and renewed wait.
- Change-email focus, refresh clearing, modal cancellation and late send response
  rejection after dismissal/reopen.
- Exact local query/fragment return, Escape/focus restoration and ordinary Back
  behavior before the refresh case.
- App-session-controlled header, lazy provider loading, cross-tab logout,
  temporary-unavailable retry and rejection of a stale pre-logout balance.
- Pending initial/refreshed application sessions retain checking controls without
  displaying guest controls before the response.
- An interrupted provider-bundle download produces a status announcement;
  closing/reopening successfully retries the real installed SDK.
- Profile create/publish and session-management controls using synthetic API
  responses; independent grant bars and sticky qualification display.
- The after run additionally removes only the selected other session, restores
  focus to Refresh active sessions, and delays a current-session DELETE across a
  synthetic account change. The late result cannot sign out the replacement
  account, emit provider logout or overwrite its new session list.
- Axe checks tagged WCAG 2/2.1/2.2 A/AA for auth, invalid-code, settings and modal
  fixtures; polite/atomic error announcements; no viewport overflow.
- Shared header style parity with/without the debate stylesheet, and desktop
  guest/member header, email entry, code error and full account settings reflow
  with horizontally reachable controls at 200% CSS zoom.

Strict browser-automation TypeScript checking passed after harness changes.
No check, assertion or threshold was disabled to hide the Back failure.

## Screenshot matching

`account-email-*`, `account-signed-in-*`, `signup-popup-*`, `code-popup-*`,
`code-error-*`, `header-*`, `wallet-progress-*` and `balance-dialog-*` are the
current **before-change** journeys. Later screenshots must use the same fixture
data, viewport, reduced-motion setting and capture names for comparison.
`legacy-comparison-*` deliberately renders `?baseline=1`, the earlier password
surface, and is historical context rather than the current before-change UI.

Matched after screenshots use the same names, data, reduced-motion setting and
viewports. Visual inspection of the mobile account settings preserves the dark
theme, shared header, profile, wallet and balance layout while adding security
passkeys and individual session controls. Screenshots are evidence of these
fixtures only; synthetic balances are neither issued money nor proof of a
financial workflow.

Representative current baseline images:

- [Desktop email auth](before/account-email-desktop.png)
- [Mobile email auth](before/account-email-mobile.png)
- [Mobile signup popup](before/signup-popup-mobile.png)
- [Desktop account settings](before/account-signed-in-desktop.png)
- [Mobile account settings](before/account-signed-in-mobile.png)

Representative integrated after images:

- [Desktop email auth](after/account-email-desktop.png)
- [Mobile email auth](after/account-email-mobile.png)
- [Mobile signup popup](after/signup-popup-mobile.png)
- [Desktop account settings](after/account-signed-in-desktop.png)
- [Mobile account settings](after/account-signed-in-mobile.png)
- [Mobile delayed-session-removal protection](after/session-race-protected-mobile.png)
- [Account security at 200% CSS zoom](after/account-settings-zoom.png)

## Limits and remaining acceptance

This proves neither genuine signup/return/recovery nor successful provider-token
exchange, Google authorization, passkey ownership, production CAPTCHA/email
delivery, hosted-session revocation or provider acceptance. It must not replace
the existing genuine hosted signup evidence. Synthetic whole-string insertion
and autocomplete attributes do not prove OS clipboard or SMS/email autofill on a
physical device. Axe and DOM/focus assertions are distinct from screen-reader
testing and complete WCAG conformance. Mobile is an emulated viewport; no
physical device was tested. CSS zoom is an automated reflow check, distinct from
browser/OS text scaling and physical-device use. Security-passkey empty-state
rendering is covered, but this fixture does not enroll a security passkey or
claim a real WebAuthn browser/backend ceremony. The separate
[real-backend virtual-authenticator trial](security-passkey-browser/README.md)
records those ceremonies and its own tested revision. The
[native screen-reader attempt](screen-reader-attempt.md) was blocked and is
explicitly incomplete; it does not establish a VoiceOver pass.

Reproduction uses public configuration only:

```sh
PRIVY_APP_ID=cmvfjb3r800vy0hl3heg2cuvv \
AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/after \
AUTH_BROWSER_PHASE=after \
npm run verify:email-auth-browser
```

The harness listens on an ephemeral loopback port and launches headless Chrome.
`AUTH_BROWSER_PUBLIC_DIR` can point to a frozen generated-asset directory; it was
used for the before run. The normal after run must use a fresh integrated build.
