# Local email-first account evidence

Recorded 2026-10-19 on `feat/email-first-accounts`. These are synthetic local
acceptance fixtures, not hosted signup or financial acceptance.

`npm run verify:email-auth-browser` runs the installed Privy SDK within the
server-rendered account page and account CSP. Public provider metadata is read
live, with CAPTCHA disabled in the local intercepted metadata only; staging
CAPTCHA remains enabled. OTP sending/verification is intercepted. Google/passkey availability and
the balances/profit events are fixture responses. No inbox, hosted account,
provider wallet or real money is changed.

| Viewport    | Before                                                                                                                              | Email-first                                                                                                                       | Incorrect code                                                                                                                         | Withdrawal progress                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440 × 1000 | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/before-desktop.png) | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/after-desktop.png) | [Error](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/code-error-desktop.png) | [Balance menu](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/wallet-progress-desktop.png) |
| 390 × 844   | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/before-mobile.png)  | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/after-mobile.png)  | [Error](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/code-error-mobile.png)  | [Balance menu](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/email-first/wallet-progress-mobile.png)  |

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

These fixture results do not establish real CAPTCHA validation, provider login or
code delivery. Separately, the founder completed a genuine hosted email signup;
the [backend inspection](hosted-signup.json) confirms exactly one new stable
account/provider mapping and preserves the manual account. Recovery, credential
management and hosted revocation remain separate gates. The hosted protected
auth request passed its Redis control after rollout. The [selected reset
report](reset-selected.json) records the requested deletion of IDs 1–4 with
unselected accounts, content and immutable history preserved. No funded issuance,
purchase/redemption adapter, financial reconciliation or complete account
acceptance is claimed. See the [current work record](../../email-first-accounts.md).

The separately requested [visual refresh](../account-refresh/README.md) supersedes
these original interface screenshots and expands the local account/dialog checks.
