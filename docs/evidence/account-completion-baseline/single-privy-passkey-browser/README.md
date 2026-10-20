# Single Privy passkey browser acceptance

The final frozen-asset execution on 2026-10-20 **passed all 92 checks, exit 0**, with no page errors or requirement failures. [browser-results.json](browser-results.json) records every check, launch revision `db7392600876dcd597ca2605ebeb2f52e78e5281`, exact verifier/SSR hashes and all served asset hashes. [run.txt](run.txt) preserves terminal output. [source-state.json](source-state.json) independently confirms the recorded verifier and assets still matched after the run; the shared checkout included uncommitted verifier changes.

```sh
PRIVY_APP_ID=cmvfjb3r800vy0hl3heg2cuvv AUTH_BROWSER_PHASE=after AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/single-privy-passkey-browser node scripts/verify-email-auth-browser.ts
```

The app ID is public configuration. This local fixture uses the installed Privy React SDK and real Chromium virtual-authenticator registration/assertion. Provider OTP/passkey endpoints and application responses are intercepted synthetic fixtures. Public app metadata is fetched live, with CAPTCHA disabled only in the fixture response. No genuine provider account, email, hosted database, funds or external transaction is created or modified.

The final checks retain the previous authentication, return-to-action, account-switch, storage, keyboard, automated accessibility and mobile assertions, plus reset-error classification and the single-Privy-key flows:

- Account settings exposes one Add a passkey control. Cancelling retained authorization issues no proof/provider request, rejects duplicate submissions and restores focus to the exact re-enabled initiating control.
- The installed SDK creates exactly one credential. Interrupted activation preserves only its intent ID across refresh; protected account reads remain hidden/503. The original cookie can resume through scoped retained proof and user verification of that same key, without another registration.
- The expired first-key fixture first rejects the old provider SID, offers explicit sign-in again, then requires another SDK email-code login with a different synthetic SID. Only the server availability response exposes restart; native verification of the same key completes only the bootstrap endpoint.
- A real replacement-login HTTP response holds the browser's Web Lock. Account change aborts the original account's queued completion before submission and preserves the replacement HttpOnly cookie.
- The Privy key cannot authorize its own removal. There is no second local enrollment/removal control, and an unavailable guarded request opens no additional provider ceremony.

The final screenshots [desktop](single-privy-passkey-desktop.png) and [mobile](single-privy-passkey-mobile.png) show the single accepted credential and hidden legacy-only section. Restart [confirmation](first-privy-passkey-restart-confirmation-desktop-expired-restart.png) and [completion](first-privy-passkey-restart-complete-desktop-expired-restart.png), classified denial screenshots and the existing journey captures are also retained. The reviewer inspected both final single-key screenshots; the assertions also check overflow and relevant control visibility.

Historical failed trials remain labelled in `failed-*` and `historical-final-failures/`. They include the actual opener-focus failure, fixed by capturing the clicked control before asynchronous busy state; initial SDK wire/RP fixtures; a strict text-selector ambiguity; and incorrect pending/expired-session fixture responses. The final fixture matches the original-cookie session monitor's pending503 and the expired fresh-login/restart SID fences. Its legacy internal recovery event now waits for SDK readiness and the server-populated comparison hint before testing denied storage. None of those failed trials is counted as a passing run.

This is not genuine provider login/link, email delivery, CAPTCHA, hosted-session, physical-device, screen-reader or complete WCAG acceptance. Real PostgreSQL and separate installed-SDK/native/PG verification are recorded independently in the integrated and `security-passkey-browser/privy-only/` evidence. [Cookie coordination](../single-privy-passkey-bootstrap-cookie-browser/README.md) separately passed seven native HTTP groups over 14 cookie issuers; arbitrary API clients do not participate in browser locks.
