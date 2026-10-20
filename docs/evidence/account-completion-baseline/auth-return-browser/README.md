# Return to the initiating action and recovery browser acceptance

The approved behavior preserves the page and draft for the initiating user, returns focus to the initiating control, and requires another explicit confirmation before an action. Login never automatically retries a message, Follow, match request, stake, payment or wallet change. Only a bounded, expiring public action locator may cross full-page/OAuth navigation; form values are never serialized by the return helper.

The native browser fixture uses the real server-rendered header, matching and inline A4 markup, the compiled browser modules and the installed Privy SDK. Provider public metadata is fetched from Privy. CAPTCHA is disabled only in the intercepted fixture metadata; OTP delivery/verification and application session responses are synthetic. This does not establish hosted email delivery, successful provider signup/login, CAPTCHA acceptance, physical-device behavior, screen-reader operation or complete WCAG conformance.

## Recorded runs

- `initial-results.json` and `initial-run.txt`: 62 browser check groups at launch HEAD `4b880918934f8be0060f260392ea29f0601a01e9`, with the then-uncommitted return work identified in `initial-source-state.json`. PASS, before the later settings-focus, marker-storage and account-switch follow-ups.
- `intermediate-results.json` and `intermediate-run.txt`: 66 groups at `9080a93471ca430be61cf6c3d9b03d63335297fc`. PASS, including settings completion without a return URL and denied recovery-marker reads/writes across refresh. This precedes the matching/inline corrections in `c98294c`.
- `browser-results.json` and `final-run.txt`: final **70/70 groups PASS**, exit 0, at launch HEAD `97be514d568169d5bd3f1acc569bb5494642a42a`. Zero page errors and zero requirement failures. `final-source-state.json` records source and built-asset fingerprints. The final verifier received only Prettier line wrapping after execution; the reversible `verifier-format-only.patch` preserves its exact tested source hash.

The final command is:

```sh
PRIVY_APP_ID=<public-app-id> AUTH_BROWSER_PHASE=after AUTH_BROWSER_ARTIFACT_DIR=docs/evidence/account-completion-baseline/auth-return-browser node scripts/verify-email-auth-browser.ts
```

Desktop and mobile are Chromium viewport emulations. Generated results identify exact asset and compiled server-renderer hashes. Screenshots in this directory are from the final passing run. The mobile inline original/replacement pair was visually inspected and its argument input is readable in both frames. Existing matching baseline screenshots are under `../before/`; the unchanged header/auth journeys use the same fixtures and viewports. The new inline original/replacement pair uses the same synthetic debate and viewport to show that the old actor’s draft is detached and is not exposed to another verified account.

## Independent disposable community gate

The maintained command completed with exit 0 against a new native PostgreSQL 17.10 SCRAM cluster and runtime role on Node 24.19.0:

```sh
LC_ALL=C LANG=C COMMUNITY_POSTGRES_MODE=host COMMUNITY_DURABLE_TRIAL=1 COMMUNITY_SOAK_SECONDS=30 node scripts/verify-community-local.ts
```

`community-native-run.txt` records the complete result. The changed community source and native race helper are exactly those committed in `10d3730`; `community-source-state.json` captures their hashes and generated assets before the next coordinated build. Later matching/inline fixes do not change community code.

All maintained migration, UTF-8/Unicode, PostgreSQL durability, media-controller, chat-retention, browser and load stages passed. The new native race holds an original actor’s reconciliation response across account replacement, rejects retry under the replacement actor, permits an explicit recovered draft as a new submission, and reconciles the original receipt after the original actor returns. The load stage used 500 clients, 50 rooms, 30 seconds, 300 writes and 3,000 delivery samples; p50 was 36 ms and p95 was 255 ms. Final open streams were zero. Restart recovery was 1,400 ms; reconnect storm recovery was 435 ms. These are local results with synthetic media providers, not hosted latency or LiveKit capacity acceptance.

No retained or manually created hosted account was changed. No real funds or financial provider transaction was used.

The first final attempt hit a fixture synchronization race: the old ready notice was still present while a held logout-others response triggered a new identity lookup. `fixture-barrier-failure.txt` records it. The fixture now waits for the actual follow-up `/api/auth/me` response and restored signed-in visibility, retaining the original state assertion. The following 70-group PASS is preserved in `pre-visual-refinement-results.json`; the final repeat centers the inline argument screenshot so the fixed fixture badge does not cover it. No application change was made for either fixture refinement.
