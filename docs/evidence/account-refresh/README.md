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

| View          | Original desktop                               | Refreshed desktop                            | Original mobile                               | Refreshed mobile                            |
| ------------- | ---------------------------------------------- | -------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Email entry   | [Before](before/after-desktop.png)             | [After](after/after-desktop.png)             | [Before](before/after-mobile.png)             | [After](after/after-mobile.png)             |
| Code error    | [Before](before/code-error-desktop.png)        | [After](after/code-error-desktop.png)        | [Before](before/code-error-mobile.png)        | [After](after/code-error-mobile.png)        |
| Account       | [Before](before/account-signed-in-desktop.png) | [After](after/account-signed-in-desktop.png) | [Before](before/account-signed-in-mobile.png) | [After](after/account-signed-in-mobile.png) |
| Balance menu  | [Before](before/wallet-progress-desktop.png)   | [After](after/wallet-progress-desktop.png)   | [Before](before/wallet-progress-mobile.png)   | [After](after/wallet-progress-mobile.png)   |
| Wallet dialog | [Before](before/balance-dialog-desktop.png)    | [After](after/balance-dialog-desktop.png)    | [Before](before/balance-dialog-mobile.png)    | [After](after/balance-dialog-mobile.png)    |

[Refreshed results](after/browser-results.json) cover SDK initialization,
email/code labels and autofill hints, keyboard submission, code-field focus,
resend waiting, incorrect-code errors, changing email, refresh, exact initiating
query/fragment return, balance bars, sticky qualification and Escape/focus
restoration. Signed-in fixtures verify server-owned authentication methods while
the SDK is signed out, profile creation/publication, permanent handles and
other/all-session sign-out controls. No horizontal overflow or page errors were
observed. Automated axe WCAG 2/2.1/2.2 AA tags found no violations in the email
form, signed-in account area and wallet dialog at either size.

Public Privy metadata is read live; CAPTCHA is explicitly disabled only in the
local intercepted response. OTP endpoints, optional Google/passkey availability,
account responses and balances are synthetic. The 1,250 YC withdrawal amount,
40% welcome progress and qualified daily grant are examples, not funded accounts.
These checks do not establish full WCAG conformance, screen-reader usability,
physical-device passkeys, live optional-provider flows, or financial acceptance.
The founder's [real hosted signup](../email-first/hosted-signup.json) is separate.

Reproduce the refresh evidence after `npm run build`:

```sh
PRIVY_APP_ID=your-public-app-id AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-refresh/after npm run verify:email-auth-browser
```

The public app ID is sufficient for this command; never load the app secret.
