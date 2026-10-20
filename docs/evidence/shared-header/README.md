# Shared navigation and authentication popup

Recorded 2026-10-19. The founder requested Live's navigation on every ordinary
page, Log in / Sign up for visitors, and balance / Deposit / account controls
only after login. This continues PR #42 from clean `7cdcbda`, nine commits ahead
of fetched `origin/main` (`fd60543`), with no incoming main changes.

The shared server header now covers discovery, Live, debates, topics, profiles,
matching, coins, account, moderation and measurement pages. The broadcast overlay
remains a clean broadcast asset. Homepage All ideas / Following filters and idea
search remain in a toolbar below navigation. Links to the account page and
protected actions use the same login/signup popup for visitors. Modified/new-tab
links and the deliberate legacy-account fallback retain normal navigation.

Only `/api/auth/me` can reveal member controls. Provider/browser authentication
state is not YapArena authorization. The header clears stale values on account
changes, shares logout across tabs, handles unavailable session reads separately
from signed-out state, and ignores old play/sandbox balance events in email-first
mode. The balance menu retains withdrawal progress and breakdowns. Deposit shows
an honest unavailable notice; this change enables no funding or withdrawals.

The provider bundle loads on demand outside the account page. The popup reuses
the existing strict TSX island, supports email codes, safely retains the initiating
path/query/fragment, clears email/code on dismissal, restores focus, and closes
on Escape and browser Back. Successful authentication returns through navigation
so protected page controllers reinitialize. Optional Google returns keep only a
validated local navigation path in session storage; OAuth credential parameters
are removed from return paths and HTTP logs. Google/passkeys remain disabled in
the selected staging application. All pages admit the necessary Privy/CAPTCHA
origins in CSP while preserving configured media/playback origins and existing
frame-ancestor restrictions. Unused external-wallet directory access stays off.

## Matched local evidence

The [before fixture](before/browser-results.json) ran against `7cdcbda` before
the new sources were built. The [after fixture](after/browser-results.json) uses
the same synthetic accounts, balances, reduced motion and viewport dimensions:
desktop 1440 × 1000 and mobile 390 × 844. Full-page screenshots can extend below
the viewport. No real user, OTP, token or secret appears in these artifacts.

| View                     | Before desktop                                 | After desktop                                | Before mobile                                 | After mobile                                |
| ------------------------ | ---------------------------------------------- | -------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Account entry and header | [Before](before/after-desktop.png)             | [After](after/after-desktop.png)             | [Before](before/after-mobile.png)             | [After](after/after-mobile.png)             |
| Signed-in account        | [Before](before/account-signed-in-desktop.png) | [After](after/account-signed-in-desktop.png) | [Before](before/account-signed-in-mobile.png) | [After](after/account-signed-in-mobile.png) |
| Balance progress         | [Before](before/wallet-progress-desktop.png)   | [After](after/wallet-progress-desktop.png)   | [Before](before/wallet-progress-mobile.png)   | [After](after/wallet-progress-mobile.png)   |

New popup views: [desktop](after/signup-popup-desktop.png),
[mobile](after/signup-popup-mobile.png), [code entry](after/code-popup-desktop.png).
New shared header: [visitor](after/header-guest-desktop.png),
[member desktop](after/header-member-desktop.png),
[member mobile](after/header-member-mobile.png).

The local browser fixture verifies code labels/autofill, keyboard submission,
resend waiting, errors, email changes, refresh, popup mode switching,
protected-action links, exact return paths, cancellation, Back/Escape/focus,
profile creation/publication, session controls, balance breakdowns and per-grant
progress. Additional cases cover two tabs, session-service outage/retry and a
delayed balance response arriving after logout. Automated axe WCAG 2/2.1/2.2 AA
tags cover the form, popup, signed-in area and wallet dialog at both sizes, with
no violations in the tested regions. Manual screen-reader, physical-device and
complete WCAG conformance acceptance remain outstanding.

The installed Privy SDK reads live public metadata, with CAPTCHA disabled only
in the local intercepted metadata response. OTP, optional-method flags, account
sessions and balances are synthetic. This does not prove real popup login,
Google/passkey recovery, inbox delivery or financial acceptance. The founder's
earlier [genuine signup](../email-first/hosted-signup.json) is separate evidence.

Reproduce after `npm run build`:

```sh
PRIVY_APP_ID=your-public-app-id AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/shared-header/after npm run verify:email-auth-browser
DATABASE_TEST_MODE=host npm run verify:browser
```

The public app ID is sufficient for the first command. Do not load an operator
environment or app secret into a browser test or runtime process.
