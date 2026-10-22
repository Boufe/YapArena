# Account, authentication and wallet visual refresh

Recorded 2026-10-19. The founder requested a modern interface that preserves
YapArena's theme and the existing account functions. These matched local fixtures
use desktop 1440 × 1000 and mobile 390 × 844 viewports, reduced motion, the same
measurement preference, installed Privy SDK and synthetic account/balance data.
Full-page screenshots may extend vertically beyond the viewport.

The original design is built from commit `e407a48` in a separate detached worktree.
The same updated fixture supplies both designs, including the site's base CSS
for the wallet dialog. No live user data, OTP, token or provider secret is captured.
The legacy signed-out page (`before-*.png` inside each directory) is byte-identical
between builds at both sizes, confirming that its appearance is preserved.

| View          | Original desktop                                                                                                                                          | Refreshed desktop                                                                                                                                       | Original mobile                                                                                                                                          | Refreshed mobile                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email entry   | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/after-desktop.png)             | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/after-desktop.png)             | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/after-mobile.png)             | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/after-mobile.png)             |
| Code error    | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/code-error-desktop.png)        | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/code-error-desktop.png)        | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/code-error-mobile.png)        | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/code-error-mobile.png)        |
| Account       | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/account-signed-in-desktop.png) | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/account-signed-in-desktop.png) | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/account-signed-in-mobile.png) | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/account-signed-in-mobile.png) |
| Balance menu  | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/wallet-progress-desktop.png)   | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/wallet-progress-desktop.png)   | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/wallet-progress-mobile.png)   | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/wallet-progress-mobile.png)   |
| Wallet dialog | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/balance-dialog-desktop.png)    | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/balance-dialog-desktop.png)    | [Before](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/before/balance-dialog-mobile.png)    | [After](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/after/balance-dialog-mobile.png)    |

[Refreshed results](after/browser-results.json) cover SDK initialization,
email/code labels and autofill hints, keyboard submission, code-field focus,
resend waiting, incorrect-code errors, changing email, refresh, exact initiating
query/fragment return, balance bars, sticky qualification and Escape/focus
restoration. Signed-in fixtures verify server-owned authentication methods while
the SDK is signed out, profile creation/publication, permanent handles and
other/all-session sign-out controls. No horizontal overflow or page errors were
observed. Automated axe WCAG 2/2.1/2.2 AA tags found no violations in the email
form, signed-in account area and wallet dialog at either size.
The follow-up SDK configuration check also verifies that unused wallet-directory
requests do not cause top-level CSP violations. The separate native-wallet
controller remains in use. [Core release results](release-results.json) record
the complete disposable-database quality and browser gate for the visual change.

Public Privy metadata is read live; CAPTCHA is explicitly disabled only in the
local intercepted response. OTP endpoints, optional Google/passkey availability,
account responses and balances are synthetic. The 1,250 YC withdrawal amount,
40% welcome progress and qualified daily grant are examples, not funded accounts.
These checks do not establish full WCAG conformance, screen-reader usability,
physical-device passkeys, live optional-provider flows, or financial acceptance.
The founder's [real hosted signup](../email-first/hosted-signup.json) is separate.

## Hosted rollout

The [deployment report](hosted-deployment.json) records revision `a1dcf40` live
on the authorized staging web service. `/ready`, `/account`, `/debates` and
`/live` returned 200; an anonymous session lookup returned 401. No database reset,
financial enablement, automatic-deployment change or worker revision change was
part of the UI rollout.

Real anonymous [desktop](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/hosted-desktop.png) and [mobile](https://github.com/Boufe/YapArena/blob/archive/email-first-accounts-20261022/docs/evidence/account-refresh/hosted-mobile.png)
screenshots use the same viewport dimensions as the local comparison. These
staging views have Google/passkeys off, unlike the explicit local optional-method
fixture. [Browser observations](hosted-anonymous.json) use no request interception:
email readiness was 2.275/2.296 seconds and compressed bundle transfer about
1.72 MB, with no page errors, overflow or top-level CSP violations. CAPTCHA frames
loaded; no email, OTP or CAPTCHA response was submitted. These workstation runs
are not physical-device, inbox or population-performance evidence.

The [account postflight](hosted-accounts.json) verifies the retained accounts and
manual signup still exist, with no live coin journals or grants. Two cumulative
provider-session exchanges map to the same new account; one app session is active.
The postflight does not establish a captured returning-user/revocation journey.

Reproduce the refresh evidence after `npm run build`:

```sh
PRIVY_APP_ID=your-public-app-id AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-refresh/after npm run verify:email-auth-browser
```

The public app ID is sufficient for this command; never load the app secret.
