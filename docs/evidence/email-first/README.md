# Local email-first account evidence

Recorded 2026-10-19 on `feat/email-first-accounts`. These are synthetic local
acceptance fixtures, not hosted signup or financial acceptance.

`npm run verify:email-auth-browser` runs the installed Privy SDK within the
server-rendered account page and account CSP. Public provider metadata is read
live, with CAPTCHA disabled in the local intercepted metadata only; staging
CAPTCHA remains enabled. OTP sending/verification is intercepted. Google/passkey availability and
the balances/profit events are fixture responses. No inbox, hosted account,
provider wallet or real money is changed.

| Viewport    | Before                       | Email-first                | Incorrect code                  | Withdrawal progress                         |
| ----------- | ---------------------------- | -------------------------- | ------------------------------- | ------------------------------------------- |
| 1440 × 1000 | [Before](before-desktop.png) | [After](after-desktop.png) | [Error](code-error-desktop.png) | [Balance menu](wallet-progress-desktop.png) |
| 390 × 844   | [Before](before-mobile.png)  | [After](after-mobile.png)  | [Error](code-error-mobile.png)  | [Balance menu](wallet-progress-mobile.png)  |

Matching before/after viewport, measurement preference, reduced-motion setting
and SSR fixture are used. Changed account content is intentional; the shared
navigation and page design remain. Full-page screenshots extend beyond the
viewport vertically. The displayed 1,250 YC withdrawable, 40% welcome progress,
unstarted daily lot and permanently qualified daily lot are synthetic examples.

[Machine-readable checks](browser-results.json) cover initialization, accessible
form labels/autofill hints, keyboard submission, focus, resend waiting, incorrect
code handling, changing email, refresh, no overflow, independent grant bars,
Escape/focus restoration in menus/dialogs and exact query/fragment return links.
Settings are also checked with an authenticated application-session fixture and
a signed-out Privy SDK, ensuring the server account supplies its method list.
Automated axe checks apply WCAG 2/2.1/2.2 AA tags to the email form; they do not
establish full conformance or screen-reader/physical-device acceptance.

The full `DATABASE_TEST_MODE=host npm run verify:browser` gate passed separately:
524 source/SQL tests, zero skips, fresh/upgrade database isolation, account/A4,
debate workspace, shared discovery, homepage and synthetic media preview checks.
Coverage: 94.22% lines, 92.76% branches, 95.45% functions. The production image
also built with the locked dependencies. Real Redis checks used two clients,
100 atomic concurrent increments, TTL expiry and bounded outage failure.

Real CAPTCHA validation, provider login, code delivery, recovery, credential management, hosted
revocation and Redis connectivity remain separate gates. No funded issuance,
purchase/redemption adapter, financial reconciliation or reset acceptance is
claimed. See the [current work record](../../email-first-accounts.md).
