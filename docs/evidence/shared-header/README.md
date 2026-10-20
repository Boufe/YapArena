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

The [complete release gate](release-results.json) passed on `9c19585`: 528 tests,
zero skips, 94.30% line / 92.88% branch / 95.63% function coverage; fresh/upgrade
SQL isolation, account/A4/workspace/shared-data browsers, homepage and Live/replay
preview checks all passed. Two earlier gate runs stopped at assertions for the
removed homepage nav/account link. Those assertions now exercise the shared Live
link and no-JavaScript Log in fallback. A sandbox attempt could not initialize
PostgreSQL shared memory; the recorded successful gate used permitted native
PostgreSQL 17 outside that sandbox, with disposable owner/runtime identities.
The optional historical original-export geometry comparison was not requested;
this authorized design change does not claim parity with that old header.

CI's separate community browser found header overflow at 200% CSS zoom on the
initial revision ([failed run](https://github.com/Boufe/YapArena/actions/runs/39345178262)).
The follow-up uses container queries in addition to viewport fallbacks so layout
responds to the space the header actually has. Focused synthetic
[visitor](after/header-guest-zoom.png) and
[member](after/header-member-zoom.png) checks now verify 1280 × 900 at 200% zoom.
The [complete community trial](community-results.json) passed locally, including
the existing zoom, narrow-screen, draft recovery, IME, reconnect, moderation and
axe checks, plus a 300-second synthetic 500-client/50-room HTTP soak and cleanup.
This is not hosted/media capacity evidence. Remaining responsive rules now live
in the shared stylesheet; desktop/mobile comparisons verify identical header
geometry, typography and colors without depending on the debate stylesheet.

## Hosted observations

The [deployment report](hosted-deployment.json) records the explicitly deployed
staging revision, healthy public routes and anonymous session denial. No database
reset, financial enablement, automatic deployment change or worker revision change
is part of this rollout.

Real anonymous [desktop](hosted-popup-desktop.png) and
[mobile](hosted-popup-mobile.png) popup screenshots use fresh browser contexts
with no interception. The [hosted browser report](hosted-anonymous.json) checks
the shared header on seven public pages, zero provider requests before opening
authentication, real provider/CAPTCHA initialization, exact initiating URLs and
Back/Escape/Keep exploring dismissal with focus restoration. It records measured
readiness and compressed transfer size; these workstation observations are not
population-performance, successful login, inbox, physical-device or WCAG acceptance.
The first hosted check matched both a header link and a hidden popup button;
the corrected check scopes its selector to the header. No credential was submitted.

The [read-only account postflight](hosted-accounts.json) verifies four preserved
accounts, one verified provider identity and zero live money journals/grants.
There is no active manual-account app session at this observation; its latest
session deletion was 2026-10-19 22:49:55 UTC, before this rollout. Two consumed
provider-session exchanges remain recorded. No acceptance identity was created.
