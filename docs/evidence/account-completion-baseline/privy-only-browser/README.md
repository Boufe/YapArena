# Classified provider exchange failures: local browser acceptance

The maintained installed-SDK browser verifier completed with **78 check groups PASS**, exit 0, on 2026-10-20 at launch HEAD `edbed1f4ff68320e74c3d58afd07a2c58ce5a0d5` plus the working-tree structured failure classification and fixtures. There were zero page errors and zero requirement failures. [Raw output](run.txt), [browser results](browser-results.json) and [source/asset fingerprints](source-state.json) record the exact boundary before the next passkey-UI build.

```sh
PRIVY_APP_ID=<public-app-id> AUTH_BROWSER_PHASE=after AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/privy-only-browser node scripts/verify-email-auth-browser.ts
```

Eight new groups cover four synthetic server codes at desktop and mobile viewport sizes. `provider_reset_review_required`, `provider_reset_pending` and an unknown 403 keep application access denied, show their classified notice and never request a changed-method candidate or show an empty retained-method reconciliation. Only `provider_credentials_changed` opens the exact before/after review and its synthetic retained password option. Each scenario observes one application exchange and no unexpected provider path. The existing 70 groups continue to cover email/code states, recovery markers/storage denial, account/session races, focus/accessibility checks, return-to-action context, loading/failure spacing, matching and inline account isolation.

The four `exchange-*-mobile.png` / desktop counterparts show those classifications. The reset-review and changed-credential mobile frames were visually inspected. This fixture uses the installed Privy SDK and public metadata with intercepted OTP/session endpoints and a deliberately synthetic, unsigned provider token. It does not establish successful genuine provider login, real email delivery, hosted reset/recovery completion, CAPTCHA validation, physical-device behavior, screen-reader operation or complete WCAG conformance.

## Failed attempts kept separately

`failed-phase-privy-only/` preserves the two transferred failed logs and partial screenshots. The invocation used `AUTH_BROWSER_PHASE=privy-only`, selecting an existing legacy-phase branch which tried to click hidden `#sign-out` while the current checking-state control was visible. The corrected run uses the maintained current-UI `after` phase; no visibility assertion was weakened.

`failed-frame-storage/run.txt` preserves the subsequent final page-error failure. The new classification fixture set measurement storage in every frame, including sandboxed SDK frames. Its setup now uses the same top-level-window guard as the maintained main fixture. No application source or compiled asset changed for either fixture correction. The final zero-page-error assertion remains intact and passed. No actual provider email/account mutation was performed.
