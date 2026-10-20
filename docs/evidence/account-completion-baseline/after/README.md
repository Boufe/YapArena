# Email and account browser fixture

Actual local Chromium run: **48 checks passed**, desktop 1440×1000 and mobile
390×844, at revision `7e813e325f011700937fd667b167a6babea5f313`.
[Results](browser-results.json) record the timestamp, exact built-asset hashes
and verifier/server-rendering source hashes. The matching original captures
remain in [before](../before/).

Matching desktop/mobile account captures were also visually inspected. The
shared header, dark theme, cards and responsive column order are preserved;
the page grows to accommodate provider methods, security keys and owned sessions.

The real installed Privy browser SDK and public app configuration are used;
email-code delivery, verification and application responses are intercepted
synthetic fixtures. No inbox, hosted identity, hosted database or funds were
changed. These captures do not establish genuine hosted email, Google or Privy
passkey acceptance.

The run covers initialization, resend/error/cancellation/back/refresh behavior,
keyboard and focus, account/header controls, session-removal ownership, stale
account reads, trusted-dialog cancellation and erased credentials. It also holds
old default/header/all/other-session logout replies across an account change and
proves that they cannot clear or relabel the replacement UI or invoke provider
logout. The real HTTP cookie-jar regression in `tests/auth.test.js` separately
checks the actual cookie response behavior. Same-account changes during a held
logout converge through a fresh server lookup. The separate
[actual two-tab HTTP trial](../session-coordination-browser/README.md) verifies
issuance/revocation ordering and HttpOnly cookie headers; these intercepted UI
responses do not establish that protocol behavior by themselves.

Changed account surfaces have automated WCAG-tag checks, mobile layout checks
and desktop 200% **CSS zoom** reflow checks. Automated checks are separate from
screen-reader, physical-device and browser/OS zoom acceptance.

Reproduce after building, with the public `PRIVY_APP_ID` configured:

```sh
AUTH_BROWSER_PHASE=after AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/after npm run verify:email-auth-browser
```
